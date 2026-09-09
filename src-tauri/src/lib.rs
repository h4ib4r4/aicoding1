use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, State};

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

#[derive(Debug, Deserialize, Serialize)]
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
    analyze_turns: Vec<u32>,
    max_visits: Option<u32>,
}

struct EngineProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Drop for EngineProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

struct KataGoState {
    process: Mutex<Option<EngineProcess>>,
    executable: String,
    model: String,
    config: String,
    data_dir: PathBuf,
}

fn coords_to_gtp(x: u8, y: u8) -> Result<String, String> {
    const LETTERS: &[u8] = b"ABCDEFGHJKLMNOPQRSTUVWXYZ";
    if x >= 19 || y >= 19 {
        return Err("棋盘坐标超出范围".into());
    }
    Ok(format!("{}{}", LETTERS[x as usize] as char, 19 - y))
}

fn start_katago(state: &KataGoState) -> Result<EngineProcess, String> {
    fs::create_dir_all(&state.data_dir).map_err(|error| error.to_string())?;
    let data_dir = state.data_dir.to_string_lossy().replace('\\', "/");
    let mut child = Command::new(&state.executable)
        .args([
            "analysis",
            "-model",
            &state.model,
            "-config",
            &state.config,
            "-override-config",
            &format!("homeDataDir={data_dir},logDir={data_dir}/logs"),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|error| format!("无法启动 KataGo：{error}"))?;
    let stdin = child.stdin.take().ok_or("无法连接 KataGo 输入")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("无法连接 KataGo 输出")?);
    Ok(EngineProcess {
        child,
        stdin,
        stdout,
    })
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

#[tauri::command]
fn katago_status() -> serde_json::Value {
    let executable = std::env::var("KATAGO_EXE")
        .unwrap_or_else(|_| r"G:\Edge_download\KataGo\katago.exe".into());
    let model = std::env::var("KATAGO_MODEL").unwrap_or_else(|_| {
        r"G:\Edge_download\KataGo\kata1-tf3-b11c768-s11001M-d5973M.bin.gz".into()
    });
    serde_json::json!({ "ready": PathBuf::from(&executable).exists() && PathBuf::from(&model).exists(), "backend": "TensorRT / CUDA", "executable": executable, "model": model })
}

#[tauri::command]
fn analyze_position(
    state: State<'_, KataGoState>,
    request: AnalysisRequest,
) -> Result<Vec<serde_json::Value>, String> {
    if request.analyze_turns.is_empty() {
        return Err("未指定分析手数".into());
    }
    let moves = request
        .moves
        .iter()
        .map(|item| {
            let point = if item.pass.unwrap_or(false) {
                "pass".into()
            } else {
                coords_to_gtp(
                    item.x.ok_or("着法缺少横坐标")?,
                    item.y.ok_or("着法缺少纵坐标")?,
                )?
            };
            Ok(serde_json::json!([item.color, point]))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let id = format!(
        "tauri-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis()
    );
    let query = serde_json::json!({
        "id": id,
        "moves": moves,
        "rules": "chinese",
        "komi": 7.5,
        "boardXSize": 19,
        "boardYSize": 19,
        "analyzeTurns": request.analyze_turns,
        "maxVisits": request.max_visits.unwrap_or(64).clamp(1, 500),
        "includePolicy": true
    });
    let mut guard = state.process.lock().map_err(|_| "KataGo 状态锁定失败")?;
    if guard.is_none() {
        *guard = Some(start_katago(&state)?);
    }
    let process = guard.as_mut().ok_or("KataGo 尚未启动")?;
    writeln!(process.stdin, "{}", query).map_err(|error| format!("发送分析请求失败：{error}"))?;
    process.stdin.flush().map_err(|error| error.to_string())?;
    let expected = request.analyze_turns.len();
    let mut results = Vec::with_capacity(expected);
    while results.len() < expected {
        let mut line = String::new();
        if process
            .stdout
            .read_line(&mut line)
            .map_err(|error| error.to_string())?
            == 0
        {
            *guard = None;
            return Err("KataGo 意外退出".into());
        }
        let value: serde_json::Value = serde_json::from_str(line.trim())
            .map_err(|error| format!("KataGo 返回格式错误：{error}"))?;
        if value.get("id").and_then(|value| value.as_str()) != Some(id.as_str()) {
            continue;
        }
        if let Some(error) = value.get("error").and_then(|value| value.as_str()) {
            return Err(error.into());
        }
        results.push(value);
    }
    results.sort_by_key(|value| {
        value
            .get("turnNumber")
            .and_then(|turn| turn.as_u64())
            .unwrap_or(0)
    });
    Ok(results)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let executable = std::env::var("KATAGO_EXE")
        .unwrap_or_else(|_| r"G:\Edge_download\KataGo\katago.exe".into());
    let model = std::env::var("KATAGO_MODEL").unwrap_or_else(|_| {
        r"G:\Edge_download\KataGo\kata1-tf3-b11c768-s11001M-d5973M.bin.gz".into()
    });
    let config = std::env::var("KATAGO_CONFIG")
        .unwrap_or_else(|_| r"G:\Edge_download\KataGo\analysis_example.cfg".into());
    tauri::Builder::default()
        .setup(move |app| {
            initialize_database(&app.handle())?;
            let data_dir = app
                .path()
                .app_cache_dir()
                .map_err(|error| error.to_string())?
                .join("katago");
            app.manage(KataGoState {
                process: Mutex::new(None),
                executable,
                model,
                config,
                data_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_games,
            list_folders,
            create_folder,
            update_game,
            import_sgf,
            katago_status,
            analyze_position
        ])
        .run(tauri::generate_context!())
        .expect("运行弈境桌面应用失败");
}

#[cfg(test)]
mod tests {
    use super::sgf_property;

    #[test]
    fn reads_sgf_metadata() {
        let sgf = "(;GM[1]GN[测试棋谱]PB[黑方]PW[白方];B[pd])";
        assert_eq!(sgf_property(sgf, "GN"), "测试棋谱");
        assert_eq!(sgf_property(sgf, "PB"), "黑方");
    }
}
