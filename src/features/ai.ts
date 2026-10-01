// AI 助手前端的公共类型与工具（云端请求全部发生在 Rust 层）。

export interface AiProvider {
  id: string;
  name: string;
  kind: string;
  base_url: string;
  model: string;
  has_key: boolean;
  is_active: boolean;
}

export interface SaveProviderRequest {
  id?: string;
  name: string;
  kind: string;
  base_url: string;
  model: string;
  api_key?: string | null;
}

export interface AiProviderPreset {
  kind: string;
  label: string;
  base_url: string;
  default_model: string;
  models: string[];
}

export interface AiSettings {
  active_provider_id: string | null;
  system_prompt: string;
  privacy_accepted: boolean;
  mock_base_url: string;
}

export interface AiMessage {
  id: number;
  role: 'user' | 'assistant' | string;
  content: string;
  /** 用户上传的图片（data URL），为空表示没有附件。 */
  image?: string;
  /** 图片文件名，用于界面展示。 */
  image_name?: string;
  created_at: string;
}

export interface AiConversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  preview: string;
}

export interface ProposedChange {
  kind: string;
  task_id?: string | null;
  title?: string | null;
  date?: string | null;
  start_time?: string | null;
  duration_minutes?: number | null;
  priority?: string | null;
  category_name?: string | null;
  repeat?: string | null;
  notes?: string | null;
  minutes_before?: number | null;
  remind_at?: string | null;
  message?: string | null;
  reason?: string | null;
}

export interface ChatRequest {
  request_id: string;
  conversation_id?: string | null;
  provider_id?: string | null;
  message: string;
  mode: 'chat' | 'analyze_today' | 'analyze_week' | 'propose_changes';
  language?: string;
  temperature?: number;
  /** 附带图片（data URL），多模态模型可直接读取。 */
  image?: string | null;
  /** 图片文件名。 */
  image_name?: string | null;
  /** 是否先联网搜索再回答。 */
  web_search?: boolean;
}

export interface AiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ApplyResult {
  applied: number;
  summary: string[];
  reminder_count: number;
  undo_available: boolean;
  undo_remaining?: number;
}

export interface WebSource {
  title: string;
  snippet: string;
  url: string;
  text?: string;
}

export interface AiReminder {
  id: string;
  task_id: string | null;
  title: string;
  remind_at: string;
  message: string;
}

export type StreamEvent =
  | { type: 'started'; request_id: string; conversation_id: string }
  | { type: 'delta'; content: string }
  | { type: 'sources'; items: WebSource[]; note?: string | null }
  | { type: 'tool_proposal'; id: string; name: string; changes: ProposedChange[] }
  | { type: 'usage'; prompt_tokens: number; completion_tokens: number; total_tokens: number }
  | { type: 'done' }
  | { type: 'stopped' }
  | { type: 'title'; conversation_id: string; title: string }
  | { type: 'error'; message: string };

export const PROVIDER_KIND_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  moonshot: 'Moonshot',
  siliconflow: 'SiliconFlow',
  openrouter: 'OpenRouter',
  custom: '自定义',
  mock: '本地模拟',
};

export function providerKindLabel(kind: string): string {
  return PROVIDER_KIND_LABELS[kind] || kind;
}

export function changeKindLabel(kind: string, language: 'zh-CN' | 'en'): string {
  const zh: Record<string, string> = {
    update: '修改任务',
    add: '新增任务',
    complete: '标记完成',
    delete: '删除任务',
    reminder: '创建提醒',
  };
  const en: Record<string, string> = {
    update: 'Update',
    add: 'Add',
    complete: 'Complete',
    delete: 'Delete',
    reminder: 'Reminder',
  };
  const table = language === 'zh-CN' ? zh : en;
  return table[kind] || kind;
}

export function describeChange(
  change: ProposedChange,
  language: 'zh-CN' | 'en',
): string {
  const zh = language === 'zh-CN';
  const parts: string[] = [];
  if (change.title) parts.push(change.title);
  if (change.date) parts.push(change.date);
  if (change.start_time) parts.push(change.start_time);
  if (change.duration_minutes)
    parts.push(zh ? `${change.duration_minutes} 分钟` : `${change.duration_minutes} min`);
  if (change.priority)
    parts.push(
      zh
        ? `优先级 ${change.priority}`
        : `priority ${change.priority}`,
    );
  if (change.category_name) parts.push(change.category_name);
  if (change.repeat) parts.push(zh ? `重复 ${change.repeat}` : `repeat ${change.repeat}`);
  if (change.minutes_before)
    parts.push(
      zh
        ? `提前 ${change.minutes_before} 分钟`
        : `${change.minutes_before} min before`,
    );
  if (change.remind_at) parts.push(change.remind_at);
  return parts.join(' · ');
}
