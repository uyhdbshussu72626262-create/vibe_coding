// AI 回答的富文本渲染：Markdown（marked）+ 安全过滤（DOMPurify）+ 数学公式（KaTeX）。
// 全部使用成熟开源方案，不手写解析器。

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import 'katex/dist/katex.min.css';

// 只注册常用语言，控制体积；未注册的语言会走自动识别。
const LANGUAGES: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

for (const [name, definition] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, definition);
}

const MATH_PLACEHOLDER = /@@KATEX:(\d+)@@/g;

marked.setOptions({
  gfm: true,
  breaks: true,
});

function renderFormula(source: string, displayMode: boolean): string {
  try {
    return katex.renderToString(source.trim(), {
      displayMode,
      throwOnError: false,
      strict: false,
      output: 'html',
    });
  } catch {
    // 公式语法错误时退回原文，避免整条回答渲染失败。
    return `<code>${escapeHtml(source)}</code>`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/// 先把数学公式抽出来替换成占位符，渲染完 Markdown 后再放回，
/// 这样 LaTeX 里的下划线、星号等不会被当作 Markdown 语法吃掉。
function extractMath(source: string, store: string[]): string {
  const push = (html: string): string => {
    store.push(html);
    return `\n\n@@KATEX:${store.length - 1}@@\n\n`;
  };
  const pushInline = (html: string): string => {
    store.push(html);
    return `@@KATEX:${store.length - 1}@@`;
  };

  return source
    .replace(/\$\$([\s\S]+?)\$\$/g, (_match, tex: string) => push(renderFormula(tex, true)))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_match, tex: string) => push(renderFormula(tex, true)))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_match, tex: string) => pushInline(renderFormula(tex, false)))
    .replace(/(^|[^\\\w$])\$([^$\n]+?)\$/g, (_match, prefix: string, tex: string) => {
      return `${prefix}${pushInline(renderFormula(tex, false))}`;
    });
}

/// 把 AI 返回的 Markdown 文本渲染成安全的 HTML 字符串。
export function renderMarkdown(source: string): string {
  const text = typeof source === 'string' ? source : String(source ?? '');
  if (!text.trim()) return '';

  const store: string[] = [];
  const withPlaceholders = extractMath(text, store);
  const parsed = marked.parse(withPlaceholders) as string;
  const sanitized = DOMPurify.sanitize(parsed, {
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'input', 'object', 'embed'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick'],
  });

  const restored = sanitized.replace(
    MATH_PLACEHOLDER,
    (_match, index: string) => store[Number(index)] ?? '',
  );
  return convertRemoteImages(restored);
}

/// 远程图片默认不加载：改写成“点击加载”占位块，避免打开对话就请求第三方图片
/// （CSP 也不放开 img-src https）。用户点击后由 Rust 侧下载并转成 data URL。
function convertRemoteImages(html: string): string {
  if (typeof document === 'undefined' || !/https?:\/\//i.test(html)) {
    return html;
  }
  const template = document.createElement('template');
  template.innerHTML = html;
  const images = Array.from(template.content.querySelectorAll('img'));
  for (const image of images) {
    const src = image.getAttribute('src') || '';
    if (!/^https?:\/\//i.test(src)) continue;
    const alt = image.getAttribute('alt') || '';
    const wrapper = document.createElement('span');
    wrapper.className = 'ai-image-placeholder';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost-button ai-image-load';
    button.setAttribute('data-action', 'ai-load-image');
    button.setAttribute('data-src', src);
    button.textContent = '点击加载图片';
    wrapper.append(button);
    if (alt) {
      const caption = document.createElement('span');
      caption.className = 'ai-image-alt';
      caption.textContent = alt;
      wrapper.append(caption);
    }
    image.replaceWith(wrapper);
  }
  return template.innerHTML;
}

/// 纯文本兜底渲染（用于标题、预览等不需要 Markdown 的位置）。
export function stripMarkdown(source: string): string {
  return (source || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\$\$?[\s\S]*?\$\$?/g, ' ')
    .replace(/[#>*_~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/// 从元素里找出被点击的外部链接（用于拦截跳转、避免 WebView 离开应用）。
export function findExternalLink(target: HTMLElement): string | null {
  const anchor = target.closest('a[href]');
  if (!anchor) return null;
  if (!anchor.closest('.ai-markdown')) return null;
  const href = anchor.getAttribute('href') || '';
  if (!/^https?:\/\//i.test(href)) return null;
  return href;
}

/// 给渲染后的代码块加上语法高亮、语言标签和复制按钮。
/// 已处理过的块会标记 data-decorated，重复调用是安全的。
export function decorateCodeBlocks(root: HTMLElement): void {
  const codeBlocks = Array.from(root.querySelectorAll<HTMLElement>('pre > code'));
  for (const code of codeBlocks) {
    const pre = code.parentElement;
    if (!pre || pre.dataset.decorated === '1') continue;
    pre.dataset.decorated = '1';

    const languageClass = Array.from(code.classList).find((name) =>
      name.startsWith('language-'),
    );
    const language = languageClass ? languageClass.replace('language-', '') : '';
    const source = code.textContent || '';

    try {
      if (language && hljs.getLanguage(language)) {
        code.innerHTML = hljs.highlight(source, {
          language,
          ignoreIllegals: true,
        }).value;
      } else if (source.trim()) {
        code.innerHTML = hljs.highlightAuto(source).value;
      }
    } catch {
      // 高亮失败时保留原始代码文本。
    }
    code.classList.add('hljs');

    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';
    const head = document.createElement('div');
    head.className = 'code-block__head';
    const label = document.createElement('span');
    label.textContent = language || 'code';
    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'mini-button code-block__copy';
    copyButton.dataset.action = 'ai-copy';
    copyButton.dataset.copy = source;
    copyButton.textContent = '复制';
    head.append(label, copyButton);
    pre.parentNode?.insertBefore(wrapper, pre);
    wrapper.append(head, pre);
  }
}
