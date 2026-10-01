// 各类弹层面板（设置 / 回收站 / 大目标 / 导出 / 声音 / 番茄钟设置）的渲染。
// 由 app.ts 传入上下文调用，便于单独维护与复用。

import { addDays, sortTasks, toDateKey } from '../core.ts';
import { SOUND_OPTIONS } from './audio.ts';
import { translate } from '../i18n.ts';
import { baseName, escapeHtml, icon } from '../ui/dom.ts';
import type { Goal, Task } from '../types.ts';
import type { AppState } from '../app.ts';

export interface PanelViewContext {
  state: AppState;
  t: (key: Parameters<typeof translate>[1]) => string;
  /// 任务卡片的渲染由 app.ts 提供，避免面板模块反向依赖主视图。
  renderTaskCard?: (task: Task, mode: 'pending' | 'completed' | 'trash') => string;
}
export function renderSettingsPanel(ctx: PanelViewContext): string {
    const settings = ctx.state.data.settings;
    const categories = ctx.state.data.categories
      .sort((a, b) => a.order - b.order)
      .map(
        (category) => `
          <li class="settings-row">
            <span class="color-dot" style="--category-color:${escapeHtml(category.color)}"></span>
            <span>${escapeHtml(category.name)}</span>
            <button type="button" class="mini-button" data-action="delete-category" data-category-id="${escapeHtml(category.id)}">×</button>
          </li>`,
      )
      .join('');
    return `
      <div class="modal-backdrop">
        <section class="modal" data-modal="settings">
          <header class="modal__head">
            <div><span class="column__eyebrow">SETTINGS</span><h2>${ctx.t('settings')}</h2></div>
            <button type="button" class="icon-button" data-action="close-panel">×</button>
          </header>
          <div class="settings-grid">
            <label class="setting">
              <span>${ctx.t('theme')}</span>
              <select data-setting="theme">
                ${(['system', 'light', 'dark', 'retro'] as const)
                  .map((value) => `<option value="${value}"${settings.theme === value ? ' selected' : ''}>${value}</option>`)
                  .join('')}
              </select>
            </label>
            <label class="setting">
              <span>${ctx.t('language')}</span>
              <select data-setting="language">
                <option value="zh-CN"${settings.language === 'zh-CN' ? ' selected' : ''}>中文</option>
                <option value="en"${settings.language === 'en' ? ' selected' : ''}>English</option>
              </select>
            </label>
            <label class="setting">
              <span>${ctx.t('timeFormat')}</span>
              <select data-setting="timeFormat">
                <option value="24h"${settings.timeFormat === '24h' ? ' selected' : ''}>24h</option>
                <option value="12h"${settings.timeFormat === '12h' ? ' selected' : ''}>12h</option>
              </select>
            </label>
            <label class="setting">
              <span>${ctx.t('focusMinutes')}</span>
              <select data-setting="focusMinutes">
                ${[15, 25, 45, 60]
                  .map((value) => `<option value="${value}"${Number(settings.focusMinutes) === value ? ' selected' : ''}>${value}</option>`)
                  .join('')}
              </select>
            </label>
            <label class="setting">
              <span>${ctx.t('focusStyle')}</span>
              <select data-setting="focusStyle">
                ${(['retro', 'minimal', 'neon'] as const)
                  .map((value) => `<option value="${value}"${settings.focusStyle === value ? ' selected' : ''}>${value}</option>`)
                  .join('')}
              </select>
            </label>
            <label class="setting">
              <span>${ctx.t('pageScale')}</span>
              <input type="range" min="75" max="150" step="5" value="${Math.round((settings.uiScale || 1) * 100)}" data-setting="uiScalePercent" />
            </label>
            <label class="setting">
              <span>${ctx.t('soundVolume')}</span>
              <input type="range" min="0" max="100" step="1" value="${Math.round((settings.soundVolume || 0.45) * 100)}" data-setting="soundVolumePercent" />
            </label>
            <label class="setting setting--check">
              <input type="checkbox" data-setting="autoSave" ${settings.autoSave ? 'checked' : ''} />
              <span>${ctx.t('autoSave')}</span>
            </label>
            <label class="setting setting--check">
              <input type="checkbox" data-setting="closeToTray" ${settings.closeToTray ? 'checked' : ''} />
              <span>${ctx.t('closeToTray')}</span>
            </label>
            <label class="setting setting--check">
              <input type="checkbox" data-setting="launchAtStartup" ${settings.launchAtStartup ? 'checked' : ''} />
              <span>${ctx.t('launchAtStartup')}</span>
            </label>
            <label class="setting setting--check">
              <input type="checkbox" data-setting="notificationsEnabled" ${settings.notificationsEnabled ? 'checked' : ''} />
              <span>${ctx.t('notificationsEnabled')}</span>
            </label>
            <label class="setting">
              <span>${ctx.t('weatherCity')}</span>
              <span class="inline-form">
                <input type="text" data-setting="weatherCity" value="${escapeHtml(settings.weatherCity || '')}" placeholder="Shanghai" />
                <button type="button" class="ghost-button" data-action="weather-gps">${icon('target')}${ctx.t('useGps')}</button>
              </span>
            </label>
          </div>
          <section class="settings-block">
            <h3>${ctx.t('categories')}</h3>
            <ul class="settings-list">${categories || `<li class="muted">—</li>`}</ul>
            <div class="inline-form">
              <input type="text" data-category-input placeholder="${ctx.t('categoryName')}" />
              <button type="button" class="ghost-button" data-action="add-category">${icon('plus')}${ctx.t('addCategory')}</button>
            </div>
          </section>
          <section class="settings-block">
            <h3>${ctx.t('backupSection')}</h3>
            <div class="inline-form">
              <button type="button" class="primary-button" data-action="backup-now">${icon('download')}${ctx.t('backupNow')}</button>
              <button type="button" class="ghost-button" data-action="open-backup-folder">${ctx.t('openBackupFolder')}</button>
            </div>
            <p class="settings-path">%APPDATA%\\com.knowlira.daynora\\backups\\</p>
            <ul class="settings-list backups">
              ${
                ctx.state.backups.length
                  ? ctx.state.backups
                      .slice(-7)
                      .reverse()
                      .map(
                        (path) =>
                          `<li><span>${escapeHtml(baseName(path))}</span><button type="button" class="mini-button" data-action="copy-text" data-copy="${escapeHtml(path)}">⧉</button></li>`,
                      )
                      .join('')
                  : `<li class="muted">—</li>`
              }
            </ul>
          </section>
          <section class="settings-block">
            <h3>${ctx.t('updater')}</h3>
            <p class="muted">${ctx.state.updaterStatus === 'disabled' ? ctx.t('updaterDisabled') : escapeHtml(ctx.state.updaterStatus)}</p>
          </section>
        </section>
      </div>`;
  }

