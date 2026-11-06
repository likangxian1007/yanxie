import { randomBytes } from 'node:crypto';
import * as Y from 'yjs';
import {
  SHEET_FIRST_ID,
  SHEET_LIMITS,
  SHEET_PARTS,
  SHEET_YDOC,
  YDOC_FIELD,
  sheetTypeName,
  type SheetPart,
} from '@srh/shared';

/**
 * 表格 v2（多工作表）在服务端的读写：markdown 表示、agent / REST 的结构化编辑、旧单表结构的迁移、
 * 版本恢复。结构与前端 apps/web/src/features/docs/editors/sheet/model/schema.ts 一致（API.md §2.7.1）：
 *
 * - sheetOrder Y.Array<工作表 id>（读时去重）、sheetInfo Y.Map<id, { name, hidden? }>、cellStyles Y.Map
 * - 每张表 sheet:<id>:rows / cols（Y.Array<行 / 列 id>，读时去重），sheet:<id>:cells
 *   Y.Map<"行id:列id", 原始输入>，以及 fmt / rowp / colp / merges / view / cache
 *
 * 迁移与默认表都用确定 id（表 s1、行 r<i>、列 c<i>），服务端和客户端各做一次也不会出现两份。
 */

export const SHEET_MAX = { rows: SHEET_LIMITS.rows, cols: SHEET_LIMITS.cols };
const LEGACY_FORMATS = 'formats';
const LEGACY_NUMFMT: Record<string, string> = { fixed2: '0.00', percent: '0.00%' };
/** markdown 里每张表最多导出的行列 */
const MD_ROWS = 200;
const MD_COLS = 26;

export class SheetEditError extends Error {}

interface SheetParts {
  rows: Y.Array<string>;
  cols: Y.Array<string>;
  cells: Y.Map<unknown>;
  fmt: Y.Map<unknown>;
  rowp: Y.Map<unknown>;
  colp: Y.Map<unknown>;
  merges: Y.Map<unknown>;
  view: Y.Map<unknown>;
  cache: Y.Map<unknown>;
}

function parts(doc: Y.Doc, id: string): SheetParts {
  const n = (p: SheetPart) => sheetTypeName(id, p);
  return {
    rows: doc.getArray<string>(n('rows')),
    cols: doc.getArray<string>(n('cols')),
    cells: doc.getMap<unknown>(n('cells')),
    fmt: doc.getMap<unknown>(n('fmt')),
    rowp: doc.getMap<unknown>(n('rowp')),
    colp: doc.getMap<unknown>(n('colp')),
    merges: doc.getMap<unknown>(n('merges')),
    view: doc.getMap<unknown>(n('view')),
    cache: doc.getMap<unknown>(n('cache')),
  };
}

function wbTypes(doc: Y.Doc) {
  return {
    order: doc.getArray<string>(SHEET_YDOC.order),
    info: doc.getMap<{ name?: string; hidden?: boolean }>(SHEET_YDOC.info),
    styles: doc.getMap<unknown>(SHEET_YDOC.styles),
  };
}

