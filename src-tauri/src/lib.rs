use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};

const DEFAULT_EXECUTABLE: &str = r"G:\Edge_download\KataGo\katago.exe";
const DEFAULT_MODEL: &str = r"G:\Edge_download\KataGo\kata1-tf3-b11c768-s11001M-d5973M.bin.gz";
const DEFAULT_CONFIG: &str = r"G:\Edge_download\KataGo\analysis_example.cfg";

#[derive(Debug, Deserialize, Serialize, Clone)]
struct MoveInput {
    color: String,
    x: Option<u8>,
    y: Option<u8>,
    pass: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisRequest {
    moves: Vec<MoveInput>,
    #[serde(default)]
    initial_stones: Vec<MoveInput>,
    analyze_turns: Vec<u32>,
    max_visits: Option<u32>,
    /// 棋谱自带的规则与贴目；古谱（明清规则）为贴 0 目，缺省时按现代中国规则 7.5 目。
    rules: Option<String>,
    komi: Option<f64>,
}

// ---------------------------------------------------------------------------
// 引擎路径解析
//
// 引擎体积大（模型约 200MB），不适合塞进安装包，因此走「就近查找」：
//   1. 环境变量 KATAGO_EXE / KATAGO_MODEL / KATAGO_CONFIG，或只给 KATAGO_DIR 由目录推导
//   2. 可执行文件同目录下的 katago.json（便携版：拷一份改路径即可）
//   3. 本机默认安装位置
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineConfig {
    executable: String,
    model: String,
    config: String,
    data_dir: String,
    /// 路径来自哪里，方便前端提示用户「改哪个文件」
    source: String,
    config_file: String,
}

fn config_file_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut list = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            list.push(dir.join("katago.json"));
        }
    }
    if let Ok(dir) = app.path().app_config_dir() {
        list.push(dir.join("katago.json"));
    }
    list
}

fn read_config_file(path: &Path) -> Option<serde_json::Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// 依次尝试各个键名，返回第一个真正有内容的字符串。
/// 注意要在同一个键上完成「取值 → 去空白 → 判空」，否则写了 "exe": "" 这种
/// 占位空值时，后面的别名键就再也轮不到了。
fn json_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(|item| item.as_str())
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
    })
}

/// 从 KATAGO_DIR 推导三件套：可执行文件、体积最大的 .bin.gz 模型、analysis 配置。
fn derive_from_directory(directory: &str) -> Option<(String, String, String)> {
    let dir = PathBuf::from(directory);
    if !dir.is_dir() {
        return None;
    }
    let entries = fs::read_dir(&dir).ok()?;
    let mut executable = None;
    let mut model: Option<(u64, PathBuf)> = None;
    let mut config = None;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if name.ends_with(".exe") && name.contains("katago") {
            executable = Some(path);
        } else if name.ends_with(".bin.gz") || name.ends_with(".txt.gz") {
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            if model.as_ref().map(|(best, _)| size > *best).unwrap_or(true) {
                model = Some((size, path));
            }
        } else if name == "analysis_example.cfg" || name == "analysis.cfg" {
            config = Some(path);
        }
    }
    if config.is_none() {
        let fallback = dir.join("analysis_example.cfg");
        if fallback.is_file() {
            config = Some(fallback);
        }
    }
    Some((
        executable?.to_string_lossy().to_string(),
        model?.1.to_string_lossy().to_string(),
        config?.to_string_lossy().to_string(),
    ))
}

