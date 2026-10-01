import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask } from '../src/core.ts';
import {
  createFocusSession,
  focusProgress,
  formatFocusTime,
  startSession,
  tickSession,
} from '../src/features/focus.ts';
import {
  dailySummaryKey,
  dueTaskReminders,
  isDailySummaryDue,
} from '../src/features/notifications.ts';
import {
  isWeatherCacheFresh,
  weatherEmoji,
  weatherLabel,
} from '../src/features/weather.ts';

test('focus clock formats and ticks correctly', () => {
  const session = createFocusSession('task_1', 'Deep work', 25, 'retro');
  assert.equal(formatFocusTime(session.remainingSeconds), '25:00');
  const startedAt = 1_000_000;
  const running = startSession(session, startedAt);
  const next = tickSession(running, startedAt + 1000);
  assert.equal(formatFocusTime(next.remainingSeconds), '24:59');
  assert.equal(focusProgress(next, startedAt + 1000), 0);
  assert.equal(formatFocusTime(0), '00:00');
});

test('focus clock progress reaches 100 percent at the end', () => {
  const session = createFocusSession('task_1', 'Deep work', 1, 'minimal');
  const finished = { ...session, remainingSeconds: 0, running: false };
  assert.equal(focusProgress(finished), 100);
});

test('task reminders only fire inside the reminder window', () => {
  const task = createTask({ id: 'task_1', title: 'Math', date: '2026-09-28', startTime: '09:00' });
  const now = new Date(2026, 8, 28, 9, 5);
  assert.deepEqual(dueTaskReminders([task], now, new Set()), [
    { taskId: 'task_1', title: 'Math', startTime: '09:00' },
  ]);
  assert.deepEqual(dueTaskReminders([task], new Date(2026, 8, 28, 10, 0), new Set()), []);
  assert.deepEqual(dueTaskReminders([task], now, new Set(['2026-09-28:task_1'])), []);
});

test('daily summary is due after 22:00', () => {
  const before = new Date(2026, 8, 28, 21, 30);
  const after = new Date(2026, 8, 28, 22, 1);
  assert.equal(isDailySummaryDue(before, null), false);
  assert.equal(isDailySummaryDue(after, null), true);
  assert.equal(isDailySummaryDue(after, '2026-09-28'), false);
  assert.equal(dailySummaryKey(after), 'summary:2026-09-28');
});

test('weather codes map to emoji and labels', () => {
  assert.equal(weatherEmoji(0), '☀️');
  assert.equal(weatherEmoji(63), '🌧️');
  assert.equal(weatherLabel(0, 'zh-CN'), '晴');
  assert.equal(weatherLabel(95, 'en'), 'Thunderstorm');
});

test('weather cache respects the 30 minute TTL', () => {
  const snapshot = {
    city: 'Shanghai',
    latitude: 31.2,
    longitude: 121.5,
    temperature: 26,
    weatherCode: 1,
    windSpeed: 3,
    updatedAt: 1_000,
  };
  assert.equal(isWeatherCacheFresh(snapshot, 1_000 + 29 * 60 * 1000), true);
  assert.equal(isWeatherCacheFresh(snapshot, 1_000 + 31 * 60 * 1000), false);
});
