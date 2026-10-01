// 专注计时核心：按「结束时间戳」计算剩余秒数，
// 因此窗口最小化、被系统节流甚至程序退出重开后都不会丢时间。

export type FocusStyle = 'retro' | 'minimal' | 'neon';

export interface FocusSession {
  taskId: string;
  title: string;
  totalSeconds: number;
  /// 暂停时的剩余秒数；运行中由 endsAt 推算（tick 后保持同步）。
  remainingSeconds: number;
  running: boolean;
  /// 运行中的结束时间戳（epoch ms）；暂停时为 null。
  endsAt: number | null;
  style: FocusStyle;
  soundPreset: string;
  savedAt: number;
}

export interface FocusStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const FOCUS_SESSIONS_KEY = 'daynora.focus-sessions.v2';
const LEGACY_SESSION_KEY = 'daynora.focus-session.v1';
const VALID_SOUNDS = ['off', 'rain', 'clock', 'water'];

function defaultStorage(): FocusStorage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // 隐私模式 / 无存储环境
  }
  return null;
}

export function normalizeSession(input: Partial<FocusSession>): FocusSession {
  const totalSeconds = Math.max(1, Math.round(Number(input.totalSeconds) || 60));
  const running = Boolean(input.running) && Number(input.endsAt) > 0;
  const remainingSeconds = Math.min(
    totalSeconds,
    Math.max(0, Math.floor(Number(input.remainingSeconds) || 0)),
  );
  const style: FocusStyle = (['retro', 'minimal', 'neon'] as const).includes(
    input.style as FocusStyle,
  )
    ? (input.style as FocusStyle)
    : 'retro';
  const soundPreset =
    typeof input.soundPreset === 'string' && VALID_SOUNDS.includes(input.soundPreset)
      ? input.soundPreset
      : 'off';
  return {
    taskId: String(input.taskId || ''),
    title: String(input.title || ''),
    totalSeconds,
    remainingSeconds,
    running,
    endsAt: running ? Number(input.endsAt) : null,
    style,
    soundPreset,
    savedAt: Number(input.savedAt) || Date.now(),
  };
}

export function createFocusSession(
  taskId: string,
  title: string,
  minutes: number,
  style: FocusStyle,
  soundPreset = 'off',
): FocusSession {
  const safeMinutes = Math.max(1, Math.round(minutes));
  const totalSeconds = safeMinutes * 60;
  return {
    taskId,
    title,
    totalSeconds,
    remainingSeconds: totalSeconds,
    running: false,
    endsAt: null,
    style,
    soundPreset,
    savedAt: Date.now(),
  };
}

/// 当前真实剩余秒数：运行中按结束时间戳推算，暂停时用快照值。
export function remainingSecondsAt(session: FocusSession, now = Date.now()): number {
  if (session.running && session.endsAt) {
    return Math.max(0, Math.ceil((session.endsAt - now) / 1000));
  }
  return Math.max(0, Math.floor(session.remainingSeconds));
}

export function isSessionFinished(session: FocusSession, now = Date.now()): boolean {
  return remainingSecondsAt(session, now) <= 0;
}

export function startSession(session: FocusSession, now = Date.now()): FocusSession {
  const remaining = Math.max(0, Math.floor(session.remainingSeconds));
  return {
    ...session,
    remainingSeconds: remaining,
    running: remaining > 0,
    endsAt: remaining > 0 ? now + remaining * 1000 : null,
    savedAt: now,
  };
}

export function pauseSession(session: FocusSession, now = Date.now()): FocusSession {
  return {
    ...session,
    remainingSeconds: remainingSecondsAt(session, now),
    running: false,
    endsAt: null,
    savedAt: now,
  };
}

export function resetSession(session: FocusSession, now = Date.now()): FocusSession {
  return {
    ...session,
    remainingSeconds: session.totalSeconds,
    running: false,
    endsAt: null,
    savedAt: now,
  };
}

/// 定时刷新：把 running 会话的剩余秒数写回快照，归零时自动变为停止状态。
export function tickSession(session: FocusSession, now = Date.now()): FocusSession {
  if (!session.running) return session;
  const remaining = remainingSecondsAt(session, now);
  return {
    ...session,
    remainingSeconds: remaining,
    running: remaining > 0,
    endsAt: remaining > 0 ? session.endsAt : null,
  };
}

export function focusProgress(session: FocusSession, now = Date.now()): number {
  if (!session.totalSeconds) return 0;
  const remaining = remainingSecondsAt(session, now);
  return Math.min(
    100,
    Math.max(0, Math.round(((session.totalSeconds - remaining) / session.totalSeconds) * 100)),
  );
}

export function formatFocusTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/// 读取所有任务的计时快照；首次运行会把旧版单会话迁移过来。
export function loadFocusSessions(
  storage: FocusStorage | null = defaultStorage(),
): Record<string, FocusSession> {
  const sessions: Record<string, FocusSession> = {};
  if (!storage) return sessions;
  try {
    const raw = storage.getItem(FOCUS_SESSIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, Partial<FocusSession>>;
      for (const [key, value] of Object.entries(parsed || {})) {
        if (!value) continue;
        const session = normalizeSession({ ...value, taskId: value.taskId || key });
        if (session.taskId) sessions[session.taskId] = session;
      }
      return sessions;
    }
    const legacy = storage.getItem(LEGACY_SESSION_KEY);
    if (legacy) {
      const session = normalizeSession(JSON.parse(legacy) as Partial<FocusSession>);
      // 旧版不持久化运行状态，这里按暂停恢复，避免重开后“偷偷跑完”。
      session.running = false;
      session.endsAt = null;
      if (session.taskId) sessions[session.taskId] = session;
    }
  } catch {
    // 数据损坏时从空状态开始，不影响使用。
  }
  return sessions;
}

export function saveFocusSessions(
  sessions: Record<string, FocusSession>,
  storage: FocusStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(FOCUS_SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    // 存储失败不影响当前会话。
  }
}
