// 专注计时控制器：与界面解耦，负责每个任务的计时快照、持久化、结束提醒。
// 计时基于「结束时间戳」，窗口最小化 / 系统节流 / 程序重启都不会丢时间。

import {
  createFocusSession,
  isSessionFinished,
  loadFocusSessions,
  pauseSession,
  resetSession,
  saveFocusSessions,
  startSession,
  tickSession,
  type FocusSession,
  type FocusStorage,
  type FocusStyle,
} from './focus.ts';

export interface FocusControllerDeps {
  storage?: FocusStorage;
  style: () => FocusStyle;
  soundPreset: () => string;
  volume: () => number;
  notify: (title: string, body: string) => void;
  playSound: (preset: string, volume: number) => Promise<void>;
  stopSound: () => void;
  playAlarm: () => Promise<void>;
  enterFullscreen: () => Promise<void>;
  exitFullscreen: () => Promise<void>;
  hideWindow: () => Promise<void>;
  requestRender: () => void;
  showToast: (message: string) => void;
  finishedTitle: () => string;
}

export interface FocusController {
  sessionFor(taskId: string): FocusSession | null;
  activeSession(): FocusSession | null;
  visibleSession(): FocusSession | null;
  isOverlayVisible(): boolean;
  start(taskId: string, title: string, minutes: number): Promise<void>;
  openOverlay(taskId?: string): Promise<void>;
  closeOverlay(): void;
  toggle(): void;
  reset(): void;
  hideToTray(): Promise<void>;
  tick(): void;
  forget(taskId: string): void;
}

export function createFocusController(deps: FocusControllerDeps): FocusController {
  const sessions = loadFocusSessions(deps.storage);
  let visibleTaskId: string | null = null;

  // 程序关闭期间已经跑完的会话直接清理，避免重开后出现“负数倒计时”。
  for (const [taskId, session] of Object.entries(sessions)) {
    if (isSessionFinished(session)) delete sessions[taskId];
  }
  persist();

  function persist(): void {
    saveFocusSessions(sessions, deps.storage);
  }

  function live(taskId: string): FocusSession | null {
    const session = sessions[taskId];
    return session ? tickSession(session) : null;
  }

  async function playAmbient(session: FocusSession): Promise<void> {
    if (session.soundPreset && session.soundPreset !== 'off') {
      await deps.playSound(session.soundPreset, deps.volume()).catch(() => undefined);
    }
  }

  async function openOverlay(taskId?: string): Promise<void> {
    const target = taskId ?? activeTaskId();
    if (!target || !sessions[target]) {
      deps.showToast(deps.finishedTitle());
      return;
    }
    visibleTaskId = target;
    const session = sessions[target];
    if (session.running) await playAmbient(session);
    await deps.enterFullscreen();
    deps.requestRender();
  }

  function activeTaskId(): string | null {
    const list = Object.values(sessions)
      .filter((session) => !isSessionFinished(session))
      .sort((a, b) => b.savedAt - a.savedAt);
    return list[0]?.taskId ?? null;
  }

  function sessionFor(taskId: string): FocusSession | null {
    if (!taskId) return null;
    const session = live(taskId);
    if (!session || isSessionFinished(session)) return null;
    return session;
  }

  function activeSession(): FocusSession | null {
    const taskId = activeTaskId();
    return taskId ? sessionFor(taskId) : null;
  }

  function visibleSession(): FocusSession | null {
    return visibleTaskId ? sessionFor(visibleTaskId) : null;
  }

  async function start(taskId: string, title: string, minutes: number): Promise<void> {
    if (!taskId) return;
    // 已有会话：先按当前时间刷新剩余秒数，再继续，避免把流逝的时间补回来。
    let session = sessions[taskId] ? tickSession(sessions[taskId]) : null;
    if (!session) {
      session = createFocusSession(taskId, title, minutes, deps.style(), deps.soundPreset());
    } else {
      session = { ...session, title };
    }
    // 已有会话时保留剩余时间，只有新会话才从整段时长开始。
    sessions[taskId] = startSession(session);
    visibleTaskId = taskId;
    persist();
    await playAmbient(sessions[taskId]);
    await deps.enterFullscreen();
    deps.requestRender();
  }

  function toggle(): void {
    const session = visibleSession();
    if (!session) return;
    if (session.running) {
      sessions[session.taskId] = pauseSession(session);
      deps.stopSound();
    } else {
      sessions[session.taskId] = startSession(session);
      void playAmbient(sessions[session.taskId]);
    }
    persist();
    deps.requestRender();
  }

  function reset(): void {
    const session = visibleSession();
    if (!session) return;
    sessions[session.taskId] = resetSession(session);
    deps.stopSound();
    persist();
    deps.requestRender();
  }

  function closeOverlay(): void {
    // 只关闭界面，计时继续；环境音也保持播放。
    visibleTaskId = null;
    void deps.exitFullscreen();
  }

  async function hideToTray(): Promise<void> {
    visibleTaskId = null;
    await deps.exitFullscreen();
    await deps.hideWindow().catch(() => undefined);
  }

  function tick(): void {
    let changed = false;
    for (const [taskId, session] of Object.entries(sessions)) {
      if (!session.running) continue;
      const next = tickSession(session);
      if (next.remainingSeconds <= 0) {
        delete sessions[taskId];
        changed = true;
        if (visibleTaskId === taskId) {
          visibleTaskId = null;
          void deps.exitFullscreen();
        }
        deps.stopSound();
        void deps.playAlarm();
        deps.notify(deps.finishedTitle(), session.title);
      } else if (next.remainingSeconds !== session.remainingSeconds) {
        // 运行中的剩余秒数只是快照显示值，endsAt 在开始时已经持久化，
        // 因此这里不需要每次（每秒）都写存储，避免无意义的磁盘写入。
        sessions[taskId] = next;
      }
    }
    if (changed) {
      persist();
      deps.requestRender();
    }
  }

  function forget(taskId: string): void {
    if (!taskId || !sessions[taskId]) return;
    delete sessions[taskId];
    if (visibleTaskId === taskId) visibleTaskId = null;
    persist();
  }

  return {
    sessionFor,
    activeSession,
    visibleSession,
    isOverlayVisible: () => visibleTaskId !== null && Boolean(sessions[visibleTaskId]),
    start,
    openOverlay,
    closeOverlay,
    toggle,
    reset,
    hideToTray,
    tick,
    forget,
  };
}