fn resolve_engine_config(app: &AppHandle) -> EngineConfig {
    let data_dir = app
        .path()
        .app_cache_dir()
        .map(|dir| dir.join("katago"))
        .unwrap_or_else(|_| PathBuf::from(".katago-data"))
        .to_string_lossy()
        .to_string();

    // 便携版会把 katago.json 写成相对路径（./katago/katago.exe）。
    // 相对路径一律以可执行文件所在目录为基准，否则从快捷方式或别处启动就会找不到引擎。
    let base = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let anchor = |value: String| -> String {
        let candidate = PathBuf::from(&value);
        if candidate.is_absolute() {
            value
        } else {
            base.join(candidate).to_string_lossy().to_string()
        }
    };

    let candidates = config_file_candidates(app);
    let config_file = candidates
        .iter()
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| candidates[0].to_string_lossy().to_string());

    let file_value = candidates
        .iter()
        .find(|path| path.is_file())
        .and_then(|path| read_config_file(path));

    let from_file = |keys: &[&str]| -> Option<String> {
        file_value.as_ref().and_then(|value| json_string(value, keys))
    };

    // 环境变量优先于配置文件，便于临时覆盖。
    let env_dir = std::env::var("KATAGO_DIR").ok().map(anchor);
    let derived = env_dir.as_deref().and_then(derive_from_directory);

    let executable = std::env::var("KATAGO_EXE")
        .ok()
        .or_else(|| derived.as_ref().map(|triple| triple.0.clone()))
        .or_else(|| from_file(&["executable", "exe", "katago"]))
        .unwrap_or_else(|| DEFAULT_EXECUTABLE.to_string());
    let model = std::env::var("KATAGO_MODEL")
        .ok()
        .or_else(|| derived.as_ref().map(|triple| triple.1.clone()))
        .or_else(|| from_file(&["model"]))
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let config = std::env::var("KATAGO_CONFIG")
        .ok()
        .or_else(|| derived.as_ref().map(|triple| triple.2.clone()))
        .or_else(|| from_file(&["config", "configPath", "analysisConfig"]))
        .unwrap_or_else(|| DEFAULT_CONFIG.to_string());

    let has_env =
        std::env::var("KATAGO_EXE").is_ok() || std::env::var("KATAGO_DIR").is_ok();
    let source = if has_env {
        "环境变量"
    } else if file_value.is_some() {
        "katago.json"
    } else {
        "默认安装路径"
    };

    let data_dir = file_value
        .as_ref()
        .and_then(|value| json_string(value, &["dataDir", "homeDataDir"]))
        .unwrap_or(data_dir);

    EngineConfig {
        executable: anchor(executable),
        model: anchor(model),
        config: anchor(config),
        data_dir: anchor(data_dir),
        source: source.into(),
        config_file,
    }
}

// ---------------------------------------------------------------------------
// KataGo 子进程
//
// 关键点：模型加载（TensorRT 首次约 30–90 秒）与整局分析都很慢，
// 绝不能占住调用线程，所以 stdout 交给独立线程读取，按请求 id 派发，
// 每个请求自己带超时等待，UI 线程全程只做一次跨线程等待。
// ---------------------------------------------------------------------------

struct EngineInner {
    child: Child,
    stdin: ChildStdin,
}

impl Drop for EngineInner {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

type Routes = Arc<Mutex<HashMap<String, mpsc::Sender<serde_json::Value>>>>;

struct KataGoRuntime {
    config: EngineConfig,
    engine: Mutex<Option<EngineInner>>,
    routes: Routes,
    /// 引擎是否已经成功返回过分析结果（用来区分「正在加载模型」和「就绪」）
    served: AtomicBool,
}

impl KataGoRuntime {
    fn new(config: EngineConfig) -> Self {
        Self {
            config,
            engine: Mutex::new(None),
            routes: Arc::new(Mutex::new(HashMap::new())),
            served: AtomicBool::new(false),
        }
    }

    fn missing_files(&self) -> Vec<String> {
        [
            ("可执行文件", &self.config.executable),
            ("神经网络模型", &self.config.model),
            ("分析配置", &self.config.config),
        ]
        .iter()
        .filter(|(_, path)| !Path::new(path).exists())
        .map(|(label, path)| format!("{label}：{path}"))
        .collect()
    }

    fn status(&self) -> serde_json::Value {
        let missing = self.missing_files();
        let running = self
            .engine
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false);
        let state = if !missing.is_empty() {
            "unavailable"
        } else if !running {
            "stopped"
        } else if self.served.load(Ordering::Relaxed) {
            "ready"
        } else {
            "loading"
        };
        serde_json::json!({
            "available": missing.is_empty(),
            "running": running,
            "state": state,
            "backend": "TensorRT / CUDA",
            "missing": missing,
            "source": self.config.source,
            "configFile": self.config.config_file,
            "dataDir": self.config.data_dir,
            "executable": self.config.executable,
            "model": self.config.model,
            "config": self.config.config,
        })
    }

