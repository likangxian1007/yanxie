/**
 * 源码与预览的同步滚动：两边都按“块”（段落、标题、公式……）的源码行号和预览位置建立对应，
 * 块之间线性插值。纯函数。
 */

export interface Anchor {
  /** 源码行号（可带小数） */
  line: number;
  /** 预览里的像素位置 */
  top: number;
}

function search(anchors: Anchor[], value: number, key: 'line' | 'top'): number {
  // 最后一个 anchors[i][key] <= value 的下标，没有则 -1
  let lo = 0;
  let hi = anchors.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((anchors[mid]?.[key] ?? 0) <= value) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** 源码行 → 预览像素位置 */
export function lineToTop(anchors: Anchor[], line: number, maxTop: number): number {
  if (anchors.length === 0) return 0;
  const i = search(anchors, line, 'line');
  if (i < 0) return 0;
  const a = anchors[i] as Anchor;
  const b = anchors[i + 1];
  if (!b) return Math.min(maxTop, a.top);
  const span = b.line - a.line;
  const t = span > 0 ? Math.min(1, (line - a.line) / span) : 0;
  return Math.min(maxTop, a.top + t * (b.top - a.top));
}

/** 预览像素位置 → 源码行 */
export function topToLine(anchors: Anchor[], top: number): number {
  if (anchors.length === 0) return 1;
  const i = search(anchors, top, 'top');
  if (i < 0) return anchors[0]?.line ?? 1;
  const a = anchors[i] as Anchor;
  const b = anchors[i + 1];
  if (!b) return a.line;
  const span = b.top - a.top;
  const t = span > 0 ? Math.min(1, (top - a.top) / span) : 0;
  return a.line + t * (b.line - a.line);
}

/** 按行号找所在块（最后一个 line <= 目标行的块） */
export function blockIndexForLine(lines: number[], line: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((lines[mid] ?? 0) <= line) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
