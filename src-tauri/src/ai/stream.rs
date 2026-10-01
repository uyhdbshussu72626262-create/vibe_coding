//! 基于 `eventsource-stream` 的 SSE 流式解析（reqwest 负责网络传输）。
//! 处理 OpenAI 兼容协议：content delta、tool_calls delta 聚合、usage 统计与 [DONE]。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde_json::Value;

use crate::ai::client::truncate;
use crate::ai::types::{StreamEvent, ProposedChange};
use crate::ai::tools::parse_proposed_changes;

pub type StopFlag = Arc<AtomicBool>;

#[derive(Debug, Default)]
pub struct RawToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Default)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

#[derive(Debug, Default)]
pub struct SseOutcome {
    pub content: String,
    pub tool_calls: Vec<RawToolCall>,
    pub usage: Usage,
}

/// 流式错误：附带已经收到的部分内容，便于把半截回答保存/展示给用户。
#[derive(Debug)]
pub struct SseError {
    pub message: String,
    pub outcome: SseOutcome,
}

/// 发起流式对话，逐个事件回调给调用方。返回聚合后的完整内容。
pub async fn stream_chat(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: &Value,
    stop: StopFlag,
    mut on_event: impl FnMut(StreamEvent) -> Result<(), String>,
) -> Result<SseOutcome, SseError> {
    let mut request = client.post(url).json(body);
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    let response = request
        .send()
        .await
        .map_err(|error| SseError {
            message: friendly_network_error(&error),
            outcome: SseOutcome::default(),
        })?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(SseError {
            message: format!("HTTP {}：{}", status.as_u16(), truncate(&text, 300)),
            outcome: SseOutcome::default(),
        });
    }

    let mut outcome = SseOutcome::default();
    let mut tool_buffers: Vec<RawToolCall> = Vec::new();
    let mut stream = response.bytes_stream().eventsource();

    while let Some(item) = stream.next().await {
        if stop.load(Ordering::Relaxed) {
            if let Err(error) = on_event(StreamEvent::Stopped) {
                return Err(SseError {
                    message: error,
                    outcome,
                });
            }
            return Ok(outcome);
        }
        match item {
            Ok(event) => {
                if event.data == b"[DONE]".as_slice() {
                    break;
                }
                let data_text = String::from_utf8_lossy(&event.data);
                let chunk: Value = match serde_json::from_str(&data_text) {
                    Ok(value) => value,
                    Err(_) => continue,
                };

                if let Some(usage) = chunk.get("usage") {
                    if let Some(value) = usage.get("prompt_tokens").and_then(Value::as_u64) {
                        outcome.usage.prompt_tokens = value as u32;
                    }
                    if let Some(value) = usage.get("completion_tokens").and_then(Value::as_u64) {
                        outcome.usage.completion_tokens = value as u32;
                    }
                    if let Some(value) = usage.get("total_tokens").and_then(Value::as_u64) {
                        outcome.usage.total_tokens = value as u32;
                    }
                }

                let Some(choices) = chunk.get("choices").and_then(Value::as_array) else {
                    continue;
                };
                let Some(choice) = choices.first() else {
                    continue;
                };
                let delta = choice.get("delta").cloned().unwrap_or(Value::Null);

                if let Some(content) = delta
                    .get("content")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    outcome.content.push_str(content);
                    if let Err(error) = on_event(StreamEvent::Delta {
                        content: content.to_string(),
                    }) {
                        return Err(SseError {
                            message: error,
                            outcome,
                        });
                    }
                }

                if let Some(tool_calls) = delta
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .cloned()
                {
                    merge_tool_deltas(&mut tool_buffers, &tool_calls);
                }

                // 有 provider 直接给出完整的 message.tool_calls（非增量场景的兜底）。
                if let Some(message) = choice.get("message") {
                    if let Some(tool_calls) = message
                        .get("tool_calls")
                        .and_then(Value::as_array)
                        .cloned()
                    {
                        merge_tool_deltas(&mut tool_buffers, &tool_calls);
                    }
                    if let Some(content) = message
                        .get("content")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                    {
                        outcome.content = content.to_string();
                        if let Err(error) = on_event(StreamEvent::Delta {
                            content: content.to_string(),
                        }) {
                            return Err(SseError {
                                message: error,
                                outcome,
                            });
                        }
                    }
                }
            }
            Err(error) => {
                return Err(SseError {
                    message: format!("流式响应中断：{error}"),
                    outcome,
                });
            }
        }
    }

    if stop.load(Ordering::Relaxed) {
        if let Err(error) = on_event(StreamEvent::Stopped) {
            return Err(SseError {
                message: error,
                outcome,
            });
        }
        return Ok(outcome);
    }

    outcome.tool_calls = tool_buffers;
    Ok(outcome)
}

/// 把 OpenAI 的增量 tool_calls 按 index 聚合（name/id 先到，arguments 分片追加）。
fn merge_tool_deltas(buffers: &mut Vec<RawToolCall>, deltas: &[Value]) {
    for delta in deltas {
        let index = delta.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        if buffers.len() <= index {
            buffers.resize_with(index + 1, RawToolCall::default);
        }
        let buffer = &mut buffers[index];
        if let Some(id) = delta.get("id").and_then(Value::as_str) {
            buffer.id = id.to_string();
        }
        let function = delta.get("function").cloned().unwrap_or(Value::Null);
        if let Some(name) = function.get("name").and_then(Value::as_str) {
            buffer.name = name.to_string();
        }
        if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
            buffer.arguments.push_str(arguments);
        }
    }
}

/// 把聚合好的工具调用解析成结构化修改建议，同时生成工具事件的回调。
pub fn finalize_tool_proposals(
    tool_calls: &[RawToolCall],
) -> Result<Vec<ProposedChange>, String> {
    let mut all_changes = Vec::new();
    for call in tool_calls {
        if call.name == "propose_schedule_changes" {
            match parse_proposed_changes(&call.arguments) {
                Ok(mut changes) => all_changes.append(&mut changes),
                Err(error) => {
                    return Err(format!("解析 AI 修改建议失败：{error}"));
                }
            }
        }
    }
    Ok(all_changes)
}

fn friendly_network_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return "连接超时，请检查网络或稍后重试".to_string();
    }
    if error.is_connect() {
        return format!("无法连接服务器（{}）", error);
    }
    format!("网络请求失败：{error}")
}