    /// 拉起进程（幂等）。仅做启动动作，不等待模型加载完成。
    fn ensure_started(&self) -> Result<(), String> {
        let mut guard = self.engine.lock().map_err(|_| "引擎状态锁定失败".to_string())?;
        if guard.is_some() {
            return Ok(());
        }
        let missing = self.missing_files();
        if !missing.is_empty() {
            return Err(format!(
                "未找到 KataGo 运行文件（{}）。请在 katago.json 中填写正确路径：{}",
                missing.join("；"),
                self.config.config_file
            ));
        }
        fs::create_dir_all(&self.config.data_dir)
            .map_err(|error| format!("无法创建引擎数据目录：{error}"))?;
        let data_dir = self.config.data_dir.replace('\\', "/");

        let mut command = Command::new(&self.config.executable);
        command
            .args([
                "analysis",
                "-model",
                &self.config.model,
                "-config",
                &self.config.config,
                "-override-config",
                &format!("homeDataDir={data_dir},logDir={data_dir}/logs"),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW：不弹黑框

        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 KataGo：{error}"))?;
        let stdin = child.stdin.take().ok_or("无法连接 KataGo 输入")?;
        let stdout = child.stdout.take().ok_or("无法连接 KataGo 输出")?;

        let routes = self.routes.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
                    continue;
                };
                let Some(id) = value.get("id").and_then(|item| item.as_str()) else {
                    continue;
                };
                let sender = routes
                    .lock()
                    .ok()
                    .and_then(|map| map.get(id).cloned());
                if let Some(sender) = sender {
                    // 接收端已放弃时忽略即可
                    let _ = sender.send(value);
                }
            }
            // 读取结束说明进程退出，所有等待中的请求都会因通道断开而立刻失败
        });

        *guard = Some(EngineInner { child, stdin });
        Ok(())
    }

    fn analyze(&self, request: AnalysisRequest) -> Result<Vec<serde_json::Value>, String> {
        if request.analyze_turns.is_empty() {
            return Err("未指定分析手数".into());
        }
        self.ensure_started()?;

        let moves = request
            .moves
            .iter()
            .map(|item| {
                let point = if item.pass.unwrap_or(false) {
                    "pass".to_string()
                } else {
                    coords_to_gtp(
                        item.x.ok_or("着法缺少横坐标")?,
                        item.y.ok_or("着法缺少纵坐标")?,
                    )?
                };
                Ok(serde_json::json!([item.color, point]))
            })
            .collect::<Result<Vec<_>, String>>()?;

        let initial_stones = request
            .initial_stones
            .iter()
            .filter(|item| !item.pass.unwrap_or(false))
            .map(|item| {
                Ok(serde_json::json!([
                    item.color,
                    coords_to_gtp(item.x.ok_or("摆子缺少横坐标")?, item.y.ok_or("摆子缺少纵坐标")?)?
                ]))
            })
            .collect::<Result<Vec<_>, String>>()?;

        let id = format!(
            "yijing-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_millis()
        );
        let query = serde_json::json!({
            "id": id,
            "moves": moves,
            "initialStones": initial_stones,
            "rules": request.rules.as_deref().unwrap_or("chinese"),
            "komi": request.komi.unwrap_or(7.5),
            "boardXSize": 19,
            "boardYSize": 19,
            "analyzeTurns": request.analyze_turns,
            "maxVisits": request.max_visits.unwrap_or(64).clamp(1, 500),
            "includePolicy": true
        });

        let (sender, receiver) = mpsc::channel();
        {
            let mut routes = self.routes.lock().map_err(|_| "分析通道锁定失败")?;
            routes.insert(id.clone(), sender);
        }

        let written = {
            let mut guard = self
                .engine
                .lock()
                .map_err(|_| "引擎状态锁定失败".to_string())?;
            match guard.as_mut() {
                Some(inner) => writeln!(inner.stdin, "{query}")
                    .and_then(|_| inner.stdin.flush())
                    .is_ok(),
                None => false,
            }
        };
        if !written {
            self.release(&id);
            if let Ok(mut guard) = self.engine.lock() {
                *guard = None;
            }
            return Err("与 KataGo 通信失败，引擎已重置，请重试".into());
        }

        let expected = request.analyze_turns.len();
        // 首帧要等模型加载；随后每手留出足够余量。
        let budget = Duration::from_secs(180) + Duration::from_secs(4) * expected as u32;
        let deadline = Instant::now() + budget;
        let mut results = Vec::with_capacity(expected);
        let mut failure: Option<String> = None;

        while results.len() < expected {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                failure = Some(format!(
                    "KataGo 分析超时（已等待 {} 秒）。可降低访问次数后重试。",
                    budget.as_secs()
                ));
                break;
            }
            match receiver.recv_timeout(remaining.min(Duration::from_secs(10))) {
                Ok(value) => {
                    if let Some(error) = value.get("error").and_then(|item| item.as_str()) {
                        failure = Some(format!("KataGo 拒绝该请求：{error}"));
                        break;
                    }
                    results.push(value);
                }
                // 只是还没轮到结果，继续等
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    failure = Some("KataGo 进程已退出，引擎已重置，请重试".into());
                    if let Ok(mut guard) = self.engine.lock() {
                        *guard = None;
                    }
                    break;
                }
            }
        }

        self.release(&id);
        if let Some(message) = failure {
            return Err(message);
        }
        self.served.store(true, Ordering::Relaxed);
        results.sort_by_key(|value| {
            value
                .get("turnNumber")
                .and_then(|turn| turn.as_u64())
                .unwrap_or(0)
        });
        Ok(results)
    }

    fn release(&self, id: &str) {
        if let Ok(mut routes) = self.routes.lock() {
            routes.remove(id);
        }
    }

    fn shutdown(&self) {
        if let Ok(mut guard) = self.engine.lock() {
            *guard = None;
        }
    }
}

