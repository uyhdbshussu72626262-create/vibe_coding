// AI 助手抽屉面板：会话管理、流式对话、Markdown/公式渲染、提供商设置。
// 这里不直接依赖 app.ts，通过 deps 注入需要的宿主能力，方便复用到其他项目。

import { Channel } from '@tauri-apps/api/core';
import type {
  AiConversation,
  AiMessage,
  AiProvider,
  AiProviderPreset,
  AiReminder,
  AiSettings,
  ChatRequest,
  ProposedChange,
  SaveProviderRequest,
  StreamEvent,
  WebSource,
} from './ai';
import { changeKindLabel, describeChange, providerKindLabel } from './ai';
import { decorateCodeBlocks, findExternalLink, renderMarkdown } from './markdown';

const WIDTH_STORAGE_KEY = 'daynora.ai.drawer-width.v1';
const DEFAULT_WIDTH = 460;
const MIN_WIDTH = 380;
const MAX_WIDTH = 960;
const STREAM_RENDER_INTERVAL = 90;

/// 面板只依赖仓库里的 AI 相关能力，避免和具体仓库实现耦合。
export interface AiRepository {
  listConversations(): Promise<AiConversation[]>;
  createConversation(title?: string): Promise<AiConversation>;
  deleteConversation(id: string): Promise<void>;
  renameConversation(id: string, title: string): Promise<void>;
  listProviders(): Promise<AiProvider[]>;
  getPresets(): Promise<AiProviderPreset[]>;
  saveProvider(request: SaveProviderRequest): Promise<AiProvider>;
  deleteProvider(id: string): Promise<void>;
  setActiveProvider(id: string | null): Promise<void>;
  getAiSettings(): Promise<AiSettings>;
  setSystemPrompt(prompt: string): Promise<void>;
  acceptPrivacy(): Promise<void>;
  testProvider(id?: string | null): Promise<string>;
  listAiMessages(conversationId: string): Promise<AiMessage[]>;
  clearAiMessages(conversationId: string): Promise<void>;
  stopGeneration(requestId: string): Promise<void>;
  chatStream(request: ChatRequest, channel: Channel<StreamEvent>): Promise<void>;
  applyAiChanges(changes: ProposedChange[]): Promise<{
    applied: number;
    summary: string[];
    undo_remaining?: number;
  }>;
  undoAiChanges(): Promise<{ applied: number; summary: string[]; undo_remaining?: number }>;
  pollAiReminders(): Promise<AiReminder[]>;
  notify(title: string, body: string): Promise<void>;
  aiUndoCount(): Promise<number>;
  fetchRemoteImage(url: string): Promise<string>;
  openExternalUrl(url: string): Promise<void>;
}

export interface AiPanelDeps {
  repository: AiRepository;
  t: (key: string) => string;
  icon: (name: string, className?: string) => string;
  escapeHtml: (value: unknown) => string;
  showToast: (message: string) => void;
  requestRender: () => void;
  reloadAppData: () => Promise<void>;
  language: () => 'zh-CN' | 'en';
  createId: (prefix?: string) => string;
}

export interface AiPanel {
  isOpen(): boolean;
  isStreaming(): boolean;
  open(): Promise<void>;
  toggle(): Promise<void>;
  close(): void;
  render(): string;
  afterRender(): void;
  onClick(rawTarget: HTMLElement): Promise<boolean>;
  onChange(target: HTMLElement): Promise<boolean>;
  onInput(target: HTMLElement): boolean;
  onKeydown(event: KeyboardEvent): boolean;
  pollReminders(): Promise<void>;
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

class AiPanelController implements AiPanel {
  private opened = false;
  private tab: 'chat' | 'settings' = 'chat';
  private railOpen = false;
  private providers: AiProvider[] = [];
  private presets: AiProviderPreset[] = [];
  private settings: AiSettings | null = null;
  private conversations: AiConversation[] = [];
  private activeConversationId: string | null = null;
  private messages: AiMessage[] = [];
  private streaming = false;
  private requestId: string | null = null;
  private partial = '';
  private error: string | null = null;
  private usage: { prompt: number; completion: number; total: number } | null = null;
  private proposals: ProposedChange[] = [];
  private proposalSelected: boolean[] = [];
  private conversationQuery = '';
  private width = DEFAULT_WIDTH;
  private stickToBottom = true;
  private messagesEl: HTMLElement | null = null;
  private scrollHandler: (() => void) | null = null;
  private streamTimer: number | null = null;
  private markdownCache = new Map<string, string>();
  /** 待发送的图片（data URL）。 */
  private attachedImage: { dataUrl: string; name: string } | null = null;
  /** 预览中的图片。 */
  private previewImage: { dataUrl: string; name: string } | null = null;
  /** 是否在发送前先联网搜索。 */
  private webEnabled = false;
  /** 本轮联网搜索的来源。 */
  private sources: WebSource[] = [];
  /** 会话索引（快速跳到某次提问）是否展开。 */
  private indexOpen = false;
  private undoRemaining = 0;

  constructor(private readonly deps: AiPanelDeps) {
    this.width = this.loadWidth();
  }

  private t(key: string): string {
    return this.deps.t(key);
  }

  private icon(name: string, className = ''): string {
    return this.deps.icon(name, className);
  }

