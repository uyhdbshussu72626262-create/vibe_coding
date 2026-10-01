import { Channel, invoke } from '@tauri-apps/api/core';
import type { AppData } from '../types';
import { cloneAppData } from '../core';
import type {
  AiConversation,
  AiMessage,
  AiProvider,
  AiProviderPreset,
  AiReminder,
  AiSettings,
  ApplyResult,
  ChatRequest,
  ProposedChange,
  SaveProviderRequest,
  StreamEvent,
  WebSource,
} from '../features/ai';

export interface TextFilePayload {
  path: string;
  contents: string;
}

export interface Repository {
  readonly kind: 'tauri' | 'local';
  load(): Promise<AppData | null>;
  save(data: AppData): Promise<void>;
  backup(): Promise<string | null>;
  listBackups(): Promise<string[]>;
  saveTextFile(defaultName: string, contents: string): Promise<string | null>;
  openTextFile(): Promise<TextFilePayload | null>;
  notify(title: string, body: string): Promise<void>;
  setAutostart(enabled: boolean): Promise<void>;
  getAutostart(): Promise<boolean>;
  setCloseToTray(enabled: boolean): Promise<void>;
  updaterStatus(): Promise<string>;
  openBackupFolder(): Promise<void>;
  listProviders(): Promise<AiProvider[]>;
  getPresets(): Promise<AiProviderPreset[]>;
  saveProvider(request: SaveProviderRequest): Promise<AiProvider>;
  deleteProvider(id: string): Promise<void>;
  setActiveProvider(id: string | null): Promise<void>;
  getAiSettings(): Promise<AiSettings>;
  setSystemPrompt(prompt: string): Promise<void>;
  acceptPrivacy(): Promise<void>;
  testProvider(id?: string | null): Promise<string>;
  listConversations(): Promise<AiConversation[]>;
  createConversation(title?: string): Promise<AiConversation>;
  deleteConversation(id: string): Promise<void>;
  renameConversation(id: string, title: string): Promise<void>;
  listAiMessages(conversationId: string): Promise<AiMessage[]>;
  clearAiMessages(conversationId: string): Promise<void>;
  stopGeneration(requestId: string): Promise<void>;
  chatStream(request: ChatRequest, channel: Channel<StreamEvent>): Promise<void>;
  applyAiChanges(changes: ProposedChange[]): Promise<ApplyResult>;
  undoAiChanges(): Promise<ApplyResult>;
  aiUndoCount(): Promise<number>;
  pollAiReminders(): Promise<AiReminder[]>;
  fetchRemoteImage(url: string): Promise<string>;
  webSearch(query: string, limit?: number): Promise<WebSource[]>;
  openExternalUrl(url: string): Promise<void>;
  kvGet(key: string): Promise<string | null>;
  kvSet(key: string, value: string): Promise<void>;
  kvDelete(key: string): Promise<void>;
  undoPush(payload: AppData): Promise<number>;
  undoPop(): Promise<AppData | null>;
  undoClear(): Promise<void>;
  undoList(): Promise<AppData[]>;
}

export function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  );
}

export class TauriRepository implements Repository {
  readonly kind = 'tauri' as const;

  async load(): Promise<AppData | null> {
    return invoke<AppData | null>('load_snapshot');
  }

  async save(data: AppData): Promise<void> {
    await invoke('save_snapshot', { data });
  }

  async backup(): Promise<string | null> {
    return invoke<string | null>('backup_database');
  }

  async listBackups(): Promise<string[]> {
    return invoke<string[]>('list_backups');
  }

  async saveTextFile(defaultName: string, contents: string): Promise<string | null> {
    return invoke<string | null>('save_text_file', { defaultName, contents });
  }

  async openTextFile(): Promise<TextFilePayload | null> {
    return invoke<TextFilePayload | null>('open_text_file');
  }

  async notify(title: string, body: string): Promise<void> {
    await invoke('notify', { title, body });
  }

