//! Tauri 命令层：提供商管理、流式对话、计划分析与修改、提醒轮询。

use chrono::{DateTime, Duration, Local, NaiveDateTime, TimeZone};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::ai::analysis::{context_system_prompt, mode_system_prompt};
use crate::ai::client::{
    build_chat_body, build_http_client, chat_completions_url, system_message, truncate,
    user_message, user_message_with_image,
};
use crate::ai::mock::MockManager;
use crate::ai::providers::{presets, ProviderKind};
use crate::ai::stream::{finalize_tool_proposals, stream_chat};
use crate::ai::tools::proposal_tool_schema;
use crate::ai::types::{
    AiMessageView, AiSettingsView, ApplyResult, ChatMessage, ChatMode, ChatRequest,
    ConversationView, ProviderView, ProposedChange, ReminderView, Role, SaveProviderRequest,
    StreamEvent, WebSource,
};
use crate::ai::StopRegistry;
use crate::db::{self, DbState, Snapshot};
use crate::security;

const DEFAULT_SYSTEM_PROMPT: &str = "你是 Daynora 任务管理软件内置的 AI 助手，\
擅长时间管理与任务规划。请用简洁、友好的语言回答问题；\
当用户需要最新资料时，可以提示他打开输入框下方的「联网搜索」开关。";

struct ResolvedProvider {
    base_url: String,
    model: String,
    api_key: String,
}

fn new_id(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let stamp = Local::now().format("%Y%m%d%H%M%S%3f");
    let number = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{stamp}_{number}")
}

fn mock_base_url(app: &AppHandle) -> String {
    let manager = app.state::<MockManager>();
    let _ = manager.ensure_started();
    manager.base_url()
}

fn active_provider_id(conn: &rusqlite::Connection) -> Result<Option<String>, String> {
    db::get_ai_setting(conn, "active_provider_id")
}

fn provider_views(conn: &rusqlite::Connection) -> Result<Vec<ProviderView>, String> {
    let active = active_provider_id(conn)?;
    let providers = db::list_ai_providers(conn)?;
    Ok(providers
        .iter()
        .map(|provider| ProviderView {
            id: provider.id.clone(),
            name: provider.name.clone(),
            kind: provider.kind.clone(),
            base_url: provider.base_url.clone(),
            model: provider.model.clone(),
            has_key: !provider.api_key.is_empty(),
            is_active: active.as_deref() == Some(provider.id.as_str()),
        })
        .collect())
}

fn resolve_provider(app: &AppHandle, provider_id: Option<String>) -> Result<ResolvedProvider, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    let providers = db::list_ai_providers(&conn)?;
    if providers.is_empty() {
        return Err("尚未配置 AI 提供商，请先在 AI 设置中添加".to_string());
    }
    let active = active_provider_id(&conn)?;
    let selected = provider_id.clone().or(active);
    let provider = match selected {
        Some(id) => providers.iter().find(|item| item.id == id),
        None => providers.first(),
    }
    .ok_or_else(|| "找不到指定的 AI 提供商".to_string())?;

    let api_key = if provider.api_key.is_empty() {
        String::new()
    } else {
        security::unprotect(&provider.api_key)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .unwrap_or_default()
    };
    if provider.kind != "mock" && api_key.is_empty() {
        return Err(format!("提供商「{}」尚未填写 API 密钥", provider.name));
    }

    let base_url = if provider.kind == "mock" {
        mock_base_url(app)
    } else {
        provider.base_url.clone()
    };

    Ok(ResolvedProvider {
        base_url,
        model: provider.model.clone(),
        api_key,
    })
}

// ---------------------------------------------------------------------------
// 提供商与设置
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn ai_presets(app: AppHandle) -> Result<Value, String> {
    let mock_url = mock_base_url(&app);
    Ok(json!(presets(&mock_url)))
}

#[tauri::command]
pub fn ai_list_providers(state: State<'_, DbState>) -> Result<Vec<ProviderView>, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    provider_views(&conn)
}

#[tauri::command]
pub fn ai_save_provider(
    state: State<'_, DbState>,
    app: AppHandle,
    request: SaveProviderRequest,
) -> Result<ProviderView, String> {
    let kind = ProviderKind::parse(&request.kind);
    let kind_str = kind.as_str().to_string();
    let is_mock = kind == ProviderKind::Mock;

    let base_url = if is_mock {
        mock_base_url(&app)
    } else {
        let url = request.base_url.trim().trim_end_matches('/').to_string();
        if !url.starts_with("https://") && !url.starts_with("http://") {
            return Err("Base URL 必须以 http:// 或 https:// 开头".to_string());
        }
        url
    };
    let model = if is_mock {
        "mock-model".to_string()
    } else {
        request.model.trim().to_string()
    };
    if !is_mock && model.is_empty() {
        return Err("请填写模型名称".to_string());
    }
    let name = request.name.trim().to_string();
    if name.is_empty() {
        return Err("请填写提供商名称".to_string());
    }

    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    let id = request.id.clone().unwrap_or_else(|| new_id("provider"));
    let now = Local::now().to_rfc3339();

    // api_key：None 保留旧值；Some 更新（空字符串视为清除）。
    let api_key = match request.api_key {
        Some(key) => {
            let trimmed = key.trim().to_string();
            if trimmed.is_empty() {
                Vec::new()
            } else {
                security::protect(trimmed.as_bytes())?
            }
        }
        None => {
            let existing = db::list_ai_providers(&conn)?;
            existing
                .iter()
                .find(|item| item.id == id)
                .map(|item| item.api_key.clone())
                .unwrap_or_default()
        }
    };

    let created_at = db::list_ai_providers(&conn)?
        .iter()
        .find(|item| item.id == id)
        .map(|item| item.created_at.clone())
        .unwrap_or_else(|| now.clone());

    db::upsert_ai_provider(
        &conn,
        &db::StoredProvider {
            id: id.clone(),
            name,
            kind: kind_str,
            base_url,
            model,
            api_key,
            created_at,
            updated_at: now,
        },
    )?;

    // 首个提供商自动设为当前使用。
    if active_provider_id(&conn)?.is_none() {
        db::set_ai_setting(&conn, "active_provider_id", &id)?;
    }

    let views = provider_views(&conn)?;
    views
        .into_iter()
        .find(|view| view.id == id)
        .ok_or_else(|| "保存成功但读取失败".to_string())
}

