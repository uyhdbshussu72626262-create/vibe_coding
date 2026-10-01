//! AI 模块的公共数据类型：聊天请求、流式事件、计划修改建议等。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatMode {
    #[default]
    Chat,
    AnalyzeToday,
    AnalyzeWeek,
    ProposeChanges,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    #[serde(default)]
    pub request_id: String,
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
    pub message: String,
    #[serde(default)]
    pub mode: ChatMode,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub temperature: Option<f32>,
    /// 用户上传的图片（data URL，多模态模型可直接读取）。
    #[serde(default)]
    pub image: Option<String>,
    /// 图片文件名（用于界面显示，不参与模型请求）。
    #[serde(default)]
    pub image_name: Option<String>,
    /// 是否先联网搜索再回答。
    #[serde(default)]
    pub web_search: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    System,
    User,
    Assistant,
}

impl Role {
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
    /// 仅用户消息可能带图片（data URL）。
    #[serde(default)]
    pub image: Option<String>,
}

/// 推送给前端的流式事件。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    Started {
        request_id: String,
        conversation_id: String,
    },
    Delta {
        content: String,
    },
    /// 联网搜索得到的参考来源。
    Sources {
        items: Vec<WebSource>,
        /// 搜索失败时的说明（前端以提示形式展示）。
        #[serde(default)]
        note: Option<String>,
    },
    ToolProposal {
        id: String,
        name: String,
        changes: Vec<ProposedChange>,
    },
    Usage {
        prompt_tokens: u32,
        completion_tokens: u32,
        total_tokens: u32,
    },
    Done,
    Stopped,
    /// 首轮对话结束后由模型总结出的短标题。
    Title {
        conversation_id: String,
        title: String,
    },
    Error {
        message: String,
    },
}

/// AI 提出的一条计划修改操作，用户确认后才允许落地。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProposedChange {
    pub kind: String,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub duration_minutes: Option<u32>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub category_name: Option<String>,
    #[serde(default)]
    pub repeat: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub minutes_before: Option<u32>,
    #[serde(default)]
    pub remind_at: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderView {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub base_url: String,
    pub model: String,
    pub has_key: bool,
    pub is_active: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SaveProviderRequest {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub kind: String,
    pub base_url: String,
    pub model: String,
    /// None 表示保持已保存的密钥不变；Some 表示更新密钥。
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiSettingsView {
    pub active_provider_id: Option<String>,
    pub system_prompt: String,
    pub privacy_accepted: bool,
    pub mock_base_url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiMessageView {
    pub id: i64,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub image: String,
    #[serde(default)]
    pub image_name: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConversationView {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: i64,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReminderView {
    pub id: String,
    pub task_id: Option<String>,
    pub title: String,
    pub remind_at: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApplyResult {
    pub applied: usize,
    pub summary: Vec<String>,
    pub reminder_count: usize,
    pub undo_available: bool,
    pub undo_remaining: usize,
}

/// 联网搜索的一条结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSource {
    pub title: String,
    pub snippet: String,
    pub url: String,
    /// 抓取到的页面正文（可为空）。
    #[serde(default)]
    pub text: String,
}
