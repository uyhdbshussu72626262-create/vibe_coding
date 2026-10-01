//! 云端 AI 网络请求层（单独目录，便于学习与研究）。
//!
//! 仅支持 OpenAI 兼容协议；网络传输使用 reqwest + rustls，
//! SSE 解析基于 eventsource-stream，工具调用为 OpenAI function calling 格式。

pub mod analysis;
pub mod client;
pub mod commands;
pub mod media;
pub mod mock;
pub mod providers;
pub mod stream;
pub mod tools;
pub mod types;
pub mod web;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager};

/// 记录进行中的流式请求，用于“停止生成”。
#[derive(Default)]
pub struct StopRegistry {
    flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl StopRegistry {
    pub fn register(&self, id: &str) -> Arc<AtomicBool> {
        let mut flags = self
            .flags
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let flag = Arc::new(AtomicBool::new(false));
        flags.insert(id.to_string(), flag.clone());
        flag
    }

    pub fn stop(&self, id: &str) {
        let flags = self
            .flags
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(flag) = flags.get(id) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    pub fn unregister(&self, id: &str) {
        let mut flags = self
            .flags
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        flags.remove(id);
    }

    pub fn shutdown_all(&self) {
        let flags = self
            .flags
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for flag in flags.values() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

pub fn setup(app: &AppHandle) {
    app.manage(StopRegistry::default());
    app.manage(mock::MockManager::default());
}

pub fn shutdown(app: &AppHandle) {
    app.state::<StopRegistry>().shutdown_all();
    app.state::<mock::MockManager>().shutdown();
}