#[tauri::command]
pub fn ai_delete_provider(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    db::delete_ai_provider(&conn, &id)?;
    if active_provider_id(&conn)?.as_deref() == Some(id.as_str()) {
        let remaining = db::list_ai_providers(&conn)?;
        match remaining.first() {
            Some(provider) => db::set_ai_setting(&conn, "active_provider_id", &provider.id)?,
            None => db::set_ai_setting(&conn, "active_provider_id", "")?,
        }
    }
    Ok(())
}

#[tauri::command]
pub fn ai_set_active_provider(
    state: State<'_, DbState>,
    id: Option<String>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    db::set_ai_setting(&conn, "active_provider_id", id.as_deref().unwrap_or(""))
}

#[tauri::command]
pub fn ai_get_settings(state: State<'_, DbState>, app: AppHandle) -> Result<AiSettingsView, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    let system_prompt = db::get_ai_setting(&conn, "system_prompt")?
        .unwrap_or_else(|| DEFAULT_SYSTEM_PROMPT.to_string());
    let privacy_accepted = db::get_ai_setting(&conn, "privacy_accepted")?.as_deref() == Some("1");
    let mock_base_url = mock_base_url(&app);
    Ok(AiSettingsView {
        active_provider_id: active_provider_id(&conn)?,
        system_prompt,
        privacy_accepted,
        mock_base_url,
    })
}

#[tauri::command]
pub fn ai_set_system_prompt(state: State<'_, DbState>, prompt: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    db::set_ai_setting(&conn, "system_prompt", &prompt)
}

#[tauri::command]
pub fn ai_accept_privacy(state: State<'_, DbState>) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    db::set_ai_setting(&conn, "privacy_accepted", "1")
}

#[tauri::command]
pub async fn ai_test_provider(
    app: AppHandle,
    provider_id: Option<String>,
) -> Result<String, String> {
    let resolved = resolve_provider(&app, provider_id)?;
    let client = build_http_client()?;
    let body = build_chat_body(
        &[user_message("ping".to_string())],
        &resolved.model,
        None,
        None,
        false,
    );
    let mut request = client
        .post(chat_completions_url(&resolved.base_url))
        .json(&body);
    if !resolved.api_key.is_empty() {
        request = request.bearer_auth(&resolved.api_key);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("连接失败：{error}"))?;
    let status = response.status();
    if status.is_success() {
        Ok("ok".to_string())
    } else {
        let text = response.text().await.unwrap_or_default();
        Err(format!(
            "HTTP {}：{}",
            status.as_u16(),
            truncate(&text, 300)
        ))
    }
}

// ---------------------------------------------------------------------------
// 对话记录
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn ai_list_conversations(state: State<'_, DbState>) -> Result<Vec<ConversationView>, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    Ok(db::list_ai_conversations(&conn)?
        .into_iter()
        .map(|conversation| ConversationView {
            id: conversation.id,
            title: conversation.title,
            created_at: conversation.created_at,
            updated_at: conversation.updated_at,
            message_count: conversation.message_count,
            preview: conversation.preview,
        })
        .collect())
}

#[tauri::command]
pub fn ai_create_conversation(
    state: State<'_, DbState>,
    title: Option<String>,
) -> Result<ConversationView, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    let id = new_id("conv");
    let title = title
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "新对话".to_string());
    db::create_ai_conversation(&conn, &id, &title)?;
    let now = Local::now().to_rfc3339();
    Ok(ConversationView {
        id,
        title,
        created_at: now.clone(),
        updated_at: now,
        message_count: 0,
        preview: String::new(),
    })
}

#[tauri::command]
pub fn ai_delete_conversation(state: State<'_, DbState>, conversation_id: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    db::delete_ai_conversation(&conn, &conversation_id)
}

#[tauri::command]
pub fn ai_rename_conversation(
    state: State<'_, DbState>,
    conversation_id: String,
    title: String,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    let title = title.trim();
    if title.is_empty() {
        return Err("标题不能为空".to_string());
    }
    db::rename_ai_conversation(&conn, &conversation_id, &truncate(title, 40))
}

#[tauri::command]
pub fn ai_list_messages(
    state: State<'_, DbState>,
    conversation_id: String,
) -> Result<Vec<AiMessageView>, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    Ok(db::list_ai_messages(&conn, &conversation_id)?
        .into_iter()
        .map(|message| AiMessageView {
            id: message.id,
            role: message.role,
            content: message.content,
            image: message.image,
            image_name: message.image_name,
            created_at: message.created_at,
        })
        .collect())
}

#[tauri::command]
pub fn ai_clear_messages(state: State<'_, DbState>, conversation_id: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    db::clear_ai_messages(&conn, &conversation_id)
}

