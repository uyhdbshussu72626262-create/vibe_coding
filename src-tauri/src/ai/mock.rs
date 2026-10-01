//! 内置本地模拟 OpenAI 端点（127.0.0.1，免密钥）。
//! 用于在没有 API Key 时完整测试：流式输出、停止生成、工具调用与错误提示。
//! 实现基于 tiny_http + std 线程，与真实网络请求共用同一套 SSE 解析代码。

use std::collections::VecDeque;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::{json, Value};

const CANNED_REPLY: &str = "你好！这是 Daynora 内置的本地模拟 AI，无需 API 密钥，\
用于测试聊天界面。你可以正常体验流式输出、停止生成、复制与清空功能。\
若想体验“分析计划 / 建议修改”，请点击上方按钮；若要使用真实模型，请在设置中填写你的 API 密钥。";

struct MockState {
    port: u16,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

#[derive(Default)]
pub struct MockManager {
    state: Arc<Mutex<Option<MockState>>>,
}

impl MockManager {
    pub fn base_url(&self) -> String {
        let port = self
            .state
            .lock()
            .ok()
            .and_then(|state| state.as_ref().map(|inner| inner.port))
            .unwrap_or(0);
        format!("http://127.0.0.1:{port}/v1")
    }

    pub fn ensure_started(&self) -> Result<u16, String> {
        {
            let guard = self.state.lock().map_err(|error| error.to_string())?;
            if let Some(state) = guard.as_ref() {
                if !state.stop.load(Ordering::Relaxed) {
                    return Ok(state.port);
                }
            }
        }

        let server = tiny_http::Server::http("127.0.0.1:0").map_err(|error| error.to_string())?;
        let port = server
            .server_addr()
            .to_ip()
            .map(|addr| addr.port())
            .unwrap_or(0);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let handle = std::thread::spawn(move || {
            loop {
                if stop_clone.load(Ordering::Relaxed) {
                    break;
                }
                match server.recv_timeout(Duration::from_millis(200)) {
                    Ok(Some(request)) => handle_request(request),
                    Ok(None) => continue,
                    Err(_) => break,
                }
            }
        });

        let mut guard = self.state.lock().map_err(|error| error.to_string())?;
        *guard = Some(MockState {
            port,
            stop,
            handle: Some(handle),
        });
        Ok(port)
    }

    pub fn shutdown(&self) {
        let mut guard = match self.state.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if let Some(state) = guard.take() {
            state.stop.store(true, Ordering::Relaxed);
            if let Some(handle) = state.handle {
                let _ = handle.join();
            }
        }
    }
}

fn handle_request(mut request: tiny_http::Request) {
    let url = request.url().to_string();
    let method = request.method().clone();

    if method == tiny_http::Method::Get && url == "/" {
        let response = tiny_http::Response::from_string("Daynora local mock OpenAI endpoint")
            .with_status_code(200);
        let _ = request.respond(response);
        return;
    }

    if method == tiny_http::Method::Get && url.contains("/models") {
        let body = json!({
            "object": "list",
            "data": [{"id": "mock-model", "object": "model", "owned_by": "daynora"}]
        })
        .to_string();
        let header = tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap();
        let response = tiny_http::Response::from_string(body)
            .with_status_code(200)
            .with_header(header);
        let _ = request.respond(response);
        return;
    }

    if method != tiny_http::Method::Post || !url.contains("chat/completions") {
        let response = tiny_http::Response::from_string("not found").with_status_code(404);
        let _ = request.respond(response);
        return;
    }

    let mut body_string = String::new();
    if request.as_reader().read_to_string(&mut body_string).is_err() {
        let response = tiny_http::Response::from_string("bad request").with_status_code(400);
        let _ = request.respond(response);
        return;
    }
    let body: Value = serde_json::from_str(&body_string).unwrap_or(Value::Null);

    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let last_user = messages
        .iter()
        .rev()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let stream = body
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let tools = body
        .get("tools")
        .and_then(Value::as_array)
        .map(|items| !items.is_empty())
        .unwrap_or(false);

    // 关键词触发“建议修改”路径，用于测试工具调用与差异确认 UI。
    let want_tools = tools
        && ["建议", "修改", "调整", "优化", "propose", "change"]
            .iter()
            .any(|keyword| last_user.to_ascii_lowercase().contains(keyword));

    if stream {
        respond_stream(request, want_tools, &messages);
    } else {
        respond_json(request);
    }
}

fn respond_json(request: tiny_http::Request) {
    let body = json!({
        "id": "chatcmpl-mock",
        "object": "chat.completion",
        "created": unix_now(),
        "model": "mock-model",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": CANNED_REPLY},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 12, "completion_tokens": 46, "total_tokens": 58}
    })
    .to_string();
    let header = tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap();
    let response = tiny_http::Response::from_string(body)
        .with_status_code(200)
        .with_header(header);
    let _ = request.respond(response);
}

fn respond_stream(request: tiny_http::Request, want_tools: bool, messages: &[Value]) {
    let (sender, receiver) = mpsc::channel::<Vec<u8>>();
    let messages = messages.to_vec();
    std::thread::spawn(move || {
        if want_tools {
            emit_tool_stream(&sender, &messages);
        } else {
            emit_text_stream(&sender);
        }
    });

    let header = tiny_http::Header::from_bytes("Content-Type", "text/event-stream").unwrap();
    let reader: Box<dyn Read + Send> = Box::new(MockStreamReader::new(receiver));
    let response =
        tiny_http::Response::new(tiny_http::StatusCode(200), vec![header], reader, None, None);
    let _ = request.respond(response);
}

fn emit_text_stream(sender: &Sender<Vec<u8>>) {
    send_chunk(
        sender,
        &json!({
            "id": "chatcmpl-mock",
            "object": "chat.completion.chunk",
            "created": unix_now(),
            "model": "mock-model",
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": null}]
        }),
    );
    let chars: Vec<char> = CANNED_REPLY.chars().collect();
    for chunk in chars.chunks(14) {
        let text: String = chunk.iter().collect();
        send_chunk(
            sender,
            &json!({
                "id": "chatcmpl-mock",
                "object": "chat.completion.chunk",
                "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": null}]
            }),
        );
        std::thread::sleep(Duration::from_millis(38));
    }
    send_chunk(
        sender,
        &json!({
            "id": "chatcmpl-mock",
            "object": "chat.completion.chunk",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 18, "completion_tokens": 52, "total_tokens": 70}
        }),
    );
    let _ = sender.send("data: [DONE]\n\n".as_bytes().to_vec());
}

