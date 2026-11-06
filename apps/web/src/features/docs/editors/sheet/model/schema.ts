import type * as Y from 'yjs';
import {
  SHEET_FIRST_ID,
  SHEET_LIMITS,
  SHEET_YDOC,
  sheetTypeName,
  type SheetPart,
} from '@srh/shared';

/**
 * 表格 v2 的 Y.Doc 结构（与服务端 modules/documents/sheet*.ts 共用，见 API.md §2.7.1）。
 *
 * 全部是根级共享类型：并发创建同名根类型会合并，所以两个人同时打开空表 / 迁移旧表不会互相覆盖。
 * - sheetOrder：Y.Array<sheetId>（读时去重）
 * - sheetInfo：Y.Map<sheetId, SheetInfo>
 * - cellStyles：Y.Map<styleId, CellStyle>（内容哈希做 id）
 * - sheet:<id>:rows / cols：Y.Array<行 id / 列 id>（读时去重）。插入行 = 插入一个 id，
 *   单元格以 "行id:列id" 为键，所以并发的插入行和改单元格不会错位。
 * - sheet:<id>:cells：Y.Map<"行id:列id", 原始输入>（'=' 开头为公式）
 * - sheet:<id>:fmt：Y.Map<"行id:列id", styleId>
 * - sheet:<id>:rowp / colp：Y.Map<行/列 id, { h? / w?, hidden? }>
 * - sheet:<id>:merges：Y.Map<mergeId, MergeRef>（四个角用行列 id 表示，插删行列后自动跟着走）
 * - sheet:<id>:view：Y.Map { frozenRows, frozenCols, filter, condFormats? }
 *   （condFormats：xlsx 导入的条件格式原样保存，区域用行列 id 锚定；编辑器不渲染，导出时写回，见 model/io.ts）
 * - sheet:<id>:cache：Y.Map<"行id:列id", CachedValue>（xlsx 导入时 Excel 算好的公式值）
 */

export const MAX_ROWS = SHEET_LIMITS.rows;
export const MAX_COLS = SHEET_LIMITS.cols;
export const DEFAULT_ROWS = SHEET_LIMITS.defaultRows;
export const DEFAULT_COLS = SHEET_LIMITS.defaultCols;
export const FIRST_SHEET_ID = SHEET_FIRST_ID;

export const DEFAULT_ROW_HEIGHT = 24;
export const DEFAULT_COL_WIDTH = 96;
export const MIN_ROW_HEIGHT = 16;
export const MAX_ROW_HEIGHT = 600;
export const MIN_COL_WIDTH = 24;
export const MAX_COL_WIDTH = 1200;

export type BorderStyle = 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double';
export interface BorderSide {
  s: BorderStyle;
  /** #rrggbb */
  c: string;
}

/** 单元格样式（缺省字段 = 默认值）。字段名短，存进 Yjs 体积小。 */
export interface CellStyle {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  /** 删除线 */
  s?: boolean;
  /** 字号（pt） */
  fs?: number;
  /** 字体 */
  ff?: string;
  /** 字色 #rrggbb */
  fc?: string;
  /** 填充色 #rrggbb */
  bg?: string;
  ha?: 'left' | 'center' | 'right';
  va?: 'top' | 'middle' | 'bottom';
  wrap?: boolean;
  /** Excel 数字格式代码（General、0.00、0%、¥#,##0.00、yyyy-mm-dd、0.00E+00 …） */
  nf?: string;
  bt?: BorderSide;
  br?: BorderSide;
  bb?: BorderSide;
  bl?: BorderSide;
}

export interface SheetInfo {
  name: string;
  hidden?: boolean;
  /** 标签颜色 #rrggbb */
  color?: string;
}

export interface RowProps {
  h?: number;
  hidden?: boolean;
}
export interface ColProps {
  w?: number;
  hidden?: boolean;
}

/** 合并区域：左上 (r0, c0) 到右下 (r1, c1)，都是行列 id */
export interface MergeRef {
  r0: string;
  c0: string;
  r1: string;
  c1: string;
}

