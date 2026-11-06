import type { CellRange } from '../lib/a1';

/** 表头尺寸（px） */
export const ROW_HEADER_WIDTH = 48;
export const COL_HEADER_HEIGHT = 24;

/** 前缀和数组里 x 所在的下标（隐藏的行列宽度为 0，会落到其后第一个可见的） */
export function indexAt(off: Float64Array, x: number): number {
  const n = off.length - 1;
  if (n <= 0) return 0;
  if (x <= 0) return firstVisible(off, 0);
  if (x >= off[n]!) return lastVisible(off, n - 1);
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (off[mid]! <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function firstVisible(off: Float64Array, i: number): number {
  const n = off.length - 1;
  let j = i;
  while (j < n - 1 && off[j + 1] === off[j]) j += 1;
  return j;
}
function lastVisible(off: Float64Array, i: number): number {
  let j = i;
  while (j > 0 && off[j + 1] === off[j]) j -= 1;
  return j;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 区域在表格坐标系里的矩形 */
export function rangeBox(rowOff: Float64Array, colOff: Float64Array, r: CellRange): Box {
  const left = colOff[r.c0] ?? 0;
  const top = rowOff[r.r0] ?? 0;
  return {
    left,
    top,
    width: (colOff[r.c1 + 1] ?? left) - left,
    height: (rowOff[r.r1 + 1] ?? top) - top,
  };
}

/** 可视范围（含少量缓冲），lo/hi 都是下标 */
export function visibleSpan(
  off: Float64Array,
  start: number,
  size: number,
  from: number,
  overscan = 2,
): [number, number] {
  const n = off.length - 1;
  if (n <= 0 || size <= 0) return [from, from - 1];
  const lo = Math.max(from, indexAt(off, start) - overscan);
  const hi = Math.min(n - 1, indexAt(off, start + size) + overscan);
  return [lo, hi];
}
