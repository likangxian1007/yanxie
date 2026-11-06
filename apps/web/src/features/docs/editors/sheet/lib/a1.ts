/**
 * 表格坐标工具。Y.Map `cells` 的键是 `r:c`（0 起）；界面和公式用 A1 记法（列字母 + 1 起行号）。
 */

export interface CellPos {
  row: number;
  col: number;
}

/** 闭区间范围，已规整（r0 ≤ r1，c0 ≤ c1）。 */
export interface CellRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

export function parseKey(key: string): CellPos | null {
  const m = /^(\d+):(\d+)$/u.exec(key);
  if (!m) return null;
  return { row: Number(m[1]), col: Number(m[2]) };
}

/** 0 → A，25 → Z，26 → AA */
export function colName(col: number): string {
  let n = col + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** A → 0，AA → 26；非法返回 -1 */
export function colIndex(name: string): number {
  const s = name.toUpperCase();
  if (!/^[A-Z]+$/u.test(s)) return -1;
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function toA1(row: number, col: number): string {
  return `${colName(col)}${row + 1}`;
}

/** 'B3' / '$B$3' / 'b3' → { row: 2, col: 1 }；非法返回 null */
export function parseA1(ref: string): CellPos | null {
  const m = /^\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})$/u.exec(ref.trim());
  if (!m) return null;
  return { row: Number(m[2]) - 1, col: colIndex(m[1] ?? '') };
}

export function normRange(a: CellPos, b: CellPos): CellRange {
  return {
    r0: Math.min(a.row, b.row),
    c0: Math.min(a.col, b.col),
    r1: Math.max(a.row, b.row),
    c1: Math.max(a.col, b.col),
  };
}

export function rangeLabel(r: CellRange): string {
  const a = toA1(r.r0, r.c0);
  return r.r0 === r.r1 && r.c0 === r.c1 ? a : `${a}:${toA1(r.r1, r.c1)}`;
}

export function inRange(r: CellRange, row: number, col: number): boolean {
  return row >= r.r0 && row <= r.r1 && col >= r.c0 && col <= r.c1;
}

export function rangeSize(r: CellRange): { rows: number; cols: number } {
  return { rows: r.r1 - r.r0 + 1, cols: r.c1 - r.c0 + 1 };
}

/** 有内容的最大行列（导出 CSV 用）；空表返回 null。 */
export function usedBounds(keys: Iterable<string>): { rows: number; cols: number } | null {
  let rows = -1;
  let cols = -1;
  for (const key of keys) {
    const p = parseKey(key);
    if (!p) continue;
    if (p.row > rows) rows = p.row;
    if (p.col > cols) cols = p.col;
  }
  return rows < 0 ? null : { rows: rows + 1, cols: cols + 1 };
}