export function renderTrashPanel(ctx: PanelViewContext): string {
    const tasks = ctx.state.data.tasks.filter((task) => task.status === 'trashed');
    return `
      <div class="modal-backdrop">
        <section class="modal" data-modal="trash">
          <header class="modal__head">
            <div><span class="column__eyebrow">TRASH</span><h2>${ctx.t('trash')}</h2></div>
            <button type="button" class="icon-button" data-action="close-panel">×</button>
          </header>
          ${
            tasks.length
              ? `<ul class="task-list">${tasks
                  .map((task) => ctx.renderTaskCard?.(task, 'trash') ?? '')
                  .join('')}</ul>
                 <button type="button" class="danger-button" data-action="empty-trash">${icon('trash-2')}${ctx.t('emptyTrash')}</button>`
              : `<p class="muted">${ctx.t('noTrash')}</p>`
          }
        </section>
      </div>`;
  }

export function goalLinkedTasks(goal: Goal, ctx: PanelViewContext): Task[] {
    return sortTasks(
      ctx.state.data.tasks.filter(
        (task) => task.status !== 'trashed' && goal.linkedTaskIds.includes(task.id),
      ),
    );
  }

export function renderGoalPickerList(goal: Goal, ctx: PanelViewContext): string {
    const query = ctx.state.goalTaskQuery.trim().toLowerCase();
    const all = sortTasks(ctx.state.data.tasks.filter((task) => task.status !== 'trashed'));
    const matches = query
      ? all.filter((task) => `${task.date} ${task.title}`.toLowerCase().includes(query))
      : all;
    return matches.length
      ? matches
          .map(
            (task) => `
              <label class="goal-picker__item">
                <input type="checkbox" data-action="toggle-goal-task" data-goal-id="${escapeHtml(goal.id)}" data-task-id="${escapeHtml(task.id)}" ${goal.linkedTaskIds.includes(task.id) ? 'checked' : ''} />
                <span>${escapeHtml(task.date)} · ${escapeHtml(task.title)}</span>
              </label>`,
          )
          .join('')
      : `<span class="muted">${ctx.t('noSearchResults')}</span>`;
  }

