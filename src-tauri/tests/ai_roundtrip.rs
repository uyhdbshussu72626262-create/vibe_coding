//! 端到端验证本地模拟 OpenAI 端点与 SSE 解析链路（不依赖 Tauri 窗口）。

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use daynora_lib::ai::client::{build_chat_body, build_http_client, chat_completions_url, user_message};
use daynora_lib::ai::mock::MockManager;
use daynora_lib::ai::stream::stream_chat;
use daynora_lib::ai::types::StreamEvent;

#[tokio::test]
async fn mock_stream_roundtrip_works() {
    let manager = MockManager::default();
    let port = manager.ensure_started().expect("mock server should start");
    assert!(port > 0);

    let client = build_http_client().expect("http client");
    let body = build_chat_body(
        &[user_message("你好".to_string())],
        "mock-model",
        None,
        None,
        true,
    );
    let stop: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
    let mut delta_text = String::new();
    let outcome = stream_chat(
        &client,
        &chat_completions_url(&manager.base_url()),
        "",
        &body,
        stop,
        |event| {
            if let StreamEvent::Delta { content } = &event {
                delta_text.push_str(content);
            }
            Ok(())
        },
    )
    .await
    .expect("stream should complete");

    assert!(!outcome.content.is_empty());
    assert_eq!(delta_text, outcome.content);
    assert!(outcome.usage.total_tokens > 0);
    assert!(outcome.tool_calls.is_empty());
    manager.shutdown();
}

#[tokio::test]
async fn mock_stream_can_be_stopped() {
    let manager = MockManager::default();
    manager.ensure_started().expect("mock server should start");

    let client = build_http_client().expect("http client");
    let body = build_chat_body(
        &[user_message("你好".to_string())],
        "mock-model",
        None,
        None,
        true,
    );
    let stop: Arc<AtomicBool> = Arc::new(AtomicBool::new(true));
    let outcome = stream_chat(
        &client,
        &chat_completions_url(&manager.base_url()),
        "",
        &body,
        stop,
        |_event| Ok(()),
    )
    .await
    .expect("stopping should not be an error");

    // 第一轮循环就应检测到停止标志，回复内容为空。
    assert!(outcome.content.is_empty());
    manager.shutdown();
}
