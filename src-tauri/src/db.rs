use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use crate::security;
use chrono::Local;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub version: u32,
    #[serde(default)]
    pub meta: Option<Value>,
    #[serde(default)]
    pub tasks: Vec<Value>,
    #[serde(default)]
    pub goals: Vec<Value>,
    #[serde(default)]
    pub categories: Vec<Value>,
    #[serde(default)]
    pub settings: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextFilePayload {
    pub path: String,
    pub contents: String,
}

pub struct DbState {
    pub conn: Mutex<Connection>,
    pub data_dir: PathBuf,
    pub _db_path: PathBuf,
}

pub fn init(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    fs::create_dir_all(&data_dir)?;
    fs::create_dir_all(data_dir.join("backups"))?;
    fs::create_dir_all(data_dir.join("logs"))?;

    let db_path = data_dir.join("daynora.db");
    let conn = Connection::open(&db_path)?;
    migrate_database(&conn, &data_dir.join("backups"))?;

    app.manage(DbState {
        conn: Mutex::new(conn),
        data_dir,
        _db_path: db_path,
    });

    let _ = daily_backup(app);
    Ok(())
}

/// 当前数据库结构版本。每次改表都要 +1，并在 migrate_database 里补上幂等的追赶步骤。
const SCHEMA_VERSION: i32 = 5;
/// AI 文本加密标记：老数据没有该前缀，按明文读取并会在迁移时补齐。
const ENC_PREFIX: &str = "enc:v1:";

fn user_version(conn: &Connection) -> Result<i32, String> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())
}