  async setAutostart(enabled: boolean): Promise<void> {
    await invoke('autostart_set', { enabled });
  }

  async getAutostart(): Promise<boolean> {
    return invoke<boolean>('autostart_get');
  }

  async setCloseToTray(enabled: boolean): Promise<void> {
    await invoke('set_close_to_tray', { enabled });
  }

  async updaterStatus(): Promise<string> {
    return invoke<string>('updater_status');
  }

  async openBackupFolder(): Promise<void> {
    await invoke('open_backup_folder');
  }

  async listProviders(): Promise<AiProvider[]> {
    return invoke<AiProvider[]>('ai_list_providers');
  }

  async getPresets(): Promise<AiProviderPreset[]> {
    return invoke<AiProviderPreset[]>('ai_presets');
  }

  async saveProvider(request: SaveProviderRequest): Promise<AiProvider> {
    return invoke<AiProvider>('ai_save_provider', { request });
  }

  async deleteProvider(id: string): Promise<void> {
    await invoke('ai_delete_provider', { id });
  }

  async setActiveProvider(id: string | null): Promise<void> {
    await invoke('ai_set_active_provider', { id });
  }

  async getAiSettings(): Promise<AiSettings> {
    return invoke<AiSettings>('ai_get_settings');
  }

  async setSystemPrompt(prompt: string): Promise<void> {
    await invoke('ai_set_system_prompt', { prompt });
  }

  async acceptPrivacy(): Promise<void> {
    await invoke('ai_accept_privacy');
  }

  async testProvider(id?: string | null): Promise<string> {
    return invoke<string>('ai_test_provider', { providerId: id });
  }

  async listConversations(): Promise<AiConversation[]> {
    return invoke<AiConversation[]>('ai_list_conversations');
  }

  async createConversation(title?: string): Promise<AiConversation> {
    return invoke<AiConversation>('ai_create_conversation', { title: title ?? null });
  }

  async deleteConversation(id: string): Promise<void> {
    await invoke('ai_delete_conversation', { conversationId: id });
  }

  async renameConversation(id: string, title: string): Promise<void> {
    await invoke('ai_rename_conversation', { conversationId: id, title });
  }

  async listAiMessages(conversationId: string): Promise<AiMessage[]> {
    return invoke<AiMessage[]>('ai_list_messages', { conversationId });
  }

  async clearAiMessages(conversationId: string): Promise<void> {
    await invoke('ai_clear_messages', { conversationId });
  }

  async stopGeneration(requestId: string): Promise<void> {
    await invoke('ai_stop_generation', { requestId });
  }

  async chatStream(request: ChatRequest, channel: Channel<StreamEvent>): Promise<void> {
    await invoke('ai_chat_stream', { channel, request });
  }

  async applyAiChanges(changes: ProposedChange[]): Promise<ApplyResult> {
    return invoke<ApplyResult>('ai_apply_changes', { changes });
  }

  async undoAiChanges(): Promise<ApplyResult> {
    return invoke<ApplyResult>('ai_undo_changes');
  }

  async pollAiReminders(): Promise<AiReminder[]> {
    return invoke<AiReminder[]>('ai_poll_reminders');
  }

  async aiUndoCount(): Promise<number> {
    return invoke<number>('ai_undo_count');
  }

  async fetchRemoteImage(url: string): Promise<string> {
    return invoke<string>('ai_fetch_image', { url });
  }

  async webSearch(query: string, limit = 5): Promise<WebSource[]> {
    return invoke<WebSource[]>('ai_web_search', { query, limit });
  }

  async openExternalUrl(url: string): Promise<void> {
    await invoke('open_external_url', { url });
  }

  async kvGet(key: string): Promise<string | null> {
    return invoke<string | null>('kv_get', { key });
  }

  async kvSet(key: string, value: string): Promise<void> {
    await invoke('kv_set', { key, value });
  }

  async kvDelete(key: string): Promise<void> {
    await invoke('kv_delete', { key });
  }

