import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ICONS, ICON_LICENSE } from './icons';
import { translate } from './i18n';
import {
  addDays,
  calculateGoalProgress,
  clampNotes,
  cloneAppData,
  createId,
  createTask,
  formatDuration,
  formatTime,
  moveTaskInQueue,
  normalizeAppData,
  setTaskStatus,
  sortTasks,
  summarizeDay,
  tasksForDate,
  toDateKey,
} from './core';
import { createSampleData, DEFAULT_SETTINGS } from './data/sample';
import {
  exportFileName,
  parseImportedSnapshot,
  serializeSnapshot,
  type ExportFormat,
} from './data/exporters';
import { createRepository, type Repository } from './store/repository';
import { isTauriRuntime } from './store/repository';
import {
  focusProgress,
  formatFocusTime,
  type FocusStyle,
} from './features/focus';
import { createFocusController } from './features/focus-controller';
import { createKvFocusStorage } from './features/kv-storage';
import { FOCUS_SESSIONS_KEY } from './features/focus';
import {
  renderExportPanel,
  renderFocusSetupPanel,
  renderGoalPickerList,
  renderGoalsPanel,
  renderSettingsPanel,
  renderSoundPanel,
  renderTrashPanel,
} from './features/panel-views';
import { baseName, escapeHtml, icon, renderSprite } from './ui/dom';
import { audioMixer, SOUND_OPTIONS, type SoundPreset } from './features/audio';
import { matchesTaskQuery, searchTasks } from './features/search';
import { applyZoom, nextZoom, ZOOM_MAX, ZOOM_MIN } from './features/zoom';
import {
  dailySummaryKey,
  dueTaskReminders,
  isDailySummaryDue,
} from './features/notifications';
import {
  fetchWeatherByPoint,
  fetchWeatherForCity,
  getBrowserLocation,
  isWeatherCacheFresh,
  loadCachedWeather,
  reverseGeocode,
  saveCachedWeather,
  weatherEmoji,
  weatherLabel,
  type WeatherSnapshot,
} from './features/weather';
import {
  createAiPanel,
  type AiPanel,
} from './features/ai-panel';
import type { AppData, Goal, Language, Task, ThemePreference } from './types';

const MAX_HISTORY = 15;
const NOTIFIED_KEY = 'daynora.notified.v1';

type PanelName = 'settings' | 'trash' | 'goals' | 'export' | 'sound' | 'focus-setup' | null;

interface TransferState {
  taskId: string;
  title: string;
  direction: 'to-completed' | 'to-pending';
}

/// 应用运行期状态（供 ui/features 模块以只读方式引用）。
export interface AppState {
  data: AppData;
  repository: Repository;
  selectedDate: string;
  selectedTaskId: string | null;
  history: AppData[];
  transfer: TransferState | null;
  toast: string | null;
  panel: PanelName;
  dirty: boolean;
  dragTaskId: string | null;
  backups: string[];
  weather: WeatherSnapshot | null;
  weatherLoading: boolean;
  soundPlaying: SoundPreset;
  search: string;
  expandedTaskIds: Set<string>;
  notified: Set<string>;
  updaterStatus: string;
  goalTaskPicker: string | null;
  goalTaskQuery: string;
}

function applyTheme(theme: ThemePreference): void {
  const rootElement = document.documentElement;
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  rootElement.dataset.theme = resolved;
  rootElement.dataset.themePreference = theme;
}

function chooseInitialDate(data: AppData): string {
  const today = toDateKey();
  if (tasksForDate(data.tasks, today).length) return today;
  const firstTask = sortTasks(data.tasks.filter((task) => task.status !== 'trashed'))[0];
  return firstTask ? firstTask.date : today;
}