fn emit_tool_stream(sender: &Sender<Vec<u8>>, messages: &[Value]) {
    send_chunk(
        sender,
        &json!({
            "id": "chatcmpl-mock",
            "object": "chat.completion.chunk",
            "created": unix_now(),
            "model": "mock-model",
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": null}]
        }),
    );

    let arguments = mock_tool_arguments(messages);
    send_chunk(
        sender,
        &json!({
            "id": "chatcmpl-mock",
            "object": "chat.completion.chunk",
            "choices": [{"index": 0, "delta": {
                "tool_calls": [{
                    "index": 0,
                    "id": "call_mock_1",
                    "type": "function",
                    "function": {"name": "propose_schedule_changes", "arguments": ""}
                }]
            }, "finish_reason": null}]
        }),
    );

    let bytes = arguments.as_bytes();
    for chunk in bytes.chunks(24) {
        let part = String::from_utf8_lossy(chunk).to_string();
        send_chunk(
            sender,
            &json!({
                "id": "chatcmpl-mock",
                "object": "chat.completion.chunk",
                "choices": [{"index": 0, "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "function": {"arguments": part}
                    }]
                }, "finish_reason": null}]
            }),
        );
        std::thread::sleep(Duration::from_millis(30));
    }
    send_chunk(
        sender,
        &json!({
            "id": "chatcmpl-mock",
            "object": "chat.completion.chunk",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 88, "completion_tokens": 40, "total_tokens": 128}
        }),
    );
    let _ = sender.send("data: [DONE]\n\n".as_bytes().to_vec());
}

fn mock_tool_arguments(messages: &[Value]) -> String {
    let task_id = find_first_task_id(messages);
    let mut operations = Vec::new();

    if let Some(task_id) = &task_id {
        operations.push(json!({
            "kind": "update",
            "task_id": task_id,
            "priority": "high",
            "reason": "本地模拟：把优先级调整为高，用于演示修改流程"
        }));
    }
    operations.push(json!({
        "kind": "add",
        "title": "复盘今天的工作（本地模拟示例）",
        "date": chrono::Local::now().format("%Y-%m-%d").to_string(),
        "start_time": "20:00",
        "duration_minutes": 20,
        "priority": "medium",
        "reason": "本地模拟：新增一条晚间复盘任务，用于演示新增流程"
    }));
    if let Some(task_id) = &task_id {
        operations.push(json!({
            "kind": "reminder",
            "task_id": task_id,
            "minutes_before": 15,
            "message": "即将开始任务，请提前准备（本地模拟提醒）",
            "reason": "本地模拟：演示提醒建议"
        }));
    }
    json!({"operations": operations}).to_string()
}

fn find_first_task_id(messages: &[Value]) -> Option<String> {
    for message in messages {
        let content = message
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("");
        if let Some(start) = content.find("task_") {
            let rest = &content[start + "task_".len()..];
            let end = rest
                .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'))
                .unwrap_or(rest.len());
            let id = rest[..end].to_string();
            if id.len() >= 8 {
                return Some(format!("task_{id}"));
            }
        }
    }
    None
}

fn send_chunk(sender: &Sender<Vec<u8>>, value: &Value) {
    let line = format!("data: {}\n\n", value);
    let _ = sender.send(line.into_bytes());
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

struct MockStreamReader {
    receiver: Receiver<Vec<u8>>,
    buffer: VecDeque<u8>,
    done: bool,
}

impl MockStreamReader {
    fn new(receiver: Receiver<Vec<u8>>) -> Self {
        Self {
            receiver,
            buffer: VecDeque::new(),
            done: false,
        }
    }
}

impl Read for MockStreamReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        while self.buffer.is_empty() && !self.done {
            match self.receiver.recv() {
                Ok(chunk) => self.buffer.extend(chunk),
                Err(_) => {
                    self.done = true;
                    return Ok(0);
                }
            }
        }
        if self.buffer.is_empty() {
            return Ok(0);
        }
        let count = out.len().min(self.buffer.len());
        for slot in out.iter_mut().take(count) {
            *slot = self.buffer.pop_front().unwrap_or(0);
        }
        Ok(count)
    }
}
