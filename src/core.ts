import type {
  AppData,
  DaySummary,
  Goal,
  RepeatRule,
  Settings,
  Subtask,
  Task,
  TaskStatus,
} from './types';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

let fallbackCounter = 0;

export function createId(prefix = 'id'): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  fallbackCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${fallbackCounter.toString(36)}`;
}

export function toDateKey(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseDateKey(dateKey: string): Date {
  const match = DATE_PATTERN.exec(dateKey);
  if (!match) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function isValidDateKey(dateKey: string): boolean {
  if (!DATE_PATTERN.test(dateKey)) return false;
  const date = parseDateKey(dateKey);
  return toDateKey(date) === dateKey;
}

export function isValidTime(value: string | undefined): boolean {
  return !value || TIME_PATTERN.test(value);
}

export function addDays(dateKey: string, amount: number): string {
  const date = parseDateKey(dateKey);
  date.setDate(date.getDate() + amount);
  return toDateKey(date);
}

export function compareDateKeys(a: string, b: string): number {
  return a.localeCompare(b);
}

export function clampNotes(value: string | undefined, maxLength = 50): string {
  if (!value) return '';
  return Array.from(value).slice(0, maxLength).join('');
}

export function createTask(input: Partial<Task> & { title: string; date: string }): Task {
  const now = new Date().toISOString();
  return {
    id: input.id || createId('task'),
    title: input.title.trim() || 'Untitled task',
    date: input.date,
    startTime: input.startTime,
    durationMinutes: input.durationMinutes,
    categoryId: input.categoryId,
    priority: input.priority || 'none',
    notes: clampNotes(input.notes),
    icon: input.icon || 'circle-check-big',
    subtasks: input.subtasks ? input.subtasks.map((item) => ({ ...item })) : [],
    repeat: normalizeRepeat(input.repeat),
    status: input.status || 'pending',
    order: input.order ?? Date.now(),
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
    completedAt: input.completedAt,
    source: input.source || 'user',
  };
}

export function normalizeRepeat(rule?: RepeatRule | null): RepeatRule {
  if (!rule) return { type: 'none' };
  if (rule.type === 'daily' || rule.type === 'weekly' || rule.type === 'weekdays') {
    return { type: rule.type };
  }
  return { type: 'none' };
}

export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.order !== b.order) return a.order - b.order;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

export function tasksForDate(tasks: Task[], date: string): Task[] {
  return sortTasks(tasks.filter((task) => task.date === date && task.status !== 'trashed'));
}

export function summarizeDay(tasks: Task[], date: string): DaySummary {
  const dayTasks = tasksForDate(tasks, date);
  const completed = dayTasks.filter((task) => task.status === 'completed').length;
  const total = dayTasks.length;
  return {
    date,
    total,
    completed,
    pending: total - completed,
    percent: total ? Math.round((completed / total) * 100) : 0,
  };
}

export function setTaskStatus(tasks: Task[], taskId: string, status: TaskStatus): Task[] {
  const now = new Date().toISOString();
  return tasks.map((task) =>
    task.id === taskId
      ? {
          ...task,
          status,
          completedAt: status === 'completed' ? now : undefined,
          updatedAt: now,
        }
      : task,
  );
}

export function moveTaskInQueue(tasks: Task[], taskId: string, targetIndex: number): Task[] {
  const dayTasks = sortTasks(tasks.filter((task) => task.status === 'pending'));
  const moving = dayTasks.find((task) => task.id === taskId);
  if (!moving) return tasks;

  const remaining = dayTasks.filter((task) => task.id !== taskId);
  const insertAt = Math.max(0, Math.min(targetIndex, remaining.length));
  remaining.splice(insertAt, 0, moving);

  const orderById = new Map(remaining.map((task, index) => [task.id, index]));
  return tasks.map((task) =>
    orderById.has(task.id) ? { ...task, order: orderById.get(task.id) as number } : task,
  );
}

export function addSubtask(task: Task, title: string): Task {
  const trimmed = title.trim();
  if (!trimmed) return task;
  const subtask: Subtask = { id: createId('subtask'), title: trimmed, done: false };
  return { ...task, subtasks: [...task.subtasks, subtask], updatedAt: new Date().toISOString() };
}

export function toggleSubtask(task: Task, subtaskId: string): Task {
  return {
    ...task,
    subtasks: task.subtasks.map((item) =>
      item.id === subtaskId ? { ...item, done: !item.done } : item,
    ),
    updatedAt: new Date().toISOString(),
  };
}

export function calculateGoalProgress(goal: Goal, tasks: Task[]): number {
  if (!goal.linkedTaskIds.length) return goal.progress;
  const linked = tasks.filter((task) => goal.linkedTaskIds.includes(task.id));
  if (!linked.length) return goal.progress;
  const completed = linked.filter((task) => task.status === 'completed').length;
  return Math.round((completed / linked.length) * 100);
}

export function nextRepeatDate(rule: RepeatRule, fromDate: string): string | null {
  if (rule.type === 'daily') return addDays(fromDate, 1);
  if (rule.type === 'weekly') return addDays(fromDate, 7);
  if (rule.type === 'weekdays') {
    let next = addDays(fromDate, 1);
    while ([0, 6].includes(parseDateKey(next).getDay())) {
      next = addDays(next, 1);
    }
    return next;
  }
  return null;
}

export function createInitialAppData(sample: {
  tasks: Task[];
  goals: Goal[];
  categories: AppData['categories'];
  settings: AppData['settings'];
  meta?: AppData['meta'];
}): AppData {
  return {
    version: 1,
    meta: sample.meta,
    tasks: sample.tasks,
    goals: sample.goals,
    categories: sample.categories,
    settings: sample.settings,
  };
}

export function normalizeAppData(
  input: Partial<Omit<AppData, 'settings'>> & { settings?: Partial<Settings> },
  defaults: Settings,
): AppData {
  const mergedSettings: Settings = { ...defaults, ...(input.settings || {}) };
  if (!['off', 'rain', 'clock', 'water'].includes(mergedSettings.soundPreset)) {
    mergedSettings.soundPreset = defaults.soundPreset;
  }
  mergedSettings.uiScale = Math.min(1.5, Math.max(0.75, Number(mergedSettings.uiScale) || 1));
  mergedSettings.soundVolume = Math.min(
    1,
    Math.max(0, Number.isFinite(Number(mergedSettings.soundVolume)) ? Number(mergedSettings.soundVolume) : defaults.soundVolume),
  );
  return {
    version: input.version || 1,
    meta: input.meta,
    tasks: Array.isArray(input.tasks) ? input.tasks.map((task) => createTask(task)) : [],
    goals: Array.isArray(input.goals) ? input.goals : [],
    categories: Array.isArray(input.categories) ? input.categories : [],
    settings: mergedSettings,
  };
}

export function cloneAppData(data: AppData): AppData {
  return JSON.parse(JSON.stringify(data)) as AppData;
}

export function formatDuration(minutes: number | undefined, language: 'zh-CN' | 'en'): string {
  if (!minutes) return '';
  if (minutes < 60) return language === 'zh-CN' ? `${minutes} 分钟` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!rest) return language === 'zh-CN' ? `${hours} 小时` : `${hours} h`;
  return language === 'zh-CN' ? `${hours} 小时 ${rest} 分` : `${hours} h ${rest} min`;
}

export function formatTime(value: string | undefined, timeFormat: '24h' | '12h'): string {
  if (!value) return '';
  if (timeFormat === '24h') return value;
  const [hourText, minuteText] = value.split(':');
  const hour = Number(hourText);
  const suffix = hour < 12 ? 'AM' : 'PM';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${minuteText} ${suffix}`;
}
