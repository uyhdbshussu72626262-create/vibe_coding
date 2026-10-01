import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  calculateGoalProgress,
  clampNotes,
  createTask,
  formatTime,
  moveTaskInQueue,
  nextRepeatDate,
  normalizeAppData,
  parseDateKey,
  setTaskStatus,
  summarizeDay,
  toDateKey,
} from '../src/core.ts';
import type { Goal, Task } from '../src/types.ts';

function makeTask(overrides: Partial<Task> = {}): Task {
  return createTask({
    title: overrides.title || 'Test task',
    date: overrides.date || '2026-09-28',
    ...overrides,
  });
}

test('date keys round trip and add days across month boundaries', () => {
  assert.equal(toDateKey(new Date(2026, 8, 28)), '2026-09-28');
  assert.equal(toDateKey(parseDateKey('2026-10-01')), '2026-10-01');
  assert.equal(addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(addDays('2026-10-01', -1), '2026-09-30');
});

test('notes are clamped to 50 characters', () => {
  const text = '一'.repeat(60);
  assert.equal(Array.from(clampNotes(text)).length, 50);
});

test('createTask applies safe defaults and clamps notes', () => {
  const task = createTask({
    title: '  Read Spring ',
    date: '2026-09-28',
    notes: 'x'.repeat(80),
  });
  assert.equal(task.title, 'Read Spring');
  assert.equal(task.status, 'pending');
  assert.equal(task.priority, 'none');
  assert.equal(Array.from(task.notes || '').length, 50);
  assert.equal(task.repeat.type, 'none');
});

test('summarizeDay calculates task count, completion and percentage', () => {
  const tasks = [
    makeTask({ status: 'completed' }),
    makeTask(),
    makeTask({ date: '2026-09-29' }),
    makeTask({ status: 'trashed' }),
  ];
  const summary = summarizeDay(tasks, '2026-09-28');
  assert.equal(summary.total, 2);
  assert.equal(summary.completed, 1);
  assert.equal(summary.pending, 1);
  assert.equal(summary.percent, 50);
});

test('setTaskStatus stores completion time and clears it when reopened', () => {
  const task = makeTask();
  const completed = setTaskStatus([task], task.id, 'completed')[0];
  assert.equal(completed.status, 'completed');
  assert.ok(completed.completedAt);
  const reopened = setTaskStatus([completed], task.id, 'pending')[0];
  assert.equal(reopened.status, 'pending');
  assert.equal(reopened.completedAt, undefined);
});

test('moveTaskInQueue reorders pending tasks', () => {
  const first = makeTask({ title: 'First', order: 0 });
  const second = makeTask({ title: 'Second', order: 1 });
  const third = makeTask({ title: 'Third', order: 2 });
  const moved = moveTaskInQueue([first, second, third], third.id, 0);
  const pending = moved
    .filter((task) => task.status === 'pending')
    .sort((a, b) => a.order - b.order)
    .map((task) => task.title);
  assert.deepEqual(pending, ['Third', 'First', 'Second']);
});

test('goal progress follows linked tasks when available', () => {
  const first = makeTask({ status: 'completed' });
  const second = makeTask();
  const goal: Goal = {
    id: 'goal_1',
    title: 'Goal',
    progress: 0,
    status: 'active',
    linkedTaskIds: [first.id, second.id],
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
  };
  assert.equal(calculateGoalProgress(goal, [first, second]), 50);
  assert.equal(calculateGoalProgress({ ...goal, linkedTaskIds: [] }, [first, second]), 0);
});

test('weekday repeat skips Saturday and Sunday', () => {
  assert.equal(nextRepeatDate({ type: 'weekdays' }, '2026-09-25'), '2026-09-28');
  assert.equal(nextRepeatDate({ type: 'daily' }, '2026-09-25'), '2026-09-26');
  assert.equal(nextRepeatDate({ type: 'weekly' }, '2026-09-25'), '2026-10-02');
  assert.equal(nextRepeatDate({ type: 'none' }, '2026-09-25'), null);
});

test('time formatting supports 12-hour display', () => {
  assert.equal(formatTime('09:05', '24h'), '09:05');
  assert.equal(formatTime('09:05', '12h'), '9:05 AM');
  assert.equal(formatTime('21:30', '12h'), '9:30 PM');
  assert.equal(formatTime('00:15', '12h'), '12:15 AM');
});

test('normalizeAppData keeps safe defaults and preserves tasks', () => {
  const normalized = normalizeAppData(
    {
      tasks: [createTask({ title: 'Restored', date: '2026-09-28' })],
      goals: [],
      categories: [],
      settings: { language: 'en' },
    },
    {
      theme: 'system',
      language: 'zh-CN',
      timeFormat: '24h',
      autoSave: true,
      uiScale: 1,
      soundVolume: 0.45,
      soundPreset: 'rain',
      focusMinutes: 25,
      focusStyle: 'retro',
      launchAtStartup: false,
      closeToTray: true,
      notificationsEnabled: true,
      sidebarCollapsed: false,
      pendingCollapsed: false,
    },
  );
  assert.equal(normalized.version, 1);
  assert.equal(normalized.tasks.length, 1);
  assert.equal(normalized.settings.language, 'en');
  assert.equal(normalized.settings.theme, 'system');
});
