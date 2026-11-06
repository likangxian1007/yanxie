import { sanitizeLatexHtml } from '../render/sanitize';
import type { LatexBlock } from '../render/types';

const blockKey = new WeakMap<Element, string>();

/**
 * 按块增量更新预览：内容没变的块复用原来的 DOM 节点（KaTeX 公式不用重新挂载），
 * 只替换改动过的块，大文档也能保持顺滑。
 */
export function patchBlocks(container: HTMLElement, blocks: LatexBlock[]): void {
  const pool = new Map<string, HTMLElement[]>();
  for (const child of Array.from(container.children)) {
    const key = blockKey.get(child);
    if (key === undefined) {
      child.remove();
      continue;
    }
    const list = pool.get(key);
    if (list) list.push(child as HTMLElement);
    else pool.set(key, [child as HTMLElement]);
  }
  let ref: ChildNode | null = container.firstChild;
  for (const b of blocks) {
    let el = pool.get(b.html)?.shift();
    if (!el) {
      el = document.createElement('div');
      el.className = 'ltx-block';
      el.innerHTML = sanitizeLatexHtml(b.html);
      blockKey.set(el, b.html);
    }
    const line = String(b.line);
    const endLine = String(b.endLine);
    if (el.dataset.line !== line) el.dataset.line = line;
    if (el.dataset.endLine !== endLine) el.dataset.endLine = endLine;
    if (el === ref) ref = el.nextSibling;
    else container.insertBefore(el, ref);
  }
  for (const rest of pool.values()) for (const el of rest) el.remove();
}