fn coords_to_gtp(x: u8, y: u8) -> Result<String, String> {
    const LETTERS: &[u8] = b"ABCDEFGHJKLMNOPQRSTUVWXYZ";
    if x >= 19 || y >= 19 {
        return Err("棋盘坐标超出范围".into());
    }
    Ok(format!("{}{}", LETTERS[x as usize] as char, 19 - y))
}

// ---------------------------------------------------------------------------
// 棋谱库存储（应用数据目录，随应用走，与浏览器缓存无关）
//
// 正式存储是 SQLite：一局棋一行，改一局只写一行，事务保证不会写坏半个文件。
// library.json 只作为老版本留下的数据源被读取一次，迁移后改名留档。
// ---------------------------------------------------------------------------

/// 老格式棋谱库的位置（仅用于一次性迁移）
fn library_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("library.json"))
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("yijing.sqlite"))
}

/// 棋谱库结构版本。改动表结构时加一，并在 migrate 里写清怎么升。
const SCHEMA_VERSION: i64 = 1;

fn connection(app: &AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(database_path(app)?).map_err(|error| error.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| error.to_string())?;
    migrate(&conn)?;
    Ok(conn)
}

/// 建表 / 升级结构。
///
/// 早期版本建过 folders / games / game_search 三张表，那是按「关系型棋谱库」设想的字段
/// （folder_id、content_hash、FTS 索引），和界面真正在用的模型对不上：一局棋带着
/// setup / moves / tag / favorite / ruleset，本质是一份文档而不是一条记录，而且那套表
/// 从没写过数据。所以 v0 → v1 直接清掉重建，免得两套互不相容的定义并存。
///
/// 一局棋占一行：改一个收藏只写一行，而不是把整个棋谱库重新序列化一遍——这正是
/// 这套存储要解决的问题。排序靠 position，字段完整性靠 payload 原样保存的 JSON。
fn migrate(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if version > SCHEMA_VERSION {
        return Err(format!(
            "棋谱库结构版本为 {version}，比当前程序支持的 {SCHEMA_VERSION} 更新，请升级弈境后再打开"
        ));
    }
    if version < SCHEMA_VERSION {
        conn.execute_batch(
            "DROP TABLE IF EXISTS game_search;
             DROP TABLE IF EXISTS games;
             DROP TABLE IF EXISTS folders;",
        )
        .map_err(|error| error.to_string())?;
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS games (
           row_id INTEGER PRIMARY KEY AUTOINCREMENT,
           game_key TEXT NOT NULL UNIQUE,
           position INTEGER NOT NULL DEFAULT 0,
           payload TEXT NOT NULL,
           digest TEXT NOT NULL DEFAULT '',
           updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         CREATE INDEX IF NOT EXISTS idx_games_position ON games(position, row_id);",
    )
    .map_err(|error| error.to_string())?;
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn digest_of(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn read_meta(conn: &Connection, key: &str) -> Result<Option<serde_json::Value>, String> {
    let text: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key=?1", [key], |row| row.get(0))
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(text.and_then(|value| serde_json::from_str(&value).ok()))
}

fn write_meta(conn: &Connection, key: &str, value: &serde_json::Value) -> Result<(), String> {
    let text = serde_json::to_string(value).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO meta(key,value) VALUES (?1,?2)
         ON CONFLICT(key) DO UPDATE SET value=?2",
        params![key, text],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// 棋盘数据的主键：优先用棋谱自身的 id，界面选谱和去重都认它。
/// 用 JSON 原文而不是字符串拼接，数字 1 和字符串 "1" 才不会被当成同一局。
fn game_key(game: &serde_json::Value, index: usize) -> String {
    match game.get("id") {
        Some(id) if !id.is_null() => {
            serde_json::to_string(id).unwrap_or_else(|_| format!("\"#index-{index}\""))
        }
        _ => format!("\"#index-{index}\""),
    }
}

/// 写入一局棋；内容与库里已有的完全一致就跳过，返回是否真的写了。
/// 导入旧棋谱库与日常同步共用这一条路径，两边不会长出分歧。
fn upsert_game(conn: &Connection, key: &str, index: i64, payload: &str) -> Result<bool, String> {
    if key.trim().is_empty() {
        return Err("棋谱缺少主键，拒绝写入".into());
    }
    let digest = digest_of(payload);
    // 内容没变就跳过：收藏、显示开关这类改动常常会连带把棋谱重新提交上来
    let existing: Option<String> = conn
        .query_row(
            "SELECT digest FROM games WHERE game_key=?1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if existing.as_deref() == Some(digest.as_str()) {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO games(game_key,position,payload,digest) VALUES (?1,?2,?3,?4)
         ON CONFLICT(game_key) DO UPDATE SET position=?2,payload=?3,digest=?4,
           updated_at=CURRENT_TIMESTAMP",
        params![key, index, payload, digest],
    )
    .map_err(|error| error.to_string())?;
    Ok(true)
}

/// 组装前端的整库快照。某一行 payload 坏掉时只跳过那一局，不让整个棋谱库打不开——
/// 一条坏数据没有理由连累其余棋谱。
///
/// `keys` 与 `games` 一一对应地交回前端。主键一旦由两边各自推算（Rust 走 serde_json、
/// JS 走 JSON.stringify），浮点数的文本形式就可能对不上，结果不是更新而是写成重复行。
/// 让前端沿用数据库里的原文，这个隐患就不存在了。
fn read_snapshot(conn: &Connection) -> Result<serde_json::Value, String> {
    let mut statement = conn
        .prepare("SELECT game_key, payload FROM games ORDER BY position, row_id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut games = Vec::new();
    let mut keys = Vec::new();
    for row in rows {
        let (key, text) = row.map_err(|error| error.to_string())?;
        match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(value) => {
                games.push(value);
                keys.push(key);
            }
            Err(error) => eprintln!("[棋谱库] 跳过无法解析的一行（{key}）：{error}"),
        }
    }
    Ok(serde_json::json!({
        "version": SCHEMA_VERSION,
        "games": games,
        "keys": keys,
        "folders": read_meta(conn, "folders")?.unwrap_or_else(|| serde_json::json!([])),
        "tags": read_meta(conn, "tags")?.unwrap_or_else(|| serde_json::json!([])),
        "settings": read_meta(conn, "settings")?.unwrap_or(serde_json::Value::Null),
    }))
}

/// 老版本是把整个棋谱库序列化成一个 library.json 覆盖写盘。首次打开新版本时把它搬进
/// 数据库，原文件改名留档而不是删除：迁移万一有偏差，用户的原始数据还在原地。
fn import_legacy_library(
    app: &AppHandle,
    conn: &mut Connection,
) -> Result<Option<serde_json::Value>, String> {
    let path = library_path(app)?;
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|error| format!("读取旧棋谱库失败：{error}"))?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    let snapshot: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => {
            // 解析不了就别动它，留给用户自己查看。此时界面按「没有本地棋谱库」处理，
            // 内存里从浏览器带来的棋谱仍会写进新库，不至于白丢。
            eprintln!("[棋谱库] library.json 无法解析，保留原文件待查：{error}");
            return Ok(None);
        }
    };
    let games = snapshot
        .get("games")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    if games.is_empty() {
        return Ok(None);
    }

    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    for (index, game) in games.iter().enumerate() {
        let payload = serde_json::to_string(game).map_err(|error| error.to_string())?;
        upsert_game(&transaction, &game_key(game, index), index as i64, &payload)?;
    }
    for key in ["folders", "tags", "settings"] {
        if let Some(value) = snapshot.get(key) {
            if !value.is_null() {
                write_meta(&transaction, key, value)?;
            }
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    let archived = path.with_file_name(format!("library.json.imported-{stamp}"));
    match fs::rename(&path, &archived) {
        Ok(()) => eprintln!(
            "[棋谱库] 已迁移 {} 局到数据库，原文件留档为 {}",
            games.len(),
            archived.to_string_lossy()
        ),
        Err(error) => eprintln!("[棋谱库] 迁移完成，但旧文件改名失败：{error}"),
    }
    Ok(Some(read_snapshot(conn)?))
}

// ---------------------------------------------------------------------------
// 棋谱库读写：数据存在应用数据目录，卸载/清缓存都不会动它
// ---------------------------------------------------------------------------

/// 前端提交的增量改动。只带真正变过的棋谱——把整库序列化一遍再写盘，正是这套存储
/// 要替掉的做法：改一个收藏不该牵动几千局棋。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameUpsert {
    /// 前端算好的主键（棋谱 id 的 JSON 原文）。跨语言各自拼数字容易出偏差，交给前端更稳。
    key: String,
    /// 在完整列表里的位置，用来还原顺序
    index: i64,
    game: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryChange {
    #[serde(default)]
    upserts: Vec<GameUpsert>,
    /// 已移出棋谱库的主键
    #[serde(default)]
    removed: Vec<String>,
    folders: Option<serde_json::Value>,
    tags: Option<serde_json::Value>,
    settings: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncReport {
    written: usize,
    skipped: usize,
    removed: usize,
}

#[tauri::command]
fn library_load(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let mut conn = connection(&app)?;
    let stored: i64 = conn
        .query_row("SELECT COUNT(*) FROM games", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if stored == 0 {
        if let Some(snapshot) = import_legacy_library(&app, &mut conn)? {
            return Ok(Some(snapshot));
        }
    }
    let snapshot = read_snapshot(&conn)?;
    // 棋谱、分类、标签、设置全空才算首次运行，此时交给前端写入初始数据
    let empty = |value: &serde_json::Value| {
        value.as_array().map(|list| list.is_empty()).unwrap_or(true)
    };
    if empty(&snapshot["games"])
        && empty(&snapshot["folders"])
        && empty(&snapshot["tags"])
        && snapshot["settings"].is_null()
    {
        return Ok(None);
    }
    Ok(Some(snapshot))
}

#[tauri::command]
fn library_sync(app: AppHandle, change: LibraryChange) -> Result<SyncReport, String> {
    let mut conn = connection(&app)?;
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    let mut written = 0;
    let mut skipped = 0;
    for entry in &change.upserts {
        let payload = serde_json::to_string(&entry.game).map_err(|error| error.to_string())?;
        if upsert_game(&transaction, &entry.key, entry.index, &payload)? {
            written += 1;
        } else {
            skipped += 1;
        }
    }
    let mut removed = 0;
    for key in &change.removed {
        removed += transaction
            .execute("DELETE FROM games WHERE game_key=?1", [key])
            .map_err(|error| error.to_string())?;
    }
    if let Some(value) = &change.folders {
        write_meta(&transaction, "folders", value)?;
    }
    if let Some(value) = &change.tags {
        write_meta(&transaction, "tags", value)?;
    }
    if let Some(value) = &change.settings {
        write_meta(&transaction, "settings", value)?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(SyncReport {
        written,
        skipped,
        removed,
    })
}

/// 棋谱名会直接变成文件名，路径分隔符与 Windows 保留字符必须剔掉：
/// 留着 `..\` 或者 `*` 轻则写不进去，重则落到别的目录。
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            ch if (ch as u32) < 0x20 => '_',
            ch => ch,
        })
        .collect();
    // 顺带挡掉 Windows 不接受的结尾点号，以及过长名字
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let stem: String = trimmed.chars().take(80).collect();
    let stem = stem.trim().trim_matches('.').trim();
    if stem.is_empty() {
        "yijing-game.sgf".to_string()
    } else if stem.to_lowercase().ends_with(".sgf") {
        stem.to_string()
    } else {
        format!("{stem}.sgf")
    }
}

/// 重名时追加 -1、-2 序号，绝不静默覆盖用户已有的棋谱。
fn unique_path(directory: &Path, filename: &str) -> PathBuf {
    let candidate = directory.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let stem = candidate
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("yijing-game");
    let extension = candidate
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("sgf");
    for index in 1..1000 {
        let next = directory.join(format!("{stem}-{index}.{extension}"));
        if !next.exists() {
            return next;
        }
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    directory.join(format!("{stem}-{stamp}.{extension}"))
}

/// 导出 SGF 到系统的「下载」目录，并把完整路径回报给界面。
/// 桌面版不能依赖浏览器的 <a download>：WebView2 的下载行为受策略影响，
/// 用户也无从知道文件存到哪去了。
#[tauri::command]
fn export_sgf(app: AppHandle, filename: String, content: String) -> Result<String, String> {
    let directory = app
        .path()
        .download_dir()
        .or_else(|_| app.path().document_dir())
        .map_err(|error| format!("找不到可写入的目录：{error}"))?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建导出目录：{error}"))?;
    let path = unique_path(&directory, &sanitize_filename(&filename));
    fs::write(&path, content).map_err(|error| format!("写入 SGF 失败：{error}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 前端把关键节点与异常写进应用数据目录的 yijing.log。
/// 发布版没有控制台，出问题时这是唯一的现场记录。
#[tauri::command]
fn log_line(app: AppHandle, text: String) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("yijing.log");
    // 单文件上限约 1MB，超了就从头来过，避免无限增长
    if path.metadata().map(|meta| meta.len() > 1_048_576).unwrap_or(false) {
        let _ = fs::remove_file(&path);
    }
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("无法写入日志：{error}"))?;
    writeln!(file, "[{elapsed}] {text}").map_err(|error| error.to_string())?;
    Ok(())
}

/// 在系统文件管理器里打开数据目录，方便用户备份棋谱库。
#[tauri::command]
fn open_data_folder(app: AppHandle) -> Result<(), String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer");
        command.arg(&directory);
        command.creation_flags(0x08000000);
        command
            .spawn()
            .map_err(|error| format!("无法打开数据目录：{error}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("xdg-open")
            .arg(&directory)
            .spawn()
            .map_err(|error| format!("无法打开数据目录：{error}"))?;
    }
    Ok(())
}

/// 前端在空闲时调用，提前把模型装进显存，免得第一次分析干等一分钟。
#[tauri::command]
async fn warmup_engine(state: State<'_, Arc<KataGoRuntime>>) -> Result<serde_json::Value, String> {
    let runtime = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.ensure_started()?;
        Ok(runtime.status())
    })
    .await
    .map_err(|error| format!("预热任务异常：{error}"))?
}

#[tauri::command]
fn katago_status(state: State<'_, Arc<KataGoRuntime>>) -> serde_json::Value {
    state.status()
}

#[tauri::command]
fn set_window_title(window: tauri::Window, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|error| error.to_string())
}

#[tauri::command]
async fn analyze_position(
    state: State<'_, Arc<KataGoRuntime>>,
    request: AnalysisRequest,
) -> Result<Vec<serde_json::Value>, String> {
    let runtime = state.inner().clone();
    // spawn_blocking：分析动辄数十秒，必须离开异步运行时线程
    tauri::async_runtime::spawn_blocking(move || runtime.analyze(request))
        .await
        .map_err(|error| format!("分析任务异常：{error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();
            let config = resolve_engine_config(&handle);
            let runtime = Arc::new(KataGoRuntime::new(config));
            app.manage(runtime);

            // 注：WebView2 的启动参数在 tauri.conf.json 的 additionalBrowserArgs 里。
            // 其中的 --no-sandbox 不是可选项：缺了它，在远程桌面或受限会话下
            // 客户区会整片黑屏——窗口、标题栏都正常，唯独网页内容画不出来。
            Ok(())
        })
        // 窗口关闭时主动回收引擎，否则 Windows 上会残留一个 katago.exe 占着显存
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(runtime) = window.app_handle().try_state::<Arc<KataGoRuntime>>() {
                    runtime.shutdown();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            katago_status,
            warmup_engine,
            analyze_position,
            library_load,
            library_sync,
            export_sgf,
            open_data_folder,
            set_window_title,
            log_line
        ])
        .run(tauri::generate_context!())
        .expect("运行弈境桌面应用失败");
}

#[cfg(test)]
mod tests {
    use super::{
        derive_from_directory, game_key, json_string, migrate, read_meta, read_snapshot,
        sanitize_filename, unique_path, upsert_game, write_meta,
    };
    use rusqlite::Connection;
    use serde_json::json;

    fn scratch() -> Connection {
        let conn = Connection::open_in_memory().expect("内存库应能打开");
        migrate(&conn).expect("建表应成功");
        conn
    }

    #[test]
    fn json_string_accepts_aliases_and_skips_blanks() {
        let value = json!({ "exe": "  ", "katago": "C:/k/katago.exe" });
        assert_eq!(
            json_string(&value, &["executable", "exe", "katago"]).as_deref(),
            Some("C:/k/katago.exe")
        );
    }

    #[test]
    fn derive_from_directory_handles_missing_folder() {
        assert!(derive_from_directory(r"Z:\definitely-not-here").is_none());
    }

    #[test]
    fn migrate_is_idempotent_and_sets_version() {
        let conn = scratch();
        // 再跑一次不该报错，也不该把已有数据清掉
        upsert_game(&conn, "1", 0, r#"{"id":1}"#).expect("写入应成功");
        migrate(&conn).expect("重复建表应成功");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM games", [], |row| row.get(0))
            .expect("应能统计");
        assert_eq!(count, 1, "重复迁移不能清掉数据");
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("应能读版本");
        assert_eq!(version, super::SCHEMA_VERSION);
    }

    #[test]
    fn game_key_keeps_numbers_and_strings_apart() {
        assert_eq!(game_key(&json!({ "id": 7 }), 0), "7");
        assert_eq!(game_key(&json!({ "id": "7" }), 0), "\"7\"");
        assert_ne!(
            game_key(&json!({ "id": 7 }), 0),
            game_key(&json!({ "id": "7" }), 0),
            "数字 7 与字符串 \"7\" 不能是同一局"
        );
        assert_eq!(game_key(&json!({}), 3), "\"#index-3\"");
        assert_eq!(game_key(&json!({ "id": null }), 1), "\"#index-1\"");
    }

    #[test]
    fn upsert_skips_unchanged_payload() {
        let conn = scratch();
        assert!(upsert_game(&conn, "1", 0, r#"{"id":1,"title":"甲"}"#).expect("首次写入"));
        assert!(
            !upsert_game(&conn, "1", 0, r#"{"id":1,"title":"甲"}"#).expect("重复写入"),
            "内容一致时不该再写一次"
        );
        assert!(upsert_game(&conn, "1", 0, r#"{"id":1,"title":"乙"}"#).expect("内容变了要写"));
        assert!(upsert_game(&conn, "", 0, "{}").is_err(), "没有主键应拒绝");
    }

    #[test]
    fn snapshot_keeps_order_and_meta() {
        let conn = scratch();
        // 故意乱序写入：读回来必须按 position 排
        upsert_game(&conn, "b", 1, r#"{"id":"b","title":"第二"}"#).expect("写入");
        upsert_game(&conn, "a", 0, r#"{"id":"a","title":"第一"}"#).expect("写入");
        write_meta(&conn, "settings", &json!({ "volume": 0.3 })).expect("写设置");
        write_meta(&conn, "settings", &json!({ "volume": 0.8 })).expect("覆盖设置");

        let snapshot = read_snapshot(&conn).expect("应能读出快照");
        assert_eq!(snapshot["games"][0]["title"], "第一");
        assert_eq!(snapshot["games"][1]["title"], "第二");
        // 主键要和棋谱一一对应：前端靠它认身份，错位就会更新到别的棋谱上
        assert_eq!(snapshot["keys"][0], "a");
        assert_eq!(snapshot["keys"][1], "b");
        assert_eq!(
            snapshot["keys"].as_array().unwrap().len(),
            snapshot["games"].as_array().unwrap().len()
        );
        assert_eq!(read_meta(&conn, "settings").unwrap().unwrap()["volume"], 0.8);
        assert!(read_meta(&conn, "tags").unwrap().is_none());
    }

    #[test]
    fn snapshot_survives_one_broken_row() {
        let conn = scratch();
        upsert_game(&conn, "ok", 0, r#"{"id":"ok"}"#).expect("写入");
        conn.execute(
            "INSERT INTO games(game_key,position,payload,digest) VALUES ('bad',1,'{不是 JSON','x')",
            [],
        )
        .expect("直接塞进一行坏数据");
        let snapshot = read_snapshot(&conn).expect("坏一行不该让整库读不出来");
        assert_eq!(snapshot["games"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["games"][0]["id"], "ok");
        assert_eq!(snapshot["keys"], serde_json::json!(["ok"]), "跳过的行不能留下孤立的键");
    }

    #[test]
    fn removes_absent_games_only() {
        let conn = scratch();
        upsert_game(&conn, "keep", 0, r#"{"id":"keep"}"#).expect("写入");
        upsert_game(&conn, "drop", 1, r#"{"id":"drop"}"#).expect("写入");
        conn.execute("DELETE FROM games WHERE game_key=?1", ["drop"])
            .expect("删除");
        let snapshot = read_snapshot(&conn).expect("读快照");
        assert_eq!(snapshot["games"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["games"][0]["id"], "keep");
    }

    #[test]
    fn sanitize_filename_strips_paths_and_normalises_extension() {
        assert_eq!(sanitize_filename("当湖十局 · 第 1 局"), "当湖十局 · 第 1 局.sgf");
        assert_eq!(sanitize_filename("a/b\\c:d*e?f"), "a_b_c_d_e_f.sgf");
        assert_eq!(sanitize_filename("已有后缀.SGF"), "已有后缀.SGF");
        assert_eq!(sanitize_filename("   "), "yijing-game.sgf");
        assert_eq!(sanitize_filename(""), "yijing-game.sgf");
        assert_eq!(sanitize_filename("..."), "yijing-game.sgf");
        // 超长名字要截断，否则 Windows 上会因为路径过长直接写不进去
        assert!(sanitize_filename(&"长".repeat(300)).chars().count() <= 84);
    }

    #[test]
    fn sanitize_filename_cannot_escape_the_target_folder() {
        // 这类名字的要害不是「好不好看」，而是不能还留着分隔符或前导点，
        // 否则拼进目录就可能落到别处去。
        for name in [
            r"..\..\windows",
            "../../etc/passwd",
            r"..\..\..\Users\me\.ssh\authorized_keys",
            "/absolute/path.sgf",
            "C:\\Windows\\System32\\evil",
            "....//....//x",
        ] {
            let cleaned = sanitize_filename(name);
            assert!(!cleaned.contains('/'), "{name} → {cleaned} 仍含 /");
            assert!(!cleaned.contains('\\'), "{name} → {cleaned} 仍含 \\");
            assert!(!cleaned.starts_with('.'), "{name} → {cleaned} 仍以点开头");
            assert!(cleaned.ends_with(".sgf"), "{name} → {cleaned} 后缀不对");
            assert!(!cleaned.contains(':'), "{name} → {cleaned} 仍含盘符冒号");
            assert_eq!(
                std::path::Path::new(&cleaned).components().count(),
                1,
                "{name} → {cleaned} 不该是多段路径"
            );
        }
    }

    #[test]
    fn unique_path_never_overwrites() {
        let directory = std::env::temp_dir().join("yijing-unique-path-test");
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("建临时目录");
        let first = unique_path(&directory, "对局.sgf");
        assert_eq!(first.file_name().unwrap(), "对局.sgf");
        std::fs::write(&first, b"(;)").expect("占位");
        let second = unique_path(&directory, "对局.sgf");
        assert_eq!(second.file_name().unwrap(), "对局-1.sgf");
        std::fs::write(&second, b"(;)").expect("占位");
        assert_eq!(
            unique_path(&directory, "对局.sgf").file_name().unwrap(),
            "对局-2.sgf"
        );
        let _ = std::fs::remove_dir_all(&directory);
    }
}
