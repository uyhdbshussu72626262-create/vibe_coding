// 通用 DOM / SVG 小工具：HTML 转义、Lucide 图标、雪碧图、路径文件名。

import { ICONS } from '../icons.ts';

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/// 生成一个内联 SVG 图标；未知图标名回退到一个中性图标。
export function icon(name: string, className = ''): string {
  const safeName = ICONS[name] ? name : 'circle-check-big';
  return `<svg class="icon ${className}" aria-hidden="true"><use href="#ic-${safeName}"></use></svg>`;
}

/// 页面里只需要渲染一次图标雪碧图。
export function renderSprite(): string {
  return `<svg id="icon-sprite" aria-hidden="true" hidden>${Object.keys(ICONS)
    .map((name) => `<symbol id="ic-${name}" viewBox="0 0 24 24">${ICONS[name][0]}</symbol>`)
    .join('')}</svg>`;
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