fn set_user_version(conn: &Connection, version: i32) -> Result<(), String> {
    conn.execute_batch(&format!("PRAGMA user_version = {version}"))
        .map_err(|error| error.to_string())
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![table],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(count > 0)
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let mut rows = stmt.query([]).map_err(|error| error.to_string())?;
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
        let name: String = row.get(1).map_err(|error| error.to_string())?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn vacuum_into(conn: &Connection, path: &PathBuf) -> Result<(), String> {
    let escaped = path.display().to_string().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{escaped}'"))
        .map_err(|error| error.to_string())
}

/// 版本化迁移：升级前自动做一次文件级备份，方便回滚。
/// 步骤都写成幂等的“追赶式”，既能升级老库，也能直接初始化新库。
fn migrate_database(conn: &Connection, backup_dir: &PathBuf) -> Result<(), String> {
    let current = user_version(conn)?;
    let has_tasks = table_exists(conn, "tasks")?;
    if current >= SCHEMA_VERSION {
        return Ok(());
    }

    if has_tasks {
        let _ = fs::create_dir_all(backup_dir);
        let stamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
        let path = backup_dir.join(format!("daynora-pre-migration-v{current}-{stamp}.db"));
        let _ = vacuum_into(conn, &path);
        let _ = prune_backups(backup_dir, BACKUP_KEEP);
    }

    // v1：基线结构（全部 IF NOT EXISTS，老库重复执行也安全）
    conn.execute_batch(SCHEMA_SQL)
        .map_err(|error| error.to_string())?;

    // v2：会话列 + 历史消息归入“历史对话”
    if !column_exists(conn, "ai_messages", "conversation_id")? {
        conn.execute_batch(
            "ALTER TABLE ai_messages ADD COLUMN conversation_id TEXT NOT NULL DEFAULT ''",
        )
        .map_err(|error| error.to_string())?;
    }
    migrate_ai_conversations(conn)?;

    // v3：AI 快照 / 通用键值 / 撤销栈由 SCHEMA_SQL 建表，无需额外步骤。

    // v4：消息支持图片附件（加密后存 base64）
    if !column_exists(conn, "ai_messages", "image")? {
        conn.execute_batch("ALTER TABLE ai_messages ADD COLUMN image TEXT NOT NULL DEFAULT ''")
            .map_err(|error| error.to_string())?;
    }

    // v5：图片附件的文件名（明文，仅供界面展示）
    if !column_exists(conn, "ai_messages", "image_name")? {
        conn.execute_batch(
            "ALTER TABLE ai_messages ADD COLUMN image_name TEXT NOT NULL DEFAULT ''",
        )
        .map_err(|error| error.to_string())?;
    }

    // 老版本的历史消息/会话标题是明文，这里统一补成加密存储。
    encrypt_legacy_ai_text(conn)?;

    set_user_version(conn, SCHEMA_VERSION)?;
    Ok(())
}

/// 把早期版本写入的明文 AI 文本补成加密存储（幂等）。
fn encrypt_legacy_ai_text(conn: &Connection) -> Result<(), String> {
    let mut message_rows: Vec<(i64, String, String)> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT id, content, image FROM ai_messages
                 WHERE content <> '' OR image <> ''",
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (id, content, image) = row.map_err(|error| error.to_string())?;
            if !content.starts_with(ENC_PREFIX) || !image.starts_with(ENC_PREFIX) {
                message_rows.push((id, content, image));
            }
        }
    }
    for (id, content, image) in message_rows {
        let encrypted_content = encrypt_text(&content)?;
        let encrypted_image = encrypt_text(&image)?;
        conn.execute(
            "UPDATE ai_messages SET content = ?1, image = ?2 WHERE id = ?3",
            params![encrypted_content, encrypted_image, id],
        )
        .map_err(|error| error.to_string())?;
    }

    let mut title_rows: Vec<(String, String)> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, title FROM ai_conversations WHERE title <> ''")
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (id, title) = row.map_err(|error| error.to_string())?;
            if !title.starts_with(ENC_PREFIX) {
                title_rows.push((id, title));
            }
        }
    }
    for (id, title) in title_rows {
        let encrypted = encrypt_text(&title)?;
        conn.execute(
            "UPDATE ai_conversations SET title = ?1 WHERE id = ?2",
            params![encrypted, id],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 加密任意文本（DPAPI + base64）。空字符串保持为空。
pub(crate) fn encrypt_text(value: &str) -> Result<String, String> {
    if value.is_empty() {
        return Ok(String::new());
    }
    let blob = security::protect(value.as_bytes())?;
    Ok(format!("{ENC_PREFIX}{}", BASE64.encode(blob)))
}

/// 解密文本；没有前缀的老数据按明文返回，解不开则返回空串而不是密文。
pub(crate) fn decrypt_text(value: &str) -> String {
    let Some(encoded) = value.strip_prefix(ENC_PREFIX) else {
        return value.to_string();
    };
    let Ok(blob) = BASE64.decode(encoded) else {
        return String::new();
    };
    let Ok(bytes) = security::unprotect(&blob) else {
        return String::new();
    };
    String::from_utf8(bytes).unwrap_or_default()
}

/// 老版本只有单条会话记录：这里补上 conversation_id 列，并把历史消息挂到一个“历史对话”下。
fn migrate_ai_conversations(conn: &Connection) -> Result<(), String> {
    let mut has_column = false;
    {
        let mut stmt = conn
            .prepare("PRAGMA table_info(ai_messages)")
            .map_err(|error| error.to_string())?;
        let mut rows = stmt.query([]).map_err(|error| error.to_string())?;
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let name: String = row.get(1).map_err(|error| error.to_string())?;
            if name == "conversation_id" {
                has_column = true;
            }
        }
    }
    if !has_column {
        conn.execute_batch(
            "ALTER TABLE ai_messages ADD COLUMN conversation_id TEXT NOT NULL DEFAULT ''",
        )
        .map_err(|error| error.to_string())?;
    }

    let orphans: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM ai_messages WHERE conversation_id = '' OR conversation_id IS NULL",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if orphans == 0 {
        return Ok(());
    }

    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM ai_conversations ORDER BY updated_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let conversation_id = match existing {
        Some(id) => id,
        None => {
            let now = Local::now().to_rfc3339();
            conn.execute(
                "INSERT INTO ai_conversations(id, title, created_at, updated_at) VALUES(?1, ?2, ?3, ?4)",
                params!["conv_legacy", encrypt_text("历史对话")?, now, now],
            )
            .map_err(|error| error.to_string())?;
            "conv_legacy".to_string()
        }
    };
    conn.execute(
        "UPDATE ai_messages SET conversation_id = ?1 WHERE conversation_id = '' OR conversation_id IS NULL",
        params![conversation_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_snapshot(state: State<'_, DbState>) -> Result<Option<Snapshot>, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    load_snapshot_inner(&conn)
}

pub(crate) fn load_snapshot_inner(conn: &Connection) -> Result<Option<Snapshot>, String> {
    if !is_seeded(conn)? {
        return Ok(None);
    }

    let mut tasks = Vec::new();
    let mut task_stmt = conn
        .prepare("SELECT payload FROM tasks ORDER BY date ASC, order_index ASC")
        .map_err(|error| error.to_string())?;
    let task_rows = task_stmt
        .query_map([], |row| {
            let blob: Vec<u8> = row.get(0)?;
            Ok(blob)
        })
        .map_err(|error| error.to_string())?;
    for row in task_rows {
        let blob = row.map_err(|error| error.to_string())?;
        tasks.push(decrypt_json(&blob)?);
    }

    let mut goals = Vec::new();
    let mut goal_stmt = conn
        .prepare("SELECT payload FROM goals")
        .map_err(|error| error.to_string())?;
    let goal_rows = goal_stmt
        .query_map([], |row| {
            let blob: Vec<u8> = row.get(0)?;
            Ok(blob)
        })
        .map_err(|error| error.to_string())?;
    for row in goal_rows {
        let blob = row.map_err(|error| error.to_string())?;
        goals.push(decrypt_json(&blob)?);
    }

    let mut categories = Vec::new();
    let mut category_stmt = conn
        .prepare("SELECT payload FROM categories ORDER BY order_index ASC")
        .map_err(|error| error.to_string())?;
    let category_rows = category_stmt
        .query_map([], |row| {
            let blob: Vec<u8> = row.get(0)?;
            Ok(blob)
        })
        .map_err(|error| error.to_string())?;
    for row in category_rows {
        let blob = row.map_err(|error| error.to_string())?;
        categories.push(decrypt_json(&blob)?);
    }

    let settings: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'settings'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let settings_value = settings
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    let meta: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'snapshot_meta'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let meta_value = meta.and_then(|raw| serde_json::from_str::<Value>(&raw).ok());

    Ok(Some(Snapshot {
        version: 1,
        meta: meta_value,
        tasks,
        goals,
        categories,
        settings: settings_value,
    }))
}

#[tauri::command]
pub fn save_snapshot(state: State<'_, DbState>, data: Snapshot) -> Result<(), String> {
    let mut conn = state.conn.lock().map_err(|error| error.to_string())?;
    save_snapshot_inner(&mut conn, &data)
}

pub(crate) fn save_snapshot_inner(conn: &mut Connection, data: &Snapshot) -> Result<(), String> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;

    tx.execute("DELETE FROM tasks", [])
        .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM goals", [])
        .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM categories", [])
        .map_err(|error| error.to_string())?;

    for (index, task) in data.tasks.iter().enumerate() {
        let id = value_string(task, "id")?;
        let date = value_string(task, "date")?;
        let status = value_string(task, "status")?;
        let updated_at = value_string(task, "updatedAt")?;
        let order_index = task
            .get("order")
            .and_then(Value::as_i64)
            .unwrap_or(index as i64);
        let payload = encrypt_json(task)?;
        tx.execute(
            "INSERT INTO tasks(id, date, status, order_index, updated_at, payload) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, date, status, order_index, updated_at, payload],
        )
        .map_err(|error| error.to_string())?;
    }

    for goal in data.goals.iter() {
        let id = value_string(goal, "id")?;
        let updated_at = value_string(goal, "updatedAt")?;
        let payload = encrypt_json(goal)?;
        tx.execute(
            "INSERT INTO goals(id, updated_at, payload) VALUES(?1, ?2, ?3)",
            params![id, updated_at, payload],
        )
        .map_err(|error| error.to_string())?;
    }

    for (index, category) in data.categories.iter().enumerate() {
        let id = value_string(category, "id")?;
        let order_index = category
            .get("order")
            .and_then(Value::as_i64)
            .unwrap_or(index as i64);
        let payload = encrypt_json(category)?;
        tx.execute(
            "INSERT INTO categories(id, order_index, payload) VALUES(?1, ?2, ?3)",
            params![id, order_index, payload],
        )
        .map_err(|error| error.to_string())?;
    }

    let settings = serde_json::to_string(&data.settings).map_err(|error| error.to_string())?;
    tx.execute(
        "INSERT OR REPLACE INTO settings(key, value) VALUES('settings', ?1)",
        params![settings],
    )
    .map_err(|error| error.to_string())?;

    if let Some(meta) = &data.meta {
        let meta = serde_json::to_string(&meta).map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES('snapshot_meta', ?1)",
            params![meta],
        )
        .map_err(|error| error.to_string())?;
    }

    tx.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES('seeded', '1')",
        [],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn backup_database(state: State<'_, DbState>) -> Result<Option<String>, String> {
    let path = backup_now(state.inner())?;
    Ok(Some(path))
}

#[tauri::command]
pub fn list_backups(state: State<'_, DbState>) -> Result<Vec<String>, String> {
    let backup_dir = state.data_dir.join("backups");
    let mut files = list_backup_files(&backup_dir)?;
    files.sort();
    Ok(files)
}

#[tauri::command]
pub fn save_text_file(default_name: String, contents: String) -> Result<Option<String>, String> {
    let path = rfd::FileDialog::new()
        .set_file_name(&default_name)
        .save_file();
    if let Some(path) = path {
        fs::write(&path, contents).map_err(|error| error.to_string())?;
        return Ok(Some(path.display().to_string()));
    }
    Ok(None)
}

#[tauri::command]
pub fn open_text_file() -> Result<Option<TextFilePayload>, String> {
    let path = rfd::FileDialog::new()
        .add_filter("Daynora data", &["json", "csv", "md", "markdown", "txt"])
        .pick_file();
    if let Some(path) = path {
        let contents = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        return Ok(Some(TextFilePayload {
            path: path.display().to_string(),
            contents,
        }));
    }
    Ok(None)
}

fn is_seeded(conn: &Connection) -> Result<bool, String> {
    let value: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = 'seeded'", [], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(value.as_deref() == Some("1"))
}

fn value_string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("snapshot item is missing string field: {key}"))
}

