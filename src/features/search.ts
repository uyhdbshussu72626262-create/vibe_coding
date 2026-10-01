import type { Category, Task } from '../types';

function haystack(task: Task, categories: Category[]): string {
  const category = categories.find((item) => item.id === task.categoryId)?.name || '';
  return [
    task.title,
    task.date,
    task.startTime || '',
    task.notes || '',
    category,
    task.priority,
    ...task.subtasks.map((item) => item.title),
  ]
    .join(' ')
    .toLowerCase();
}

export function matchesTaskQuery(task: Task, categories: Category[], query: string): boolean {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return true;
  return haystack(task, categories).includes(keyword);
}

export function searchTasks(tasks: Task[], categories: Category[], query: string): Task[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return [];
  return tasks.filter(
    (task) => task.status !== 'trashed' && matchesTaskQuery(task, categories, keyword),
  );
}
