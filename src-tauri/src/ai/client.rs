//! HTTP 客户端与 OpenAI 兼容请求体的构造。
//! 仅使用 rustls（无 OpenSSL 依赖），Windows 下开箱即用。

use serde_json::{json, Value};

use crate::ai::types::{ChatMessage, Role};

pub fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|error| error.to_string())
}

pub fn chat_completions_url(base_url: &str) -> String {
    format!("{}/chat/completions", base_url.trim_end_matches('/'))
}

/// 构造 OpenAI 兼容的请求体。`tools` 为 None 时不做工具调用。
pub fn build_chat_body(
    messages: &[ChatMessage],
    model: &str,
    tools: Option<&Value>,
    temperature: Option<f32>,
    stream: bool,
) -> Value {
    let mut body = json!({
        "model": model,
        "messages": messages
            .iter()
            .map(|message| match &message.image {
                // 带图片的用户消息用 OpenAI 多模态格式：文本 + image_url 两部分。
                Some(image) if !image.is_empty() => json!({
                    "role": message.role.as_str(),
                    "content": [
                        { "type": "text", "text": message.content },
                        { "type": "image_url", "image_url": { "url": image } }
                    ]
                }),
                _ => json!({
                    "role": message.role.as_str(),
                    "content": message.content,
                }),
            })
            .collect::<Vec<_>>(),
        "stream": stream,
    });
    if let Some(tools) = tools {
        body["tools"] = tools.clone();
        body["tool_choice"] = json!("auto");
    }
    if let Some(temperature) = temperature {
        body["temperature"] = json!(temperature.clamp(0.0, 2.0));
    }
    body
}

pub fn system_message(content: String) -> ChatMessage {
    ChatMessage {
        role: Role::System,
        content,
        image: None,
    }
}

pub fn user_message(content: String) -> ChatMessage {
    ChatMessage {
        role: Role::User,
        content,
        image: None,
    }
}

pub fn user_message_with_image(content: String, image: Option<String>) -> ChatMessage {
    ChatMessage {
        role: Role::User,
        content,
        image,
    }
}

pub fn truncate(value: &str, max_chars: usize) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= max_chars {
        return value.to_string();
    }
    let mut result: String = chars[..max_chars].iter().collect();
    result.push('…');
    result
}