  async undoPush(payload: AppData): Promise<number> {
    return invoke<number>('undo_push', { payload });
  }

  async undoPop(): Promise<AppData | null> {
    return invoke<AppData | null>('undo_pop');
  }

  async undoClear(): Promise<void> {
    await invoke('undo_clear');
  }

  async undoList(): Promise<AppData[]> {
    return invoke<AppData[]>('undo_list');
  }
}

export class LocalStorageRepository implements Repository {
  readonly kind = 'local' as const;
  private undoStack: AppData[] = [];

  constructor(private readonly key = 'daynora.dev-data-v1') {}

  async load(): Promise<AppData | null> {
    try {
      const raw = window.localStorage.getItem(this.key);
      return raw ? (JSON.parse(raw) as AppData) : null;
    } catch {
      return null;
    }
  }

  async save(data: AppData): Promise<void> {
    try {
      window.localStorage.setItem(this.key, JSON.stringify(data));
    } catch {
      // 浏览器隐私模式或存储空间不足时忽略，桌面版会使用 SQLite。
    }
  }

  async backup(): Promise<string | null> {
    return null;
  }

  async listBackups(): Promise<string[]> {
    return [];
  }

  async saveTextFile(defaultName: string, contents: string): Promise<string | null> {
    const blob = new Blob([contents], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = defaultName;
    anchor.click();
    URL.revokeObjectURL(url);
    return 'browser-download';
  }

  async openTextFile(): Promise<TextFilePayload | null> {
    type PickerWindow = {
      showOpenFilePicker?: () => Promise<Array<{ getFile(): Promise<File> }>>;
    };
    const picker = (window as unknown as PickerWindow).showOpenFilePicker;
    if (picker) {
      const handles = await picker();
      const file = await handles[0].getFile();
      return { path: file.name, contents: await file.text() };
    }
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,.csv,.md,.markdown,.txt';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        resolve({ path: file.name, contents: await file.text() });
      };
      input.click();
    });
  }

  async notify(): Promise<void> {
    // 浏览器开发环境不弹系统通知。
  }

  async setAutostart(): Promise<void> {
    // 浏览器开发环境不支持开机自启。
  }

  async getAutostart(): Promise<boolean> {
    return false;
  }

  async setCloseToTray(): Promise<void> {
    // 浏览器开发环境不支持托盘。
  }

  async updaterStatus(): Promise<string> {
    return 'disabled';
  }

  async openBackupFolder(): Promise<void> {
    // 浏览器开发环境不支持打开本机文件夹。
  }

  async listProviders(): Promise<AiProvider[]> {
    return [];
  }

  async getPresets(): Promise<AiProviderPreset[]> {
    return [];
  }

  async saveProvider(): Promise<AiProvider> {
    throw new Error('浏览器开发环境不支持 AI 提供商');
  }

  async deleteProvider(): Promise<void> {}

  async setActiveProvider(): Promise<void> {}

  async getAiSettings(): Promise<AiSettings> {
    return {
      active_provider_id: null,
      system_prompt: '',
      privacy_accepted: false,
      mock_base_url: '',
    };
  }

  async setSystemPrompt(): Promise<void> {}

  async acceptPrivacy(): Promise<void> {}

  async testProvider(): Promise<string> {
    throw new Error('浏览器开发环境不支持连接 AI');
  }

  async listConversations(): Promise<AiConversation[]> {
    return [];
  }

  async createConversation(): Promise<AiConversation> {
    const now = new Date().toISOString();
    return {
      id: `conv_${Date.now().toString(36)}`,
      title: '新对话',
      created_at: now,
      updated_at: now,
      message_count: 0,
      preview: '',
    };
  }

  async deleteConversation(): Promise<void> {}

  async renameConversation(): Promise<void> {}

  async listAiMessages(): Promise<AiMessage[]> {
    return [];
  }

  async clearAiMessages(): Promise<void> {}

  async stopGeneration(): Promise<void> {}

  async chatStream(request: ChatRequest, channel: Channel<StreamEvent>): Promise<void> {
    // 浏览器开发环境的模拟回复：顺带覆盖 Markdown、代码高亮与公式渲染。
    const reply = [
      '（浏览器开发环境模拟回复）桌面版会通过 Rust 层连接你配置的 OpenAI 兼容接口，这里用于预览排版效果。',
      '',
      '```rust',
      'fn main() {',
      '    let plan = vec!["晨间阅读", "深度工作", "复盘"];',
      '    println!("今天要做 {} 件事", plan.len());',
      '}',
      '```',
      '',
      '- 支持列表、**加粗**、`行内代码` 与引用',
      '- 行内公式 $E = mc^2$，块级公式：',
      '',
      '$$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$',
      '',
      '> 提示：把鼠标移到代码块右上角可以复制整段代码。',
      '',
      '参考链接（用于验证点击后应交给系统浏览器打开）：[Daynora 示例链接](https://example.com/daynora-link-test)',
    ].join('\n');
    channel.onmessage?.({ type: 'started', request_id: request.request_id } as StreamEvent);
    let index = 0;
    while (index < reply.length) {
      channel.onmessage?.({
        type: 'delta',
        content: reply.slice(index, index + 6),
      } as StreamEvent);
      index += 6;
      await new Promise((resolve) => window.setTimeout(resolve, 24));
    }
    channel.onmessage?.({
      type: 'usage',
      prompt_tokens: 10,
      completion_tokens: 40,
      total_tokens: 50,
    } as StreamEvent);
    channel.onmessage?.({ type: 'done' } as StreamEvent);
  }

  async applyAiChanges(): Promise<ApplyResult> {
    throw new Error('浏览器开发环境不支持修改计划');
  }

  async undoAiChanges(): Promise<ApplyResult> {
    throw new Error('浏览器开发环境不支持修改计划');
  }

  async pollAiReminders(): Promise<AiReminder[]> {
    return [];
  }

  async aiUndoCount(): Promise<number> {
    return 0;
  }

  async fetchRemoteImage(): Promise<string> {
    throw new Error('浏览器开发环境不支持加载远程图片');
  }

  async webSearch(): Promise<WebSource[]> {
    throw new Error('浏览器开发环境不支持联网搜索');
  }

  async openExternalUrl(url: string): Promise<void> {
    window.open(url, '_blank', 'noopener');
  }

  async kvGet(key: string): Promise<string | null> {
    try {
      return window.localStorage.getItem(`daynora.kv.${key}`);
    } catch {
      return null;
    }
  }

  async kvSet(key: string, value: string): Promise<void> {
    try {
      window.localStorage.setItem(`daynora.kv.${key}`, value);
    } catch {
      // 忽略隐私模式下的存储失败。
    }
  }

  async kvDelete(key: string): Promise<void> {
    try {
      window.localStorage.removeItem(`daynora.kv.${key}`);
    } catch {
      // 忽略。
    }
  }

  async undoPush(payload: AppData): Promise<number> {
    this.undoStack.push(cloneAppData(payload));
    if (this.undoStack.length > 15) this.undoStack.shift();
    return this.undoStack.length;
  }

  async undoPop(): Promise<AppData | null> {
    return this.undoStack.pop() ?? null;
  }

  async undoClear(): Promise<void> {
    this.undoStack = [];
  }

  async undoList(): Promise<AppData[]> {
    return this.undoStack.map((item) => cloneAppData(item));
  }
}