export function renderGoalLinks(goal: Goal, ctx: PanelViewContext): string {
    const linked = goalLinkedTasks(goal, ctx);
    const pickerOpen = ctx.state.goalTaskPicker === goal.id;
    return `
      <div class="goal-links">
        <div class="goal-links__head">
          <span>${ctx.t('linkedTasks')} <em>${linked.length}</em></span>
          <button type="button" class="ghost-button" data-action="toggle-goal-picker" data-goal-id="${escapeHtml(goal.id)}">
            ${icon(pickerOpen ? 'chevron-left' : 'plus')}${pickerOpen ? ctx.t('close') : ctx.t('manageLinkedTasks')}
          </button>
        </div>
        <div class="goal-links__list">
          ${
            linked.length
              ? linked
                  .map(
                    (task) => `
                      <span class="goal-link">
                        <span class="goal-link__text">${escapeHtml(task.date)} · ${escapeHtml(task.title)}</span>
                        <button type="button" class="mini-button" data-action="unlink-goal-task" data-goal-id="${escapeHtml(goal.id)}" data-task-id="${escapeHtml(task.id)}" title="${ctx.t('delete')}">×</button>
                      </span>`,
                  )
                  .join('')
              : `<span class="muted">${ctx.t('noLinkedTasks')}</span>`
          }
        </div>
        ${
          pickerOpen
            ? `<div class="goal-picker">
                <input type="search" data-goal-search="${escapeHtml(goal.id)}" value="${escapeHtml(ctx.state.goalTaskQuery)}" placeholder="${ctx.t('searchPlaceholder')}" />
                <div class="goal-picker__list" data-goal-picker-list="${escapeHtml(goal.id)}">
                  ${renderGoalPickerList(goal, ctx)}
                </div>
              </div>`
            : ''
        }
      </div>`;
  }

export function renderGoalEditor(goal: Goal, ctx: PanelViewContext): string {
    return `
      <article class="goal-editor" data-goal-id="${escapeHtml(goal.id)}">
        <div class="field-row">
          <label class="field">
            <span>${ctx.t('goalTitle')}</span>
            <input type="text" data-goal-field="title" value="${escapeHtml(goal.title)}" />
          </label>
          <label class="field">
            <span>${ctx.t('targetDate')}</span>
            <input type="date" data-goal-field="targetDate" value="${escapeHtml(goal.targetDate || '')}" />
          </label>
        </div>
        <label class="field field--wide">
          <span>${ctx.t('goalDescription')}</span>
          <textarea rows="2" data-goal-field="description">${escapeHtml(goal.description || '')}</textarea>
        </label>
        ${renderGoalLinks(goal, ctx)}
        <div class="modal__actions">
          <button type="button" class="ghost-button" data-action="save-goal" data-goal-id="${escapeHtml(goal.id)}">${ctx.t('saveNow')}</button>
          <button type="button" class="danger-button" data-action="delete-goal" data-goal-id="${escapeHtml(goal.id)}">${ctx.t('delete')}</button>
        </div>
      </article>`;
  }

export function renderGoalsPanel(ctx: PanelViewContext): string {
    return `
      <div class="modal-backdrop">
        <section class="modal modal--wide" data-modal="goals">
          <header class="modal__head">
            <div><span class="column__eyebrow">GOALS</span><h2>${ctx.t('goals')}</h2></div>
            <button type="button" class="icon-button" data-action="close-panel">×</button>
          </header>
          <article class="goal-editor goal-editor--new" data-goal-new>
            <div class="field-row">
              <label class="field">
                <span>${ctx.t('goalTitle')}</span>
                <input type="text" data-new-goal-field="title" />
              </label>
              <label class="field">
                <span>${ctx.t('targetDate')}</span>
                <input type="date" data-new-goal-field="targetDate" value="${escapeHtml(addDays(toDateKey(), 30))}" />
              </label>
            </div>
            <label class="field field--wide">
              <span>${ctx.t('goalDescription')}</span>
              <textarea rows="2" data-new-goal-field="description"></textarea>
            </label>
            <button type="button" class="primary-button" data-action="add-goal">${icon('plus')}${ctx.t('addGoal')}</button>
          </article>
          <div class="goal-editors">${ctx.state.data.goals.map((goal) => renderGoalEditor(goal, ctx)).join('')}</div>
        </section>
      </div>`;
  }