function dedupe(ids: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

const detRow = (i: number) => `r${i}`;
const detCol = (i: number) => `c${i}`;

function randomId(prefix: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = prefix;
  for (const b of randomBytes(7)) out += alphabet[b % alphabet.length];
  return out;
}

export function colName(c: number): string {
  let s = '';
  let n = c + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ------------------------------------------------------------------ 读

export interface SheetView {
  id: string;
  name: string;
  hidden: boolean;
  rows: string[];
  cols: string[];
  cells: Y.Map<unknown>;
}

export function hasWorkbook(doc: Y.Doc): boolean {
  return wbTypes(doc).order.length > 0;
}

export function hasLegacySheet(doc: Y.Doc): boolean {
  const cells = doc.getMap<unknown>(YDOC_FIELD.sheetCells);
  const meta = doc.getMap<unknown>(YDOC_FIELD.sheetMeta);
  return cells.size > 0 || (meta.size > 0 && meta.get('migrated') === undefined);
}

export function listSheets(doc: Y.Doc): SheetView[] {
  const wb = wbTypes(doc);
  return dedupe(wb.order.toArray())
    .filter((id) => wb.info.has(id))
    .map((id) => {
      const p = parts(doc, id);
      const info = wb.info.get(id) ?? {};
      return {
        id,
        name: String(info.name ?? id),
        hidden: !!info.hidden,
        rows: dedupe(p.rows.toArray()),
        cols: dedupe(p.cols.toArray()),
        cells: p.cells,
      };
    });
}

function rawText(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

/** 一张表的网格（原始输入）：rows × cols，只到有内容的最大行列 */
function sheetGrid(s: SheetView): { grid: string[][]; rows: number; cols: number } {
  const rowIndex = new Map(s.rows.map((id, i) => [id, i]));
  const colIndex = new Map(s.cols.map((id, i) => [id, i]));
  const at = new Map<string, string>();
  let maxR = -1;
  let maxC = -1;
  s.cells.forEach((v, key) => {
    const raw = rawText(v);
    if (!raw) return;
    const i = key.indexOf(':');
    const r = rowIndex.get(key.slice(0, i));
    const c = colIndex.get(key.slice(i + 1));
    if (r === undefined || c === undefined) return;
    at.set(`${r}:${c}`, raw);
    maxR = Math.max(maxR, r);
    maxC = Math.max(maxC, c);
  });
  const R = Math.min(maxR + 1, MD_ROWS);
  const C = Math.min(maxC + 1, MD_COLS);
  const grid = Array.from({ length: R }, (_, r) =>
    Array.from({ length: C }, (_, c) => at.get(`${r}:${c}`) ?? ''),
  );
  return { grid, rows: maxR + 1, cols: maxC + 1 };
}

function gridMarkdown(grid: string[][], rows: number, cols: number): string {
  if (rows <= 0) return '（空表格）';
  const R = grid.length;
  const C = grid[0]?.length ?? 0;
  const esc = (s: string) => s.replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
  const header = `|   | ${Array.from({ length: C }, (_, c) => colName(c)).join(' | ')} |`;
  const sep = `|---|${' --- |'.repeat(C)}`;
  const body = grid.map((line, r) => `| ${r + 1} | ${line.map(esc).join(' | ')} |`);
  const more = rows > R || cols > C ? `\n\n（只显示了前 ${R} 行、${C} 列）` : '';
  return [header, sep, ...body].join('\n') + more;
}

/** 旧单表结构（还没迁移、没人打开过的文档）的网格 */
function legacyGrid(doc: Y.Doc): { grid: string[][]; rows: number; cols: number } {
  const cells = doc.getMap<unknown>(YDOC_FIELD.sheetCells);
  let maxR = -1;
  let maxC = -1;
  cells.forEach((v, key) => {
    if (!rawText(v)) return;
    const [r, c] = key.split(':').map(Number) as [number, number];
    if (!Number.isInteger(r) || !Number.isInteger(c)) return;
    maxR = Math.max(maxR, r);
    maxC = Math.max(maxC, c);
  });
  const R = Math.min(maxR + 1, MD_ROWS);
  const C = Math.min(maxC + 1, MD_COLS);
  const grid = Array.from({ length: R }, (_, r) =>
    Array.from({ length: C }, (_, c) => rawText(cells.get(`${r}:${c}`))),
  );
  return { grid, rows: maxR + 1, cols: maxC + 1 };
}

export const SHEET_HEADING = '## 工作表：';

/**
 * markdown 表示（API.md §2.7.2）：只有一张表时与旧格式完全一样（带行列号的表格）；
 * 多张表时每张前面一行 `## 工作表：名字`（隐藏的表名字后加“（隐藏）”），表之间空一行。
 */
export function sheetToMarkdown(doc: Y.Doc): string {
  if (!hasWorkbook(doc)) {
    const g = legacyGrid(doc);
    return gridMarkdown(g.grid, g.rows, g.cols);
  }
  const sheets = listSheets(doc);
  if (sheets.length === 1) {
    const g = sheetGrid(sheets[0]!);
    return gridMarkdown(g.grid, g.rows, g.cols);
  }
  return sheets
    .map((s) => {
      const g = sheetGrid(s);
      return `${SHEET_HEADING}${s.name}${s.hidden ? '（隐藏）' : ''}\n\n${gridMarkdown(g.grid, g.rows, g.cols)}`;
    })
    .join('\n\n');
}

// ------------------------------------------------------------------ 迁移 / 建表

function initSheet(doc: Y.Doc, id: string, rows: number, cols: number) {
  const p = parts(doc, id);
  if (p.rows.length === 0) p.rows.push(Array.from({ length: rows }, (_, i) => detRow(i)));
  if (p.cols.length === 0) p.cols.push(Array.from({ length: cols }, (_, i) => detCol(i)));
}

/** v1 → v2（与前端 model/migrate.ts 同一算法）；调用方负责 transact */
export function migrateLegacySheet(doc: Y.Doc): boolean {
  if (hasWorkbook(doc) || !hasLegacySheet(doc)) return false;
  const cells = doc.getMap<unknown>(YDOC_FIELD.sheetCells);
  const meta = doc.getMap<unknown>(YDOC_FIELD.sheetMeta);
  const formats = doc.getMap<unknown>(LEGACY_FORMATS);
  const pos = (key: string) => {
    const m = /^(\d+):(\d+)$/u.exec(key);
    if (!m) return null;
    const row = Number(m[1]);
    const col = Number(m[2]);
    return row < SHEET_MAX.rows && col < SHEET_MAX.cols ? { row, col } : null;
  };
  let rows = Number(meta.get('rows')) || 0;
  let cols = Number(meta.get('cols')) || 0;
  cells.forEach((_v, k) => {
    const p = pos(k);
    if (!p) return;
    rows = Math.max(rows, p.row + 1);
    cols = Math.max(cols, p.col + 1);
  });
  rows = Math.min(SHEET_MAX.rows, Math.max(rows, SHEET_LIMITS.defaultRows));
  cols = Math.min(SHEET_MAX.cols, Math.max(cols, SHEET_LIMITS.defaultCols));
  const wb = wbTypes(doc);
  initSheet(doc, SHEET_FIRST_ID, rows, cols);
  const t = parts(doc, SHEET_FIRST_ID);
  cells.forEach((v, k) => {
    const p = pos(k);
    const raw = rawText(v);
    if (p && raw) t.cells.set(`${detRow(p.row)}:${detCol(p.col)}`, raw);
  });
  formats.forEach((v, k) => {
    const p = pos(k);
    const nf = typeof v === 'string' ? LEGACY_NUMFMT[v] : undefined;
    if (!p || !nf) return;
    const style = { nf };
    const id = styleIdOf(style);
    if (!wb.styles.has(id)) wb.styles.set(id, style);
    t.fmt.set(`${detRow(p.row)}:${detCol(p.col)}`, id);
  });
  const widths = meta.get('colWidths');
  if (widths instanceof Y.Map) {
    widths.forEach((w, k) => {
      const c = Number(k);
      if (Number.isInteger(c) && c >= 0 && c < cols && typeof w === 'number' && w > 0) {
        t.colp.set(detCol(c), { w: Math.round(w) });
      }
    });
  }
  wb.info.set(SHEET_FIRST_ID, { name: 'Sheet1' });
  wb.order.push([SHEET_FIRST_ID]);
  cells.clear();
  formats.clear();
  meta.set('migrated', 2);
  return true;
}

/** 保证有 v2 工作簿：先迁移旧结构，再兜底建默认表；调用方负责 transact */
export function ensureWorkbook(doc: Y.Doc): void {
  if (migrateLegacySheet(doc) || hasWorkbook(doc)) return;
  const wb = wbTypes(doc);
  initSheet(doc, SHEET_FIRST_ID, SHEET_LIMITS.defaultRows, SHEET_LIMITS.defaultCols);
  if (!wb.info.has(SHEET_FIRST_ID)) wb.info.set(SHEET_FIRST_ID, { name: 'Sheet1' });
  wb.order.push([SHEET_FIRST_ID]);
}

/** 与前端 schema.ts 的 styleIdOf 相同（FNV-1a 两路） */
export function styleIdOf(style: Record<string, unknown>): string {
  const entries = Object.entries(style)
    .filter(([, v]) => v !== undefined && v !== null && v !== false && v !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return '';
  const json = JSON.stringify(Object.fromEntries(entries));
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < json.length; i += 1) {
    const ch = json.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ch, 0x5bd1e995) >>> 0;
  }
  return `st${h1.toString(36)}${h2.toString(36)}`;
}

// ------------------------------------------------------------------ 写

function findSheet(doc: Y.Doc, name: string | undefined): SheetView | null {
  const sheets = listSheets(doc);
  if (!name) return sheets[0] ?? null;
  return sheets.find((s) => s.name.toLowerCase() === name.trim().toLowerCase()) ?? null;
}

/** 新建一张表（名字已存在时返回那张） */
export function addSheet(doc: Y.Doc, name: string): SheetView {
  const existing = findSheet(doc, name);
  if (existing) return existing;
  const wb = wbTypes(doc);
  const id = randomId('sx');
  initSheet(doc, id, SHEET_LIMITS.defaultRows, SHEET_LIMITS.defaultCols);
  wb.info.set(id, { name: name.trim().slice(0, 31) || 'Sheet' });
  wb.order.push([id]);
  return findSheet(doc, name)!;
}

/** 行列不够时在末尾补（确定 id 被占用时用随机 id） */
function ensureSize(doc: Y.Doc, s: SheetView, rows: number, cols: number) {
  const p = parts(doc, s.id);
  const grow = (arr: Y.Array<string>, have: string[], want: number, det: (i: number) => string) => {
    if (want <= have.length) return;
    const used = new Set(have);
    const add: string[] = [];
    for (let i = have.length; i < want; i += 1) {
      const id = used.has(det(i)) ? randomId('n') : det(i);
      used.add(id);
      add.push(id);
    }
    arr.push(add);
    have.push(...add);
  };
  grow(p.rows, s.rows, Math.min(rows, SHEET_MAX.rows), detRow);
  grow(p.cols, s.cols, Math.min(cols, SHEET_MAX.cols), detCol);
}

function checkBounds(r: number, c: number) {
  if (r >= SHEET_MAX.rows || c >= SHEET_MAX.cols) {
    throw new SheetEditError(
      `表格最多 ${SHEET_MAX.rows} 行、${SHEET_MAX.cols} 列，${colName(c)}${r + 1} 超出范围`,
    );
  }
}

export interface CellInput {
  r: number;
  c: number;
  value: string;
}

/** 写单元格（超出当前行列时自动扩大）；value 为空串删除 */
export function writeCells(doc: Y.Doc, s: SheetView, cells: CellInput[]) {
  for (const x of cells) checkBounds(x.r, x.c);
  const maxR = Math.max(-1, ...cells.map((x) => x.r));
  const maxC = Math.max(-1, ...cells.map((x) => x.c));
  ensureSize(doc, s, maxR + 1 + (maxR + 1 > s.rows.length ? 10 : 0), maxC + 1);
  const p = parts(doc, s.id);
  for (const x of cells) {
    const key = `${s.rows[x.r]}:${s.cols[x.c]}`;
    if (x.value === '') p.cells.delete(key);
    else p.cells.set(key, x.value);
    p.cache.delete(key);
  }
}

/** 清空一张表的内容（保留行列、样式） */
export function clearSheet(doc: Y.Doc, s: SheetView) {
  const p = parts(doc, s.id);
  p.cells.clear();
  p.cache.clear();
}

/** 最后一个有内容的行之后（append 用） */
export function nextFreeRow(s: SheetView): number {
  const rowIndex = new Map(s.rows.map((id, i) => [id, i]));
  let last = -1;
  s.cells.forEach((v, key) => {
    if (!rawText(v)) return;
    const r = rowIndex.get(key.slice(0, key.indexOf(':')));
    if (r !== undefined && r > last) last = r;
  });
  return last + 1;
}

export function sheetForEdit(doc: Y.Doc, name: string | undefined, create: boolean): SheetView {
  ensureWorkbook(doc);
  const s = findSheet(doc, name);
  if (s) return s;
  if (create && name) return addSheet(doc, name);
  throw new SheetEditError(`找不到工作表：${name ?? ''}`);
}

/**
 * markdown 按 `## 工作表：名字` 分段（replace_all / append 可以一次写多张表）；
 * 没有这种标题时返回 [{ name: undefined, body }]。
 */
export function splitSheetSections(markdown: string): Array<{ name?: string; body: string }> {
  const lines = markdown.split(/\r?\n/u);
  const out: Array<{ name?: string; body: string[] }> = [];
  for (const line of lines) {
    const m = /^##\s*工作表[：:]\s*(.+?)\s*$/u.exec(line);
    if (m) out.push({ name: m[1]!.replace(/（隐藏）$/u, '').trim(), body: [] });
    else {
      if (out.length === 0) out.push({ body: [] });
      out[out.length - 1]!.body.push(line);
    }
  }
  return out
    .map((s) => ({ name: s.name, body: s.body.join('\n') }))
    .filter((s) => s.name !== undefined || s.body.trim() !== '');
}

// ------------------------------------------------------------------ 版本恢复

/** 用 source 的工作簿整体替换 target 的（调用方负责 transact）。source 可以是旧结构，会先迁移。 */
export function replaceWorkbook(target: Y.Doc, source: Y.Doc) {
  source.transact(() => {
    if (!hasWorkbook(source)) ensureWorkbook(source);
  });
  ensureWorkbook(target);
  const st = wbTypes(source);
  const tt = wbTypes(target);
  const srcIds = dedupe(st.order.toArray()).filter((id) => st.info.has(id));
  const tgtIds = dedupe(tt.order.toArray());
  for (const id of tgtIds) {
    if (srcIds.includes(id)) continue;
    const p = parts(target, id);
    for (const part of SHEET_PARTS) {
      const t = p[part];
      if (t instanceof Y.Array) {
        if (t.length) t.delete(0, t.length);
      } else t.clear();
    }
    tt.info.delete(id);
  }
  if (tt.order.length) tt.order.delete(0, tt.order.length);
  tt.order.push(srcIds);
  st.styles.forEach((v, k) => {
    if (!tt.styles.has(k)) tt.styles.set(k, v);
  });
  for (const id of srcIds) {
    tt.info.set(id, { ...(st.info.get(id) ?? {}) });
    const sp = parts(source, id);
    const tp = parts(target, id);
    for (const part of SHEET_PARTS) {
      const s = sp[part];
      const t = tp[part];
      if (s instanceof Y.Array && t instanceof Y.Array) {
        const next = dedupe(s.toArray());
        const cur = dedupe(t.toArray());
        if (next.join('\u0000') !== cur.join('\u0000')) {
          if (t.length) t.delete(0, t.length);
          t.push(next);
        }
      } else if (s instanceof Y.Map && t instanceof Y.Map) {
        for (const key of [...t.keys()]) if (!s.has(key)) t.delete(key);
        s.forEach((v, key) => {
          if (JSON.stringify(t.get(key)) !== JSON.stringify(v)) t.set(key, v);
        });
      }
    }
  }
}
