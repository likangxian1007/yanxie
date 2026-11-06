import * as Y from 'yjs';
import { YDOC_FIELD } from '@srh/shared';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  FIRST_SHEET_ID,
  MAX_COLS,
  MAX_ROWS,
  detColId,
  detRowId,
  idKey,
  sheetTypes,
  styleIdOf,
  workbookTypes,
  type CellStyle,
} from './schema';
import { initSheet } from './workbook';

/**
 * v1（单表：Y.Map `cells` 键 r:c、Y.Map `sheet` 行列数与列宽、Y.Map `formats`）→ v2 的惰性迁移。
 *
 * 用确定的 id（表 s1、行 r<i>、列 c<i>）写入，所以服务端加载时、两个客户端同时打开时各迁移一次也不会
 * 产生两份：数组里的重复 id 读时去重，Map 的同键写入值相同。迁移后旧 `cells` / `formats` 清空，
 * `sheet` 里记 `migrated: 2`。与服务端 modules/documents/sheet-model.ts 的 migrateLegacySheet 保持一致。
 */

export const LEGACY_FORMATS = 'formats';
export const MIGRATION_ORIGIN = { sheet: 'migrate' };

const LEGACY_NUMFMT: Record<string, string> = { fixed2: '0.00', percent: '0.00%' };

export function hasWorkbook(doc: Y.Doc): boolean {
  return workbookTypes(doc).order.length > 0;
}

export function hasLegacy(doc: Y.Doc): boolean {
  const cells = doc.getMap<string>(YDOC_FIELD.sheetCells);
  const meta = doc.getMap<unknown>(YDOC_FIELD.sheetMeta);
  return cells.size > 0 || (meta.size > 0 && meta.get('migrated') === undefined);
}

function legacyPos(key: string): { row: number; col: number } | null {
  const m = /^(\d+):(\d+)$/u.exec(key);
  if (!m) return null;
  const row = Number(m[1]);
  const col = Number(m[2]);
  return row < MAX_ROWS && col < MAX_COLS ? { row, col } : null;
}

/** 有 v1 数据且还没有 v2 结构时迁移；返回是否做了迁移 */
export function migrateLegacySheet(doc: Y.Doc, origin: unknown = MIGRATION_ORIGIN): boolean {
  if (hasWorkbook(doc) || !hasLegacy(doc)) return false;
  const cells = doc.getMap<unknown>(YDOC_FIELD.sheetCells);
  const meta = doc.getMap<unknown>(YDOC_FIELD.sheetMeta);
  const formats = doc.getMap<unknown>(LEGACY_FORMATS);
  doc.transact(() => {
    let rows = Number(meta.get('rows')) || 0;
    let cols = Number(meta.get('cols')) || 0;
    cells.forEach((_v, k) => {
      const p = legacyPos(k);
      if (!p) return;
      rows = Math.max(rows, p.row + 1);
      cols = Math.max(cols, p.col + 1);
    });
    rows = Math.min(MAX_ROWS, Math.max(rows, DEFAULT_ROWS));
    cols = Math.min(MAX_COLS, Math.max(cols, DEFAULT_COLS));
    const wb = workbookTypes(doc);
    initSheet(doc, FIRST_SHEET_ID, rows, cols);
    const t = sheetTypes(doc, FIRST_SHEET_ID);
    cells.forEach((v, k) => {
      const p = legacyPos(k);
      const raw = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
      if (p && raw) t.cells.set(idKey(detRowId(p.row), detColId(p.col)), raw);
    });
    formats.forEach((v, k) => {
      const p = legacyPos(k);
      const nf = typeof v === 'string' ? LEGACY_NUMFMT[v] : undefined;
      if (!p || !nf) return;
      const style: CellStyle = { nf };
      const id = styleIdOf(style);
      if (!wb.styles.has(id)) wb.styles.set(id, style);
      t.fmt.set(idKey(detRowId(p.row), detColId(p.col)), id);
    });
    const widths = meta.get('colWidths');
    if (widths instanceof Y.Map) {
      widths.forEach((w, k) => {
        const c = Number(k);
        if (Number.isInteger(c) && c >= 0 && c < cols && typeof w === 'number' && w > 0) {
          t.colp.set(detColId(c), { w: Math.round(w) });
        }
      });
    }
    wb.info.set(FIRST_SHEET_ID, { name: 'Sheet1' });
    wb.order.push([FIRST_SHEET_ID]);
    cells.clear();
    formats.clear();
    meta.set('migrated', 2);
  }, origin);
  return true;
}

/** 空文档（新建、没有任何表）：建默认的第一张表（确定 id，并发创建自然合并） */
export function ensureDefaultSheet(doc: Y.Doc, origin: unknown = MIGRATION_ORIGIN): boolean {
  if (hasWorkbook(doc) || hasLegacy(doc)) return false;
  const wb = workbookTypes(doc);
  doc.transact(() => {
    initSheet(doc, FIRST_SHEET_ID, DEFAULT_ROWS, DEFAULT_COLS);
    if (!wb.info.has(FIRST_SHEET_ID)) wb.info.set(FIRST_SHEET_ID, { name: 'Sheet1' });
    wb.order.push([FIRST_SHEET_ID]);
  }, origin);
  return true;
}

/** 打开时调用：先迁移旧结构，再保证至少有一张表 */
export function prepareWorkbook(doc: Y.Doc, origin: unknown = MIGRATION_ORIGIN): void {
  if (!migrateLegacySheet(doc, origin)) ensureDefaultSheet(doc, origin);
}
