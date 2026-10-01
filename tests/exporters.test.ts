import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask } from '../src/core.ts';
import { parseImportedSnapshot, serializeSnapshot } from '../src/data/exporters.ts';
import type { AppData, Settings } from '../src/types.ts';

const settings: Settings = {
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
};

function sampleData(): AppData {
  const task = createTask({
    id: 'task_1',
    title: 'Spring 源码',
    date: '2026-09-28',
    startTime: '09:00',
    durationMinutes: 120,
    notes: '测试备注',
  });
  return {
    version: 1,
    tasks: [task],
    goals: [],
    categories: [{ id: 'cat_app', name: '计算机应用', color: '#b8542f', icon: 'monitor', order: 0 }],
    settings,
  };
}

test('snapshot exports JSON, CSV and Markdown', () => {
  const data = sampleData();
  const json = serializeSnapshot(data, 'json');
  const csv = serializeSnapshot(data, 'csv');
  const markdown = serializeSnapshot(data, 'md');

  assert.match(json, /"title": "Spring 源码"/);
  assert.match(csv, /Spring 源码/);
  assert.match(csv, /09:00/);
  assert.match(markdown, /## 2026-09-28/);
  assert.match(markdown, /Spring 源码/);
});

test('JSON snapshot can be imported back', () => {
  const data = sampleData();
  const imported = parseImportedSnapshot(serializeSnapshot(data, 'json'), settings);
  assert.equal(imported.tasks.length, 1);
  assert.equal(imported.tasks[0].title, 'Spring 源码');
  assert.equal(imported.settings.language, 'zh-CN');
});

test('invalid import payload is rejected', () => {
  assert.throws(() => parseImportedSnapshot('{"version":1}', settings), /tasks/);
});
