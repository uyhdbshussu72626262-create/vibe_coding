import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FOCUS_SESSIONS_KEY,
  createFocusSession,
  formatFocusTime,
  loadFocusSessions,
  normalizeSession,
  pauseSession,
  remainingSecondsAt,
  resetSession,
  saveFocusSessions,
  startSession,
  tickSession,
  type FocusSession,
  type FocusStorage,
} from '../src/features/focus.ts';
import { createFocusController } from '../src/features/focus-controller.ts';

class MemoryStorage implements FocusStorage {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  raw(key: string): string | null {
    return this.getItem(key);
  }
}

function sessionOf(minutes = 10): FocusSession {
  return createFocusSession('task_a', '深度工作', minutes, 'retro', 'rain');
}

test('剩余时间按结束时间戳计算，窗口被节流也不会丢时间', () => {
  const start = 1_000_000;
  const running = startSession(sessionOf(10), start);
  assert.equal(running.endsAt, start + 600_000);

  // 模拟“卡顿/最小化”后过了 90 秒才刷新一次
  const later = tickSession(running, start + 90_000);
  assert.equal(later.remainingSeconds, 510);
  assert.equal(formatFocusTime(later.remainingSeconds), '08:30');

  // 时间走完
  const finished = tickSession(running, start + 600_000);
  assert.equal(finished.remainingSeconds, 0);
  assert.equal(finished.running, false);
  assert.equal(finished.endsAt, null);
});

test('暂停保留剩余时间，继续时从暂停处接着走', () => {
  const start = 2_000_000;
  const running = startSession(sessionOf(5), start);
  const paused = pauseSession(running, start + 60_000);
  assert.equal(paused.running, false);
  assert.equal(paused.remainingSeconds, 240);
  assert.equal(paused.endsAt, null);

  // 暂停期间时间流逝不影响剩余
  assert.equal(remainingSecondsAt(paused, start + 600_000), 240);

  const resumed = startSession(paused, start + 600_000);
  assert.equal(resumed.running, true);
  assert.equal(resumed.endsAt, start + 600_000 + 240_000);
});

test('重置回到整段时长', () => {
  const running = startSession(sessionOf(15), 5_000);
  const reset = resetSession(running, 6_000);
  assert.equal(reset.remainingSeconds, 900);
  assert.equal(reset.running, false);
  assert.equal(reset.endsAt, null);
});

test('每个任务的计时快照互相独立，并可持久化/恢复', () => {
  const storage = new MemoryStorage();
  const a = startSession(createFocusSession('task_a', 'A', 25, 'retro', 'rain'), 10_000);
  const b = pauseSession(startSession(createFocusSession('task_b', 'B', 5, 'neon', 'clock'), 10_000), 70_000);

  saveFocusSessions({ task_a: a, task_b: b }, storage);
  const restored = loadFocusSessions(storage);

  assert.deepEqual(Object.keys(restored).sort(), ['task_a', 'task_b']);
  assert.equal(restored.task_a.title, 'A');
  assert.equal(restored.task_a.endsAt, 10_000 + 1500_000);
  assert.equal(restored.task_b.remainingSeconds, 240);
  assert.equal(restored.task_b.running, false);
  assert.equal(restored.task_b.soundPreset, 'clock');
});

test('损坏数据不会导致异常', () => {
  const storage = new MemoryStorage();
  storage.setItem(FOCUS_SESSIONS_KEY, '{ not json');
  assert.deepEqual(loadFocusSessions(storage), {});

  const normalized = normalizeSession({ totalSeconds: 60, style: 'weird' as never });
  assert.equal(normalized.style, 'retro');
  assert.equal(normalized.running, false);
});

test('旧版单会话会被迁移为暂停状态', () => {
  const storage = new MemoryStorage();
  storage.setItem(
    'daynora.focus-session.v1',
    JSON.stringify({
      taskId: 'task_old',
      title: '旧会话',
      totalSeconds: 1500,
      remainingSeconds: 900,
      running: true,
      style: 'minimal',
      soundPreset: 'water',
      savedAt: 1,
    }),
  );
  const sessions = loadFocusSessions(storage);
  assert.equal(sessions.task_old.remainingSeconds, 900);
  assert.equal(sessions.task_old.running, false);
  assert.equal(sessions.task_old.endsAt, null);
});

function controllerFor(storage: FocusStorage) {
  const finished: string[] = [];
  const notifications: string[] = [];
  const controller = createFocusController({
    storage,
    style: () => 'retro',
    soundPreset: () => 'off',
    volume: () => 0.4,
    notify: (title, body) => notifications.push(`${title}:${body}`),
    playSound: async () => undefined,
    stopSound: () => undefined,
    playAlarm: async () => undefined,
    enterFullscreen: async () => undefined,
    exitFullscreen: async () => undefined,
    hideWindow: async () => undefined,
    requestRender: () => undefined,
    showToast: (message) => finished.push(message),
    finishedTitle: () => '专注结束',
  });
  return { controller, notifications };
}

test('控制器：重复开始同一任务不会重置倒计时', async () => {
  const storage = new MemoryStorage();
  // 该任务的计时在 10 分钟前就已经开始，再次点击“开始专注”应继续而不是重置。
  const startedAt = Date.now() - 600_000;
  saveFocusSessions(
    { task_a: startSession(createFocusSession('task_a', '写方案', 25, 'retro', 'off'), startedAt) },
    storage,
  );

  const { controller } = controllerFor(storage);
  assert.equal(controller.sessionFor('task_a')?.remainingSeconds, 900);

  await controller.start('task_a', '写方案', 25);
  assert.equal(controller.sessionFor('task_a')?.remainingSeconds, 900);
  assert.equal(controller.sessionFor('task_a')?.running, true);
});

test('控制器：关闭界面后计时继续，退出程序后仍能恢复', async () => {
  const storage = new MemoryStorage();
  const { controller } = controllerFor(storage);
  await controller.start('task_a', '写方案', 20);
  controller.closeOverlay();
  assert.equal(controller.isOverlayVisible(), false);
  assert.equal(controller.activeSession()?.taskId, 'task_a');
  assert.equal(controller.activeSession()?.running, true);

  const raw = storage.raw(FOCUS_SESSIONS_KEY);
  assert.ok(raw && raw.includes('task_a'));
});

test('控制器：程序关闭期间跑完的计时在启动时清理，不刷屏提醒', () => {
  const storage = new MemoryStorage();
  saveFocusSessions(
    { task_a: startSession(sessionOf(1), Date.now() - 120_000) },
    storage,
  );

  const { controller, notifications } = controllerFor(storage);
  assert.equal(controller.sessionFor('task_a'), null);
  assert.equal(notifications.length, 0);
});

test('控制器：forget 会删除指定任务的快照', async () => {
  const storage = new MemoryStorage();
  const { controller } = controllerFor(storage);
  await controller.start('task_a', '写方案', 10);
  assert.ok(controller.sessionFor('task_a'));
  controller.forget('task_a');
  assert.equal(controller.sessionFor('task_a'), null);
});

test('控制器：计时归零时发出提醒并清理快照', async () => {
  const storage = new MemoryStorage();
  saveFocusSessions(
    {
      task_a: {
        ...sessionOf(1),
        running: true,
        remainingSeconds: 1,
        endsAt: Date.now() + 40,
      },
    },
    storage,
  );

  const { controller, notifications } = controllerFor(storage);
  assert.ok(controller.sessionFor('task_a'));
  await new Promise((resolve) => setTimeout(resolve, 60));
  controller.tick();

  assert.equal(controller.sessionFor('task_a'), null);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /专注结束/);
});