export class MemoryRepository implements Repository {
  readonly kind = 'local' as const;
  private data: AppData | null = null;
  private undoStack: AppData[] = [];

  async load(): Promise<AppData | null> {
    return this.data ? cloneAppData(this.data) : null;
  }

  async save(data: AppData): Promise<void> {
    this.data = cloneAppData(data);
  }

  async backup(): Promise<string | null> {
    return null;
  }

  async listBackups(): Promise<string[]> {
    return [];
  }

  async saveTextFile(): Promise<string | null> {
    return null;
  }

  async openTextFile(): Promise<TextFilePayload | null> {
    return null;
  }

  async notify(): Promise<void> {}

  async setAutostart(): Promise<void> {}

  async getAutostart(): Promise<boolean> {
    return false;
  }

  async setCloseToTray(): Promise<void> {}

  async updaterStatus(): Promise<string> {
    return 'disabled';
  }

  async openBackupFolder(): Promise<void> {}

  async listProviders(): Promise<AiProvider[]> {
    return [];
  }

  async getPresets(): Promise<AiProviderPreset[]> {
    return [];
  }

  async saveProvider(): Promise<AiProvider> {
    throw new Error('内存仓库不支持 AI 提供商');
  }

  async deleteProvider(): Promise<void> {}

  async setActiveProvider(): Promise<void> {}