fn encrypt_json(value: &Value) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    security::protect(&bytes)
}

fn decrypt_json(blob: &[u8]) -> Result<Value, String> {
    let bytes = security::unprotect(blob).unwrap_or_else(|_| blob.to_vec());
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

fn daily_backup(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<DbState>();
    let today = Local::now().format("%Y-%m-%d").to_string();
    let last: Option<String> = {
        let conn = state.conn.lock().map_err(|error| error.to_string())?;
        conn.query_row(
            "SELECT value FROM meta WHERE key = 'last_backup_date'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
    };
    if last.as_deref() == Some(today.as_str()) {
        return Ok(());
    }

    let path = backup_now(state.inner())?;
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES('last_backup_date', ?1)",
        params![today],
    )
    .map_err(|error| error.to_string())?;
    let _ = path;
    Ok(())
}

fn backup_now(state: &DbState) -> Result<String, String> {
    let backup_dir = state.data_dir.join("backups");
    fs::create_dir_all(&backup_dir).map_err(|error| error.to_string())?;
    let stamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let path = backup_dir.join(format!("daynora-{stamp}.db"));

    {
        let conn = state.conn.lock().map_err(|error| error.to_string())?;
        vacuum_into(&conn, &path)?;
    }

    prune_backups(&backup_dir, BACKUP_KEEP)?;
    Ok(path.display().to_string())
}

/// 备份保留数量（简单策略：只按数量裁剪）。
const BACKUP_KEEP: usize = 20;

fn list_backup_files(dir: &PathBuf) -> Result<Vec<String>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) == Some("db") {
            files.push(path.display().to_string());
        }
    }
    Ok(files)
}

