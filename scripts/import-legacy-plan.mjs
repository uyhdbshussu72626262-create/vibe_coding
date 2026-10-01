/**
 * 把旧版 holiday-plan/src/plan.ts 中的固定计划转换成 Daynora 的示例数据。
 * 只使用 Node 内置模块，不需要联网安装依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const LEGACY_PLAN = path.resolve(PROJECT_ROOT, '..', 'holiday-plan', 'src', 'plan.ts');
const OUTPUT = path.join(PROJECT_ROOT, 'src', 'data', 'sample-plan.json');

const YEAR = 2026;

function loadLegacyPlan() {
  const source = fs.readFileSync(LEGACY_PLAN, 'utf8');
  const js = stripTypeScriptTypes(source, { mode: 'strip' });
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${js}\n;globalThis.__PLAN__ = PLAN;`, context, { filename: 'legacy-plan.ts' });
  return context.__PLAN__;
}

function parseLegacyDate(label) {
  const match = /^(\d{1,2})月(\d{1,2})日/.exec(label.trim());
  if (!match) return null;
  const month = String(Number(match[1])).padStart(2, '0');
  const day = String(Number(match[2])).padStart(2, '0');
  return `${YEAR}-${month}-${day}`;
}

function clampText(value, max = 50) {
  return Array.from(value || '').slice(0, max).join('');
}

function parseStartTime(time) {
  const [start] = String(time).split(/[–-]/);
  const match = /(\d{1,2}:\d{2})/.exec(start || '');
  return match ? match[1].padStart(5, '0') : undefined;
}

function categoryId(moduleId) {
  return `cat_${moduleId}`;
}

function createSampleTask(block, day, index) {
  const date = parseLegacyDate(day.label);
  if (!date) return null;
  const details = Array.isArray(block.detail) ? block.detail : [];
  const taskId = `sample_${day.id}_${index + 1}`;

  return {
    id: taskId,
    title: block.title,
    date,
    startTime: parseStartTime(block.time),
    durationMinutes: Math.max(1, Math.round(Number(block.hours || 0) * 60)),
    categoryId: categoryId(block.module),
    priority: block.focus ? 'high' : 'none',
    notes: clampText(details[0] || ''),
    icon: block.icon || 'circle-check-big',
    subtasks: details.slice(1).map((title, subtaskIndex) => ({
      id: `${taskId}_sub_${subtaskIndex + 1}`,
      title,
      done: false,
    })),
    repeat: { type: 'none' },
    status: 'pending',
    order: index,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    source: 'sample',
  };
}

function main() {
  const legacy = loadLegacyPlan();
  const categories = legacy.modules.map((module, index) => ({
    id: categoryId(module.id),
    name: module.name,
    color: ['#b8542f', '#355070', '#3f6c51', '#9a6b2f'][index % 4],
    icon: module.icon,
    order: index,
  }));

  const tasks = [];
  for (const day of legacy.days) {
    day.blocks.forEach((block, index) => {
      const task = createSampleTask(block, day, index);
      if (task) tasks.push(task);
    });
  }

  const goals = legacy.modules.map((module, index) => {
    const linkedTaskIds = tasks
      .filter((task) => task.categoryId === categoryId(module.id))
      .map((task) => task.id);
    return {
      id: `goal_${module.id}`,
      title: module.name,
      description: module.note,
      targetDate: '2026-10-05',
      progress: 0,
      status: 'active',
      linkedTaskIds,
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: '2026-09-23T00:00:00.000Z',
    };
  });

  const sample = {
    version: 1,
    meta: {
      title: legacy.title,
      subtitle: legacy.subtitle,
      importedFrom: 'holiday-plan/src/plan.ts',
    },
    tasks,
    goals,
    categories,
    settings: {
      theme: 'system',
      language: 'zh-CN',
      timeFormat: '24h',
      autoSave: true,
      launchAtStartup: false,
      closeToTray: true,
      notificationsEnabled: true,
    },
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(sample, null, 2)}\n`, 'utf8');
  console.log(`已导入 ${tasks.length} 个示例任务 -> ${OUTPUT}`);
}

main();
