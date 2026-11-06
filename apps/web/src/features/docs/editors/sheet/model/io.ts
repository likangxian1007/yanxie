import type * as Y from 'yjs';
import type { CellRange } from '../lib/a1';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  FIRST_SHEET_ID,
  MAX_COLS,
  MAX_ROWS,
  cleanStyle,
  detColId,
  detRowId,
  idKey,
  randomId,
  sheetTypes,
  styleIdOf,
  workbookTypes,
  type CachedValue,
  type CellStyle,
} from './schema';
import { initSheet, type Workbook } from './workbook';

/**
 * 与文件格式无关的工作簿数据（xlsx / csv 导入导出的中间表示）。下标都是 0 起。
 */
export interface SheetCellData {
  r: number;
  c: number;
  /** 原始输入（'=' 开头为公式；文本里看起来像数字的已加 ' 前缀） */
  raw: string;
  style?: CellStyle;
  /** 公式的缓存值（Excel 算好的） */
  cached?: CachedValue;
}

export interface SheetData {
  name: string;
  hidden?: boolean;
  rows?: number;
  cols?: number;
  cells: SheetCellData[];
  /** 行高 px */
  rowHeights?: Record<number, number>;
  /** 列宽 px */
  colWidths?: Record<number, number>;
  hiddenRows?: number[];
  hiddenCols?: number[];
  merges?: CellRange[];
  frozenRows?: number;
  frozenCols?: number;
  filter?: CellRange;
  /** 条件格式：编辑器不渲染，只原样保存，导出 .xlsx 时写回 */
  condFormats?: CondFormatData[];
}

/**
 * 一组条件格式（对应 xlsx 里的一个 <conditionalFormatting sqref>）。
 * rules 是 ExcelJS 的规则对象（cellIs / colorScale / dataBar / expression …，已是纯 JSON），不解释。
 * 存进 Y.Doc 时区域用行列 id 锚定（插入行列会跟着走，角所在的行列被删时这一组丢弃）；
 * 规则里的公式文本不随插入删除调整。
 */
export interface CondFormatData {
  ranges: CellRange[];
  rules: unknown[];
}

/** Y.Doc 里 sheet view 的 condFormats 项 */
interface CondFormatRef {
  areas: Array<{ r0: string; c0: string; r1: string; c1: string }>;
  rules: unknown[];
}

export interface WorkbookData {
  sheets: SheetData[];
}

/**
 * 把工作簿数据写进 Y.Doc。
 * - replace：doc 里还没有表（导入到空文档）。第一张表用确定 id s1。
 * - append：作为新表追加到已有工作簿（编辑器里的“导入 Excel”），重名自动加序号。
 * 返回新表的 id。
 */
export function writeWorkbookData(
  doc: Y.Doc,
  data: WorkbookData,
  opts: { mode: 'replace' | 'append'; origin?: unknown; workbook?: Workbook } = { mode: 'replace' },
): string[] {
  const wbt = workbookTypes(doc);
  const ids: string[] = [];
  doc.transact(() => {
    const taken = new Set<string>();
    wbt.info.forEach((v) => taken.add(String(v?.name ?? '').toLowerCase()));
    const unique = (name: string) => {
      const base = name.trim().slice(0, 31) || 'Sheet';
      let n = base;
      for (let i = 2; taken.has(n.toLowerCase()); i += 1) n = `${base} (${i})`;
      taken.add(n.toLowerCase());
      return n;
    };
    data.sheets.forEach((sheet, index) => {
      const id =
        opts.mode === 'replace' && index === 0 && !wbt.info.has(FIRST_SHEET_ID)
          ? FIRST_SHEET_ID
          : randomId('s');
      ids.push(id);
      let rows = sheet.rows ?? 0;
      let cols = sheet.cols ?? 0;
      for (const c of sheet.cells) {
        rows = Math.max(rows, c.r + 1);
        cols = Math.max(cols, c.c + 1);
      }
      for (const m of sheet.merges ?? []) {
        rows = Math.max(rows, m.r1 + 1);
        cols = Math.max(cols, m.c1 + 1);
      }
      rows = Math.min(MAX_ROWS, Math.max(rows + 20, DEFAULT_ROWS));
      cols = Math.min(MAX_COLS, Math.max(cols + 2, DEFAULT_COLS));
      initSheet(doc, id, rows, cols);
      const t = sheetTypes(doc, id);
      for (const c of sheet.cells) {
        if (c.r >= rows || c.c >= cols) continue;
        const k = idKey(detRowId(c.r), detColId(c.c));
        if (c.raw !== '') t.cells.set(k, c.raw);
        if (c.style) {
          const sid = styleIdOf(c.style);
          if (sid) {
            if (!wbt.styles.has(sid)) wbt.styles.set(sid, cleanStyle(c.style));
            t.fmt.set(k, sid);
          }
        }
        if (c.cached !== undefined && c.raw.startsWith('=')) t.cache.set(k, c.cached);
      }
      for (const [r, h] of Object.entries(sheet.rowHeights ?? {})) {
        const i = Number(r);
        if (i < rows && h > 0) t.rowp.set(detRowId(i), { h: Math.round(h) });
      }
      for (const r of sheet.hiddenRows ?? []) {
        if (r < rows) t.rowp.set(detRowId(r), { ...(t.rowp.get(detRowId(r)) ?? {}), hidden: true });
      }
      for (const [c, w] of Object.entries(sheet.colWidths ?? {})) {
        const i = Number(c);
        if (i < cols && w > 0) t.colp.set(detColId(i), { w: Math.round(w) });
      }
      for (const c of sheet.hiddenCols ?? []) {
        if (c < cols) t.colp.set(detColId(c), { ...(t.colp.get(detColId(c)) ?? {}), hidden: true });
      }
      for (const m of sheet.merges ?? []) {
        if (m.r0 === m.r1 && m.c0 === m.c1) continue;
        t.merges.set(randomId('m'), {
          r0: detRowId(m.r0),
          c0: detColId(m.c0),
          r1: detRowId(m.r1),
          c1: detColId(m.c1),
        });
      }
      if (sheet.frozenRows) t.view.set('frozenRows', sheet.frozenRows);
      if (sheet.frozenCols) t.view.set('frozenCols', sheet.frozenCols);
      if (sheet.filter) {
        const f = sheet.filter;
        t.view.set('filter', {
          r0: detRowId(f.r0),
          c0: detColId(f.c0),
          r1: detRowId(f.r1),
          c1: detColId(f.c1),
          criteria: {},
        });
      }
      const cfs: CondFormatRef[] = [];
      for (const cf of sheet.condFormats ?? []) {
        const areas = cf.ranges
          .filter((r) => r.r0 < rows && r.c0 < cols)
          .map((r) => ({
            r0: detRowId(r.r0),
            c0: detColId(r.c0),
            r1: detRowId(Math.min(r.r1, rows - 1)),
            c1: detColId(Math.min(r.c1, cols - 1)),
          }));
        if (areas.length && cf.rules.length) cfs.push({ areas, rules: cf.rules });
      }
      if (cfs.length) t.view.set('condFormats', cfs);
      wbt.info.set(
        id,
        sheet.hidden ? { name: unique(sheet.name), hidden: true } : { name: unique(sheet.name) },
      );
      wbt.order.push([id]);
    });
  }, opts.origin);
  return ids;
}