export function renderExportPanel(ctx: PanelViewContext): string {
    return `
      <div class="modal-backdrop">
        <section class="modal" data-modal="export">
          <header class="modal__head">
            <div><span class="column__eyebrow">DATA</span><h2>${ctx.t('exportFile')}</h2></div>
            <button type="button" class="icon-button" data-action="close-panel">×</button>
          </header>
          <div class="export-actions">
            <button type="button" class="primary-button" data-action="export-format" data-format="json">${icon('download')}${ctx.t('exportJson')}</button>
            <button type="button" class="ghost-button" data-action="export-format" data-format="csv">${icon('download')}${ctx.t('exportCsv')}</button>
            <button type="button" class="ghost-button" data-action="export-format" data-format="md">${icon('download')}${ctx.t('exportMarkdown')}</button>
            <button type="button" class="ghost-button" data-action="import-file">${icon('download')}${ctx.t('importFile')}</button>
            <button type="button" class="ghost-button" data-action="print-page">${icon('printer')}${ctx.t('print')}</button>
          </div>
        </section>
      </div>`;
  }


export function renderSoundPanel(ctx: PanelViewContext): string {
    return `
      <div class="modal-backdrop">
        <section class="modal" data-modal="sound">
          <header class="modal__head">
            <div><span class="column__eyebrow">SOUND</span><h2>${ctx.t('sound')}</h2></div>
            <button type="button" class="icon-button" data-action="close-panel">×</button>
          </header>
          <div class="sound-grid">
            ${SOUND_OPTIONS.map(
              (option) => `
                <button type="button" class="sound-option${ctx.state.soundPlaying === option.id ? ' is-active' : ''}" data-action="sound-select" data-sound="${option.id}">
                  <span>${escapeHtml(option.label)}</span>
                  <em>${option.file ? '音频文件' : '关闭'}</em>
                </button>`,
            ).join('')}
          </div>
          <label class="setting">
            <span>${ctx.t('soundVolume')}</span>
            <input type="range" min="0" max="100" step="1" value="${Math.round((ctx.state.data.settings.soundVolume || 0.45) * 100)}" data-sound-volume />
          </label>
          <div class="modal__actions">
            <button type="button" class="ghost-button" data-action="sound-stop">${ctx.t('stop')}</button>
            <button type="button" class="primary-button" data-action="close-panel">${ctx.t('close')}</button>
          </div>
        </section>
      </div>`;
  }

export function renderFocusSetupPanel(ctx: PanelViewContext): string {
    const tasks = ctx.state.data.tasks
      .filter((task) => task.status !== 'trashed')
      .slice(0, 80)
      .map((task) => `<option value="${escapeHtml(task.id)}">${escapeHtml(task.date)} · ${escapeHtml(task.title)}</option>`)
      .join('');
    return `
      <div class="modal-backdrop">
        <section class="modal" data-modal="focus-setup">
          <header class="modal__head">
            <div><span class="column__eyebrow">POMODORO</span><h2>${ctx.t('focusSetup')}</h2></div>
            <button type="button" class="icon-button" data-action="close-panel">×</button>
          </header>
          <div class="settings-grid">
            <label class="setting">
              <span>${ctx.t('focusDuration')}</span>
              <input type="number" min="5" max="180" step="5" value="${ctx.state.data.settings.focusMinutes || 45}" data-focus-duration />
            </label>
            <label class="setting">
              <span>${ctx.t('focusStyle')}</span>
              <select data-focus-style>
                ${(['retro', 'minimal', 'neon'] as const)
                  .map((value) => `<option value="${value}"${ctx.state.data.settings.focusStyle === value ? ' selected' : ''}>${value}</option>`)
                  .join('')}
              </select>
            </label>
            <label class="setting">
              <span>${ctx.t('focusSound')}</span>
              <select data-focus-sound>
                ${SOUND_OPTIONS.map((option) => `<option value="${option.id}"${ctx.state.data.settings.soundPreset === option.id ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
              </select>
            </label>
            <label class="setting">
              <span>${ctx.t('focusTaskLink')}</span>
              <select data-focus-task>
                <option value="">—</option>${tasks}
              </select>
            </label>
          </div>
          <div class="modal__actions">
            <button type="button" class="primary-button" data-action="start-focus-from-setup">${icon('timer')}${ctx.t('focusStart')}</button>
          </div>
        </section>
      </div>`;
  }