function loadNotified(): Set<string> {
  try {
    const raw = window.localStorage.getItem(NOTIFIED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveNotified(values: Set<string>): void {
  try {
    window.localStorage.setItem(NOTIFIED_KEY, JSON.stringify([...values].slice(-300)));
  } catch {
    // noop
  }
}

/// 桌面版从 SQLite 读取“已提醒”标记（旧数据仍可从 localStorage 迁移过来）。
async function loadNotifiedFromStore(repository: Repository): Promise<Set<string>> {
  try {
    const raw = await repository.kvGet(NOTIFIED_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    // 读取失败按空处理。
  }
  return loadNotified();
}

/// 桌面版写回 SQLite；浏览器预览继续用 localStorage。
function persistNotified(repository: Repository, values: Set<string>): void {
  const payload = JSON.stringify([...values].slice(-300));
  if (isTauriRuntime()) {
    void repository.kvSet(NOTIFIED_KEY, payload).catch(() => undefined);
    return;
  }
  try {
    window.localStorage.setItem(NOTIFIED_KEY, payload);
  } catch {
    // noop
  }
}

async function enterFocusFullscreen(): Promise<void> {
  try {
    if (isTauriRuntime()) {
      await getCurrentWindow().setFullscreen(true);
    } else if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    }
  } catch {
    // 全屏失败不影响倒计时。
  }
}

async function exitFocusFullscreen(): Promise<void> {
  try {
    if (isTauriRuntime()) {
      await getCurrentWindow().setFullscreen(false);
    } else if (document.fullscreenElement) {
      await document.exitFullscreen();
    }
  } catch {
    // noop
  }
}

export async function bootstrapApp(root: HTMLElement): Promise<void> {
  const repository = createRepository();
  const stored = await repository.load();
  const data = stored && stored.tasks?.length ? normalizeAppData(stored, DEFAULT_SETTINGS) : createSampleData();
  if (!stored) {
    await repository.save(data);
  }

  // 桌面版把这些小数据放到 SQLite（浏览器预览仍用 localStorage）。
  const desktop = isTauriRuntime();
  const focusStorage = desktop
    ? await createKvFocusStorage(repository, [FOCUS_SESSIONS_KEY, 'daynora.focus-session.v1'])
    : undefined;
  const notified = desktop ? await loadNotifiedFromStore(repository) : loadNotified();
  const history = desktop ? await repository.undoList().catch(() => []) : [];

  const state: AppState = {
    data,
    repository,
    selectedDate: chooseInitialDate(data),
    selectedTaskId: null,
    history,
    transfer: null,
    toast: null,
    panel: null,
    dirty: false,
    dragTaskId: null,
    backups: [],
    weather: loadCachedWeather(),
    weatherLoading: false,
    soundPlaying: 'off',
    search: '',
    expandedTaskIds: new Set(),
    notified,
    updaterStatus: 'disabled',
    goalTaskPicker: null,
    goalTaskQuery: '',
  };

  applyTheme(state.data.settings.theme);
  applyZoom(state.data.settings.uiScale || 1);
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.data.settings.theme === 'system') applyTheme('system');
    });
  }

  const t = (key: Parameters<typeof translate>[1]): string =>
    translate(state.data.settings.language, key);

  // 专注计时交给独立控制器：每个任务各自保存快照，退出界面/退出程序都能续上。
  const focus = createFocusController({
    storage: focusStorage,
    style: () => state.data.settings.focusStyle,
    soundPreset: () => state.data.settings.soundPreset,
    volume: () => state.data.settings.soundVolume,
    notify: (title, body) => {
      void state.repository.notify(title, body);
    },
    playSound: (preset, volume) =>
      audioMixer.play(preset as SoundPreset, volume),
    stopSound: () => audioMixer.stop(),
    playAlarm: () => audioMixer.playAlarm(),
    enterFullscreen: enterFocusFullscreen,
    exitFullscreen: exitFocusFullscreen,
    hideWindow: async () => {
      // 最小化而不是隐藏：Windows 任务栏保留图标，点一下就能回到程序。
      if (isTauriRuntime()) await getCurrentWindow().minimize();
    },
    requestRender: () => render(),
    showToast,
    finishedTitle: () => t('focusFinished'),
  });

  const currentTask = (): Task | null =>
    state.data.tasks.find((task) => task.id === state.selectedTaskId) || null;
  const dayTasks = (): Task[] => tasksForDate(state.data.tasks, state.selectedDate);
  const pendingTasks = (): Task[] => dayTasks().filter((task) => task.status === 'pending');
  const completedTasks = (): Task[] => dayTasks().filter((task) => task.status === 'completed');
  const trashedTasks = (): Task[] => state.data.tasks.filter((task) => task.status === 'trashed');

  async function persist(): Promise<void> {
    try {
      await state.repository.save(state.data);
      state.dirty = false;
    } catch (error) {
      showToast(`${t('saveFailed')}: ${String(error)}`);
    }
  }

  async function commit(): Promise<void> {
    if (state.data.settings.autoSave) {
      await persist();
    } else {
      state.dirty = true;
      render();
    }
  }

  function pushHistory(): void {
    const snapshot = cloneAppData(state.data);
    state.history.push(snapshot);
    if (state.history.length > MAX_HISTORY) state.history.shift();
    // 撤销栈同步落库，重开软件后仍可撤回。
    if (isTauriRuntime()) {
      void state.repository.undoPush(snapshot).catch(() => undefined);
    }
  }

  function showToast(message: string): void {
    state.toast = message;
    window.setTimeout(() => {
      state.toast = null;
      render();
    }, 2200);
  }

  /// 外链点击处理：同步阻止 WebView 自身跳转，改用系统默认浏览器打开。
  /// 必须在事件分发阶段同步调用 preventDefault，否则默认导航已经发生。
  function interceptExternalLink(event: MouseEvent): boolean {
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return false;
    const href = anchor.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href)) return false;
    event.preventDefault();
    event.stopPropagation();
    if (isTauriRuntime()) {
      void state.repository
        .openExternalUrl(href)
        .catch(() => window.open(href, '_blank', 'noopener'));
    } else {
      window.open(href, '_blank', 'noopener');
    }
    return true;
  }

  async function loadWeather(force = false): Promise<void> {
    let cached = state.weather || loadCachedWeather();
    if (cached && /^-?\d/.test(cached.city)) {
      const cityName = await reverseGeocode(
        cached.latitude,
        cached.longitude,
        state.data.settings.language,
      ).catch(() => t('currentLocation'));
      cached = { ...cached, city: cityName };
      saveCachedWeather(cached);
      state.data.settings.weatherCity = cityName;
    }
    const city = state.data.settings.weatherCity;
    if (!city) {
      state.weather = cached;
      render();
      return;
    }
    if (!force && cached && isWeatherCacheFresh(cached) && cached.city === city) {
      state.weather = cached;
      render();
      return;
    }
    state.weatherLoading = true;
    render();
    try {
      const snapshot = await fetchWeatherForCity(city);
      state.weather = snapshot;
      saveCachedWeather(snapshot);
      state.data.settings.weatherLatitude = snapshot.latitude;
      state.data.settings.weatherLongitude = snapshot.longitude;
      await persist();
    } catch (error) {
      showToast(`${t('weatherLoadFailed')}: ${String(error)}`);
    } finally {
      state.weatherLoading = false;
      render();
    }
  }

  function checkReminders(): void {
    if (!state.data.settings.notificationsEnabled) return;
    const now = new Date();
    const due = dueTaskReminders(state.data.tasks, now, state.notified);
    let changed = false;
    due.forEach((item) => {
      state.notified.add(`${toDateKey(now)}:${item.taskId}`);
      changed = true;
      void state.repository.notify(t('taskReminder'), `${item.startTime} · ${item.title}`);
    });
    if (isDailySummaryDue(now, [...state.notified].some((key) => key === dailySummaryKey(now)) ? toDateKey(now) : null)) {
      state.notified.add(dailySummaryKey(now));
      changed = true;
      const summary = summarizeDay(state.data.tasks, toDateKey(now));
      void state.repository.notify(
        t('dailySummary'),
        state.data.settings.language === 'zh-CN'
          ? `今天完成 ${summary.completed}/${summary.total} 个任务`
        : `${summary.completed}/${summary.total} tasks completed today`,
      );
    }
    if (changed) persistNotified(state.repository, state.notified);
  }

  /// 开始或继续某个任务的专注：已有会话时保留剩余时间，不重置。
  async function startFocus(task?: Task, minutesOverride?: number): Promise<void> {
    const title =
      task?.title || (state.data.settings.language === 'zh-CN' ? '专注时间' : 'Focus session');
    await focus.start(
      task?.id || '',
      title,
      minutesOverride || state.data.settings.focusMinutes || 45,
    );
    state.soundPlaying = (focus.visibleSession()?.soundPreset as SoundPreset) || 'off';
  }

  /// 继续某个任务已有的专注会话（不重置倒计时）。
  async function resumeFocusForTask(taskId: string): Promise<void> {
    await focus.openOverlay(taskId);
    state.soundPlaying = (focus.visibleSession()?.soundPreset as SoundPreset) || 'off';
  }

  function updateFocusClock(): void {
    const session = focus.visibleSession();
    if (!session) return;
    const timeNode = document.querySelector<HTMLElement>('[data-focus-time]');
    const progressNode = document.querySelector<HTMLElement>('[data-focus-progress]');
    const stateNode = document.querySelector<HTMLElement>('[data-focus-state]');
    if (timeNode) {
      timeNode.textContent = formatFocusTime(session.remainingSeconds);
      timeNode.classList.remove('is-ticking');
      void timeNode.offsetWidth;
      timeNode.classList.add('is-ticking');
    }
    if (progressNode) progressNode.style.width = `${focusProgress(session)}%`;
    if (stateNode) stateNode.textContent = session.running ? 'RUN' : 'PAUSE';
  }

  function priorityLabel(priority: Task['priority']): string {
    if (priority === 'low') return t('priorityLow');
    if (priority === 'medium') return t('priorityMedium');
    if (priority === 'high') return t('priorityHigh');
    return t('priorityNone');
  }

  function repeatLabel(repeat: Task['repeat']['type']): string {
    if (repeat === 'daily') return t('repeatDaily');
    if (repeat === 'weekly') return t('repeatWeekly');
    if (repeat === 'weekdays') return t('repeatWeekdays');
    return t('repeatNone');
  }

  function renderTaskCard(task: Task, mode: 'pending' | 'completed' | 'trash'): string {
    const category = state.data.categories.find((item) => item.id === task.categoryId);
    const selected = task.id === state.selectedTaskId ? ' is-selected' : '';
    const priorityClass = task.priority === 'none' ? '' : ` is-priority-${task.priority}`;
    const draggable = mode === 'pending' ? ' draggable="true"' : '';
    const time = formatTime(task.startTime, state.data.settings.timeFormat);
    const expanded = state.expandedTaskIds.has(task.id);
    const showDate = !!state.search.trim();
    const details = [
      task.notes ? `<p class="task-card__note">${escapeHtml(task.notes)}</p>` : '',
    ]
      .filter(Boolean)
      .join('');
    return `
      <li class="task-card${selected}${priorityClass} task-card--${mode}" data-task-id="${escapeHtml(task.id)}" data-mode="${mode}"${draggable}>
        ${
          mode === 'trash'
            ? ''
            : `<label class="task-card__check" title="${mode === 'pending' ? t('completed') : t('undo')}">
                <input type="checkbox" data-action="toggle-task" data-task-id="${escapeHtml(task.id)}" ${mode === 'completed' ? 'checked' : ''} />
                <span class="checkmark">${icon('circle-check-big')}</span>
              </label>`
        }
        <button class="task-card__body" type="button" data-action="select-task" data-task-id="${escapeHtml(task.id)}">
          <span class="task-card__title">${icon(task.icon)}${escapeHtml(task.title)}</span>
          <span class="task-card__meta">
            ${showDate ? `<em>${escapeHtml(task.date)}</em>` : ''}
            ${time ? `<b>${escapeHtml(time)}</b>` : ''}
            ${task.durationMinutes ? `<span>${escapeHtml(formatDuration(task.durationMinutes, state.data.settings.language))}</span>` : ''}
            ${category ? `<span class="task-card__category" style="--category-color:${escapeHtml(category.color)}">${escapeHtml(category.name)}</span>` : ''}
          </span>
        </button>
        ${
          details && mode !== 'trash'
            ? `<button type="button" class="task-card__expand" data-action="toggle-expand" data-task-id="${escapeHtml(task.id)}" title="Expand">
                ${icon(expanded ? 'chevron-left' : 'chevron-right')}
              </button>`
            : ''
        }
        ${
          mode === 'trash'
            ? `<span class="task-card__trash-actions">
                <button type="button" class="mini-button" data-action="restore-task" data-task-id="${escapeHtml(task.id)}" title="${t('restore')}">${icon('undo-2')}</button>
                <button type="button" class="mini-button" data-action="purge-task" data-task-id="${escapeHtml(task.id)}" title="${t('deleteForever')}">${icon('trash-2')}</button>
              </span>`
            : `<button class="task-card__delete" type="button" data-action="delete-task" data-task-id="${escapeHtml(task.id)}" title="${t('delete')}">
                ${icon('trash-2')}
              </button>`
        }
        ${expanded && details ? `<div class="task-card__details">${details}</div>` : ''}
      </li>`;
  }

  function renderHeader(): string {
    const summary = summarizeDay(state.data.tasks, state.selectedDate);
    const languageLabel = state.data.settings.language === 'zh-CN' ? 'EN' : '中文';
    return `
      <header class="topbar">
        <div class="topbar__row topbar__row--main">
          <div class="brand">
            <div class="brand__mark">${icon('sun-medium')}</div>
            <div>
              <h1>${t('appName')}</h1>
              <p>${t('tagline')}</p>
            </div>
          </div>
          <div class="date-nav">
            <button type="button" class="icon-button" data-action="prev-day" title="Previous day">${icon('chevron-left')}</button>
            <label class="date-picker">
              ${icon('calendar-days')}
              <input type="date" value="${escapeHtml(state.selectedDate)}" data-action="change-date" />
            </label>
            <button type="button" class="icon-button" data-action="next-day" title="Next day">${icon('chevron-right')}</button>
            <button type="button" class="ghost-button" data-action="today">${t('today')}</button>
          </div>
          <div class="stats">
            <span><b>${summary.total}</b> ${t('taskCount')}</span>
            <span><b>${summary.completed}</b> ${t('completed')}</span>
            <span><b>${summary.percent}%</b> ${t('progress')}</span>
            ${state.dirty ? `<span class="stats__dirty">${t('unsaved')}</span>` : ''}
          </div>
          <div class="topbar__actions">
            ${
              !focus.isOverlayVisible() && focus.activeSession()
                ? `<button type="button" class="ghost-button focus-resume-chip" data-action="resume-saved-focus" title="${escapeHtml(focus.activeSession()?.title || '')}">${icon('clock')}${formatFocusTime(focus.activeSession()?.remainingSeconds || 0)}</button>`
                : ''
            }
            <button type="button" class="ghost-button theme-button" data-action="cycle-theme">${icon('palette')}${t('theme')}</button>
            <button type="button" class="ghost-button" data-action="toggle-language">${languageLabel}</button>
          </div>
        </div>
        <div class="topbar__row topbar__row--tools">
          <label class="search-box">
            ${icon('search')}
            <input type="search" data-search-input value="${escapeHtml(state.search)}" placeholder="${t('searchPlaceholder')}" />
            ${state.search ? `<button type="button" class="mini-button" data-action="clear-search">×</button>` : ''}
          </label>
          <span class="topbar__hint">${state.data.settings.sidebarCollapsed ? t('sidebarCollapsed') : t('sidebarExpanded')}</span>
        </div>
      </header>
      <div class="progress-track" aria-label="${t('progress')}">
        <i style="width:${summary.percent}%"></i>
      </div>`;
  }

  function renderGoals(): string {
    if (!state.data.goals.length) return '';
    return `
      <section class="goal-strip">
        <button class="goal-strip__label" type="button" data-action="open-goals">${icon('target')}${t('goals')}</button>
        ${state.data.goals
          .map((goal) => {
            const progress = goal.linkedTaskIds.length
              ? calculateGoalProgress(goal, state.data.tasks)
              : goal.progress;
            return `
              <article class="goal-chip">
                <span>${escapeHtml(goal.title)}</span>
                <b>${progress}%</b>
                <i style="width:${progress}%"></i>
              </article>`;
          })
          .join('')}
      </section>`;
  }

  function renderPendingItems(): string {
    const searchMode = !!state.search.trim();
    const tasks = searchMode
      ? sortTasks(searchTasks(state.data.tasks, state.data.categories, state.search))
      : pendingTasks();
    return tasks.length
      ? tasks.map((task) => renderTaskCard(task, 'pending')).join('')
      : `<li class="empty-state">${searchMode ? t('noSearchResults') : t('noTasks')}</li>`;
  }

  function renderCompactTask(task: Task): string {
    const time = formatTime(task.startTime, state.data.settings.timeFormat);
    return `
      <li class="compact-task" data-task-id="${escapeHtml(task.id)}">
        <label class="compact-task__check">
          <input type="checkbox" data-action="toggle-task" data-task-id="${escapeHtml(task.id)}" />
          <span class="checkmark">${icon('circle-check-big')}</span>
        </label>
        <button type="button" class="compact-task__title" data-action="select-task" data-task-id="${escapeHtml(task.id)}">
          ${icon(task.icon)}<span>${escapeHtml(task.title)}</span>
        </button>
        ${time ? `<span class="compact-task__time">${escapeHtml(time)}</span>` : ''}
      </li>`;
  }

  function renderPendingColumn(): string {
    const searchMode = !!state.search.trim();
    const tasks = searchMode
      ? sortTasks(searchTasks(state.data.tasks, state.data.categories, state.search))
      : pendingTasks();
    const collapsed = !!state.data.settings.pendingCollapsed;
    return `
      <section class="column column--pending">
        <header class="column__head">
          <div>
            <span class="column__eyebrow">QUEUE</span>
            <h2>${t('pending')}</h2>
            ${searchMode ? `<span class="column__hint" data-search-count>${tasks.length} ${t('searchResults')}</span>` : ''}
          </div>
          <div class="column__actions">
            <button type="button" class="icon-button" data-action="toggle-pending" title="${collapsed ? t('expandPending') : t('collapsePending')}">
              ${icon(collapsed ? 'chevron-right' : 'chevron-left')}
            </button>
            <button type="button" class="primary-button" data-action="add-task">${icon('plus')}${t('addTask')}</button>
          </div>
        </header>
        ${
          collapsed
            ? `<ul class="task-list task-list--compact">${tasks.map(renderCompactTask).join('')}</ul>`
            : `<ul class="task-list" data-drop="pending" data-search-results>${renderPendingItems()}</ul>`
        }
      </section>`;
  }

  function renderIconPicker(task: Task): string {
    const choices = [
      'circle-check-big',
      'sun-medium',
      'star',
      'flag',
      'target',
      'trophy',
      'rocket',
      'compass',
      'book-open',
      'pen-line',
      'pencil',
      'file-text',
      'clipboard-list',
      'folder',
      'package',
      'languages',
      'graduation-cap',
      'sigma',
      'bar-chart',
      'trending-up',
      'activity',
      'cpu',
      'code-xml',
      'braces',
      'terminal',
      'database',
      'server',
      'cloud',
      'hard-drive',
      'layers',
      'network',
      'briefcase',
      'wallet',
      'mail',
      'laptop',
      'home',
      'utensils',
      'coffee',
      'dumbbell',
      'timer',
      'alarm-clock',
      'bell',
      'zap',
      'flame',
      'users',
      'settings',
      'monitor',
    ].filter((name) => ICONS[name]);
    return `
      <div class="icon-picker">
        ${choices
          .map(
            (name) => `
              <button type="button" class="icon-picker__item${name === task.icon ? ' is-active' : ''}" data-action="pick-icon" data-task-id="${escapeHtml(task.id)}" data-icon="${name}" title="${name}">
                ${icon(name)}
              </button>`,
          )
          .join('')}
      </div>`;
  }

  function renderEditor(): string {
    const task = currentTask();
    if (!task) {
      return `
        <section class="column column--editor">
          <header class="column__head">
            <div><span class="column__eyebrow">EDIT</span><h2>${t('editor')}</h2></div>
          </header>
          <div class="editor-empty">${icon('mouse-pointer-2')}<p>${t('selectTask')}</p></div>
        </section>`;
    }

    const categories = [...state.data.categories]
      .map(
        (category) =>
          `<option value="${escapeHtml(category.id)}"${category.id === task.categoryId ? ' selected' : ''}>${escapeHtml(category.name)}</option>`,
      )
      .join('');

    // 已经有同一个任务的专注会话时，按钮变成“继续专注”，避免倒计时被重置。
    const savedFocus = focus.sessionFor(task.id);

    return `
      <section class="column column--editor">
        <header class="column__head">
          <div><span class="column__eyebrow">EDIT</span><h2>${t('editor')}</h2></div>
          <div class="column__actions">
            ${
              state.dirty
                ? `<button type="button" class="primary-button" data-action="save-now">${t('saveNow')}</button>`
                : ''
            }
            ${
              savedFocus
                ? `<button type="button" class="primary-button" data-action="resume-task-focus" data-task-id="${escapeHtml(task.id)}">${icon('clock')}${t('focusResume')} · ${formatFocusTime(savedFocus.remainingSeconds)}</button>`
                : `<button type="button" class="primary-button" data-action="start-focus" data-task-id="${escapeHtml(task.id)}">${icon('clock')}${t('startFocus')}</button>`
            }
            <button type="button" class="ghost-button" data-action="copy-task" data-task-id="${escapeHtml(task.id)}">${icon('plus')}${t('copyTask')}</button>
            <button type="button" class="danger-button" data-action="delete-task" data-task-id="${escapeHtml(task.id)}">${icon('trash-2')}${t('delete')}</button>
          </div>
        </header>
        <form class="editor" data-task-id="${escapeHtml(task.id)}">
          <label class="field field--wide">
            <span>${t('title')}</span>
            <input name="title" value="${escapeHtml(task.title)}" data-field="title" />
          </label>
          <div class="field-row">
            <label class="field">
              <span>${t('date')}</span>
              <input type="date" name="date" value="${escapeHtml(task.date)}" data-field="date" />
            </label>
            <label class="field">
              <span>${t('time')}</span>
              <input type="time" name="startTime" value="${escapeHtml(task.startTime || '')}" data-field="startTime" />
            </label>
          </div>
          <div class="field-row">
            <label class="field">
              <span>${t('duration')}</span>
              <input type="number" min="0" step="5" name="durationMinutes" value="${task.durationMinutes ?? ''}" data-field="durationMinutes" />
            </label>
            <label class="field">
              <span>${t('priority')}</span>
              <select name="priority" data-field="priority">
                ${(['none', 'low', 'medium', 'high'] as const)
                  .map((value) => `<option value="${value}"${task.priority === value ? ' selected' : ''}>${priorityLabel(value)}</option>`)
                  .join('')}
              </select>
            </label>
          </div>
          <div class="field-row">
            <label class="field">
              <span>${t('category')}</span>
              <select name="categoryId" data-field="categoryId">
                <option value="">—</option>${categories}
              </select>
            </label>
            <label class="field">
              <span>${t('repeat')}</span>
              <select name="repeat" data-field="repeat">
                ${(['none', 'daily', 'weekly', 'weekdays'] as const)
                  .map((value) => `<option value="${value}"${task.repeat.type === value ? ' selected' : ''}>${repeatLabel(value)}</option>`)
                  .join('')}
              </select>
            </label>
          </div>
          <div class="field field--wide">
            <span>${t('icon')}</span>
            ${renderIconPicker(task)}
          </div>
          <label class="field field--wide">
            <span>${t('notes')} <em data-note-count>${Array.from(task.notes || '').length}/50</em></span>
            <textarea name="notes" rows="2" maxlength="50" data-field="notes">${escapeHtml(task.notes || '')}</textarea>
          </label>
          <p class="editor__meta">ID: ${escapeHtml(task.id)} · ${escapeHtml(task.updatedAt)}</p>
        </form>
      </section>`;
  }

  function renderCompletedColumn(): string {
    const tasks = completedTasks();
    return `
      <section class="column column--completed" data-drop="completed">
        <header class="column__head">
          <div>
            <span class="column__eyebrow">DONE</span>
            <h2>${t('completed')}</h2>
          </div>
          <div class="column__actions">
            <button type="button" class="ghost-button" data-action="undo" ${state.history.length ? '' : 'disabled'}>${icon('undo-2')}${t('undo')}</button>
            <button type="button" class="ghost-button" data-action="clear-completed" ${tasks.length ? '' : 'disabled'}>${t('clearCompleted')}</button>
          </div>
        </header>
        <ul class="task-list task-list--completed">
          ${tasks.length ? tasks.map((task) => renderTaskCard(task, 'completed')).join('') : `<li class="empty-state">${t('noCompleted')}</li>`}
        </ul>
      </section>`;
  }

  function renderConveyor(): string {
    const active = state.transfer;
    return `
      <footer class="conveyor${active ? ' is-active' : ''}">
        <div class="conveyor__label">${icon('arrow-right-left')}${state.data.settings.language === 'zh-CN' ? '任务传输带' : 'Task conveyor'}</div>
        <div class="conveyor__track">
          <span class="conveyor__dot"></span>
          <span class="conveyor__dot"></span>
          <span class="conveyor__dot"></span>
          ${active ? `<span class="conveyor__item conveyor__item--${active.direction}">${escapeHtml(active.title)}</span>` : ''}
        </div>
        <div class="conveyor__hint">${active ? (active.direction === 'to-completed' ? t('movedToCompleted') : t('movedBack')) : ''}</div>
      </footer>`;
  }

  /// 弹层面板：渲染逻辑已拆分到 features/panel-views.ts。
  function renderPanel(): string {
    const ctx = { state, t, renderTaskCard };
    if (state.panel === 'settings') return renderSettingsPanel(ctx);
    if (state.panel === 'trash') return renderTrashPanel(ctx);
    if (state.panel === 'goals') return renderGoalsPanel(ctx);
    if (state.panel === 'export') return renderExportPanel(ctx);
    if (state.panel === 'sound') return renderSoundPanel(ctx);
    if (state.panel === 'focus-setup') return renderFocusSetupPanel(ctx);
    return '';
  }
  function renderFocusOverlay(): string {
    const session = focus.visibleSession();
    if (!session) return '';
    return `
      <div class="focus-overlay focus-overlay--${session.style}">
        <div class="focus-clock">
          <div class="focus-clock__top">
            <span data-focus-state>${session.running ? 'RUN' : 'PAUSE'}</span>
            <span>${Math.round(session.totalSeconds / 60)} MIN</span>
          </div>
          <div class="focus-clock__title">${escapeHtml(session.title)}</div>
          <div class="focus-clock__time" data-focus-time>${formatFocusTime(session.remainingSeconds)}</div>
          <div class="focus-clock__progress"><i data-focus-progress style="width:${focusProgress(session)}%"></i></div>
          <div class="focus-clock__actions">
            <button type="button" class="ghost-button" data-action="focus-toggle">${session.running ? t('focusPause') : t('focusResume')}</button>
            <button type="button" class="ghost-button" data-action="focus-reset">${t('focusReset')}</button>
            <button type="button" class="ghost-button" data-action="focus-sound-toggle">${icon('volume-2')}${escapeHtml(SOUND_OPTIONS.find((item) => item.id === (session.soundPreset as SoundPreset))?.label || t('sound'))}</button>
            <button type="button" class="ghost-button" data-action="focus-minimize">${icon('minus')}${t('focusMinimize')}</button>
            <button type="button" class="danger-button" data-action="focus-close">${t('saveAndExit')}</button>
          </div>
          <p class="focus-clock__hint">${t('focusExitHint')}</p>
        </div>
      </div>`;
  }

  function renderSidebar(): string {
    const collapsed = !!state.data.settings.sidebarCollapsed;
    const weatherText = state.weather
      ? `${Math.round(state.weather.temperature)}°C ${state.weather.city}`
      : t('weatherCity');
    const item = (action: string, iconName: string, label: string, badge = ''): string => `
      <button type="button" class="sidebar__item" data-action="${action}" title="${escapeHtml(label)}">
        ${icon(iconName)}
        <span>${escapeHtml(label)}</span>
        ${badge ? `<em>${badge}</em>` : ''}
      </button>`;
    return `
      <aside class="sidebar${collapsed ? ' is-collapsed' : ''}">
        <button type="button" class="sidebar__toggle" data-action="toggle-sidebar" title="${collapsed ? t('expandSidebar') : t('collapseSidebar')}">
          ${icon(collapsed ? 'chevron-right' : 'chevron-left')}
          <span>${collapsed ? t('expandSidebar') : t('collapseSidebar')}</span>
        </button>
        <nav class="sidebar__nav">
          ${item('open-focus-setup', 'timer', t('pomodoro'))}
          ${item('toggle-sound', 'volume-2', t('sound'))}
          ${item('open-settings', 'cloud-sun', weatherText)}
          ${item('open-goals', 'target', t('goals'))}
          ${item('import-file', 'upload', t('importFile'))}
          ${item('open-export', 'download', t('exportFile'))}
          ${item('open-trash', 'trash-2', t('trash'), trashedTasks().length ? String(trashedTasks().length) : '')}
          ${item('open-ai', 'sparkles', t('ai'))}
          ${item('open-settings', 'settings', t('settings'))}
        </nav>
      </aside>`;
  }

  function render(): void {
    root.innerHTML = `
      ${renderSprite()}
      <div class="app-shell${state.selectedTaskId ? ' is-editing' : ''}">
        ${renderHeader()}
        <div class="app-body">
          ${renderSidebar()}
          <div class="main-area">
            ${renderGoals()}
            <main class="workspace">
              ${renderPendingColumn()}
              ${renderEditor()}
              ${renderCompletedColumn()}
            </main>
          </div>
        </div>
        ${renderConveyor()}
        ${renderPanel()}
        ${renderFocusOverlay()}
        ${aiPanel.render()}
        ${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ''}
        <div class="license">程序由 DeepSeek 和知澜程序员（Knowlira Developer）共同构建 · ${escapeHtml(ICON_LICENSE)} · Daynora 0.1.0</div>
      </div>`;
    aiPanel.afterRender();
  }

  function updateTask(taskId: string, patch: Partial<Task>): void {
    const now = new Date().toISOString();
    state.data.tasks = state.data.tasks.map((task) =>
      task.id === taskId ? { ...task, ...patch, updatedAt: now } : task,
    );
  }

  function selectedTaskFromDataset(target: HTMLElement): string | null {
    return target.dataset.taskId || target.closest<HTMLElement>('[data-task-id]')?.dataset.taskId || null;
  }

  async function exportCurrent(format: ExportFormat): Promise<void> {
    try {
      const path = await state.repository.saveTextFile(
        exportFileName(format),
        serializeSnapshot(state.data, format),
      );
      showToast(path ? `${t('exportSuccess')}: ${path}` : t('exportFailed'));
    } catch (error) {
      showToast(`${t('exportFailed')}: ${String(error)}`);
    }
  }

  async function importCurrent(): Promise<void> {
    try {
      const file = await state.repository.openTextFile();
      if (!file) return;
      const imported = parseImportedSnapshot(file.contents, DEFAULT_SETTINGS);
      await state.repository.backup();
      pushHistory();
      state.data = imported;
      state.selectedTaskId = null;
      state.selectedDate = chooseInitialDate(imported);
      await persist();
      showToast(t('importSuccess'));
      render();
    } catch (error) {
      showToast(`${t('importFailed')}: ${String(error)}`);
    }
  }

  /// 读取目标编辑卡片里尚未保存的文本输入，避免勾选关联任务时丢掉用户正在编辑的内容。
  function readGoalEditorPatch(goalId: string): Partial<Goal> {
    const editor = document.querySelector<HTMLElement>(`[data-goal-id="${goalId}"]`);
    if (!editor) return {};
    const patch: Partial<Goal> = {};
    const title = editor.querySelector<HTMLInputElement>('[data-goal-field="title"]')?.value.trim();
    const targetDate = editor.querySelector<HTMLInputElement>('[data-goal-field="targetDate"]')?.value;
    const description = editor.querySelector<HTMLTextAreaElement>('[data-goal-field="description"]')?.value;
    if (title) patch.title = title;
    if (targetDate !== undefined) patch.targetDate = targetDate;
    if (description !== undefined) patch.description = description;
    return patch;
  }

  function updateGoal(goalId: string, patch: Partial<Goal>): void {
    state.data.goals = state.data.goals.map((goal) =>
      goal.id === goalId ? { ...goal, ...patch, updatedAt: new Date().toISOString() } : goal,
    );
  }

  // AI 面板独立成模块（features/ai-panel.ts），这里只做依赖注入与事件转发。
  const aiPanel: AiPanel = createAiPanel({
    repository: state.repository,
    t: (key: string) =>
      translate(state.data.settings.language, key as Parameters<typeof translate>[1]),
    icon,
    escapeHtml,
    showToast,
    requestRender: () => render(),
    reloadAppData: async () => {
      const refreshed = await state.repository.load();
      if (refreshed) {
        state.data = normalizeAppData(refreshed, DEFAULT_SETTINGS);
        state.selectedTaskId = null;
      }
    },
    language: () => state.data.settings.language,
    createId,
  });

  root.addEventListener('click', async (event) => {
    // 外链拦截必须放在捕获阶段且同步执行：先阻止 WebView 自己的跳转，
    // 再交给系统浏览器打开，否则软件内部也会跟着导航过去（回不来）。
    if (interceptExternalLink(event)) return;
    const rawTarget = event.target as HTMLElement;
    if (await aiPanel.onClick(rawTarget)) return;
    if (rawTarget.classList.contains('modal-backdrop')) {
      state.panel = null;
      render();
      return;
    }
    if (rawTarget.classList.contains('ai-layer')) {
      aiPanel.close();
      render();
      return;
    }
    const target = rawTarget.closest<HTMLElement>('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    if (action === 'close-panel') {
      state.panel = null;
      render();
      return;
    }

    if (action === 'open-ai') {
      await aiPanel.toggle();
      render();
      return;
    }

    if (action === 'open-settings') {
      state.backups = await state.repository.listBackups();
      state.updaterStatus = await state.repository.updaterStatus();
      state.panel = 'settings';
      render();
      return;
    }

    if (action === 'start-focus') {
      const taskId = selectedTaskFromDataset(target);
      const task = state.data.tasks.find((item) => item.id === taskId);
      if (!task) return;
      await startFocus(task, task.durationMinutes || state.data.settings.focusMinutes);
      return;
    }

    if (action === 'focus-toggle') {
      focus.toggle();
      return;
    }

    if (action === 'focus-reset') {
      focus.reset();
      return;
    }

    if (action === 'focus-close') {
      // 退出界面但继续计时（回到软件后按钮会变成“继续专注”）。
      focus.closeOverlay();
      render();
      return;
    }

    if (action === 'focus-minimize') {
      await focus.hideToTray();
      return;
    }

    if (action === 'open-focus-setup') {
      state.panel = 'focus-setup';
      render();
      return;
    }

    if (action === 'resume-saved-focus') {
      await resumeFocusForTask(focus.activeSession()?.taskId || '');
      return;
    }

    if (action === 'resume-task-focus') {
      const taskId = selectedTaskFromDataset(target);
      if (!taskId) return;
      await resumeFocusForTask(taskId);
      return;
    }

    if (action === 'toggle-sound') {
      state.panel = state.panel === 'sound' ? null : 'sound';
      render();
      return;
    }

    if (action === 'toggle-sidebar') {
      state.data.settings.sidebarCollapsed = !state.data.settings.sidebarCollapsed;
      await persist();
      render();
      return;
    }

    if (action === 'toggle-pending') {
      state.data.settings.pendingCollapsed = !state.data.settings.pendingCollapsed;
      await persist();
      render();
      return;
    }

    if (action === 'sound-select') {
      const preset = target.dataset.sound as SoundPreset | undefined;
      if (!preset) return;
      state.data.settings.soundPreset = preset;
      state.soundPlaying = preset;
      await audioMixer.play(preset, state.data.settings.soundVolume);
      await persist();
      render();
      return;
    }

    if (action === 'sound-stop') {
      audioMixer.stop();
      state.soundPlaying = 'off';
      state.data.settings.soundPreset = 'off';
      await persist();
      render();
      return;
    }

    if (action === 'focus-sound-toggle') {
      const session = focus.visibleSession();
      if (!session) return;
      if (state.soundPlaying === 'off') {
        const preset = (session.soundPreset as SoundPreset) || 'rain';
        await audioMixer.play(preset, state.data.settings.soundVolume);
        state.soundPlaying = preset;
      } else {
        audioMixer.stop();
        state.soundPlaying = 'off';
      }
      render();
      return;
    }

    if (action === 'start-focus-from-setup') {
      const minutes = Number(document.querySelector<HTMLInputElement>('[data-focus-duration]')?.value || state.data.settings.focusMinutes || 45);
      const style = (document.querySelector<HTMLSelectElement>('[data-focus-style]')?.value || state.data.settings.focusStyle) as FocusStyle;
      const sound = (document.querySelector<HTMLSelectElement>('[data-focus-sound]')?.value || state.data.settings.soundPreset) as SoundPreset;
      const taskId = document.querySelector<HTMLSelectElement>('[data-focus-task]')?.value || '';
      const task = state.data.tasks.find((item) => item.id === taskId);
      state.data.settings.focusMinutes = Math.max(5, Math.min(180, minutes));
      state.data.settings.focusStyle = style;
      state.data.settings.soundPreset = sound;
      state.panel = null;
      await persist();
      // 面板里选的是「新的时长/样式/声音」：先清掉该任务的旧快照再开始。
      if (task) focus.forget(task.id);
      await startFocus(task, minutes);
      return;
    }

    if (action === 'toggle-expand') {
      const taskId = selectedTaskFromDataset(target);
      if (!taskId) return;
      if (state.expandedTaskIds.has(taskId)) state.expandedTaskIds.delete(taskId);
      else state.expandedTaskIds.add(taskId);
      render();
      return;
    }

    if (action === 'clear-search') {
      state.search = '';
      render();
      return;
    }

    if (action === 'copy-text') {
      const text = target.dataset.copy || '';
      if (text) await navigator.clipboard.writeText(text).catch(() => undefined);
      return;
    }

    if (action === 'open-backup-folder') {
      await state.repository.openBackupFolder();
      return;
    }

    if (action === 'weather-gps') {
      try {
        const point = await getBrowserLocation();
        const city = await reverseGeocode(
          point.latitude,
          point.longitude,
          state.data.settings.language,
        ).catch(() => t('currentLocation'));
        const snapshot = await fetchWeatherByPoint({ ...point, name: city });
        state.weather = snapshot;
        state.data.settings.weatherCity = snapshot.city;
        state.data.settings.weatherLatitude = snapshot.latitude;
        state.data.settings.weatherLongitude = snapshot.longitude;
        saveCachedWeather(snapshot);
        await persist();
        render();
      } catch (error) {
        showToast(`${t('weatherLoadFailed')}: ${String(error)}`);
      }
      return;
    }

    if (action === 'open-trash') {
      state.panel = 'trash';
      render();
      return;
    }

    if (action === 'open-goals') {
      state.panel = 'goals';
      render();
      return;
    }

    if (action === 'open-export') {
      state.panel = 'export';
      render();
      return;
    }

    if (action === 'add-task') {
      pushHistory();
      const task = createTask({
        title: state.data.settings.language === 'zh-CN' ? '新任务' : 'New task',
        date: state.selectedDate,
        order: pendingTasks().length,
      });
      state.data.tasks.push(task);
      state.selectedTaskId = task.id;
      await persist();
      render();
      return;
    }

    if (action === 'select-task') {
      const taskId = selectedTaskFromDataset(target);
      if (!taskId) return;
      state.selectedTaskId = taskId;
      render();
      return;
    }

    if (action === 'copy-task') {
      const taskId = selectedTaskFromDataset(target);
      const source = state.data.tasks.find((task) => task.id === taskId);
      if (!source) return;
      pushHistory();
      const copy = createTask({
        ...source,
        id: undefined,
        title: `${source.title} (copy)`,
        status: 'pending',
        order: pendingTasks().length,
      });
      state.data.tasks.push(copy);
      state.selectedTaskId = copy.id;
      await persist();
      showToast(t('copied'));
      render();
      return;
    }

    if (action === 'delete-task') {
      const taskId = selectedTaskFromDataset(target);
      if (!taskId) return;
      await state.repository.backup();
      pushHistory();
      state.data.tasks = setTaskStatus(state.data.tasks, taskId, 'trashed');
      focus.forget(taskId);
      state.selectedTaskId = null;
      await persist();
      showToast(t('deletedToTrash'));
      render();
      return;
    }

    if (action === 'restore-task') {
      const taskId = selectedTaskFromDataset(target);
      if (!taskId) return;
      pushHistory();
      state.data.tasks = setTaskStatus(state.data.tasks, taskId, 'pending');
      await persist();
      showToast(t('restored'));
      render();
      return;
    }

    if (action === 'purge-task') {
      const taskId = selectedTaskFromDataset(target);
      if (!taskId) return;
      await state.repository.backup();
      pushHistory();
      focus.forget(taskId);
      state.data.tasks = state.data.tasks.filter((task) => task.id !== taskId);
      state.data.goals = state.data.goals.map((goal) => ({
        ...goal,
        linkedTaskIds: goal.linkedTaskIds.filter((id) => id !== taskId),
      }));
      await persist();
      showToast(t('purged'));
      render();
      return;
    }

    if (action === 'empty-trash') {
      if (!trashedTasks().length) return;
      await state.repository.backup();
      pushHistory();
      const trashed = new Set(trashedTasks().map((task) => task.id));
      trashed.forEach((taskId) => focus.forget(taskId));
      state.data.tasks = state.data.tasks.filter((task) => !trashed.has(task.id));
      await persist();
      render();
      return;
    }

    if (action === 'undo') {
      const previous = state.history.pop();
      if (!previous) return;
      if (isTauriRuntime()) {
        void state.repository.undoPop().catch(() => undefined);
      }
      state.data = previous;
      state.selectedTaskId = null;
      await persist();
      render();
      return;
    }

    if (action === 'clear-completed') {
      if (!completedTasks().length) return;
      await state.repository.backup();
      pushHistory();
      const completedIds = new Set(completedTasks().map((task) => task.id));
      state.data.tasks = state.data.tasks.map((task) =>
        completedIds.has(task.id) ? { ...task, status: 'trashed' } : task,
      );
      await persist();
      render();
      return;
    }

    if (action === 'prev-day') {
      state.selectedDate = addDays(state.selectedDate, -1);
      state.selectedTaskId = null;
      render();
      return;
    }

    if (action === 'next-day') {
      state.selectedDate = addDays(state.selectedDate, 1);
      state.selectedTaskId = null;
      render();
      return;
    }

    if (action === 'today') {
      state.selectedDate = toDateKey();
      state.selectedTaskId = null;
      render();
      return;
    }

    if (action === 'toggle-language') {
      state.data.settings.language = state.data.settings.language === 'zh-CN' ? 'en' : 'zh-CN';
      await persist();
      render();
      return;
    }

    if (action === 'cycle-theme') {
      const order: ThemePreference[] = ['system', 'light', 'dark', 'retro'];
      const index = order.indexOf(state.data.settings.theme);
      state.data.settings.theme = order[(index + 1) % order.length];
      applyTheme(state.data.settings.theme);
      await persist();
      render();
      return;
    }

    if (action === 'pick-icon') {
      const taskId = selectedTaskFromDataset(target);
      const iconName = target.dataset.icon;
      if (!taskId || !iconName) return;
      pushHistory();
      updateTask(taskId, { icon: iconName });
      await commit();
      if (state.data.settings.autoSave) render();
      return;
    }

    if (action === 'save-now') {
      await persist();
      render();
      return;
    }

    if (action === 'backup-now') {
      const path = await state.repository.backup();
      state.backups = await state.repository.listBackups();
      showToast(path ? `${t('backupCreated')}: ${path}` : t('backupUnavailable'));
      render();
      return;
    }

    if (action === 'export-format') {
      const format = target.dataset.format as ExportFormat | undefined;
      if (!format) return;
      await exportCurrent(format);
      return;
    }

    if (action === 'import-file') {
      await importCurrent();
      return;
    }

    if (action === 'print-page') {
      window.print();
      return;
    }

    if (action === 'add-goal') {
      const title = document.querySelector<HTMLInputElement>('[data-new-goal-field="title"]')?.value.trim();
      if (!title) return;
      const targetDate = document.querySelector<HTMLInputElement>('[data-new-goal-field="targetDate"]')?.value;
      const description = document.querySelector<HTMLTextAreaElement>('[data-new-goal-field="description"]')?.value;
      const now = new Date().toISOString();
      pushHistory();
      state.data.goals.push({
        id: createId('goal'),
        title,
        description,
        targetDate,
        progress: 0,
        status: 'active',
        linkedTaskIds: [],
        createdAt: now,
        updatedAt: now,
      });
      await persist();
      showToast(t('goalAdded'));
      render();
      return;
    }

    if (action === 'save-goal') {
      const goalId = target.dataset.goalId;
      if (!goalId) return;
      pushHistory();
      updateGoal(goalId, readGoalEditorPatch(goalId));
      await persist();
      render();
      return;
    }

    if (action === 'toggle-goal-picker') {
      const goalId = target.dataset.goalId;
      if (!goalId) return;
      state.goalTaskPicker = state.goalTaskPicker === goalId ? null : goalId;
      state.goalTaskQuery = '';
      render();
      return;
    }

    if (action === 'unlink-goal-task') {
      const goalId = target.dataset.goalId;
      const taskId = target.dataset.taskId;
      if (!goalId || !taskId) return;
      const goal = state.data.goals.find((item) => item.id === goalId);
      if (!goal) return;
      pushHistory();
      updateGoal(goalId, {
        ...readGoalEditorPatch(goalId),
        linkedTaskIds: goal.linkedTaskIds.filter((id) => id !== taskId),
      });
      await persist();
      render();
      return;
    }

    if (action === 'delete-goal') {
      const goalId = target.dataset.goalId;
      if (!goalId) return;
      pushHistory();
      state.data.goals = state.data.goals.filter((goal) => goal.id !== goalId);
      await persist();
      render();
      return;
    }

    if (action === 'add-category') {
      const input = document.querySelector<HTMLInputElement>('[data-category-input]');
      const name = input?.value.trim();
      if (!name) return;
      pushHistory();
      const palette = ['#b8542f', '#355070', '#3f6c51', '#9a6b2f', '#7d5ba6', '#2f7d8c'];
      state.data.categories.push({
        id: createId('category'),
        name,
        color: palette[state.data.categories.length % palette.length],
        icon: 'circle-check-big',
        order: state.data.categories.length,
      });
      await persist();
      showToast(t('categoryAdded'));
      render();
      return;
    }

    if (action === 'delete-category') {
      const categoryId = target.dataset.categoryId;
      if (!categoryId) return;
      pushHistory();
      state.data.categories = state.data.categories.filter((category) => category.id !== categoryId);
      state.data.tasks = state.data.tasks.map((task) =>
        task.categoryId === categoryId ? { ...task, categoryId: undefined } : task,
      );
      await persist();
      render();
    }

  });

  root.addEventListener('change', async (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

    if (await aiPanel.onChange(target)) return;

    if (target.dataset.setting === 'uiScalePercent') {
      state.data.settings.uiScale = Number(target.value) / 100;
      applyZoom(state.data.settings.uiScale);
      await persist();
      render();
      return;
    }

    if (target.dataset.setting === 'soundVolumePercent') {
      state.data.settings.soundVolume = Number(target.value) / 100;
      audioMixer.setVolume(state.data.settings.soundVolume);
      await persist();
      render();
      return;
    }

    if (target.dataset.setting) {
      const key = target.dataset.setting as keyof AppData['settings'];
      let value: string | boolean | number = target.value;
      if (target instanceof HTMLInputElement && target.type === 'checkbox') value = target.checked;
      if (key === 'focusMinutes') value = Number(value);
      (state.data.settings as unknown as Record<string, unknown>)[key] = value;
      if (key === 'theme') applyTheme(value as ThemePreference);
      if (key === 'launchAtStartup') {
        try {
          await state.repository.setAutostart(Boolean(value));
        } catch (error) {
          showToast(`${t('saveFailed')}: ${String(error)}`);
        }
      }
      if (key === 'closeToTray') {
        await state.repository.setCloseToTray(Boolean(value));
      }
      await persist();
      if (key === 'weatherCity') {
        await loadWeather(true);
        return;
      }
      render();
      return;
    }

    if (target.dataset.action === 'change-date' && target instanceof HTMLInputElement) {
      state.selectedDate = target.value || toDateKey();
      state.selectedTaskId = null;
      render();
      return;
    }

    if (target.dataset.action === 'toggle-task') {
      const taskId = target.dataset.taskId;
      if (!taskId) return;
      const task = state.data.tasks.find((item) => item.id === taskId);
      if (!task) return;
      pushHistory();
      const nextStatus = target instanceof HTMLInputElement && target.checked ? 'completed' : 'pending';
      state.data.tasks = setTaskStatus(state.data.tasks, taskId, nextStatus);
      state.transfer = {
        taskId,
        title: task.title,
        direction: nextStatus === 'completed' ? 'to-completed' : 'to-pending',
      };
      await persist();
      render();
      window.setTimeout(() => {
        state.transfer = null;
        render();
      }, 950);
      return;
    }

    if (target.dataset.action === 'toggle-goal-task') {
      const goalId = target.dataset.goalId;
      const taskId = target.dataset.taskId;
      if (!goalId || !taskId || !(target instanceof HTMLInputElement)) return;
      pushHistory();
      const goal = state.data.goals.find((item) => item.id === goalId);
      if (!goal) return;
      const linked = new Set(goal.linkedTaskIds);
      if (target.checked) linked.add(taskId);
      else linked.delete(taskId);
      updateGoal(goalId, {
        ...readGoalEditorPatch(goalId),
        linkedTaskIds: [...linked],
      });
      await persist();
      render();
      return;
    }

    const field = target.dataset.field;
    const form = target.closest<HTMLFormElement>('form[data-task-id]');
    const taskId = form?.dataset.taskId;
    if (!field || !taskId) return;
    const task = state.data.tasks.find((item) => item.id === taskId);
    if (!task) return;

    let value: string | number | undefined = target.value;
    if (field === 'durationMinutes') value = value ? Number(value) : undefined;
    if (field === 'notes') value = clampNotes(String(value));

    if (field === 'repeat') {
      updateTask(taskId, { repeat: { type: value as Task['repeat']['type'] } });
    } else if (field === 'priority') {
      updateTask(taskId, { priority: value as Task['priority'] });
    } else if (field === 'categoryId') {
      updateTask(taskId, { categoryId: value ? String(value) : undefined });
    } else if (field === 'title') {
      updateTask(taskId, { title: String(value).trim() || task.title });
    } else if (field === 'date') {
      updateTask(taskId, { date: String(value) });
      state.selectedDate = String(value);
    } else if (field === 'startTime') {
      updateTask(taskId, { startTime: value ? String(value) : undefined });
    } else if (field === 'durationMinutes') {
      updateTask(taskId, { durationMinutes: typeof value === 'number' ? value : undefined });
    } else if (field === 'notes') {
      updateTask(taskId, { notes: String(value) });
    }
    await commit();
    if (state.data.settings.autoSave) render();
  });

  root.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement;

    if (aiPanel.onInput(target)) return;

    if (target.hasAttribute('data-goal-search')) {
      const goalId = target.dataset.goalSearch || '';
      state.goalTaskQuery = target.value;
      const goal = state.data.goals.find((item) => item.id === goalId);
      const list = document.querySelector<HTMLElement>(`[data-goal-picker-list="${goalId}"]`);
      if (goal && list) list.innerHTML = renderGoalPickerList(goal, { state, t, renderTaskCard });
      return;
    }

    if (target.hasAttribute('data-search-input')) {
      state.search = target.value;
      const list = document.querySelector<HTMLElement>('[data-search-results]');
      if (list) list.innerHTML = renderPendingItems();
      const count = document.querySelector<HTMLElement>('[data-search-count]');
      const total = searchTasks(state.data.tasks, state.data.categories, state.search).length;
      if (count) count.textContent = `${total} ${t('searchResults')}`;
      return;
    }

    if (target.hasAttribute('data-sound-volume')) {
      state.data.settings.soundVolume = Number(target.value) / 100;
      audioMixer.setVolume(state.data.settings.soundVolume);
      return;
    }

    if (target.dataset.field !== 'notes') return;
    const counter = target.closest('.field')?.querySelector<HTMLElement>('[data-note-count]');
    if (counter) counter.textContent = `${Array.from(target.value).length}/50`;
  });

  root.addEventListener('submit', (event) => {
    event.preventDefault();
  });

  root.addEventListener('dragstart', (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>('.task-card[data-mode="pending"]');
    if (!card?.dataset.taskId) return;
    state.dragTaskId = card.dataset.taskId;
    card.classList.add('is-dragging');
  });

  root.addEventListener('dragover', (event) => {
    if (!state.dragTaskId) return;
    const dropZone = (event.target as HTMLElement).closest<HTMLElement>('[data-drop]');
    if (!dropZone) return;
    event.preventDefault();
  });

  root.addEventListener('drop', async (event) => {
    const dragTaskId = state.dragTaskId;
    state.dragTaskId = null;
    if (!dragTaskId) return;
    const dropZone = (event.target as HTMLElement).closest<HTMLElement>('[data-drop]');
    if (!dropZone) return;
    event.preventDefault();

    if (dropZone.dataset.drop === 'completed') {
      pushHistory();
      state.data.tasks = setTaskStatus(state.data.tasks, dragTaskId, 'completed');
      state.transfer = { taskId: dragTaskId, title: 'Task', direction: 'to-completed' };
      await persist();
      render();
      window.setTimeout(() => {
        state.transfer = null;
        render();
      }, 950);
      return;
    }

    const targetCard = (event.target as HTMLElement).closest<HTMLElement>('.task-card[data-task-id]');
    const targetTaskId = targetCard?.dataset.taskId;
    const remaining = pendingTasks().filter((task) => task.id !== dragTaskId);
    const targetIndex = targetTaskId ? remaining.findIndex((task) => task.id === targetTaskId) : remaining.length;
    pushHistory();
    state.data.tasks = moveTaskInQueue(state.data.tasks, dragTaskId, Math.max(0, targetIndex));
    await persist();
    render();
  });

  root.addEventListener('dragend', () => {
    state.dragTaskId = null;
    render();
  });

  // 中键点击链接也交回系统浏览器，避免 WebView 另开窗口/会话。
  document.addEventListener(
    'auxclick',
    (event) => {
      if (event.button !== 1) return;
      interceptExternalLink(event as MouseEvent);
    },
    true,
  );

  document.addEventListener('keydown', (event) => {
    // 键盘（Tab 聚焦链接后回车）触发的外链同样交回系统浏览器。
    if (event.key === 'Enter') {
      const anchor = (document.activeElement as HTMLElement | null)?.closest?.(
        'a[href]',
      ) as HTMLAnchorElement | null;
      const href = anchor?.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) {
        event.preventDefault();
        if (isTauriRuntime()) {
          void state.repository
            .openExternalUrl(href)
            .catch(() => window.open(href, '_blank', 'noopener'));
        } else {
          window.open(href, '_blank', 'noopener');
        }
        return;
      }
    }
    if (event.key === 'Escape') {
      if (focus.isOverlayVisible()) {
        // 退出界面但保留计时，之后可以接着继续。
        focus.closeOverlay();
      } else if (aiPanel.isOpen()) {
        aiPanel.close();
      } else if (state.panel) {
        state.panel = null;
      } else {
        state.selectedTaskId = null;
      }
      render();
    }
    if (event.ctrlKey && event.key === '0') {
      event.preventDefault();
      state.data.settings.uiScale = 1;
      applyZoom(1);
      void persist();
      render();
    }
    aiPanel.onKeydown(event);
  });

  document.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const scale = nextZoom(state.data.settings.uiScale || 1, event.deltaY);
      state.data.settings.uiScale = scale;
      applyZoom(scale);
      void persist();
    },
    { passive: false },
  );

  void state.repository.setCloseToTray(state.data.settings.closeToTray);
  if (isTauriRuntime()) {
    void state.repository.getAutostart().then(async (enabled) => {
      if (enabled !== state.data.settings.launchAtStartup) {
        state.data.settings.launchAtStartup = enabled;
        await persist();
        render();
      }
    });
    void listen('daynora://today', () => {
      state.selectedDate = toDateKey();
      state.panel = null;
      render();
    });
  }

  window.setInterval(checkReminders, 30_000);
  window.setInterval(() => {
    void aiPanel.pollReminders();
  }, 30_000);
  window.setInterval(() => {
    // 基于结束时间戳刷新，即使窗口被最小化 / 系统节流也不会丢时间。
    focus.tick();
    if (!focus.visibleSession()) return;
    updateFocusClock();
  }, 1000);

  // 从托盘 / 任务栏回到前台时立即刷新一次倒计时，
  // 避免窗口被系统节流期间界面数字停在旧值。
  const refreshFocusClock = (): void => {
    focus.tick();
    if (focus.visibleSession()) updateFocusClock();
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshFocusClock();
  });
  window.addEventListener('focus', refreshFocusClock);
  if (isTauriRuntime()) {
    void getCurrentWindow().onFocusChanged(({ payload }) => {
      if (payload) refreshFocusClock();
    });
  }

  if (state.data.settings.weatherCity) {
    void loadWeather();
  }

  render();
}

export function getLanguageLabel(language: Language): string {
  return language === 'zh-CN' ? '中文' : 'English';
}
