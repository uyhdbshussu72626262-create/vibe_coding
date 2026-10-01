//! 常用 OpenAI 兼容服务商的预设：Base URL、默认模型与模型建议。
//! 全部走 Rust 网络层，密钥使用 DPAPI 加密后保存在本地 SQLite。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Deepseek,
    OpenAI,
    Moonshot,
    Siliconflow,
    Openrouter,
    Custom,
    Mock,
}

impl ProviderKind {
    pub fn parse(value: &str) -> Self {
        match value.to_ascii_lowercase().as_str() {
            "deepseek" => ProviderKind::Deepseek,
            "openai" => ProviderKind::OpenAI,
            "moonshot" => ProviderKind::Moonshot,
            "siliconflow" => ProviderKind::Siliconflow,
            "openrouter" => ProviderKind::Openrouter,
            "mock" => ProviderKind::Mock,
            _ => ProviderKind::Custom,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderKind::Deepseek => "deepseek",
            ProviderKind::OpenAI => "openai",
            ProviderKind::Moonshot => "moonshot",
            ProviderKind::Siliconflow => "siliconflow",
            ProviderKind::Openrouter => "openrouter",
            ProviderKind::Custom => "custom",
            ProviderKind::Mock => "mock",
        }
    }

    pub fn default_base_url(&self) -> &'static str {
        match self {
            ProviderKind::Deepseek => "https://api.deepseek.com/v1",
            ProviderKind::OpenAI => "https://api.openai.com/v1",
            ProviderKind::Moonshot => "https://api.moonshot.cn/v1",
            ProviderKind::Siliconflow => "https://api.siliconflow.cn/v1",
            ProviderKind::Openrouter => "https://openrouter.ai/api/v1",
            ProviderKind::Custom => "",
            ProviderKind::Mock => "",
        }
    }

    pub fn default_model(&self) -> &'static str {
        match self {
            ProviderKind::Deepseek => "deepseek-chat",
            ProviderKind::OpenAI => "gpt-4o-mini",
            ProviderKind::Moonshot => "moonshot-v1-8k",
            ProviderKind::Siliconflow => "deepseek-ai/DeepSeek-V3",
            ProviderKind::Openrouter => "openai/gpt-4o-mini",
            ProviderKind::Custom => "",
            ProviderKind::Mock => "mock-model",
        }
    }

    pub fn model_suggestions(&self) -> &'static [&'static str] {
        match self {
            ProviderKind::Deepseek => &["deepseek-chat", "deepseek-reasoner"],
            ProviderKind::OpenAI => &["gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1", "o4-mini"],
            ProviderKind::Moonshot => &[
                "moonshot-v1-8k",
                "moonshot-v1-32k",
                "moonshot-v1-128k",
                "kimi-k2-turbo-preview",
            ],
            ProviderKind::Siliconflow => &[
                "deepseek-ai/DeepSeek-V3",
                "deepseek-ai/DeepSeek-R1",
                "Qwen/Qwen2.5-72B-Instruct",
                "Qwen/Qwen2.5-7B-Instruct",
            ],
            ProviderKind::Openrouter => &[
                "openai/gpt-4o-mini",
                "openai/gpt-4o",
                "anthropic/claude-3.5-sonnet",
                "deepseek/deepseek-chat",
            ],
            ProviderKind::Custom => &[],
            ProviderKind::Mock => &["mock-model"],
        }
    }
}

/// 预设列表，供前端渲染“添加提供商”表单。
#[derive(Debug, Clone, Serialize)]
pub struct ProviderPreset {
    pub kind: String,
    pub label: String,
    pub base_url: String,
    pub default_model: String,
    pub models: Vec<String>,
}

pub fn presets(mock_base_url: &str) -> Vec<ProviderPreset> {
    let kinds = [
        ProviderKind::Deepseek,
        ProviderKind::OpenAI,
        ProviderKind::Moonshot,
        ProviderKind::Siliconflow,
        ProviderKind::Openrouter,
        ProviderKind::Custom,
    ];
    kinds
        .iter()
        .map(|kind| ProviderPreset {
            kind: kind.as_str().to_string(),
            label: match kind {
                ProviderKind::Deepseek => "DeepSeek".to_string(),
                ProviderKind::OpenAI => "OpenAI".to_string(),
                ProviderKind::Moonshot => "Moonshot (月之暗面)".to_string(),
                ProviderKind::Siliconflow => "SiliconFlow (硅基流动)".to_string(),
                ProviderKind::Openrouter => "OpenRouter".to_string(),
                ProviderKind::Custom => "自定义".to_string(),
                ProviderKind::Mock => "本地模拟（免密钥测试）".to_string(),
            },
            base_url: if *kind == ProviderKind::Mock {
                mock_base_url.to_string()
            } else {
                kind.default_base_url().to_string()
            },
            default_model: kind.default_model().to_string(),
            models: kind.model_suggestions().iter().map(|s| s.to_string()).collect(),
        })
        .collect()
}