#[tauri::command]
pub fn ai_stop_generation(state: State<'_, StopRegistry>, request_id: String) -> Result<(), String> {
    state.stop(&request_id);
    Ok(())
}

// ---------------------------------------------------------------------------
// 流式对话（含分析与修改建议模式）
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ai_chat_stream(
    app: AppHandle,
    channel: tauri::ipc::Channel<StreamEvent>,
    request: ChatRequest,
) -> Result<(), String> {
    let request_id = if request.request_id.is_empty() {
        new_id("req")
    } else {
        request.request_id.clone()
    };
    let stop = app.state::<StopRegistry>().register(&request_id);
    let language = request.language.clone().unwrap_or_else(|| "zh-CN".to_string());
    let user_text = request.message.trim().to_string();
    if user_text.is_empty() {
        return Err("消息不能为空".to_string());
    }

    let resolved = resolve_provider(&app, request.provider_id.clone())?;
    let send = |event: StreamEvent| {
        channel.send(event).map_err(|error| error.to_string())
    };

    // 解析会话：指定了就用指定的，没指定就新建一个（第一次对话会自动生成标题）。
    let conversation_id = {
        let db_state = app.state::<DbState>();
        let conn = db_state
            .conn
            .lock()
            .map_err(|error| error.to_string())?;
        let requested = request
            .conversation_id
            .clone()
            .filter(|id| !id.trim().is_empty());
        match requested {
            Some(id) => {
                let exists: Option<String> = conn
                    .query_row(
                        "SELECT id FROM ai_conversations WHERE id = ?1",
                        [&id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| error.to_string())?;
                if exists.is_none() {
                    db::create_ai_conversation(&conn, &id, "新对话")?;
                }
                id
            }
            None => {
                let id = new_id("conv");
                db::create_ai_conversation(&conn, &id, "新对话")?;
                id
            }
        }
    };

    send(StreamEvent::Started {
        request_id: request_id.clone(),
        conversation_id: conversation_id.clone(),
    })?;

    // 联网搜索：先把资料取回来，再作为上下文注入；失败只提示、不打断对话。
    let mut web_context: Option<String> = None;
    if request.web_search {
        match crate::ai::web::ai_web_search(user_text.clone(), Some(5)).await {
            Ok(results) => {
                let items: Vec<WebSource> = results
                    .iter()
                    .map(|item| WebSource {
                        title: item.title.clone(),
                        snippet: item.snippet.clone(),
                        url: item.url.clone(),
                        text: item.text.clone(),
                    })
                    .collect();
                let mut context = format!(
                    "【联网检索模式】当前本地时间：{}。以下资料由 Daynora 刚刚从互联网检索得到（含链接）：\n",
                    Local::now().format("%Y-%m-%d %H:%M")
                );
                for (index, item) in results.iter().enumerate() {
                    let body = if item.text.trim().is_empty() {
                        item.snippet.clone()
                    } else {
                        item.text.clone()
                    };
                    context.push_str(&format!(
                        "{}. {}\n摘要：{}\n链接：{}\n\n",
                        index + 1,
                        item.title,
                        body,
                        item.url
                    ));
                }
                context.push_str(
                    "\n请直接、紧扣用户的问题、基于以上资料回答，并在引用处附上链接。\
                     不要把资料当成不相干的背景，也不要只复述用户问题。\
                     不要回答“我无法联网”或“我无法获取实时信息”——检索已经完成；\
                     如果资料不足以回答，请说明资料有限并给出你能确定的部分。",
                );
                web_context = Some(context);
                send(StreamEvent::Sources {
                    items,
                    note: None,
                })?;
            }
            Err(error) => {
                send(StreamEvent::Sources {
                    items: Vec::new(),
                    note: Some(format!("联网搜索失败：{error}")),
                })?;
            }
        }
    }

    // 组装消息（分析模式附带任务快照，聊天模式使用历史记录）。
    let mut messages: Vec<ChatMessage> = Vec::new();
    let tools = (request.mode == ChatMode::ProposeChanges).then(proposal_tool_schema);

    match request.mode {
        ChatMode::Chat => {
            let db_state = app.state::<DbState>();
            let conn = db_state
                .conn
                .lock()
                .map_err(|error| error.to_string())?;
            let custom_prompt = db::get_ai_setting(&conn, "system_prompt")?
                .unwrap_or_else(|| DEFAULT_SYSTEM_PROMPT.to_string());
            if !custom_prompt.trim().is_empty() {
                messages.push(system_message(custom_prompt));
            }
            // 让模型知道“现在”是什么时候，避免把实时问题当作训练截止前的旧问题。
            messages.push(system_message(format!(
                "当前本地时间：{}。如果用户需要最新信息，可以提示他打开输入框下方的「联网搜索」开关。",
                Local::now().format("%Y-%m-%d %H:%M")
            )));
            // 历史消息里的图片只保留最近两张，避免请求体过大。
            let mut history = db::list_ai_messages(&conn, &conversation_id)?;
            let image_positions: Vec<usize> = history
                .iter()
                .enumerate()
                .filter(|(_, message)| !message.image.is_empty())
                .map(|(index, _)| index)
                .collect();
            let keep_from = image_positions
                .len()
                .saturating_sub(2);
            let keep_images: Vec<usize> = image_positions.into_iter().skip(keep_from).collect();
            for (index, history) in history.drain(..).enumerate() {
                let role = match history.role.as_str() {
                    "user" => Role::User,
                    "assistant" => Role::Assistant,
                    _ => continue,
                };
                messages.push(ChatMessage {
                    role,
                    content: history.content,
                    image: keep_images
                        .contains(&index)
                        .then(|| history.image.clone())
                        .filter(|image| !image.is_empty()),
                });
            }
        }
        _ => {
            let db_state = app.state::<DbState>();
            let conn = db_state
                .conn
                .lock()
                .map_err(|error| error.to_string())?;
            let snapshot = db::load_snapshot_inner(&conn)?
                .ok_or_else(|| "暂无任务数据可供分析".to_string())?;
            let mode_prompt = mode_system_prompt(request.mode, &language);
            let context_prompt = context_system_prompt(&snapshot, &language);
            messages.push(system_message(format!(
                "{mode_prompt}\n\n{context_prompt}"
            )));
        }
    }
    if let Some(context) = web_context {
        messages.push(system_message(context));
    }
    messages.push(user_message_with_image(user_text.clone(), request.image.clone()));

    // 先持久化用户消息。
    {
        let db_state = app.state::<DbState>();
        let conn = db_state
            .conn
            .lock()
            .map_err(|error| error.to_string())?;
        db::append_ai_message_with_image(
            &conn,
            &conversation_id,
            "user",
            &user_text,
            request.image.as_deref().unwrap_or(""),
            request.image_name.as_deref().unwrap_or(""),
        )?;
    }

    let client = build_http_client()?;
    let url = chat_completions_url(&resolved.base_url);
    let body = build_chat_body(
        &messages,
        &resolved.model,
        tools.as_ref(),
        request.temperature,
        true,
    );

    let outcome = stream_chat(&client, &url, &resolved.api_key, &body, stop, &send).await;

    match outcome {
        Ok(result) => {
            let mut assistant_text = result.content.clone();
            if !result.tool_calls.is_empty() {
                let proposals = finalize_tool_proposals(&result.tool_calls)?;
                if !proposals.is_empty() {
                    send(StreamEvent::ToolProposal {
                        id: format!("proposal_{}", new_id("p")),
                        name: "propose_schedule_changes".to_string(),
                        changes: proposals.clone(),
                    })?;
                    assistant_text = format!(
                        "[计划修改建议] 共 {} 条修改，请在右侧列表中确认后应用。",
                        proposals.len()
                    );
                }
            }
            if assistant_text.trim().is_empty() {
                assistant_text = "（AI 未返回回复内容，请重试或检查模型配置）".to_string();
            }
            if result.usage.total_tokens > 0 {
                send(StreamEvent::Usage {
                    prompt_tokens: result.usage.prompt_tokens,
                    completion_tokens: result.usage.completion_tokens,
                    total_tokens: result.usage.total_tokens,
                })?;
            }
            if !assistant_text.trim().is_empty() {
                let db_state = app.state::<DbState>();
                let conn = db_state
                    .conn
                    .lock()
                    .map_err(|error| error.to_string())?;
                db::append_ai_message(&conn, &conversation_id, "assistant", &assistant_text)?;
            }
            send(StreamEvent::Done)?;

            // 首轮问答结束后，让模型给这个会话起一个短标题。
            let needs_title = {
                let db_state = app.state::<DbState>();
                let conn = db_state
                    .conn
                    .lock()
                    .map_err(|error| error.to_string())?;
                let count = db::count_ai_messages(&conn, &conversation_id)?;
                let title = conn
                    .query_row(
                        "SELECT title FROM ai_conversations WHERE id = ?1",
                        [&conversation_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(|error| error.to_string())?;
                count <= 2 && title.as_deref() == Some("新对话")
            };
            if needs_title {
                if let Ok(title) =
                    generate_conversation_title(&client, &resolved, &user_text, &language).await
                {
                    let db_state = app.state::<DbState>();
                    let conn = db_state
                        .conn
                        .lock()
                        .map_err(|error| error.to_string())?;
                    db::rename_ai_conversation(&conn, &conversation_id, &title)?;
                    drop(conn);
                    send(StreamEvent::Title {
                        conversation_id: conversation_id.clone(),
                        title,
                    })?;
                }
            }
        }
        Err(error) => {
            send(StreamEvent::Error {
                message: error.message.clone(),
            })?;
            if !error.outcome.content.trim().is_empty() {
                let db_state = app.state::<DbState>();
                let conn = db_state
                    .conn
                    .lock()
                    .map_err(|error| error.to_string())?;
                db::append_ai_message(
                    &conn,
                    &conversation_id,
                    "assistant",
                    &error.outcome.content,
                )?;
            }
        }
    }

    app.state::<StopRegistry>().unregister(&request_id);
    Ok(())
}

// ---------------------------------------------------------------------------
// 修改建议的确认应用与撤销
// ---------------------------------------------------------------------------

/// 让模型把首轮对话总结成一个短标题（失败不影响主流程）。
async fn generate_conversation_title(
    client: &reqwest::Client,
    provider: &ResolvedProvider,
    user_text: &str,
    language: &str,
) -> Result<String, String> {
    let prompt = if language != "en" {
        format!(
            "请用不超过 12 个字概括下面这段对话的主题，只输出标题本身，不要引号、不要句号。\n\n{}",
            user_text
        )
    } else {
        format!(
            "Summarize the topic of this conversation in at most 6 words. Output only the title, without quotes.\n\n{}",
            user_text
        )
    };
    let mut body = build_chat_body(
        &[user_message(prompt)],
        &provider.model,
        None,
        Some(0.2),
        false,
    );
    body["max_tokens"] = json!(64);

    let mut request = client
        .post(chat_completions_url(&provider.base_url))
        .json(&body);
    if !provider.api_key.is_empty() {
        request = request.bearer_auth(&provider.api_key);
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let value: Value = response.json().await.map_err(|error| error.to_string())?;
    let raw = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let fallback: String = user_text.chars().take(16).collect();
    Ok(sanitize_title(raw, &fallback))
}

fn sanitize_title(raw: &str, fallback: &str) -> String {
    let mut text = raw.trim().to_string();
    if let Some(first_line) = text.lines().find(|line| !line.trim().is_empty()) {
        text = first_line.trim().to_string();
    }
    let trimmed = text.trim_matches(|ch: char| {
        matches!(
            ch,
            '"' | '\''
                | '“'
                | '”'
                | '‘'
                | '’'
                | '《'
                | '》'
                | '【'
                | '】'
                | '#'
                | '*'
                | '`'
                | '。'
                | '.'
                | ':'
                | '：'
                | ' '
        )
    });
    let result: String = trimmed.chars().take(24).collect();
    if result.trim().is_empty() {
        fallback.trim().to_string()
    } else {
        result.trim().to_string()
    }
}

#[derive(Debug, Clone)]
struct ReminderInsert {
    id: String,
    task_id: Option<String>,
    title: String,
    remind_at: String,
    message: String,
}

#[tauri::command]
pub fn ai_apply_changes(
    state: State<'_, DbState>,
    changes: Vec<ProposedChange>,
) -> Result<ApplyResult, String> {
    if changes.is_empty() {
        return Ok(ApplyResult {
            applied: 0,
            summary: Vec::new(),
            reminder_count: 0,
            undo_available: false,
            undo_remaining: 0,
        });
    }

    // 先做一次数据库文件备份（锁外执行，避免死锁）。
    let _backup_path = db::ai_backup_now(state.inner())?;

    let mut conn = state.conn.lock().map_err(|error| error.to_string())?;
    let mut snapshot = db::load_snapshot_inner(&conn)?
        .ok_or_else(|| "暂无任务数据可供修改".to_string())?;
    let backup_json = serde_json::to_string(&snapshot).map_err(|error| error.to_string())?;
    // 每次应用都存一份快照，支持连续多步撤销（保留最近 20 份）。
    let summary_label = summarize_changes(&changes);
    db::push_ai_snapshot(&conn, &summary_label, &backup_json)?;

    let (summary, reminders) = apply_changes_to_snapshot(&mut snapshot, &changes)?;
    db::save_snapshot_inner(&mut conn, &snapshot)?;

    for reminder in &reminders {
        conn.execute(
            "INSERT INTO ai_reminders(id, task_id, title, remind_at, message, notified)
             VALUES(?1, ?2, ?3, ?4, ?5, 0)",
            rusqlite::params![
                reminder.id,
                reminder.task_id,
                reminder.title,
                reminder.remind_at,
                reminder.message
            ],
        )
        .map_err(|error| error.to_string())?;
    }

    Ok(ApplyResult {
        applied: summary.len(),
        summary,
        reminder_count: reminders.len(),
        undo_available: db::count_ai_snapshots(&conn)? > 0,
        undo_remaining: db::count_ai_snapshots(&conn)? as usize,
    })
}

#[tauri::command]
pub fn ai_undo_changes(state: State<'_, DbState>) -> Result<ApplyResult, String> {
    let mut conn = state.conn.lock().map_err(|error| error.to_string())?;
    let backup_json = db::pop_ai_snapshot(&conn)?.ok_or_else(|| "没有可撤销的修改".to_string())?;
    let snapshot: Snapshot =
        serde_json::from_str(&backup_json).map_err(|error| error.to_string())?;
    db::save_snapshot_inner(&mut conn, &snapshot)?;
    let remaining = db::count_ai_snapshots(&conn)? as usize;
    Ok(ApplyResult {
        applied: 0,
        summary: vec!["已撤销上次 AI 修改，任务计划已恢复".to_string()],
        reminder_count: 0,
        undo_available: remaining > 0,
        undo_remaining: remaining,
    })
}

/// 还剩多少步可以撤销（供界面显示）。
#[tauri::command]
pub fn ai_undo_count(state: State<'_, DbState>) -> Result<usize, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    Ok(db::count_ai_snapshots(&conn)? as usize)
}

/// 把修改列表整理成一句简短说明，作为快照标题。
fn summarize_changes(changes: &[ProposedChange]) -> String {
    let mut updates = 0;
    let mut adds = 0;
    let mut completes = 0;
    let mut deletes = 0;
    let mut reminders = 0;
    for change in changes {
        match change.kind.as_str() {
            "update" => updates += 1,
            "add" => adds += 1,
            "complete" => completes += 1,
            "delete" => deletes += 1,
            "reminder" => reminders += 1,
            _ => {}
        }
    }
    let mut parts = Vec::new();
    if updates > 0 {
        parts.push(format!("修改 {updates} 项"));
    }
    if adds > 0 {
        parts.push(format!("新增 {adds} 项"));
    }
    if completes > 0 {
        parts.push(format!("完成 {completes} 项"));
    }
    if deletes > 0 {
        parts.push(format!("删除 {deletes} 项"));
    }
    if reminders > 0 {
        parts.push(format!("提醒 {reminders} 项"));
    }
    if parts.is_empty() {
        "AI 计划修改".to_string()
    } else {
        parts.join("，")
    }
}

fn apply_changes_to_snapshot(
    snapshot: &mut Snapshot,
    changes: &[ProposedChange],
) -> Result<(Vec<String>, Vec<ReminderInsert>), String> {
    let mut summary = Vec::new();
    let mut reminders = Vec::new();

    for change in changes {
        let result = match change.kind.as_str() {
            "update" => apply_update(snapshot, change),
            "add" => apply_add(snapshot, change),
            "complete" => apply_complete(snapshot, change),
            "delete" => apply_delete(snapshot, change),
            "reminder" => apply_reminder(snapshot, change, &mut reminders),
            other => Err(format!("不支持的修改类型：{other}")),
        };
        match result {
            Ok(description) => summary.push(description),
            Err(error) => summary.push(format!("跳过一条建议：{error}")),
        }
    }
    Ok((summary, reminders))
}

fn clamp_notes(value: &str, max_chars: usize) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= max_chars {
        return value.to_string();
    }
    chars[..max_chars].iter().collect()
}

fn validate_date(value: &str) -> Result<(), String> {
    NaiveDateTime::parse_from_str(&format!("{value} 00:00"), "%Y-%m-%d %H:%M")
        .map(|_| ())
        .map_err(|_| format!("日期格式无效：{value}"))
}

fn validate_time(value: &str) -> Result<(), String> {
    NaiveDateTime::parse_from_str(&format!("2000-01-01 {value}"), "%Y-%m-%d %H:%M")
        .map(|_| ())
        .map_err(|_| format!("时间格式无效：{value}（应为 HH:mm）"))
}

fn resolve_category_id(snapshot: &mut Snapshot, name: &str) -> Option<String> {
    if name.trim().is_empty() {
        return None;
    }
    let existing = snapshot.categories.iter().find(|category| {
        category
            .get("name")
            .and_then(Value::as_str)
            .map(|item| item.eq_ignore_ascii_case(name.trim()))
            .unwrap_or(false)
    });
    if let Some(category) = existing {
        return category.get("id").and_then(Value::as_str).map(ToOwned::to_owned);
    }
    let palette = ["#b8542f", "#355070", "#3f6c51", "#9a6b2f", "#7d5ba6", "#2f7d8c"];
    let id = new_id("category");
    let order = snapshot.categories.len() as i64;
    let color = palette[(order as usize) % palette.len()];
    snapshot.categories.push(json!({
        "id": id,
        "name": name.trim(),
        "color": color,
        "icon": "circle-check-big",
        "order": order,
    }));
    Some(id)
}

fn apply_update(snapshot: &mut Snapshot, change: &ProposedChange) -> Result<String, String> {
    // 先解析分类（可能新建），避免与任务的可变借用冲突。
    let category_id = change
        .category_name
        .as_deref()
        .and_then(|name| resolve_category_id(snapshot, name));
    let task_id = change.task_id.as_deref().unwrap_or("");
    let task = snapshot
        .tasks
        .iter_mut()
        .find(|task| task.get("id").and_then(Value::as_str) == Some(task_id))
        .ok_or_else(|| format!("任务 {task_id} 不存在"))?;
    let mut description = Vec::new();
    if let Some(title) = &change.title {
        task["title"] = json!(title);
        description.push(format!("标题改为「{title}」"));
    }
    if let Some(date) = &change.date {
        validate_date(date)?;
        task["date"] = json!(date);
        description.push(format!("日期改为 {date}"));
    }
    if let Some(start_time) = &change.start_time {
        validate_time(start_time)?;
        task["startTime"] = json!(start_time);
        description.push(format!("时间改为 {start_time}"));
    }
    if let Some(duration) = change.duration_minutes {
        task["durationMinutes"] = json!(duration);
        description.push(format!("时长改为 {duration} 分钟"));
    }
    if let Some(priority) = &change.priority {
        if !["none", "low", "medium", "high"].contains(&priority.as_str()) {
            return Err(format!("优先级无效：{priority}"));
        }
        task["priority"] = json!(priority);
        description.push(format!("优先级改为 {priority}"));
    }
    if let Some(repeat) = &change.repeat {
        if !["none", "daily", "weekly", "weekdays"].contains(&repeat.as_str()) {
            return Err(format!("重复规则无效：{repeat}"));
        }
        task["repeat"] = json!({ "type": repeat });
        description.push(format!("重复改为 {repeat}"));
    }
    if let Some(notes) = &change.notes {
        task["notes"] = json!(clamp_notes(notes, 50));
        description.push("更新了备注".to_string());
    }
    if let (Some(category_id), Some(category_name)) = (&category_id, &change.category_name) {
        task["categoryId"] = json!(category_id);
        description.push(format!("分类改为「{category_name}」"));
    }
    task["updatedAt"] = json!(Local::now().to_rfc3339());
    let title = task
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("任务");
    Ok(format!("修改「{title}」：{}", description.join("；")))
}

fn apply_add(snapshot: &mut Snapshot, change: &ProposedChange) -> Result<String, String> {
    let title = change
        .title
        .as_deref()
        .ok_or_else(|| "新增任务缺少标题".to_string())?
        .trim()
        .to_string();
    let date = change
        .date
        .as_deref()
        .ok_or_else(|| "新增任务缺少日期".to_string())?
        .to_string();
    validate_date(&date)?;
    if let Some(start_time) = &change.start_time {
        validate_time(start_time)?;
    }
    if let Some(priority) = &change.priority {
        if !["none", "low", "medium", "high"].contains(&priority.as_str()) {
            return Err(format!("优先级无效：{priority}"));
        }
    }
    let repeat = change.repeat.clone().unwrap_or_else(|| "none".to_string());
    if !["none", "daily", "weekly", "weekdays"].contains(&repeat.as_str()) {
        return Err(format!("重复规则无效：{repeat}"));
    }
    let category_id = change
        .category_name
        .as_deref()
        .and_then(|name| resolve_category_id(snapshot, name));
    let max_order = snapshot
        .tasks
        .iter()
        .filter_map(|task| task.get("order").and_then(Value::as_i64))
        .max()
        .unwrap_or(0);
    let now = Local::now().to_rfc3339();
    let mut task = json!({
        "id": new_id("task"),
        "title": title,
        "date": date,
        "priority": change.priority.clone().unwrap_or_else(|| "none".to_string()),
        "icon": "circle-check-big",
        "subtasks": [],
        "repeat": { "type": repeat },
        "status": "pending",
        "order": max_order + 1,
        "createdAt": now,
        "updatedAt": now,
        "source": "ai",
    });
    if let Some(start_time) = &change.start_time {
        task["startTime"] = json!(start_time);
    }
    if let Some(duration) = change.duration_minutes {
        task["durationMinutes"] = json!(duration);
    }
    if let Some(category_id) = &category_id {
        task["categoryId"] = json!(category_id);
    }
    if let Some(notes) = &change.notes {
        task["notes"] = json!(clamp_notes(notes, 50));
    }
    snapshot.tasks.push(task);
    Ok(format!("新增任务「{title}」（{date}）"))
}

fn apply_complete(snapshot: &mut Snapshot, change: &ProposedChange) -> Result<String, String> {
    let task_id = change.task_id.as_deref().unwrap_or("");
    let task = snapshot
        .tasks
        .iter_mut()
        .find(|task| task.get("id").and_then(Value::as_str) == Some(task_id))
        .ok_or_else(|| format!("任务 {task_id} 不存在"))?;
    task["status"] = json!("completed");
    task["completedAt"] = json!(Local::now().to_rfc3339());
    task["updatedAt"] = json!(Local::now().to_rfc3339());
    let title = task
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("任务");
    Ok(format!("将「{title}」标记为已完成"))
}

fn apply_delete(snapshot: &mut Snapshot, change: &ProposedChange) -> Result<String, String> {
    let task_id = change.task_id.as_deref().unwrap_or("");
    let before = snapshot.tasks.len();
    snapshot
        .tasks
        .retain(|task| task.get("id").and_then(Value::as_str) != Some(task_id));
    if snapshot.tasks.len() == before {
        return Err(format!("任务 {task_id} 不存在"));
    }
    Ok(format!("删除任务 {task_id}"))
}

fn apply_reminder(
    snapshot: &Snapshot,
    change: &ProposedChange,
    reminders: &mut Vec<ReminderInsert>,
) -> Result<String, String> {
    let title = match &change.task_id {
        Some(task_id) => snapshot
            .tasks
            .iter()
            .find(|task| task.get("id").and_then(Value::as_str) == Some(task_id.as_str()))
            .and_then(|task| task.get("title").and_then(Value::as_str))
            .map(ToOwned::to_owned)
            .or_else(|| change.title.clone())
            .unwrap_or_else(|| "任务提醒".to_string()),
        None => change.title.clone().unwrap_or_else(|| "任务提醒".to_string()),
    };
    let remind_at = compute_remind_at(change, &snapshot.tasks)?;
    let message = change
        .message
        .clone()
        .unwrap_or_else(|| format!("准备开始：{title}"));
    reminders.push(ReminderInsert {
        id: new_id("rem"),
        task_id: change.task_id.clone(),
        title: title.clone(),
        remind_at: remind_at.clone(),
        message,
    });
    Ok(format!("创建提醒「{title}」({remind_at})"))
}

fn compute_remind_at(change: &ProposedChange, tasks: &[Value]) -> Result<String, String> {
    if let Some(raw) = &change.remind_at {
        if let Ok(parsed) = DateTime::parse_from_rfc3339(raw) {
            return Ok(parsed.to_rfc3339());
        }
        for format in ["%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M"] {
            if let Ok(naive) = NaiveDateTime::parse_from_str(raw, format) {
                if let Some(local) = Local.from_local_datetime(&naive).single() {
                    return Ok(local.to_rfc3339());
                }
            }
        }
        return Err(format!("无法解析提醒时间：{raw}"));
    }
    let task_id = change
        .task_id
        .as_deref()
        .ok_or_else(|| "提醒缺少 task_id 或 remind_at".to_string())?;
    let task = tasks
        .iter()
        .find(|task| task.get("id").and_then(Value::as_str) == Some(task_id))
        .ok_or_else(|| "提醒引用的任务不存在".to_string())?;
    let date = task
        .get("date")
        .and_then(Value::as_str)
        .ok_or_else(|| "任务缺少日期，无法推算提醒时间".to_string())?;
    let start_time = task
        .get("startTime")
        .and_then(Value::as_str)
        .ok_or_else(|| "任务缺少开始时间，请提供 remind_at".to_string())?;
    let naive = NaiveDateTime::parse_from_str(&format!("{date} {start_time}"), "%Y-%m-%d %H:%M")
        .map_err(|_| "任务时间格式无效".to_string())?;
    let local = Local
        .from_local_datetime(&naive)
        .single()
        .ok_or_else(|| "无法解析本地时间".to_string())?;
    let minutes = change.minutes_before.unwrap_or(15) as i64;
    Ok((local - Duration::minutes(minutes)).to_rfc3339())
}

// ---------------------------------------------------------------------------
// 提醒轮询（仅应用运行期间生效）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn ai_poll_reminders(state: State<'_, DbState>) -> Result<Vec<ReminderView>, String> {
    let conn = state.conn.lock().map_err(|error| error.to_string())?;
    let now = Local::now().to_rfc3339();
    let mut stmt = conn
        .prepare(
            "SELECT id, task_id, title, remind_at, message FROM ai_reminders
             WHERE notified = 0 AND remind_at <= ?1 ORDER BY remind_at ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([&now], |row| {
            Ok(ReminderView {
                id: row.get(0)?,
                task_id: row.get(1)?,
                title: row.get(2)?,
                remind_at: row.get(3)?,
                message: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?;

    let mut due = Vec::new();
    for row in rows {
        let reminder = row.map_err(|error| error.to_string())?;
        let skip = match &reminder.task_id {
            Some(task_id) => {
                let status: Option<String> = conn
                    .query_row(
                        "SELECT status FROM tasks WHERE id = ?1",
                        [task_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| error.to_string())?;
                match status.as_deref() {
                    Some("pending") => false,
                    _ => true,
                }
            }
            None => false,
        };
        conn.execute(
            "UPDATE ai_reminders SET notified = 1 WHERE id = ?1",
            [&reminder.id],
        )
        .map_err(|error| error.to_string())?;
        if !skip {
            due.push(reminder);
        }
    }

    // 清理 7 天前已通知的提醒。
    let cutoff = (Local::now() - Duration::days(7)).to_rfc3339();
    conn.execute(
        "DELETE FROM ai_reminders WHERE notified = 1 AND remind_at < ?1",
        [&cutoff],
    )
    .map_err(|error| error.to_string())?;

    Ok(due)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_snapshot() -> Snapshot {
        Snapshot {
            version: 1,
            meta: None,
            tasks: vec![
                json!({
                    "id": "task_a",
                    "title": "写周报",
                    "date": "2026-09-29",
                    "status": "pending",
                    "order": 0,
                    "updatedAt": "2026-09-29T08:00:00+08:00",
                    "priority": "low",
                    "subtasks": []
                }),
                json!({
                    "id": "task_b",
                    "title": "开会",
                    "date": "2026-09-29",
                    "startTime": "10:00",
                    "status": "pending",
                    "order": 1,
                    "updatedAt": "2026-09-29T08:00:00+08:00",
                    "priority": "medium",
                    "subtasks": []
                }),
            ],
            goals: Vec::new(),
            categories: Vec::new(),
            settings: json!({}),
        }
    }

    #[test]
    fn update_and_add_are_applied() {
        let mut snapshot = sample_snapshot();
        let changes = vec![
            ProposedChange {
                kind: "update".to_string(),
                task_id: Some("task_a".to_string()),
                priority: Some("high".to_string()),
                ..ProposedChange::default()
            },
            ProposedChange {
                kind: "add".to_string(),
                title: Some("新任务".to_string()),
                date: Some("2026-09-30".to_string()),
                duration_minutes: Some(30),
                ..ProposedChange::default()
            },
        ];
        let (summary, reminders) = apply_changes_to_snapshot(&mut snapshot, &changes).unwrap();
        assert_eq!(summary.len(), 2);
        assert!(reminders.is_empty());

        let updated = snapshot
            .tasks
            .iter()
            .find(|task| task["id"] == "task_a")
            .unwrap();
        assert_eq!(updated["priority"], "high");

        let added = snapshot
            .tasks
            .iter()
            .find(|task| task["title"] == "新任务")
            .unwrap();
        assert_eq!(added["durationMinutes"], 30);
        assert!(added.get("notes").is_none());
        assert_eq!(added["date"], "2026-09-30");
    }

    #[test]
    fn invalid_reminder_is_skipped_with_notice() {
        let mut snapshot = sample_snapshot();
        // task_a 没有开始时间，无法推算提醒时间 → 跳过并给出说明。
        let changes = vec![ProposedChange {
            kind: "reminder".to_string(),
            task_id: Some("task_a".to_string()),
            minutes_before: Some(10),
            ..ProposedChange::default()
        }];
        let (summary, reminders) = apply_changes_to_snapshot(&mut snapshot, &changes).unwrap();
        assert_eq!(summary.len(), 1);
        assert!(summary[0].starts_with("跳过"));
        assert!(reminders.is_empty());
    }

    #[test]
    fn reminder_uses_task_start_time() {
        let mut snapshot = sample_snapshot();
        let changes = vec![ProposedChange {
            kind: "reminder".to_string(),
            task_id: Some("task_b".to_string()),
            minutes_before: Some(15),
            ..ProposedChange::default()
        }];
        let (summary, reminders) = apply_changes_to_snapshot(&mut snapshot, &changes).unwrap();
        assert_eq!(summary.len(), 1);
        assert_eq!(reminders.len(), 1);
        // 10:00 提前 15 分钟 → 09:45（本地时区）。
        assert!(reminders[0].remind_at.contains("09:45"));
        assert!(reminders[0].message.contains("写周报") || reminders[0].message.contains("开会"));
    }

    #[test]
    fn delete_and_complete_work_on_existing_tasks() {
        let mut snapshot = sample_snapshot();
        let changes = vec![
            ProposedChange {
                kind: "complete".to_string(),
                task_id: Some("task_a".to_string()),
                ..ProposedChange::default()
            },
            ProposedChange {
                kind: "delete".to_string(),
                task_id: Some("task_b".to_string()),
                ..ProposedChange::default()
            },
        ];
        let (summary, _) = apply_changes_to_snapshot(&mut snapshot, &changes).unwrap();
        assert_eq!(summary.len(), 2);
        let completed = snapshot
            .tasks
            .iter()
            .find(|task| task["id"] == "task_a")
            .unwrap();
        assert_eq!(completed["status"], "completed");
        assert!(snapshot.tasks.iter().all(|task| task["id"] != "task_b"));
    }
}
