use regex::Regex;
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GameRecord {
    id: i64,
    title: String,
    folder_id: Option<i64>,
    black_player: String,
    white_player: String,
    event: String,
    played_at: String,
    result: String,
    move_count: i64,
    deleted: bool,
}

#[derive(Debug, Serialize)]
struct FolderRecord {
    id: i64,
    name: String,
    game_count: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameUpdate {
    id: i64,
    title: String,
    folder_id: Option<i64>,
}

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
// 本地棋谱库存储（应用数据目录，随应用走，与浏览器缓存无关）
// ---------------------------------------------------------------------------

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

fn connection(app: &AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(database_path(app)?).map_err(|error| error.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| error.to_string())?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS folders (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           name TEXT NOT NULL UNIQUE,
           created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         CREATE TABLE IF NOT EXISTS games (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           title TEXT NOT NULL,
           folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
           source_path TEXT NOT NULL,
           content_hash TEXT NOT NULL UNIQUE,
           sgf TEXT NOT NULL,
           black_player TEXT NOT NULL DEFAULT '',
           white_player TEXT NOT NULL DEFAULT '',
           event TEXT NOT NULL DEFAULT '',
           played_at TEXT NOT NULL DEFAULT '',
           result TEXT NOT NULL DEFAULT '',
           move_count INTEGER NOT NULL DEFAULT 0,
           deleted INTEGER NOT NULL DEFAULT 0,
           created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         CREATE INDEX IF NOT EXISTS idx_games_folder ON games(folder_id, deleted);
         CREATE INDEX IF NOT EXISTS idx_games_players ON games(black_player, white_player);
         CREATE VIRTUAL TABLE IF NOT EXISTS game_search USING fts5(title, black_player, white_player, event, sgf);"
    ).map_err(|error| error.to_string())?;
    Ok(conn)
}

fn sgf_property(sgf: &str, key: &str) -> String {
    let pattern = format!(r"{}\[((?:\\.|[^\]])*)\]", regex::escape(key));
    Regex::new(&pattern)
        .ok()
        .and_then(|regex| regex.captures(sgf))
        .and_then(|capture| capture.get(1))
        .map(|value| value.as_str().replace("\\]", "]").replace("\\\\", "\\"))
        .unwrap_or_default()
}

fn initialize_database(app: &AppHandle) -> Result<(), String> {
    let conn = connection(app)?;
    conn.execute(
        "INSERT OR IGNORE INTO folders(name) VALUES ('我的对局'), ('职业棋谱')",
        [],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_games(
    app: AppHandle,
    folder_id: Option<i64>,
    search: Option<String>,
) -> Result<Vec<GameRecord>, String> {
    let conn = connection(&app)?;
    let pattern = format!("%{}%", search.unwrap_or_default());
    let mut statement = conn.prepare(
        "SELECT id,title,folder_id,black_player,white_player,event,played_at,result,move_count,deleted
         FROM games WHERE (?1 IS NULL OR folder_id=?1) AND (title LIKE ?2 OR black_player LIKE ?2 OR white_player LIKE ?2 OR event LIKE ?2)
         ORDER BY updated_at DESC"
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![folder_id, pattern], |row| {
            Ok(GameRecord {
                id: row.get(0)?,
                title: row.get(1)?,
                folder_id: row.get(2)?,
                black_player: row.get(3)?,
                white_player: row.get(4)?,
                event: row.get(5)?,
                played_at: row.get(6)?,
                result: row.get(7)?,
                move_count: row.get(8)?,
                deleted: row.get::<_, i64>(9)? != 0,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_folders(app: AppHandle) -> Result<Vec<FolderRecord>, String> {
    let conn = connection(&app)?;
    let mut statement = conn.prepare(
        "SELECT f.id,f.name,COUNT(g.id) FROM folders f LEFT JOIN games g ON g.folder_id=f.id AND g.deleted=0 GROUP BY f.id ORDER BY f.id"
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(FolderRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                game_count: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn create_folder(app: AppHandle, name: String) -> Result<i64, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 40 {
        return Err("文件夹名称长度应为 1–40 个字符".into());
    }
    let conn = connection(&app)?;
    conn.execute("INSERT INTO folders(name) VALUES (?1)", [name])
        .map_err(|error| error.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
fn update_game(app: AppHandle, update: GameUpdate) -> Result<(), String> {
    let title = update.title.trim();
    if title.is_empty() || title.chars().count() > 120 {
        return Err("棋谱名称长度应为 1–120 个字符".into());
    }
    let conn = connection(&app)?;
    let changed = conn
        .execute(
            "UPDATE games SET title=?1,folder_id=?2,updated_at=CURRENT_TIMESTAMP WHERE id=?3",
            params![title, update.folder_id, update.id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("棋谱不存在".into());
    }
    Ok(())
}

#[tauri::command]
fn import_sgf(
    app: AppHandle,
    path: String,
    title: Option<String>,
    folder_id: Option<i64>,
) -> Result<i64, String> {
    let sgf = fs::read_to_string(&path).map_err(|error| format!("读取 SGF 失败：{error}"))?;
    if !sgf.trim_start().starts_with("(;") {
        return Err("不是有效的 SGF 文件".into());
    }
    let hash = format!("{:x}", Sha256::digest(sgf.as_bytes()));
    let conn = connection(&app)?;
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM games WHERE content_hash=?1",
            [&hash],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
    {
        return Ok(id);
    }
    let fallback = PathBuf::from(&path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("导入的棋谱")
        .to_string();
    let resolved_title = title
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            let name = sgf_property(&sgf, "GN");
            if name.is_empty() {
                let event = sgf_property(&sgf, "EV");
                if event.is_empty() {
                    fallback
                } else {
                    event
                }
            } else {
                name
            }
        });
    let black = sgf_property(&sgf, "PB");
    let white = sgf_property(&sgf, "PW");
    let event = sgf_property(&sgf, "EV");
    let played_at = sgf_property(&sgf, "DT");
    let result = sgf_property(&sgf, "RE");
    let move_count = Regex::new(r";(?:B|W)\[[^\]]*\]")
        .unwrap()
        .find_iter(&sgf)
        .count() as i64;
    conn.execute("INSERT INTO games(title,folder_id,source_path,content_hash,sgf,black_player,white_player,event,played_at,result,move_count) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![resolved_title,folder_id,path,hash,sgf,black,white,event,played_at,result,move_count]).map_err(|error| error.to_string())?;
    let id = conn.last_insert_rowid();
    conn.execute("INSERT INTO game_search(rowid,title,black_player,white_player,event,sgf) VALUES (?1,?2,?3,?4,?5,?6)", params![id,resolved_title,black,white,event,sgf]).map_err(|error| error.to_string())?;
    Ok(id)
}

// ---------------------------------------------------------------------------
// 棋谱库读写：数据存在应用数据目录，卸载/清缓存都不会动它
// ---------------------------------------------------------------------------

#[tauri::command]
fn library_load(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = library_path(&app)?;
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|error| format!("读取本地棋谱库失败：{error}"))?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    match serde_json::from_str(&text) {
        Ok(value) => Ok(Some(value)),
        Err(_) => {
            // 文件损坏时保留现场，避免用户数据被悄悄覆盖
            let broken = path.with_extension("json.broken");
            let _ = fs::rename(&path, &broken);
            Err(format!(
                "本地棋谱库文件无法解析，已改名为 {}，将重新开始",
                broken.to_string_lossy()
            ))
        }
    }
}

#[tauri::command]
fn library_save(app: AppHandle, data: serde_json::Value) -> Result<(), String> {
    let path = library_path(&app)?;
    let temp = path.with_extension("json.tmp");
    let text = serde_json::to_string(&data).map_err(|error| error.to_string())?;
    fs::write(&temp, text).map_err(|error| format!("写入本地棋谱库失败：{error}"))?;
    if path.is_file() {
        let _ = fs::copy(&path, path.with_extension("json.bak"));
        fs::remove_file(&path).map_err(|error| format!("替换本地棋谱库失败：{error}"))?;
    }
    fs::rename(&temp, &path).map_err(|error| format!("保存本地棋谱库失败：{error}"))?;
    Ok(())
}

#[tauri::command]
fn library_location(app: AppHandle) -> Result<String, String> {
    Ok(library_path(&app)?.to_string_lossy().to_string())
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
            initialize_database(&handle)?;
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
            list_games,
            list_folders,
            create_folder,
            update_game,
            import_sgf,
            katago_status,
            warmup_engine,
            analyze_position,
            library_load,
            library_save,
            library_location,
            open_data_folder,
            set_window_title,
            log_line
        ])
        .run(tauri::generate_context!())
        .expect("运行弈境桌面应用失败");
}

#[cfg(test)]
mod tests {
    use super::{derive_from_directory, json_string, sgf_property};

    #[test]
    fn reads_sgf_metadata() {
        let sgf = "(;GM[1]GN[测试棋谱]PB[黑方]PW[白方];B[pd])";
        assert_eq!(sgf_property(sgf, "GN"), "测试棋谱");
        assert_eq!(sgf_property(sgf, "PB"), "黑方");
    }

    #[test]
    fn json_string_accepts_aliases_and_skips_blanks() {
        let value = serde_json::json!({ "exe": "  ", "katago": "C:/k/katago.exe" });
        assert_eq!(
            json_string(&value, &["executable", "exe", "katago"]).as_deref(),
            Some("C:/k/katago.exe")
        );
    }

    #[test]
    fn derive_from_directory_handles_missing_folder() {
        assert!(derive_from_directory(r"Z:\definitely-not-here").is_none());
    }
}
