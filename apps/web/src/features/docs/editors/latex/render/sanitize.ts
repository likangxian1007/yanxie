import DOMPurify from 'dompurify';

/**
 * 预览 HTML 清洗（需要 DOM）。按块缓存：大文档每次刷新只有改动过的块需要重新清洗。
 * 保留 KaTeX 需要的 style / SVG / MathML，去掉脚本、事件属性和危险链接。
 */
const CACHE_LIMIT = 3000;
const cache = new Map<string, string>();

export function sanitizeLatexHtml(html: string): string {
  const hit = cache.get(html);
  if (hit !== undefined) return hit;
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
  });
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(html, clean);
  return clean;
}
