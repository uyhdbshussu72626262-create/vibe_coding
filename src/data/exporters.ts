import { normalizeAppData, sortTasks } from '../core.ts';
import type { AppData, Settings, Task } from '../types.ts';

export type ExportFormat = 'json' | 'csv' | 'md';

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function categoryName(data: AppData, categoryId: string | undefined): string {
  if (!categoryId) return '';
  return data.categories.find((category) => category.id === categoryId)?.name || '';
}

function taskToCsvRow(data: AppData, task: Task): string {
  return [
    task.id,
    task.title,
    task.date,
    task.startTime || '',
    task.durationMinutes ?? '',
    categoryName(data, task.categoryId),
    task.priority,
    task.status,
    task.notes || '',
    task.subtasks.map((item) => `${item.done ? '[x]' : '[ ]'} ${item.title}`).join(' | '),
    task.repeat.type,
    task.updatedAt,
  ]
    .map(csvCell)
    .join(',');
}

function toCsv(data: AppData): string {
  const header = [
    'id',
    'title',
    'date',
    'startTime',
    'durationMinutes',
    'category',
    'priority',
    'status',
    'notes',
    'subtasks',
    'repeat',
    'updatedAt',
  ].join(',');
  const rows = sortTasks(data.tasks).map((task) => taskToCsvRow(data, task));
  return `${header}\n${rows.join('\n')}\n`;
}

function toMarkdown(data: AppData): string {
  const lines: string[] = [];
  lines.push(`# ${data.meta?.title || 'Daynora'}`);
  lines.push('');
  if (data.meta?.subtitle) {
    lines.push(`> ${data.meta.subtitle}`);
    lines.push('');
  }
  if (data.goals.length) {
    lines.push('## Goals');
    lines.push('');
    data.goals.forEach((goal) => {
      lines.push(`- [${goal.status === 'completed' ? 'x' : ' '}] ${goal.title} — ${goal.progress}%`);
    });
    lines.push('');
  }

  const byDate = new Map<string, Task[]>();
  sortTasks(data.tasks).forEach((task) => {
    const list = byDate.get(task.date) || [];
    list.push(task);
    byDate.set(task.date, list);
  });

  byDate.forEach((tasks, date) => {
    lines.push(`## ${date}`);
    lines.push('');
    tasks.forEach((task) => {
      const checked = task.status === 'completed' ? 'x' : ' ';
      const time = task.startTime ? ` ${task.startTime}` : '';
      const category = categoryName(data, task.categoryId);
      lines.push(`- [${checked}] ${task.title}${time}${category ? ` · ${category}` : ''}`);
      task.subtasks.forEach((subtask) => {
        lines.push(`  - [${subtask.done ? 'x' : ' '}] ${subtask.title}`);
      });
      if (task.notes) lines.push(`  - ${task.notes}`);
    });
    lines.push('');
  });
  return `${lines.join('\n')}\n`;
}

export function serializeSnapshot(data: AppData, format: ExportFormat): string {
  if (format === 'csv') return toCsv(data);
  if (format === 'md') return toMarkdown(data);
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function exportFileName(format: ExportFormat): string {
  const date = new Date().toISOString().slice(0, 10);
  if (format === 'csv') return `daynora-${date}.csv`;
  if (format === 'md') return `daynora-${date}.md`;
  return `daynora-${date}.json`;
}

export function parseImportedSnapshot(contents: string, defaults: Settings): AppData {
  const parsed = JSON.parse(contents) as Partial<AppData>;
  if (!parsed || !Array.isArray(parsed.tasks)) {
    throw new Error('JSON 文件缺少 tasks 数组，无法导入。');
  }
  return normalizeAppData(parsed, defaults);
}