fn prune_backups(dir: &PathBuf, keep: usize) -> Result<(), String> {
    let mut files = list_backup_files(dir)?;
    files.sort();
    while files.len() > keep {
        let oldest = files.remove(0);
        let _ = fs::remove_file(oldest);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// AI 数据访问（提供商、对话记录、设置、提醒）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredProvider {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub base_url: String,
    pub model: String,
    pub api_key: Vec<u8>,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) fn list_ai_providers(conn: &Connection) -> Result<Vec<StoredProvider>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, kind, base_url, model, api_key, created_at, updated_at
             FROM ai_providers ORDER BY created_at ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(StoredProvider {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                base_url: row.get(3)?,
                model: row.get(4)?,
                api_key: row.get::<_, Option<Vec<u8>>>(5)?.unwrap_or_default(),
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub(crate) fn upsert_ai_provider(
    conn: &Connection,
    provider: &StoredProvider,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO ai_providers(id, name, kind, base_url, model, api_key, created_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           kind = excluded.kind,
           base_url = excluded.base_url,
           model = excluded.model,
           api_key = excluded.api_key,
           updated_at = excluded.updated_at",
        params![
            provider.id,
            provider.name,
            provider.kind,
            provider.base_url,
            provider.model,
            provider.api_key,
            provider.created_at,
            provider.updated_at
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn delete_ai_provider(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM ai_providers WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn get_ai_setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM ai_settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(crate) fn set_ai_setting(
    conn: &Connection,
    key: &str,
    value: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO ai_settings(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredAiMessage {
    pub id: i64,
    pub role: String,
    pub content: String,
    pub image: String,
    pub image_name: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredConversation {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: i64,
    pub preview: String,
}

pub(crate) fn list_ai_conversations(conn: &Connection) -> Result<Vec<StoredConversation>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.title, c.created_at, c.updated_at,
                    (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id) AS message_count,
                    COALESCE((
                      SELECT m2.content FROM ai_messages m2
                      WHERE m2.conversation_id = c.id AND m2.role = 'user'
                      ORDER BY m2.id ASC LIMIT 1
                    ), '') AS preview
             FROM ai_conversations c
             ORDER BY c.updated_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let preview: String = row.get(5)?;
            Ok(StoredConversation {
                id: row.get(0)?,
                title: decrypt_text(&row.get::<_, String>(1)?),
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                message_count: row.get(4)?,
                preview: truncate_chars(&decrypt_text(&preview), 60),
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub(crate) fn create_ai_conversation(
    conn: &Connection,
    id: &str,
    title: &str,
) -> Result<(), String> {
    let now = Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO ai_conversations(id, title, created_at, updated_at) VALUES(?1, ?2, ?3, ?4)",
        params![id, encrypt_text(title)?, now, now],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn delete_ai_conversation(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM ai_messages WHERE conversation_id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    conn.execute("DELETE FROM ai_conversations WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn rename_ai_conversation(
    conn: &Connection,
    id: &str,
    title: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE ai_conversations SET title = ?1, updated_at = ?2 WHERE id = ?3",
        params![encrypt_text(title)?, Local::now().to_rfc3339(), id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn touch_ai_conversation(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE ai_conversations SET updated_at = ?1 WHERE id = ?2",
        params![Local::now().to_rfc3339(), id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn count_ai_messages(conn: &Connection, conversation_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM ai_messages WHERE conversation_id = ?1",
        params![conversation_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn list_ai_messages(
    conn: &Connection,
    conversation_id: &str,
) -> Result<Vec<StoredAiMessage>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, role, content, image, image_name, created_at FROM ai_messages
             WHERE conversation_id = ?1 ORDER BY id ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params![conversation_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut messages = Vec::new();
    for row in rows {
        let (id, role, content, image, image_name, created_at) =
            row.map_err(|error| error.to_string())?;
        // 密文只在读取时解密，内存与界面里始终是明文。
        messages.push(StoredAiMessage {
            id,
            role,
            content: decrypt_text(&content),
            image: decrypt_text(&image),
            image_name,
            created_at,
        });
    }
    Ok(messages)
}

pub(crate) fn append_ai_message(
    conn: &Connection,
    conversation_id: &str,
    role: &str,
    content: &str,
) -> Result<i64, String> {
    append_ai_message_with_image(conn, conversation_id, role, content, "", "")
}

pub(crate) fn append_ai_message_with_image(
    conn: &Connection,
    conversation_id: &str,
    role: &str,
    content: &str,
    image: &str,
    image_name: &str,
) -> Result<i64, String> {
    let now = Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO ai_messages(conversation_id, role, content, image, image_name, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            conversation_id,
            role,
            encrypt_text(content)?,
            encrypt_text(image)?,
            image_name,
            now
        ],
    )
    .map_err(|error| error.to_string())?;
    touch_ai_conversation(conn, conversation_id)?;
    Ok(conn.last_insert_rowid())
}

pub(crate) fn clear_ai_messages(conn: &Connection, conversation_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM ai_messages WHERE conversation_id = ?1",
        params![conversation_id],
    )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= max_chars {
        return value.to_string();
    }
    let mut result: String = chars[..max_chars].iter().collect();
    result.push('…');
    result
}

pub(crate) fn ai_backup_now(state: &DbState) -> Result<String, String> {
    backup_now(state)
}

// ---------------------------------------------------------------------------
// AI 计划修改快照（保留多份，支持连续撤销）
// ---------------------------------------------------------------------------

const AI_SNAPSHOT_KEEP: usize = 20;
const UNDO_KEEP: usize = 15;

pub(crate) fn push_ai_snapshot(
    conn: &Connection,
    summary: &str,
    payload_json: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO ai_snapshots(created_at, summary, payload) VALUES(?1, ?2, ?3)",
        params![
            Local::now().to_rfc3339(),
            truncate_chars(summary, 120),
            encrypt_text(payload_json)?
        ],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM ai_snapshots WHERE id NOT IN (
           SELECT id FROM ai_snapshots ORDER BY id DESC LIMIT ?1
         )",
        params![AI_SNAPSHOT_KEEP as i64],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn count_ai_snapshots(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM ai_snapshots", [], |row| row.get(0))
        .map_err(|error| error.to_string())
}

/// 弹出最近一份快照（包含它当时保存的计划 JSON）。
pub(crate) fn pop_ai_snapshot(conn: &Connection) -> Result<Option<String>, String> {
    let row: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, payload FROM ai_snapshots ORDER BY id DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((id, payload)) = row else {
        return Ok(None);
    };
    conn.execute("DELETE FROM ai_snapshots WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    Ok(Some(decrypt_text(&payload)))
}

// ---------------------------------------------------------------------------
// 通用键值存储（通知去重标记、每任务计时快照等）
// ---------------------------------------------------------------------------

pub(crate) fn kv_get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM app_kv WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(raw.map(|value| decrypt_text(&value)))
}

pub(crate) fn kv_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO app_kv(key, value, updated_at) VALUES(?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, encrypt_text(value)?, Local::now().to_rfc3339()],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn kv_delete(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM app_kv WHERE key = ?1", params![key])
        .map_err(|error| error.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 撤销栈（跨会话保留）
// ---------------------------------------------------------------------------

pub(crate) fn undo_push(conn: &Connection, payload_json: &str) -> Result<usize, String> {
    conn.execute(
        "INSERT INTO undo_stack(created_at, payload) VALUES(?1, ?2)",
        params![Local::now().to_rfc3339(), encrypt_text(payload_json)?],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM undo_stack WHERE id NOT IN (
           SELECT id FROM undo_stack ORDER BY id DESC LIMIT ?1
         )",
        params![UNDO_KEEP as i64],
    )
    .map_err(|error| error.to_string())?;
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM undo_stack", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    Ok(count as usize)
}

pub(crate) fn undo_pop(conn: &Connection) -> Result<Option<String>, String> {
    let row: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, payload FROM undo_stack ORDER BY id DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((id, payload)) = row else {
        return Ok(None);
    };
    conn.execute("DELETE FROM undo_stack WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    Ok(Some(decrypt_text(&payload)))
}

pub(crate) fn undo_clear(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM undo_stack", [])
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// 按时间顺序返回全部撤销快照（旧 → 新）。
pub(crate) fn undo_list(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT payload FROM undo_stack ORDER BY id ASC")
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut items = Vec::new();
    for row in rows {
        items.push(decrypt_text(&row.map_err(|error| error.to_string())?));
    }
    Ok(items)
}

/// 数据库结构：所有建表语句集中在这里，方便测试与迁移。
const SCHEMA_SQL: &str = r#"

        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          date TEXT NOT NULL,
          status TEXT NOT NULL,
          order_index INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          payload BLOB NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_date_status ON tasks(date, status, order_index);

        CREATE TABLE IF NOT EXISTS goals (
          id TEXT PRIMARY KEY,
          updated_at TEXT NOT NULL,
          payload BLOB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS categories (
          id TEXT PRIMARY KEY,
          order_index INTEGER NOT NULL DEFAULT 0,
          payload BLOB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ai_providers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          base_url TEXT NOT NULL,
          model TEXT NOT NULL,
          api_key BLOB,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ai_conversations (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ai_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL DEFAULT '',
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          image TEXT NOT NULL DEFAULT '',
          image_name TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ai_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ai_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          summary TEXT NOT NULL,
          payload TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_kv (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS undo_stack (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          payload TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ai_reminders (
          id TEXT PRIMARY KEY,
          task_id TEXT,
          title TEXT NOT NULL,
          remind_at TEXT NOT NULL,
          message TEXT NOT NULL,
          notified INTEGER NOT NULL DEFAULT 0
        );
        
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(SCHEMA_SQL).expect("schema");
        migrate_ai_conversations(&conn).expect("migrate");
        conn
    }

    #[test]
    fn conversation_messages_are_isolated() {
        let conn = test_conn();
        create_ai_conversation(&conn, "conv_a", "新对话").unwrap();
        create_ai_conversation(&conn, "conv_b", "另一条").unwrap();
        append_ai_message(&conn, "conv_a", "user", "你好").unwrap();
        append_ai_message(&conn, "conv_a", "assistant", "你好！").unwrap();
        append_ai_message(&conn, "conv_b", "user", "别的对话").unwrap();

        let conversations = list_ai_conversations(&conn).unwrap();
        assert_eq!(conversations.len(), 2);
        let first = conversations.iter().find(|item| item.id == "conv_a").unwrap();
        assert_eq!(first.message_count, 2);
        assert_eq!(first.preview, "你好");

        let messages = list_ai_messages(&conn, "conv_a").unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].content, "你好！");
        assert_eq!(count_ai_messages(&conn, "conv_b").unwrap(), 1);

        clear_ai_messages(&conn, "conv_a").unwrap();
        assert_eq!(count_ai_messages(&conn, "conv_a").unwrap(), 0);
        assert_eq!(list_ai_conversations(&conn).unwrap().len(), 2);

        delete_ai_conversation(&conn, "conv_b").unwrap();
        assert_eq!(list_ai_conversations(&conn).unwrap().len(), 1);
        assert_eq!(count_ai_messages(&conn, "conv_b").unwrap(), 0);
    }

    #[test]
    fn rename_updates_title() {
        let conn = test_conn();
        create_ai_conversation(&conn, "conv_x", "新对话").unwrap();
        rename_ai_conversation(&conn, "conv_x", "周报计划").unwrap();
        let conversations = list_ai_conversations(&conn).unwrap();
        assert_eq!(conversations[0].title, "周报计划");
    }

    #[test]
    fn legacy_messages_get_a_conversation() {
        let conn = Connection::open_in_memory().unwrap();
        // 老版本：ai_conversations 已存在，但 ai_messages 还没有 conversation_id 列。
        conn.execute_batch(
            "CREATE TABLE ai_conversations (
               id TEXT PRIMARY KEY,
               title TEXT NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE TABLE ai_messages (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               role TEXT NOT NULL,
               content TEXT NOT NULL,
               created_at TEXT NOT NULL
             );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ai_messages(role, content, created_at) VALUES('user', '旧消息', '2026-01-01T00:00:00+08:00')",
            [],
        )
        .unwrap();

        migrate_ai_conversations(&conn).unwrap();

        let conversations = list_ai_conversations(&conn).unwrap();
        assert_eq!(conversations.len(), 1);
        assert_eq!(conversations[0].title, "历史对话");
        assert_eq!(
            count_ai_messages(&conn, &conversations[0].id).unwrap(),
            1
        );
        // 幂等：重复迁移不会重复建会话。
        migrate_ai_conversations(&conn).unwrap();
        assert_eq!(list_ai_conversations(&conn).unwrap().len(), 1);
    }
}