/** 筛选：区域（首行为表头）+ 每列允许显示的值（显示文本）；没有条件的列不过滤 */
export interface FilterState {
  r0: string;
  c0: string;
  r1: string;
  c1: string;
  criteria: Record<string, string[]>;
}

export type CachedValue = number | string | boolean | { e: string };

export interface SheetTypes {
  id: string;
  rows: Y.Array<string>;
  cols: Y.Array<string>;
  cells: Y.Map<string>;
  fmt: Y.Map<string>;
  rowp: Y.Map<RowProps>;
  colp: Y.Map<ColProps>;
  merges: Y.Map<MergeRef>;
  view: Y.Map<unknown>;
  cache: Y.Map<CachedValue>;
}

export interface WorkbookTypes {
  doc: Y.Doc;
  order: Y.Array<string>;
  info: Y.Map<SheetInfo>;
  styles: Y.Map<CellStyle>;
}

export function workbookTypes(doc: Y.Doc): WorkbookTypes {
  return {
    doc,
    order: doc.getArray<string>(SHEET_YDOC.order),
    info: doc.getMap<SheetInfo>(SHEET_YDOC.info),
    styles: doc.getMap<CellStyle>(SHEET_YDOC.styles),
  };
}

const typeCache = new WeakMap<Y.Doc, Map<string, SheetTypes>>();

export function sheetTypes(doc: Y.Doc, id: string): SheetTypes {
  let byId = typeCache.get(doc);
  if (!byId) {
    byId = new Map();
    typeCache.set(doc, byId);
  }
  const hit = byId.get(id);
  if (hit) return hit;
  const name = (part: SheetPart) => sheetTypeName(id, part);
  const t: SheetTypes = {
    id,
    rows: doc.getArray<string>(name('rows')),
    cols: doc.getArray<string>(name('cols')),
    cells: doc.getMap<string>(name('cells')),
    fmt: doc.getMap<string>(name('fmt')),
    rowp: doc.getMap<RowProps>(name('rowp')),
    colp: doc.getMap<ColProps>(name('colp')),
    merges: doc.getMap<MergeRef>(name('merges')),
    view: doc.getMap<unknown>(name('view')),
    cache: doc.getMap<CachedValue>(name('cache')),
  };
  byId.set(id, t);
  return t;
}

/** "行id:列id" */
export function idKey(rowId: string, colId: string): string {
  return `${rowId}:${colId}`;
}

export function splitIdKey(key: string): [string, string] | null {
  const i = key.indexOf(':');
  if (i <= 0) return null;
  return [key.slice(0, i), key.slice(i + 1)];
}

/** 去重（保留第一次出现的位置）：并发插入同一个确定 id 时数组里会有重复项 */
export function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 随机 id（新插入的行、列、表、合并）。以字母开头且不会和确定 id（r0 / c0 / s1）撞上。 */
export function randomId(prefix: 'n' | 's' | 'm' = 'n'): string {
  let out = prefix === 's' ? 'sx' : prefix;
  const bytes = new Uint8Array(7);
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  for (const b of bytes) out += ID_CHARS[b % ID_CHARS.length];
  return out;
}

/** 确定的行列 id：第 i 行 r<i>，第 i 列 c<i>（迁移、导入、默认表用） */
export const detRowId = (i: number) => `r${i}`;
export const detColId = (i: number) => `c${i}`;

/** 样式的规范化 JSON（键排序、去掉空字段）；空样式返回 '' */
export function canonicalStyle(style: CellStyle): string {
  const entries = Object.entries(style)
    .filter(([, v]) => v !== undefined && v !== null && v !== false && v !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return '';
  return JSON.stringify(Object.fromEntries(entries));
}

/** 内容哈希（FNV-1a 两路）→ 样式 id；同样的样式在任何客户端都得到同一个 id */
export function styleIdOf(style: CellStyle): string {
  const json = canonicalStyle(style);
  if (!json) return '';
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < json.length; i += 1) {
    const ch = json.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ch, 0x5bd1e995) >>> 0;
  }
  return `st${h1.toString(36)}${h2.toString(36)}`;
}

export function cleanStyle(style: CellStyle): CellStyle {
  const json = canonicalStyle(style);
  return json ? (JSON.parse(json) as CellStyle) : {};
}
