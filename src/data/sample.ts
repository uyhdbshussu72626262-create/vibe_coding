import legacySample from './sample-plan.json';
import { cloneAppData, createInitialAppData } from '../core';
import type { AppData, Settings } from '../types';

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  language: 'zh-CN',
  timeFormat: '24h',
  autoSave: true,
  uiScale: 1,
  soundVolume: 0.45,
  soundPreset: 'rain',
  focusMinutes: 45,
  focusStyle: 'retro',
  launchAtStartup: false,
  closeToTray: true,
  notificationsEnabled: true,
  sidebarCollapsed: false,
  pendingCollapsed: false,
};

export function createSampleData(): AppData {
  const source = legacySample as unknown as AppData;
  return createInitialAppData({
    tasks: source.tasks,
    goals: source.goals,
    categories: source.categories,
    settings: source.settings || DEFAULT_SETTINGS,
    meta: source.meta,
  });
}

export function cloneSampleData(): AppData {
  return cloneAppData(createSampleData());
}