  private escapeHtml(value: unknown): string {
    return this.deps.escapeHtml(value);
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  isOpen(): boolean {
    return this.opened;
  }

  isStreaming(): boolean {
    return this.streaming;
  }

  async toggle(): Promise<void> {
    if (this.opened) {
      this.close();
      return;
    }
    await this.openPanel();
  }

  async open(): Promise<void> {
    await this.openPanel();
  }

  close(): void {
    this.opened = false;
    this.railOpen = false;
  }

  private async openPanel(): Promise<void> {
    this.opened = true;
    this.tab = 'chat';
    this.deps.requestRender();
    await this.refreshAll();
    this.deps.requestRender();
  }

  private async refreshAll(): Promise<void> {
    try {
      const [settings, providers, presets, conversations] = await Promise.all([
        this.deps.repository.getAiSettings(),
        this.deps.repository.listProviders(),
        this.deps.repository.getPresets(),
        this.deps.repository.listConversations(),
      ]);
      this.settings = settings;
      this.providers = providers;
      this.presets = presets;
      this.conversations = conversations;
      if (!this.activeConversationId && conversations.length) {
        this.activeConversationId = conversations[0].id;
      }
      await this.loadMessages();
      try {
        this.undoRemaining = await this.deps.repository.aiUndoCount();
      } catch {
        this.undoRemaining = 0;
      }
    } catch (error) {
      this.deps.showToast(String(error));
    }
  }

  private async refreshConversations(): Promise<void> {
    try {
      this.conversations = await this.deps.repository.listConversations();
    } catch {
      // 忽略：会话列表刷新失败不影响当前对话。
    }
  }

  private async loadMessages(): Promise<void> {
    // 浏览器开发环境没有后端，对话内容只保留在内存里。
    if (!isTauriRuntime()) return;
    if (!this.activeConversationId) {
      this.messages = [];
      return;
    }
    try {
      this.messages = await this.deps.repository.listAiMessages(this.activeConversationId);
    } catch (error) {
      this.deps.showToast(String(error));
      this.messages = [];
    }
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  render(): string {
    if (!this.opened) return '';
    const needsPrivacy = this.settings && !this.settings.privacy_accepted;
    return `
      <div class="ai-layer">
        <div class="ai-drawer" data-ai-drawer style="width:${this.width}px">
          <div class="ai-resizer" data-ai-resize data-action="ai-resize" title="${this.t('aiResizeHint')}"></div>
          ${this.renderHeader()}
          ${
            needsPrivacy
              ? this.renderPrivacy()
              : this.tab === 'chat'
                ? this.renderChat()
                : this.renderSettings()
          }
          ${this.renderPreview()}
        </div>
      </div>`;
  }

  private renderPreview(): string {
    if (!this.previewImage) return '';
    return `
      <div class="ai-preview">
        <div class="ai-preview__bar">
          <span>${this.escapeHtml(this.previewImage.name)}</span>
          <button type="button" class="icon-button" data-action="ai-close-preview" title="${this.t('close')}">×</button>
        </div>
        <img src="${this.previewImage.dataUrl}" alt="${this.escapeHtml(this.previewImage.name)}" />
      </div>`;
  }

  private renderHeader(): string {
    const title = this.activeConversation()?.title || this.t('aiChat');
    return `
      <header class="ai-drawer__head">
        <button type="button" class="icon-button" data-action="ai-toggle-rail" title="${this.t('aiConversations')}">${this.icon('history')}</button>
        <div class="ai-drawer__title" title="${this.escapeHtml(title)}">${this.icon('sparkles')}<span>${this.escapeHtml(title)}</span></div>
        <button type="button" class="icon-button" data-action="ai-new-conversation" title="${this.t('aiNewConversation')}" ${this.streaming ? 'disabled' : ''}>${this.icon('plus')}</button>
        <button type="button" class="icon-button" data-action="ai-toggle-index" title="${this.t('aiIndex')}">${this.icon('list-ordered')}</button>
        <button type="button" class="icon-button" data-action="ai-toggle-tab" title="${this.escapeHtml(this.tab === 'chat' ? this.t('aiSettingsTab') : this.t('aiChat'))}">${this.icon(this.tab === 'chat' ? 'settings' : 'bot')}</button>
        <button type="button" class="icon-button" data-action="ai-close" title="${this.t('close')}">×</button>
      </header>
      ${this.renderRail()}`;
  }

  private renderRail(): string {
    const query = this.conversationQuery.trim().toLowerCase();
    const list = query
      ? this.conversations.filter((conversation) =>
          `${conversation.title} ${conversation.preview}`.toLowerCase().includes(query),
        )
      : this.conversations;
    return `
      <aside class="ai-rail${this.railOpen ? ' is-open' : ''}">
        <div class="ai-rail__head">
          <span>${this.t('aiConversations')}</span>
          <button type="button" class="primary-button" data-action="ai-new-conversation" ${this.streaming ? 'disabled' : ''}>${this.icon('plus')}${this.t('aiNewConversation')}</button>
        </div>
        <input type="search" class="ai-rail__search" data-ai-search value="${this.escapeHtml(this.conversationQuery)}" placeholder="${this.t('aiSearchConversations')}" />
        <ul class="ai-conversation-list">
          ${
            list.length
              ? list
                  .map(
                    (conversation) => `
                      <li class="ai-conversation${conversation.id === this.activeConversationId ? ' is-active' : ''}">
                        <button type="button" class="ai-conversation__main" data-action="ai-select-conversation" data-id="${this.escapeHtml(conversation.id)}" ${this.streaming ? 'disabled' : ''}>
                          <b>${this.escapeHtml(conversation.title || '新对话')}</b>
                          <span>${this.escapeHtml(conversation.preview || '—')}</span>
                          <em>${conversation.message_count} 条</em>
                        </button>
                        <button type="button" class="mini-button" data-action="ai-delete-conversation" data-id="${this.escapeHtml(conversation.id)}" title="${this.t('aiDeleteConversation')}">${this.icon('trash-2')}</button>
                      </li>`,
                  )
                  .join('')
              : `<li class="muted">${this.t('aiNoConversations')}</li>`
          }
        </ul>
      </aside>`;
  }

  private renderPrivacy(): string {
    return `
      <div class="ai-privacy">
        <div class="ai-privacy__box">
          ${this.icon('shield-check')}
          <h3>${this.t('aiPrivacyTitle')}</h3>
          <p>${this.t('aiPrivacyBody')}</p>
          <button type="button" class="primary-button" data-action="ai-accept-privacy">${this.t('aiPrivacyAccept')}</button>
        </div>
      </div>`;
  }

  private activeConversation(): AiConversation | undefined {
    return this.conversations.find((item) => item.id === this.activeConversationId);
  }

  private renderMarkdownCached(message: AiMessage): string {
    const key = `${message.id}:${message.content.length}:${message.content.slice(0, 32)}`;
    const cached = this.markdownCache.get(key);
    if (cached !== undefined) return cached;
    const html = renderMarkdown(message.content);
    if (this.markdownCache.size > 240) this.markdownCache.clear();
    this.markdownCache.set(key, html);
    return html;
  }

  private renderMessage(message: AiMessage): string {
    const isUser = message.role === 'user';
    const image = message.image
      ? `<button type="button" class="ai-message__file" data-action="ai-preview-image" data-url="${this.escapeHtml(message.image)}" data-name="${this.escapeHtml(message.image_name || 'image')}">${this.icon('image')}<span>${this.escapeHtml(message.image_name || 'image')}</span></button>`
      : '';
    const body = isUser
      ? `<div class="ai-message__content">${this.escapeHtml(message.content).replace(/\n/g, '<br>')}</div>`
      : `<div class="ai-message__content ai-markdown">${this.renderMarkdownCached(message)}</div>`;
    return `
      <div class="ai-message${isUser ? ' ai-message--user' : ' ai-message--assistant'}" data-message-id="${message.id}">
        ${image}
        ${body}
        <button type="button" class="mini-button ai-message__copy" data-action="ai-copy" data-copy="${this.escapeHtml(message.content)}" title="${this.t('aiCopy')}">${this.icon('copy')}</button>
      </div>`;
  }

  /// 会话索引：列出本轮对话里的提问，点一下跳到对应位置。
  private renderConversationIndex(): string {
    const questions = this.messages.filter((message) => message.role === 'user');
    if (!this.indexOpen) return '';
    return `
      <div class="ai-index">
        <header class="ai-index__head">
          <span>${this.t('aiIndex')}</span>
          <button type="button" class="mini-button" data-action="ai-toggle-index">×</button>
        </header>
        <ol class="ai-index__list">
          ${
            questions.length
              ? questions
                  .map((message, index) => {
                    const text = message.content.replace(/\s+/g, ' ').slice(0, 40);
                    return `<li><button type="button" class="ai-index__item" data-action="ai-jump-message" data-message-id="${message.id}"><b>${index + 1}</b><span>${this.escapeHtml(text || '（图片）')}</span></button></li>`;
                  })
                  .join('')
              : `<li class="muted">${this.t('aiIndexEmpty')}</li>`
          }
        </ol>
      </div>`;
  }

  /// 联网搜索结果：作为参考来源列在回答下面。
  private renderSources(): string {
    if (!this.sources.length) return '';
    return `
      <div class="ai-sources">
        <header>${this.icon('globe')}${this.t('aiSources')} · ${this.sources.length}</header>
        <ol>
          ${this.sources
            .map(
              (source, index) => `
                <li>
                  <button type="button" class="ai-source" data-action="ai-open-link" data-url="${this.escapeHtml(source.url)}">
                    <b>${index + 1}</b>
                    <span>${this.escapeHtml(source.title)}</span>
                  </button>
                  ${source.snippet ? `<em>${this.escapeHtml(source.snippet.slice(0, 120))}</em>` : ''}
                </li>`,
            )
            .join('')}
        </ol>
      </div>`;
  }

  private renderProposals(): string {
    if (!this.proposals.length) return '';
    const language = this.deps.language();
    return `
      <section class="ai-proposals">
        <header class="ai-proposals__head">
          ${this.icon('list-checks')}
          <span>${this.t('aiProposeChanges')} · <b>${this.proposals.length}</b> ${this.t('aiProposalCount')}</span>
        </header>
        <p class="ai-proposals__hint">${this.t('aiDeletedConfirm')}</p>
        <ul class="ai-proposal-list">
          ${this.proposals
            .map((change, index) => {
              const needsConfirm = change.kind === 'delete' || change.kind === 'complete';
              return `
                <li class="ai-proposal">
                  <label class="ai-proposal__main">
                    <input type="checkbox" data-action="ai-toggle-proposal" data-index="${index}"${this.proposalSelected[index] ? ' checked' : ''} />
                    <span class="ai-proposal__body">
                      <b>${this.escapeHtml(changeKindLabel(change.kind, language))}</b>
                      <span>${this.escapeHtml(describeChange(change, language))}</span>
                      ${change.reason ? `<em>${this.escapeHtml(change.reason)}</em>` : ''}
                    </span>
                  </label>
                  ${needsConfirm ? `<i class="ai-proposal__confirm">${this.t('aiNeedsConfirm')}</i>` : ''}
                </li>`;
            })
            .join('')}
        </ul>
        <div class="ai-proposals__actions">
          <button type="button" class="primary-button" data-action="ai-apply-changes">${this.icon('check')}${this.t('aiApplySelected')}</button>
          <button type="button" class="ghost-button" data-action="ai-undo-ai">${this.icon('undo-2')}${this.t('aiUndoApply')}${this.undoRemaining > 1 ? `（${this.undoRemaining}）` : ''}</button>
        </div>
      </section>`;
  }

  private renderChat(): string {
    const active = this.providers.find((provider) => provider.is_active) || this.providers[0];
    const modelLabel = active
      ? `${active.name} · ${active.model}`
      : this.t('aiEmptyModel');
    const hasContent = this.messages.length > 0 || this.partial.length > 0 || this.streaming;
    return `
      <div class="ai-chat">
        <div class="ai-chat__model">
          ${this.icon('cpu')}
          <span>${this.t('aiModel')}：${this.escapeHtml(modelLabel)}</span>
        </div>
        <div class="ai-chat__tools">
          <button type="button" class="ghost-button" data-action="ai-analyze-today" ${this.streaming ? 'disabled' : ''}>${this.icon('calendar-days')}${this.t('aiAnalyzeToday')}</button>
          <button type="button" class="ghost-button" data-action="ai-analyze-week" ${this.streaming ? 'disabled' : ''}>${this.icon('layers')}${this.t('aiAnalyzeWeek')}</button>
          <button type="button" class="ghost-button" data-action="ai-propose" ${this.streaming ? 'disabled' : ''}>${this.icon('sliders-horizontal')}${this.t('aiProposeChanges')}</button>
          <button type="button" class="ghost-button" data-action="ai-clear" ${this.streaming || !this.activeConversationId ? 'disabled' : ''}>${this.icon('eraser')}${this.t('aiClear')}</button>
        </div>
        <div class="ai-chat__messages" data-ai-messages>
          ${
            hasContent
              ? this.messages.map((message) => this.renderMessage(message)).join('')
              : `<div class="ai-empty">${this.icon('sparkles')}<p>${this.t('aiNoMessages')}</p></div>`
          }
          ${
            this.streaming || this.partial
              ? `<div class="ai-message ai-message--assistant ai-message--streaming">
                  <div class="ai-message__content ai-markdown" data-streaming-content>${renderMarkdown(this.partial)}</div>
                  <span class="ai-cursor"></span>
                </div>`
              : ''
          }
          ${this.renderProposals()}
          ${
            this.error
              ? `<div class="ai-error">${this.icon('alert-triangle')}<span>${this.escapeHtml(this.error)}</span><button type="button" class="ghost-button" data-action="ai-retry">${this.icon('rotate-ccw')}${this.t('aiRetry')}</button></div>`
              : ''
          }
          ${
            this.usage && !this.streaming
              ? `<div class="ai-usage">${this.t('aiTokenUsage')}：${this.usage.prompt} + ${this.usage.completion} = ${this.usage.total}</div>`
              : ''
          }
          ${this.renderSources()}
        </div>
        ${this.renderConversationIndex()}
        <div class="ai-composer">
          ${
            this.attachedImage
              ? `<span class="ai-attachment">
                  <span class="ai-attachment__name">${this.icon('image')}${this.escapeHtml(this.attachedImage.name)}</span>
                  <button type="button" class="mini-button" data-action="ai-remove-image" title="${this.t('aiRemoveImage')}">×</button>
                </span>`
              : ''
          }
          <div class="ai-composer__row">
            <button type="button" class="icon-button ai-composer__attach" data-action="ai-attach-image" title="${this.t('aiAttachImage')}" ${this.streaming ? 'disabled' : ''}>${this.icon('image')}</button>
            <textarea data-ai-input rows="1" placeholder="${this.t('aiPlaceholder')}">${this.escapeHtml(this.composerDraft)}</textarea>
            ${
              this.streaming
                ? `<button type="button" class="danger-button" data-action="ai-stop">${this.icon('square')}${this.t('aiStop')}</button>`
                : `<button type="button" class="primary-button" data-action="ai-send">${this.icon('send')}${this.t('aiSend')}</button>`
            }
          </div>
          <div class="ai-composer__meta">
            <button type="button" class="ghost-button ai-web-toggle${this.webEnabled ? ' is-on' : ''}" data-action="ai-toggle-web" title="${this.t('aiWebSearchHint')}" ${this.streaming ? 'disabled' : ''}>${this.icon('globe')}${this.t('aiWebSearch')}${this.webEnabled ? ' · 开' : ''}</button>
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-ai-file hidden />
          </div>
        </div>
      </div>`;
  }

  private renderSettings(): string {
    return `
      <div class="ai-settings">
        <section class="ai-settings-block">
          <h3>${this.icon('plug')}${this.t('aiProviders')}</h3>
          <ul class="ai-provider-list">
            ${
              this.providers.length
                ? this.providers
                    .map(
                      (provider) => `
                        <li class="ai-provider${provider.is_active ? ' is-active' : ''}">
                          <div class="ai-provider__info">
                            <b>${this.escapeHtml(provider.name)}${provider.is_active ? ` <i>· ${this.t('aiUse')}</i>` : ''}</b>
                            <span>${this.escapeHtml(providerKindLabel(provider.kind))} · ${this.escapeHtml(provider.model)}</span>
                            <em>${provider.has_key ? this.icon('shield-check') + this.t('aiApiKeySaved') : this.icon('alert-triangle') + '无密钥'}</em>
                          </div>
                          <div class="ai-provider__actions">
                            ${
                              provider.is_active
                                ? ''
                                : `<button type="button" class="ghost-button" data-action="ai-use-provider" data-id="${this.escapeHtml(provider.id)}">${this.t('aiUse')}</button>`
                            }
                            <button type="button" class="ghost-button" data-action="ai-test-provider" data-id="${this.escapeHtml(provider.id)}">${this.t('aiTest')}</button>
                            <button type="button" class="mini-button" data-action="ai-delete-provider" data-id="${this.escapeHtml(provider.id)}">×</button>
                          </div>
                        </li>`,
                    )
                    .join('')
                : `<li class="muted">${this.t('aiNoProvider')}</li>`
            }
          </ul>
        </section>
        ${this.renderProviderForm()}
        <section class="ai-settings-block">
          <h3>${this.icon('braces')}${this.t('aiSystemPrompt')}</h3>
          <p class="muted">${this.t('aiSystemPromptHint')}</p>
          <textarea data-ai-system-prompt rows="4">${this.escapeHtml(this.settings?.system_prompt || '')}</textarea>
          <button type="button" class="ghost-button" data-action="ai-save-prompt">${this.t('aiSavePrompt')}</button>
        </section>
        <section class="ai-settings-block ai-privacy-note">
          ${this.icon('shield-check')}
          <p>${this.t('aiPrivacyBody')}</p>
        </section>
      </div>`;
  }

  private renderProviderForm(): string {
    const presets = this.presets.length ? this.presets : FALLBACK_PRESETS;
    return `
      <section class="ai-settings-block">
        <h3>${this.icon('plus')}${this.t('aiAddProvider')}</h3>
        <div class="ai-provider-form">
          <label class="field">
            <span>${this.t('aiProviderName')}</span>
            <input type="text" data-ai-field="name" placeholder="DeepSeek" />
          </label>
          <label class="field">
            <span>${this.t('aiProviderKind')}</span>
            <select data-ai-field="kind">
              ${presets
                .map((preset) => `<option value="${this.escapeHtml(preset.kind)}">${this.escapeHtml(preset.label)}</option>`)
                .join('')}
            </select>
          </label>
          <label class="field">
            <span>${this.t('aiBaseUrl')}</span>
            <input type="text" data-ai-field="baseUrl" value="${this.escapeHtml(presets[0]?.base_url || '')}" placeholder="https://api.example.com/v1" />
          </label>
          <label class="field">
            <span>${this.t('aiModelName')}</span>
            <input type="text" data-ai-field="model" list="ai-model-suggestions" value="${this.escapeHtml(presets[0]?.default_model || '')}" />
            <datalist id="ai-model-suggestions">
              ${(presets[0]?.models || []).map((name) => `<option value="${this.escapeHtml(name)}"></option>`).join('')}
            </datalist>
          </label>
          <label class="field">
            <span>${this.t('aiApiKey')}</span>
            <input type="password" data-ai-field="apiKey" autocomplete="off" placeholder="sk-…" />
          </label>
          <button type="button" class="primary-button" data-action="ai-save-provider">${this.icon('key-round')}${this.t('aiAddProvider')}</button>
        </div>
      </section>`;
  }

  // -------------------------------------------------------------------------
  // 渲染后处理：滚动、输入框、拖拽宽度
  // -------------------------------------------------------------------------

  afterRender(): void {
    if (!this.opened) return;

    const messagesEl = document.querySelector<HTMLElement>('[data-ai-messages]');
    if (this.scrollHandler && this.messagesEl) {
      this.messagesEl.removeEventListener('scroll', this.scrollHandler);
    }
    this.messagesEl = messagesEl;
    if (messagesEl) {
      this.scrollHandler = () => {
        this.stickToBottom =
          messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - 32;
      };
      messagesEl.addEventListener('scroll', this.scrollHandler);
      if (this.stickToBottom) this.scrollToBottom();
      // 代码块补上语法高亮、语言标签与复制按钮（流式输出时跳过，避免重复高亮）。
      if (!this.streaming) decorateCodeBlocks(messagesEl);
    }

    const input = document.querySelector<HTMLTextAreaElement>('[data-ai-input]');
    if (input) {
      this.resizeComposer(input);
      if (this.composerFocus) {
        this.composerFocus = false;
        // 点击事件结束后再聚焦，避免被浏览器默认的“聚焦原按钮”行为覆盖。
        window.setTimeout(() => {
          const element = document.querySelector<HTMLTextAreaElement>('[data-ai-input]');
          element?.focus();
          element?.setSelectionRange(element.value.length, element.value.length);
        }, 0);
      }
    }

    const resizer = document.querySelector<HTMLElement>('[data-ai-resize]');
    if (resizer) {
      resizer.addEventListener('mousedown', (event) => {
        event.preventDefault();
        this.beginResize(event.clientX);
      });
    }
  }

  private scrollToBottom(): void {
    if (!this.messagesEl) return;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private resizeComposer(input: HTMLTextAreaElement): void {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }

  private composerDraft = '';
  private composerFocus = false;

  private beginResize(startX: number): void {
    const startWidth = this.width;
    const onMove = (event: MouseEvent): void => {
      const max = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 80));
      const next = Math.min(max, Math.max(MIN_WIDTH, startWidth + (startX - event.clientX)));
      this.width = Math.round(next);
      const drawer = document.querySelector<HTMLElement>('[data-ai-drawer]');
      if (drawer) drawer.style.width = `${this.width}px`;
    };
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try {
        window.localStorage.setItem(WIDTH_STORAGE_KEY, String(this.width));
      } catch {
        // 忽略存储失败。
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  private loadWidth(): number {
    try {
      const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
      const value = Number(raw);
      if (Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH) return Math.round(value);
    } catch {
      // 忽略。
    }
    return DEFAULT_WIDTH;
  }

  // -------------------------------------------------------------------------
  // 流式对话
  // -------------------------------------------------------------------------

  private scheduleStreamUpdate(): void {
    if (this.streamTimer !== null) return;
    this.streamTimer = window.setTimeout(() => {
      this.streamTimer = null;
      this.paintStreaming();
    }, STREAM_RENDER_INTERVAL);
  }

  private paintStreaming(): void {
    const node = document.querySelector<HTMLElement>('[data-streaming-content]');
    if (!node) {
      this.deps.requestRender();
      return;
    }
    node.innerHTML = renderMarkdown(this.partial);
    if (this.stickToBottom) this.scrollToBottom();
  }

  private handleStreamEvent(event: StreamEvent): void {
    switch (event.type) {
      case 'started':
        this.streaming = true;
        this.requestId = event.request_id;
        if (!this.activeConversationId && event.conversation_id) {
          this.activeConversationId = event.conversation_id;
          void this.refreshConversations();
        }
        break;
      case 'delta':
        this.partial += event.content;
        this.paintStreamingThrottled();
        break;
      case 'tool_proposal':
        this.proposals = event.changes;
        this.proposalSelected = event.changes.map(
          (change) => change.kind !== 'delete' && change.kind !== 'complete',
        );
        this.deps.requestRender();
        break;
      case 'sources':
        this.sources = event.items || [];
        if (event.note) this.deps.showToast(event.note);
        this.deps.requestRender();
        break;
      case 'usage':
        this.usage = {
          prompt: event.prompt_tokens,
          completion: event.completion_tokens,
          total: event.total_tokens,
        };
        break;
      case 'title':
        this.conversations = this.conversations.map((conversation) =>
          conversation.id === event.conversation_id
            ? { ...conversation, title: event.title }
            : conversation,
        );
        this.deps.requestRender();
        break;
      case 'done':
        this.streaming = false;
        this.clearStreamTimer();
        void this.finishStream();
        break;
      case 'stopped':
        this.streaming = false;
        this.clearStreamTimer();
        this.deps.showToast(this.t('aiStopped'));
        void this.finishStream();
        break;
      case 'error':
        this.streaming = false;
        this.clearStreamTimer();
        this.error = event.message;
        void this.finishStream();
        break;
      default:
        break;
    }
  }

  private paintStreamingThrottled(): void {
    if (this.streamTimer !== null) return;
    const node = document.querySelector<HTMLElement>('[data-streaming-content]');
    if (!node) {
      // 还没渲染出流式气泡（刚刚点击发送），直接整体重绘。
      this.deps.requestRender();
      return;
    }
    this.scheduleStreamUpdate();
  }

  private clearStreamTimer(): void {
    if (this.streamTimer !== null) {
      window.clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
  }

  private async finishStream(): Promise<void> {
    if (!isTauriRuntime() && this.partial.trim()) {
      this.messages.push({
        id: Date.now(),
        role: 'assistant',
        content: this.partial,
        created_at: new Date().toISOString(),
      });
    }
    await this.loadMessages();
    await this.refreshConversations();
    this.partial = '';
    this.stickToBottom = true;
    this.deps.requestRender();
  }

  private async sendMessage(mode: ChatRequest['mode'], text: string): Promise<void> {
    if (this.streaming) return;
    const message = text.trim();
    if (!message) return;
    if (this.settings && !this.settings.privacy_accepted) return;
    // 浏览器开发预览没有真实提供商，跳过该校验以便验证界面；桌面版必须配置。
    if (isTauriRuntime() && !this.providers.length) {
      this.deps.showToast(this.t('aiNoProvider'));
      return;
    }

    const requestId = this.deps.createId('req');
    this.streaming = true;
    this.requestId = requestId;
    this.partial = '';
    this.error = null;
    this.usage = null;
    this.proposals = [];
    this.proposalSelected = [];
    this.stickToBottom = true;
    this.composerDraft = '';
    const image = this.attachedImage;
    this.attachedImage = null;
    this.sources = [];
    if (!isTauriRuntime() && mode === 'chat') {
      this.messages.push({
        id: Date.now(),
        role: 'user',
        content: message,
        image: image?.dataUrl,
        image_name: image?.name,
        created_at: new Date().toISOString(),
      });
    }
    this.deps.requestRender();

    try {
      const channel = this.createChannel((event) => this.handleStreamEvent(event));
      await this.deps.repository.chatStream(
        {
          request_id: requestId,
          conversation_id: this.activeConversationId,
          provider_id: null,
          message,
          mode,
          language: this.deps.language(),
          image: image?.dataUrl ?? null,
          image_name: image?.name ?? null,
          web_search: mode === 'chat' ? this.webEnabled : false,
        },
        channel,
      );
    } catch (error) {
      // 任何异常都要复位状态，避免界面卡在“生成中”。
      this.streaming = false;
      this.handleStreamEvent({ type: 'error', message: String(error) });
    }
  }

  /// 浏览器开发预览没有 Tauri IPC，用一个轻量对象代替 Channel；
  /// 桌面版走真实的 tauri::ipc::Channel。
  private createChannel(handler: (event: StreamEvent) => void): Channel<StreamEvent> {
    if (!isTauriRuntime()) {
      return { onmessage: handler } as unknown as Channel<StreamEvent>;
    }
    const channel = new Channel<StreamEvent>();
    channel.onmessage = handler;
    return channel;
  }

  private defaultAnalysisText(mode: ChatRequest['mode']): string {
    const zh = this.deps.language() === 'zh-CN';
    if (mode === 'analyze_today') {
      return zh ? '请分析我今天的任务安排是否合理。' : 'Please analyze whether my plan for today is reasonable.';
    }
    if (mode === 'analyze_week') {
      return zh ? '请分析我接下来一周的任务安排。' : 'Please analyze my plan for the coming week.';
    }
    return zh ? '请根据我的任务计划提出修改建议。' : 'Please propose changes to my schedule.';
  }

  private async startChat(mode: ChatRequest['mode']): Promise<void> {
    const input = document.querySelector<HTMLTextAreaElement>('[data-ai-input]');
    const text = mode === 'chat' ? input?.value || '' : this.defaultAnalysisText(mode);
    if (!text.trim()) return;
    if (input) input.value = '';
    await this.sendMessage(mode, text);
  }

  /// 打开外部链接：桌面版交给系统浏览器，浏览器预览用新标签页。
  private async openLink(url: string): Promise<void> {
    try {
      await this.deps.repository.openExternalUrl(url);
    } catch {
      window.open(url, '_blank', 'noopener');
    }
  }

  private async retry(): Promise<void> {
    const lastUser = [...this.messages].reverse().find((message) => message.role === 'user');
    if (!lastUser) return;
    this.error = null;
    await this.sendMessage('chat', lastUser.content);
  }

  private async applyProposals(): Promise<void> {
    const selected = this.proposals.filter((_, index) => this.proposalSelected[index]);
    if (!selected.length) {
      this.deps.showToast(this.t('aiDeletedConfirm'));
      return;
    }
    try {
      const result = await this.deps.repository.applyAiChanges(selected);
      this.undoRemaining = result.undo_remaining ?? this.undoRemaining + 1;
      this.proposals = [];
      this.proposalSelected = [];
      await this.deps.reloadAppData();
      await this.loadMessages();
      this.deps.showToast(
        result.applied > 0
          ? `${this.t('aiApplied')}（${result.applied}）`
          : this.t('aiApplyFailed'),
      );
      this.deps.requestRender();
    } catch (error) {
      this.deps.showToast(`${this.t('aiApplyFailed')}: ${String(error)}`);
    }
  }

  private async undoProposals(): Promise<void> {
    try {
      await this.deps.repository.undoAiChanges();
      this.undoRemaining = Math.max(0, this.undoRemaining - 1);
      await this.deps.reloadAppData();
      this.deps.showToast(this.t('aiUndone'));
      this.deps.requestRender();
    } catch (error) {
      this.deps.showToast(`${this.t('aiApplyFailed')}: ${String(error)}`);
    }
  }

  async pollReminders(): Promise<void> {
    if (!isTauriRuntime()) return;
    try {
      const reminders = await this.deps.repository.pollAiReminders();
      for (const reminder of reminders) {
        void this.deps.repository.notify(
          this.t('aiReminder'),
          `${reminder.title}：${reminder.message}`,
        );
      }
    } catch {
      // 提醒轮询失败不打扰用户。
    }
  }

  // -------------------------------------------------------------------------
  // 事件分发
  // -------------------------------------------------------------------------

  async onClick(rawTarget: HTMLElement): Promise<boolean> {
    const link = findExternalLink(rawTarget);
    if (link) {
      // 用系统浏览器打开，软件界面保持不动，用户随时能切回来。
      await this.openLink(link);
      return true;
    }

    const target = rawTarget.closest<HTMLElement>('[data-action]');
    if (!target) return false;
    const action = target.dataset.action || '';
    if (!action.startsWith('ai-')) return false;

    switch (action) {
      case 'ai-close':
        this.close();
        this.deps.requestRender();
        return true;
      case 'ai-toggle-rail':
        this.railOpen = !this.railOpen;
        this.deps.requestRender();
        return true;
      case 'ai-toggle-tab':
        this.tab = this.tab === 'chat' ? 'settings' : 'chat';
        this.railOpen = false;
        this.deps.requestRender();
        return true;
      case 'ai-new-conversation':
        if (this.streaming) return true;
        this.activeConversationId = null;
        this.composerDraft = '';
        this.messages = [];
        this.partial = '';
        this.error = null;
        this.usage = null;
        this.proposals = [];
        this.proposalSelected = [];
        this.railOpen = false;
        this.tab = 'chat';
        this.stickToBottom = true;
        this.composerFocus = true;
        this.deps.requestRender();
        return true;
      case 'ai-select-conversation': {
        if (this.streaming) return true;
        const id = target.dataset.id;
        if (!id) return true;
        this.activeConversationId = id;
        this.composerDraft = '';
        this.railOpen = false;
        this.error = null;
        this.usage = null;
        this.proposals = [];
        this.partial = '';
        this.stickToBottom = true;
        await this.loadMessages();
        this.deps.requestRender();
        return true;
      }
      case 'ai-delete-conversation': {
        const id = target.dataset.id;
        if (!id || this.streaming) return true;
        await this.deps.repository.deleteConversation(id);
        if (this.activeConversationId === id) {
          this.activeConversationId = null;
          this.messages = [];
        }
        await this.refreshConversations();
        this.deps.requestRender();
        return true;
      }
      case 'ai-open-link': {
        const url = target.dataset.url || '';
        if (url) await this.openLink(url);
        return true;
      }
      case 'ai-load-image': {
        const url = target.dataset.src || '';
        if (!url) return true;
        const placeholder = target.closest<HTMLElement>('.ai-image-placeholder');
        try {
          const dataUrl = await this.deps.repository.fetchRemoteImage(url);
          if (placeholder) {
            const image = document.createElement('img');
            image.src = dataUrl;
            image.alt = 'AI 回答中的图片';
            placeholder.replaceWith(image);
          }
        } catch (error) {
          this.deps.showToast(`${this.t('aiImageFailed')}: ${String(error)}`);
        }
        return true;
      }
      case 'ai-toggle-index':
        this.indexOpen = !this.indexOpen;
        this.deps.requestRender();
        return true;
      case 'ai-jump-message': {
        const id = target.dataset.messageId || '';
        this.indexOpen = false;
        this.deps.requestRender();
        window.setTimeout(() => {
          const node = document.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
          if (!node) return;
          node.scrollIntoView({ behavior: 'smooth', block: 'start' });
          node.classList.add('is-highlighted');
          window.setTimeout(() => node.classList.remove('is-highlighted'), 1600);
        }, 30);
        return true;
      }
      case 'ai-attach-image': {
        if (this.streaming) return true;
        document.querySelector<HTMLInputElement>('[data-ai-file]')?.click();
        return true;
      }
      case 'ai-remove-image':
        this.attachedImage = null;
        this.deps.requestRender();
        return true;
      case 'ai-preview-image': {
        const url = target.dataset.url || '';
        if (!url) return true;
        this.previewImage = {
          dataUrl: url,
          name: target.dataset.name || 'image',
        };
        this.deps.requestRender();
        return true;
      }
      case 'ai-close-preview':
        this.previewImage = null;
        this.deps.requestRender();
        return true;
      case 'ai-toggle-web':
        this.webEnabled = !this.webEnabled;
        this.deps.requestRender();
        return true;
      case 'ai-accept-privacy':
        await this.deps.repository.acceptPrivacy();
        if (this.settings) this.settings.privacy_accepted = true;
        this.deps.requestRender();
        return true;
      case 'ai-send':
        await this.startChat('chat');
        return true;
      case 'ai-analyze-today':
        await this.startChat('analyze_today');
        return true;
      case 'ai-analyze-week':
        await this.startChat('analyze_week');
        return true;
      case 'ai-propose':
        await this.startChat('propose_changes');
        return true;
      case 'ai-stop':
        if (this.requestId) {
          await this.deps.repository.stopGeneration(this.requestId).catch(() => undefined);
        }
        return true;
      case 'ai-retry':
        await this.retry();
        return true;
      case 'ai-clear':
        if (!this.activeConversationId) return true;
        await this.deps.repository.clearAiMessages(this.activeConversationId);
        this.messages = [];
        this.partial = '';
        this.proposals = [];
        this.error = null;
        this.deps.showToast(this.t('aiCleared'));
        await this.refreshConversations();
        this.deps.requestRender();
        return true;
      case 'ai-copy': {
        const text = target.dataset.copy || '';
        if (text) {
          await navigator.clipboard.writeText(text).catch(() => undefined);
          this.deps.showToast(this.t('aiCopied'));
        }
        return true;
      }
      case 'ai-use-provider': {
        const id = target.dataset.id;
        if (!id) return true;
        await this.deps.repository.setActiveProvider(id);
        await this.refreshAll();
        this.deps.showToast(this.t('aiActiveSet'));
        this.deps.requestRender();
        return true;
      }
      case 'ai-test-provider': {
        const id = target.dataset.id;
        try {
          await this.deps.repository.testProvider(id || null);
          this.deps.showToast(this.t('aiTestOk'));
        } catch (error) {
          this.deps.showToast(`${this.t('aiTestFailed')}: ${String(error)}`);
        }
        return true;
      }
      case 'ai-delete-provider': {
        const id = target.dataset.id;
        if (!id) return true;
        await this.deps.repository.deleteProvider(id);
        await this.refreshAll();
        this.deps.showToast(this.t('aiProviderDeleted'));
        this.deps.requestRender();
        return true;
      }
      case 'ai-save-provider': {
        const form = document.querySelector<HTMLElement>('.ai-provider-form');
        const read = (field: string): string =>
          form?.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-ai-field="${field}"]`)?.value || '';
        try {
          await this.deps.repository.saveProvider({
            name: read('name'),
            kind: read('kind'),
            base_url: read('baseUrl'),
            model: read('model'),
            api_key: read('apiKey') || null,
          });
          await this.refreshAll();
          this.deps.showToast(this.t('aiProviderSaved'));
          this.deps.requestRender();
        } catch (error) {
          this.deps.showToast(`${this.t('aiApplyFailed')}: ${String(error)}`);
        }
        return true;
      }
      case 'ai-save-prompt': {
        const prompt = document.querySelector<HTMLTextAreaElement>('[data-ai-system-prompt]')?.value || '';
        try {
          await this.deps.repository.setSystemPrompt(prompt);
          if (this.settings) this.settings.system_prompt = prompt;
          this.deps.showToast(this.t('aiPromptSaved'));
        } catch (error) {
          this.deps.showToast(String(error));
        }
        return true;
      }
      case 'ai-apply-changes':
        await this.applyProposals();
        return true;
      case 'ai-undo-ai':
        await this.undoProposals();
        return true;
      default:
        return true;
    }
  }

  async onChange(target: HTMLElement): Promise<boolean> {
    if (target instanceof HTMLInputElement && target.hasAttribute('data-ai-file')) {
      const file = target.files?.[0];
      target.value = '';
      if (!file) return true;
      if (file.size > 8 * 1024 * 1024) {
        this.deps.showToast(this.t('aiImageTooLarge'));
        return true;
      }
      const reader = new FileReader();
      reader.onload = () => {
        this.attachedImage =
          typeof reader.result === 'string'
            ? { dataUrl: reader.result, name: file.name }
            : null;
        this.deps.requestRender();
      };
      reader.readAsDataURL(file);
      return true;
    }
    if (target.dataset.action === 'ai-toggle-proposal' && target instanceof HTMLInputElement) {
      const index = Number(target.dataset.index);
      if (Number.isInteger(index) && index >= 0 && index < this.proposals.length) {
        this.proposalSelected[index] = target.checked;
      }
      return true;
    }
    if (target.dataset.aiField === 'kind' && target instanceof HTMLSelectElement) {
      const preset = this.presets.find((item) => item.kind === target.value);
      if (preset) {
        const form = target.closest<HTMLElement>('.ai-provider-form');
        const baseUrl = form?.querySelector<HTMLInputElement>('[data-ai-field="baseUrl"]');
        const model = form?.querySelector<HTMLInputElement>('[data-ai-field="model"]');
        const datalist = document.querySelector<HTMLDataListElement>('#ai-model-suggestions');
        if (baseUrl) baseUrl.value = preset.kind === 'custom' ? '' : preset.base_url;
        if (model) model.value = preset.kind === 'custom' ? '' : preset.default_model;
        if (datalist) {
          datalist.innerHTML = preset.models
            .map((name) => `<option value="${this.escapeHtml(name)}"></option>`)
            .join('');
        }
      }
      return true;
    }
    return false;
  }

  onInput(target: HTMLElement): boolean {
    if (target.hasAttribute('data-ai-input') && target instanceof HTMLTextAreaElement) {
      this.composerDraft = target.value;
      this.resizeComposer(target);
      return true;
    }
    if (target.hasAttribute('data-ai-search')) {
      this.conversationQuery = (target as HTMLInputElement).value;
      const rail = document.querySelector<HTMLElement>('.ai-rail');
      if (rail) rail.outerHTML = this.renderRail();
      const search = document.querySelector<HTMLInputElement>('[data-ai-search]');
      if (search) {
        search.focus();
        search.setSelectionRange(search.value.length, search.value.length);
      }
      return true;
    }
    return false;
  }

  onKeydown(event: KeyboardEvent): boolean {
    if (event.key !== 'Enter' || event.shiftKey) return false;
    const active = document.activeElement as HTMLElement | null;
    if (!active?.hasAttribute('data-ai-input')) return false;
    event.preventDefault();
    void this.startChat('chat');
    return true;
  }
}

const FALLBACK_PRESETS: AiProviderPreset[] = [
  { kind: 'deepseek', label: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', default_model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { kind: 'openai', label: 'OpenAI', base_url: 'https://api.openai.com/v1', default_model: 'gpt-4o-mini', models: ['gpt-4o-mini', 'gpt-4.1-mini'] },
  { kind: 'custom', label: '自定义', base_url: '', default_model: '', models: [] },
];

export function createAiPanel(deps: AiPanelDeps): AiPanel {
  return new AiPanelController(deps);
}