  async getAiSettings(): Promise<AiSettings> {
    return {
      active_provider_id: null,
      system_prompt: '',
      privacy_accepted: true,
      mock_base_url: '',
    };
  }

  async setSystemPrompt(): Promise<void> {}

  async acceptPrivacy(): Promise<void> {}

  async testProvider(): Promise<string> {
    return 'ok';
  }

  async listConversations(): Promise<AiConversation[]> {
    return [];
  }

  async createConversation(): Promise<AiConversation> {
    const now = new Date().toISOString();
    return {
      id: `conv_mem_${Date.now().toString(36)}`,
      title: '新对话',
      created_at: now,
      updated_at: now,
      message_count: 0,
      preview: '',
    };
  }

  async deleteConversation(): Promise<void> {}

  async renameConversation(): Promise<void> {}

  async listAiMessages(): Promise<AiMessage[]> {
    return [];
  }

  async clearAiMessages(): Promise<void> {}

  async stopGeneration(): Promise<void> {}

  async chatStream(request: ChatRequest, channel: Channel<StreamEvent>): Promise<void> {
    channel.onmessage?.({ type: 'started', request_id: request.request_id } as StreamEvent);
    channel.onmessage?.({ type: 'delta', content: '内存仓库模拟回复。' } as StreamEvent);
    channel.onmessage?.({ type: 'done' } as StreamEvent);
  }

  async applyAiChanges(): Promise<ApplyResult> {
    return { applied: 0, summary: [], reminder_count: 0, undo_available: false, undo_remaining: 0 };
  }

  async undoAiChanges(): Promise<ApplyResult> {
    return { applied: 0, summary: [], reminder_count: 0, undo_available: false, undo_remaining: 0 };
  }

  async pollAiReminders(): Promise<AiReminder[]> {
    return [];
  }

  async aiUndoCount(): Promise<number> {
    return this.undoStack.length;
  }

  async fetchRemoteImage(): Promise<string> {
    throw new Error('内存仓库不支持加载远程图片');
  }

  async webSearch(): Promise<WebSource[]> {
    throw new Error('内存仓库不支持联网搜索');
  }

  async openExternalUrl(): Promise<void> {}

  async kvGet(): Promise<string | null> {
    return null;
  }

  async kvSet(): Promise<void> {}

  async kvDelete(): Promise<void> {}

  async undoPush(payload: AppData): Promise<number> {
    this.undoStack.push(cloneAppData(payload));
    if (this.undoStack.length > 15) this.undoStack.shift();
    return this.undoStack.length;
  }

  async undoPop(): Promise<AppData | null> {
    return this.undoStack.pop() ?? null;
  }

  async undoClear(): Promise<void> {
    this.undoStack = [];
  }

  async undoList(): Promise<AppData[]> {
    return this.undoStack.map((item) => cloneAppData(item));
  }
}

export function createRepository(): Repository {
  return isTauriRuntime() ? new TauriRepository() : new LocalStorageRepository();
}
