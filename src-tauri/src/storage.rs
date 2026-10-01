//! 前端小数据的持久化（已迁移到 SQLite，替代 localStorage）：
//! 通知去重标记、每任务计时快照、撤销栈。

use serde_json::Value;
use tauri::State;

use crate::db::{self, DbState};

#[tauri::command]
pub fn kv_get(state: State<'_, DbState>, key: String) -> Result<Option<String>, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    db::kv_get(&conn, &key)
}

#[tauri::command]
pub fn kv_set(state: State<'_, DbState>, key: String, value: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    db::kv_set(&conn, &key, &value)
}

#[tauri::command]
pub fn kv_delete(state: State<'_, DbState>, key: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    db::kv_delete(&conn, &key)
}

#[tauri::command]
pub fn undo_push(state: State<'_, DbState>, payload: Value) -> Result<usize, String> {
    let json = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    db::undo_push(&conn, &json)
}

#[tauri::command]
pub fn undo_pop(state: State<'_, DbState>) -> Result<Option<Value>, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    match db::undo_pop(&conn)? {
        Some(json) => Ok(Some(
            serde_json::from_str(&json).map_err(|error| error.to_string())?,
        )),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn undo_clear(state: State<'_, DbState>) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    db::undo_clear(&conn)
}

#[tauri::command]
pub fn undo_list(state: State<'_, DbState>) -> Result<Vec<Value>, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    let mut items = Vec::new();
    for json in db::undo_list(&conn)? {
        if let Ok(value) = serde_json::from_str::<Value>(&json) {
            items.push(value);
        }
    }
    Ok(items)
}
