//! AI 回答里的远程图片：默认不加载，用户点击后才由 Rust 拉取并转成 data URL。
//! 这样 CSP 不必放开 img-src https，也避免打开对话就自动请求第三方图片。

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

use crate::ai::client::build_http_client;

const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Daynora/0.1";

#[tauri::command]
pub async fn ai_fetch_image(url: String) -> Result<String, String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("只支持 http/https 图片链接".to_string());
    }

    let client = build_http_client()?;
    let response = client
        .get(trimmed)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|error| format!("图片下载失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("图片下载失败：HTTP {}", response.status().as_u16()));
    }

    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/png")
        .split(';')
        .next()
        .unwrap_or("image/png")
        .trim()
        .to_string();
    if !mime.starts_with("image/") {
        return Err("该链接不是图片".to_string());
    }
    if let Some(length) = response.content_length() {
        if length as usize > MAX_IMAGE_BYTES {
            return Err("图片太大（超过 8MB）".to_string());
        }
    }

    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片太大（超过 8MB）".to_string());
    }
    Ok(format!("data:{mime};base64,{}", BASE64.encode(&bytes)))
}
