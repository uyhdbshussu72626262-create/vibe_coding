import type { Task } from '../types.ts';
import { toDateKey } from '../core.ts';

export interface TaskReminder {
  taskId: string;
  title: string;
  startTime: string;
}

export function dueTaskReminders(
  tasks: Task[],
  now: Date,
  notifiedIds: Set<string>,
  windowMinutes = 10,
): TaskReminder[] {
  const today = toDateKey(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return tasks
    .filter((task) => {
      if (task.status !== 'pending' || task.date !== today || !task.startTime) return false;
      if (notifiedIds.has(`${today}:${task.id}`)) return false;
      const [hour, minute] = task.startTime.split(':').map(Number);
      const taskMinutes = hour * 60 + minute;
      return nowMinutes >= taskMinutes && nowMinutes - taskMinutes <= windowMinutes;
    })
    .map((task) => ({ taskId: task.id, title: task.title, startTime: task.startTime as string }));
}

export function dailySummaryKey(now: Date): string {
  return `summary:${toDateKey(now)}`;
}

export function isDailySummaryDue(now: Date, lastSummaryDate: string | null): boolean {
  return now.getHours() >= 22 && lastSummaryDate !== toDateKey(now);
}