/** 读出工作簿数据（导出用）：值为原始输入，公式另带当前求值结果 */
export interface ExportCell extends SheetCellData {
  /** 公式的当前值 / 字面量的值 */
  value: number | string | boolean | { error: string } | null;
  /** 显示格式（含输入暗示的，如日期） */
  numFmt?: string;
}

export interface ExportSheet extends Omit<SheetData, 'cells'> {
  id: string;
  cells: ExportCell[];
}

export function readWorkbookData(wb: Workbook, sheetIds = wb.sheetIds()): ExportSheet[] {
  return sheetIds.map((id) => {
    const s = wb.sheet(id);
    const info = wb.sheetInfo(id);
    const keys = new Set<string>();
    s.t.cells.forEach((_v, k) => keys.add(k));
    s.t.fmt.forEach((_v, k) => keys.add(k));
    const cells: ExportCell[] = [];
    for (const k of keys) {
      const p = s.pos(k);
      if (!p) continue;
      const raw = s.raw(p.row, p.col) ?? '';
      const style = s.style(p.row, p.col);
      const value = raw === '' ? null : s.value(p.row, p.col);
      const numFmt = s.numFmt(p.row, p.col);
      cells.push({ r: p.row, c: p.col, raw, style, value, numFmt });
    }
    cells.sort((a, b) => a.r - b.r || a.c - b.c);
    const rowHeights: Record<number, number> = {};
    const hiddenRows: number[] = [];
    s.rowIds().forEach((rid, i) => {
      const p = s.t.rowp.get(rid);
      if (p?.h) rowHeights[i] = p.h;
      if (p?.hidden) hiddenRows.push(i);
    });
    const colWidths: Record<number, number> = {};
    const hiddenCols: number[] = [];
    s.colIds().forEach((cid, i) => {
      const p = s.t.colp.get(cid);
      if (p?.w) colWidths[i] = p.w;
      if (p?.hidden) hiddenCols.push(i);
    });
    const frozen = s.frozen();
    const condFormats: CondFormatData[] = [];
    const stored = s.t.view.get('condFormats');
    for (const cf of Array.isArray(stored) ? (stored as CondFormatRef[]) : []) {
      if (!cf || !Array.isArray(cf.areas) || !Array.isArray(cf.rules)) continue;
      const ranges: CellRange[] = [];
      for (const a of cf.areas) {
        const r0 = s.rowIndex(a.r0);
        const c0 = s.colIndex(a.c0);
        const r1 = s.rowIndex(a.r1);
        const c1 = s.colIndex(a.c1);
        if (r0 < 0 || c0 < 0 || r1 < 0 || c1 < 0) continue;
        ranges.push({
          r0: Math.min(r0, r1),
          c0: Math.min(c0, c1),
          r1: Math.max(r0, r1),
          c1: Math.max(c0, c1),
        });
      }
      if (ranges.length && cf.rules.length) condFormats.push({ ranges, rules: cf.rules });
    }
    return {
      id,
      name: info.name,
      hidden: info.hidden,
      rows: s.rowCount,
      cols: s.colCount,
      cells,
      rowHeights,
      colWidths,
      hiddenRows,
      hiddenCols,
      merges: s.merges().map(({ r0, c0, r1, c1 }) => ({ r0, c0, r1, c1 })),
      frozenRows: frozen.rows,
      frozenCols: frozen.cols,
      filter: s.filterArea() ?? undefined,
      ...(condFormats.length ? { condFormats } : {}),
    };
  });
}
