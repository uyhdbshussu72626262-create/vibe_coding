export type Language = 'zh-CN' | 'en';

export type ThemePreference = 'system' | 'light' | 'dark' | 'retro';

export type SoundPreset = 'off' | 'rain' | 'clock' | 'water';

export type TaskStatus = 'pending' | 'completed' | 'trashed';

export type TaskPriority = 'none' | 'low' | 'medium' | 'high';

export type RepeatRuleType = 'none' | 'daily' | 'weekly' | 'weekdays';

export interface RepeatRule {
  type: RepeatRuleType;
}

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

export interface Task {
  id: string;
  title: string;
  date: string;
  startTime?: string;
  durationMinutes?: number;
  categoryId?: string;
  priority: TaskPriority;
  notes?: string;
  icon: string;
  subtasks: Subtask[];
  repeat: RepeatRule;
  status: TaskStatus;
  order: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  source?: 'sample' | 'user';
}

export interface Goal {
  id: string;
  title: string;
  description?: string;
  targetDate?: string;
  progress: number;
  status: 'active' | 'completed' | 'paused';
  linkedTaskIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: string;
  name: string;
  color: string;
  icon: string;
  order: number;
}

export interface Settings {
  theme: ThemePreference;
  language: Language;
  timeFormat: '24h' | '12h';
  autoSave: boolean;
  weatherCity?: string;
  weatherLatitude?: number;
  weatherLongitude?: number;
  uiScale: number;
  soundVolume: number;
  soundPreset: SoundPreset;
  focusMinutes: number;
  focusStyle: 'retro' | 'minimal' | 'neon';
  launchAtStartup: boolean;
  closeToTray: boolean;
  notificationsEnabled: boolean;
  sidebarCollapsed: boolean;
  pendingCollapsed: boolean;
}

export interface AppData {
  version: number;
  meta?: {
    title: string;
    subtitle: string;
    importedFrom?: string;
  };
  tasks: Task[];
  goals: Goal[];
  categories: Category[];
  settings: Settings;
}

export interface DaySummary {
  date: string;
  total: number;
  completed: number;
  pending: number;
  percent: number;
}
