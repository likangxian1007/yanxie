import type * as Y from 'yjs';
import { FormulaEngine, literalOf, type EngineSource } from '../engine/engine';
import { formatValue, type Display } from '../engine/format';
import { dropSheetInFormula, renameSheetInFormula, shiftFormula } from '../engine/refs';
import { isFormula, type CellError, type CellValue, type Scalar } from '../engine/values';
import type { CellRange } from '../lib/a1';
import {
  DEFAULT_COL_WIDTH,
  DEFAULT_COLS,
  DEFAULT_ROW_HEIGHT,
  DEFAULT_ROWS,
  FIRST_SHEET_ID,
  MAX_COLS,
  MAX_ROWS,
  cleanStyle,
  dedupe,
  detColId,
  detRowId,
  idKey,
  randomId,
  sheetTypes,
  splitIdKey,
  styleIdOf,
  workbookTypes,
  type BorderSide,
  type CachedValue,
  type CellStyle,
  type ColProps,
  type FilterState,
  type MergeRef,
  type RowProps,
  type SheetInfo,
  type SheetTypes,
  type WorkbookTypes,
} from './schema';
import { tr } from '@/lib/i18n';

/**
 * 工作簿模型：对 Y.Doc 里表格 v2 结构（schema.ts）的读缓存 + 所有写操作 + 公式引擎。
 *
 * 读：行列 id 数组、合并区域、行高列宽在 Yjs 变化时按需失效重建；单元格直接从 Y.Map 读（O(1)）。
 * 写：每个操作一个 doc.transact(fn, origin)，origin 交给 Y.UndoManager（每人只撤销自己的修改）。
 * 订阅：doc 的 afterTransaction → 失效缓存、通知引擎哪些格变了 → version + 1 → 通知 React。
 */

export interface MergeArea {
  id: string;
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface CellWrite {
  row: number;
  col: number;
  raw: string;
  /** undefined = 不动样式；null = 清除样式 */
  style?: CellStyle | null;
}

export class SheetModel {
  readonly t: SheetTypes;
  private _rows: string[] | null = null;
  private _rowIndex: Map<string, number> | null = null;
  private _cols: string[] | null = null;
  private _colIndex: Map<string, number> | null = null;
  private _merges: MergeArea[] | null = null;
  private _mergeAt: Map<string, MergeArea> | null = null;
  private _rowOffsets: Float64Array | null = null;
  private _colOffsets: Float64Array | null = null;
  private _filterHidden: Set<number> | null = null;

  constructor(
    readonly wb: Workbook,
    readonly id: string,
  ) {
    this.t = sheetTypes(wb.doc, id);
  }

  /** @internal Yjs 变化后失效 */
  invalidate(part: 'rows' | 'cols' | 'merges' | 'rowp' | 'colp' | 'view' | 'cells') {
    if (part === 'rows') {
      this._rows = null;
      this._rowIndex = null;
      this._merges = null;
      this._mergeAt = null;
      this._rowOffsets = null;
      this._filterHidden = null;
    } else if (part === 'cols') {
      this._cols = null;
      this._colIndex = null;
      this._merges = null;
      this._mergeAt = null;
      this._colOffsets = null;
      this._filterHidden = null;
    } else if (part === 'merges') {
      this._merges = null;
      this._mergeAt = null;
    } else if (part === 'rowp') {
      this._rowOffsets = null;
    } else if (part === 'colp') {
      this._colOffsets = null;
    } else if (part === 'view' || part === 'cells') {
      this._filterHidden = null;
      this._rowOffsets = null;
    }
  }

  get name(): string {
    return this.wb.sheetInfo(this.id).name;
  }

  rowIds(): string[] {
    if (!this._rows) {
      this._rows = dedupe(this.t.rows.toArray());
      this._rowIndex = new Map(this._rows.map((id, i) => [id, i]));
    }
    return this._rows;
  }
  colIds(): string[] {
    if (!this._cols) {
      this._cols = dedupe(this.t.cols.toArray());
      this._colIndex = new Map(this._cols.map((id, i) => [id, i]));
    }
    return this._cols;
  }
  rowIndex(id: string): number {
    this.rowIds();
    return this._rowIndex?.get(id) ?? -1;
  }
  colIndex(id: string): number {
    this.colIds();
    return this._colIndex?.get(id) ?? -1;
  }
  get rowCount(): number {
    return this.rowIds().length;
  }
  get colCount(): number {
    return this.colIds().length;
  }

  key(row: number, col: number): string | null {
    const r = this.rowIds()[row];
    const c = this.colIds()[col];
    return r && c ? idKey(r, c) : null;
  }

  pos(key: string): { row: number; col: number } | null {
    const parts = splitIdKey(key);
    if (!parts) return null;
    const row = this.rowIndex(parts[0]);
    const col = this.colIndex(parts[1]);
    return row < 0 || col < 0 ? null : { row, col };
  }

  raw(row: number, col: number): string | undefined {
    const k = this.key(row, col);
    if (!k) return undefined;
    const v = this.t.cells.get(k);
    return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
  }

  value(row: number, col: number): CellValue {
    return this.wb.engine.get(this.id, row, col);
  }

  styleId(row: number, col: number): string | undefined {
    const k = this.key(row, col);
    return k ? this.t.fmt.get(k) : undefined;
  }

  style(row: number, col: number): CellStyle | undefined {
    const id = this.styleId(row, col);
    return id ? this.wb.styleById(id) : undefined;
  }

  /** 显示用的数字格式：单元格样式里的；没有时用输入暗示的（日期、百分比…） */
  numFmt(row: number, col: number): string | undefined {
    const nf = this.style(row, col)?.nf;
    if (nf) return nf;
    const raw = this.raw(row, col);
    if (raw && !isFormula(raw)) return literalOf(raw).format;
    return undefined;
  }

  cached(row: number, col: number): CachedValue | undefined {
    const k = this.key(row, col);
    return k ? this.t.cache.get(k) : undefined;
  }

  rowProps(row: number): RowProps | undefined {
    const id = this.rowIds()[row];
    return id ? this.t.rowp.get(id) : undefined;
  }
  colProps(col: number): ColProps | undefined {
    const id = this.colIds()[col];
    return id ? this.t.colp.get(id) : undefined;
  }

  /** 被筛选隐藏的行（不含表头） */
  filterHidden(): Set<number> {
    if (this._filterHidden) return this._filterHidden;
    const out = new Set<number>();
    const f = this.filter();
    if (f) {
      const area = this.filterArea(f);
      const entries = Object.entries(f.criteria).filter(([, v]) => Array.isArray(v));
      if (area && entries.length) {
        const cols = entries
          .map(([colId, allowed]) => ({ col: this.colIndex(colId), allowed: new Set(allowed) }))
          .filter((x) => x.col >= 0);
        for (let r = area.r0 + 1; r <= area.r1; r += 1) {
          for (const { col, allowed } of cols) {
            if (!allowed.has(this.wb.displayText(this, r, col))) {
              out.add(r);
              break;
            }
          }
        }
      }
    }
    this._filterHidden = out;
    return out;
  }

  rowHidden(row: number): boolean {
    return !!this.rowProps(row)?.hidden || this.filterHidden().has(row);
  }
  colHidden(col: number): boolean {
    return !!this.colProps(col)?.hidden;
  }
  rowHeight(row: number): number {
    if (this.rowHidden(row)) return 0;
    return this.rowProps(row)?.h ?? DEFAULT_ROW_HEIGHT;
  }
  colWidth(col: number): number {
    if (this.colHidden(col)) return 0;
    return this.colProps(col)?.w ?? DEFAULT_COL_WIDTH;
  }

  /** 行的上边界前缀和（长度 rows + 1） */
  rowOffsets(): Float64Array {
    if (!this._rowOffsets) {
      const n = this.rowCount;
      const out = new Float64Array(n + 1);
      for (let r = 0; r < n; r += 1) out[r + 1] = out[r]! + this.rowHeight(r);
      this._rowOffsets = out;
    }
    return this._rowOffsets;
  }
  colOffsets(): Float64Array {
    if (!this._colOffsets) {
      const n = this.colCount;
      const out = new Float64Array(n + 1);
      for (let c = 0; c < n; c += 1) out[c + 1] = out[c]! + this.colWidth(c);
      this._colOffsets = out;
    }
    return this._colOffsets;
  }

  merges(): MergeArea[] {
    if (!this._merges) {
      const out: MergeArea[] = [];
      const at = new Map<string, MergeArea>();
      this.t.merges.forEach((m, id) => {
        if (!m || typeof m !== 'object') return;
        const r0 = this.rowIndex(m.r0);
        const c0 = this.colIndex(m.c0);
        const r1 = this.rowIndex(m.r1);
        const c1 = this.colIndex(m.c1);
        if (r0 < 0 || c0 < 0 || r1 < 0 || c1 < 0) return;
        const area = {
          id,
          r0: Math.min(r0, r1),
          c0: Math.min(c0, c1),
          r1: Math.max(r0, r1),
          c1: Math.max(c0, c1),
        };
        if (area.r0 === area.r1 && area.c0 === area.c1) return;
        out.push(area);
        for (let r = area.r0; r <= area.r1; r += 1) {
          for (let c = area.c0; c <= area.c1; c += 1) at.set(`${r}:${c}`, area);
        }
      });
      this._merges = out;
      this._mergeAt = at;
    }
    return this._merges;
  }

  mergeAt(row: number, col: number): MergeArea | undefined {
    this.merges();
    return this._mergeAt?.get(`${row}:${col}`);
  }

  /** 把范围扩到完整包含相交的合并区域 */
  expandToMerges(r: CellRange): CellRange {
    const out = { ...r };
    const merges = this.merges();
    for (let changed = true; changed;) {
      changed = false;
      for (const m of merges) {
        if (m.r1 < out.r0 || m.r0 > out.r1 || m.c1 < out.c0 || m.c0 > out.c1) continue;
        if (m.r0 < out.r0 || m.r1 > out.r1 || m.c0 < out.c0 || m.c1 > out.c1) {
          out.r0 = Math.min(out.r0, m.r0);
          out.r1 = Math.max(out.r1, m.r1);
          out.c0 = Math.min(out.c0, m.c0);
          out.c1 = Math.max(out.c1, m.c1);
          changed = true;
        }
      }
    }
    return out;
  }

  frozen(): { rows: number; cols: number } {
    const fr = this.t.view.get('frozenRows');
    const fc = this.t.view.get('frozenCols');
    return {
      rows: typeof fr === 'number' ? Math.max(0, Math.min(fr, this.rowCount - 1)) : 0,
      cols: typeof fc === 'number' ? Math.max(0, Math.min(fc, this.colCount - 1)) : 0,
    };
  }

  filter(): FilterState | null {
    const f = this.t.view.get('filter');
    return f && typeof f === 'object' ? (f as FilterState) : null;
  }

  filterArea(f: FilterState | null = this.filter()): CellRange | null {
    if (!f) return null;
    const r0 = this.rowIndex(f.r0);
    const c0 = this.colIndex(f.c0);
    const r1 = this.rowIndex(f.r1);
    const c1 = this.colIndex(f.c1);
    if (r0 < 0 || c0 < 0 || r1 < 0 || c1 < 0) return null;
    return { r0, c0, r1, c1 };
  }

  /** 有内容（值或样式）的最大行列；空表返回 null */
  usedBounds(withStyles = false): { rows: number; cols: number } | null {
    let rows = -1;
    let cols = -1;
    const scan = (map: Y.Map<unknown>) =>
      map.forEach((_v, key) => {
        const p = this.pos(key);
        if (!p) return;
        if (p.row > rows) rows = p.row;
        if (p.col > cols) cols = p.col;
      });
    scan(this.t.cells as Y.Map<unknown>);
    if (withStyles) scan(this.t.fmt as Y.Map<unknown>);
    for (const m of this.merges()) {
      if (m.r1 > rows) rows = m.r1;
      if (m.c1 > cols) cols = m.c1;
    }
    return rows < 0 ? null : { rows: rows + 1, cols: cols + 1 };
  }

  /** 以 (row, col) 为起点的“当前区域”（连续非空的矩形，Excel 的 Ctrl+A / 排序 / 筛选范围） */
  currentRegion(row: number, col: number): CellRange {
    const filled = (r: number, c: number) =>
      r >= 0 && c >= 0 && r < this.rowCount && c < this.colCount && (this.raw(r, c) ?? '') !== '';
    let r0 = row;
    let r1 = row;
    let c0 = col;
    let c1 = col;
    for (let changed = true, guard = 0; changed && guard < 1000; guard += 1) {
      changed = false;
      const rowHas = (r: number) => {
        for (let c = c0 - 1; c <= c1 + 1; c += 1) if (filled(r, c)) return true;
        return false;
      };
      const colHas = (c: number) => {
        for (let r = r0 - 1; r <= r1 + 1; r += 1) if (filled(r, c)) return true;
        return false;
      };
      if (r0 > 0 && rowHas(r0 - 1)) {
        r0 -= 1;
        changed = true;
      }
      if (r1 < this.rowCount - 1 && rowHas(r1 + 1)) {
        r1 += 1;
        changed = true;
      }
      if (c0 > 0 && colHas(c0 - 1)) {
        c0 -= 1;
        changed = true;
      }
      if (c1 < this.colCount - 1 && colHas(c1 + 1)) {
        c1 += 1;
        changed = true;
      }
    }
    return { r0, c0, r1, c1 };
  }
}

export interface WorkbookEvents {
  /** 本次事务里哪些表的结构（行列、表名、表增删）变了 */
  structure: boolean;
}

export class Workbook {
  readonly t: WorkbookTypes;
  readonly engine: FormulaEngine;
  private sheets = new Map<string, SheetModel>();
  private _ids: string[] | null = null;
  private _byName: Map<string, string> | null = null;
  private listeners = new Set<() => void>();
  version = 0;

  constructor(readonly doc: Y.Doc) {
    this.t = workbookTypes(doc);
    const src: EngineSource = {
      sheetIdByName: (name) => this.sheetIdByName(name),
      sheetName: (id) => this.sheetInfo(id).name,
      size: (id) => {
        const s = this.sheet(id);
        return { rows: s.rowCount, cols: s.colCount };
      },
      raw: (id, r, c) => this.sheet(id).raw(r, c),
      cached: (id, r, c) => {
        const v = this.sheet(id).cached(r, c);
        if (v === undefined) return undefined;
        if (typeof v === 'object') return { error: v.e } as CellError;
        return v as Scalar;
      },
    };
    this.engine = new FormulaEngine(src);
    this.attach();
  }

  private attached = false;
  private attach() {
    if (this.attached) return;
    this.attached = true;
    this.doc.on('afterTransaction', this.onTransaction);
  }

  /** 停止监听 doc。之后再 subscribe 会重新监听（React StrictMode 会先清理 effect 再重新订阅） */
  destroy() {
    if (this.attached) this.doc.off('afterTransaction', this.onTransaction);
    this.attached = false;
    this.listeners.clear();
  }

  subscribe = (fn: () => void): (() => void) => {
    if (!this.attached) {
      // 断开期间可能漏掉了修改：缓存全部作废
      this.attach();
      this._ids = null;
      this._byName = null;
      this.sheets.clear();
      this.engine.reset();
      this.version += 1;
    }
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getVersion = (): number => this.version;

  private onTransaction = (tr: Y.Transaction) => {
    if (tr.changed.size === 0) return;
    let structural = false;
    const changedCells: Array<[string, number, number]> = [];
    const pending: Array<[SheetModel, Set<string | null>]> = [];
    tr.changed.forEach((keys, changedType) => {
      const type = changedType as unknown;
      if (type === this.t.order || type === this.t.info) {
        this._ids = null;
        this._byName = null;
        structural = true;
        return;
      }
      if (type === this.t.styles) return;
      for (const s of this.sheets.values()) {
        const t = s.t;
        if (type === t.rows) {
          s.invalidate('rows');
          structural = true;
        } else if (type === t.cols) {
          s.invalidate('cols');
          structural = true;
        } else if (type === t.merges) s.invalidate('merges');
        else if (type === t.rowp) s.invalidate('rowp');
        else if (type === t.colp) s.invalidate('colp');
        else if (type === t.view) s.invalidate('view');
        else if (type === t.cells || type === t.cache) {
          s.invalidate('cells');
          pending.push([s, keys]);
        } else continue;
        break;
      }
    });
    if (structural) this.engine.reset();
    else {
      for (const [s, keys] of pending) {
        keys.forEach((k) => {
          if (!k) return;
          const p = s.pos(k);
          if (p) changedCells.push([s.id, p.row, p.col]);
        });
      }
      if (changedCells.length) this.engine.cellsChanged(changedCells);
    }
    this.version += 1;
    this.listeners.forEach((l) => l());
  };

  // ------------------------------------------------------------------ 读

  sheetIds(): string[] {
    if (!this._ids) {
      const info = this.t.info;
      this._ids = dedupe(this.t.order.toArray()).filter((id) => info.has(id));
    }
    return this._ids;
  }

  sheetInfo(id: string): SheetInfo {
    const v = this.t.info.get(id);
    return v && typeof v === 'object' ? v : { name: id };
  }

  sheetIdByName(name: string): string | undefined {
    if (!this._byName) {
      this._byName = new Map();
      for (const id of this.sheetIds()) {
        const n = this.sheetInfo(id).name.toLowerCase();
        if (!this._byName.has(n)) this._byName.set(n, id);
      }
    }
    return this._byName.get(name.toLowerCase());
  }

  sheet(id: string): SheetModel {
    let s = this.sheets.get(id);
    if (!s) {
      s = new SheetModel(this, id);
      this.sheets.set(id, s);
    }
    return s;
  }

  styleById(id: string): CellStyle | undefined {
    const v = this.t.styles.get(id);
    return v && typeof v === 'object' ? v : undefined;
  }

  /** 显示文字（数字格式后的），筛选、查找、复制用 */
  displayText(s: SheetModel, row: number, col: number): string {
    return displayOf(s, row, col).text;
  }

  // ------------------------------------------------------------------ 写（工作表）

  /** 新工作表名：Sheet2、Sheet3 … 不与现有重名 */
  nextSheetName(base = 'Sheet'): string {
    const names = new Set(this.sheetIds().map((id) => this.sheetInfo(id).name.toLowerCase()));
    for (let i = this.sheetIds().length + 1; ; i += 1) {
      const n = `${base}${i}`;
      if (!names.has(n.toLowerCase())) return n;
    }
  }

  uniqueName(name: string, except?: string): string {
    const names = new Set(
      this.sheetIds()
        .filter((id) => id !== except)
        .map((id) => this.sheetInfo(id).name.toLowerCase()),
    );
    if (!names.has(name.toLowerCase())) return name;
    for (let i = 2; ; i += 1) {
      const n = `${name} (${i})`;
      if (!names.has(n.toLowerCase())) return n;
    }
  }

  /** 新建一张空表（确定 id 用于第一张表，其余随机） */
  addSheet(origin: unknown, opts: { name?: string; at?: number; id?: string } = {}): string {
    const id = opts.id ?? (this.sheetIds().length === 0 ? FIRST_SHEET_ID : randomId('s'));
    const name = this.uniqueName(opts.name?.trim() || this.nextSheetName());
    this.doc.transact(() => {
      initSheet(this.doc, id, DEFAULT_ROWS, DEFAULT_COLS);
      this.t.info.set(id, { name });
      const ids = this.sheetIds();
      const at = opts.at === undefined ? ids.length : Math.max(0, Math.min(opts.at, ids.length));
      insertIdAt(this.t.order, ids, at, [id]);
    }, origin);
    return id;
  }

  renameSheet(id: string, name: string, origin: unknown): void {
    const clean = name
      .trim()
      .replace(/[\\/?*[\]:]/gu, '')
      .slice(0, 31);
    if (!clean) return;
    const old = this.sheetInfo(id).name;
    if (old === clean) return;
    const next = this.uniqueName(clean, id);
    this.doc.transact(() => {
      this.t.info.set(id, { ...this.sheetInfo(id), name: next });
      this.rewriteAllFormulas((raw) => renameSheetInFormula(raw, old, next));
    }, origin);
  }

  deleteSheet(id: string, origin: unknown): boolean {
    const ids = this.sheetIds();
    if (ids.length <= 1 || !ids.includes(id)) return false;
    const name = this.sheetInfo(id).name;
    this.doc.transact(() => {
      removeIds(this.t.order, [id]);
      this.t.info.delete(id);
      const t = sheetTypes(this.doc, id);
      clearArray(t.rows);
      clearArray(t.cols);
      for (const m of [
        t.cells,
        t.fmt,
        t.rowp,
        t.colp,
        t.merges,
        t.view,
        t.cache,
      ] as Y.Map<unknown>[]) {
        m.clear();
      }
      this.rewriteAllFormulas((raw) => dropSheetInFormula(raw, name), id);
    }, origin);
    return true;
  }

  /** 隐藏 / 取消隐藏工作表（至少保留一张可见） */
  setSheetHidden(id: string, hidden: boolean, origin: unknown): boolean {
    const ids = this.sheetIds();
    if (hidden && ids.filter((x) => x !== id && !this.sheetInfo(x).hidden).length === 0)
      return false;
    const info = { ...this.sheetInfo(id) };
    if (hidden) info.hidden = true;
    else delete info.hidden;
    this.doc.transact(() => this.t.info.set(id, info), origin);
    return true;
  }

  moveSheet(id: string, to: number, origin: unknown): void {
    const ids = this.sheetIds();
    const from = ids.indexOf(id);
    if (from < 0 || from === to) return;
    this.doc.transact(() => {
      removeIds(this.t.order, [id]);
      const rest = ids.filter((x) => x !== id);
      insertIdAt(this.t.order, rest, Math.max(0, Math.min(to, rest.length)), [id]);
    }, origin);
  }

  duplicateSheet(id: string, origin: unknown): string {
    const src = this.sheet(id);
    const newId = randomId('s');
    const ids = this.sheetIds();
    this.doc.transact(() => {
      const t = sheetTypes(this.doc, newId);
      t.rows.push(src.rowIds());
      t.cols.push(src.colIds());
      for (const part of ['cells', 'fmt', 'rowp', 'colp', 'merges', 'cache'] as const) {
        const from = src.t[part] as Y.Map<unknown>;
        const to = t[part] as Y.Map<unknown>;
        from.forEach((v, k) => to.set(k, v));
      }
      src.t.view.forEach((v, k) => t.view.set(k, v));
      this.t.info.set(newId, { name: this.uniqueName(tr('{name} 副本', { name: src.name })) });
      insertIdAt(this.t.order, ids, ids.indexOf(id) + 1, [newId]);
    }, origin);
    return newId;
  }

  /** 对所有公式（可排除某张表）做一次文本改写 */
  private rewriteAllFormulas(fn: (raw: string, sheetName: string) => string, skip?: string) {
    for (const sid of this.sheetIds()) {
      if (sid === skip) continue;
      const t = sheetTypes(this.doc, sid);
      const name = this.sheetInfo(sid).name;
      const updates: Array<[string, string]> = [];
      t.cells.forEach((raw, k) => {
        if (!isFormula(raw)) return;
        const next = fn(raw, name);
        if (next !== raw) updates.push([k, next]);
      });
      for (const [k, v] of updates) t.cells.set(k, v);
    }
  }

  // ------------------------------------------------------------------ 写（单元格）

  setCells(sheetId: string, writes: CellWrite[], origin: unknown): void {
    if (writes.length === 0) return;
    const s = this.sheet(sheetId);
    this.doc.transact(() => {
      let maxRow = -1;
      let maxCol = -1;
      for (const w of writes) {
        if (w.row > maxRow) maxRow = w.row;
        if (w.col > maxCol) maxCol = w.col;
      }
      this.ensureSize(s, maxRow + 1, maxCol + 1);
      for (const w of writes) {
        const k = s.key(w.row, w.col);
        if (!k) continue;
        if (w.raw === '') {
          if (s.t.cells.has(k)) s.t.cells.delete(k);
        } else if (s.t.cells.get(k) !== w.raw) s.t.cells.set(k, w.raw);
        if (s.t.cache.has(k)) s.t.cache.delete(k);
        if (w.style !== undefined) this.putStyle(s, k, w.style);
      }
    }, origin);
  }

  private putStyle(s: SheetModel, key: string, style: CellStyle | null) {
    const id = style ? styleIdOf(style) : '';
    if (!id) {
      if (s.t.fmt.has(key)) s.t.fmt.delete(key);
      return;
    }
    if (!this.t.styles.has(id)) this.t.styles.set(id, cleanStyle(style!));
    if (s.t.fmt.get(key) !== id) s.t.fmt.set(key, id);
  }

  /** 扩大行列数（写到表外时） */
  ensureSize(s: SheetModel, rows: number, cols: number): void {
    const r = Math.min(rows, MAX_ROWS);
    const c = Math.min(cols, MAX_COLS);
    if (r > s.rowCount) s.t.rows.push(freshIds(s.rowCount, r - s.rowCount, 'r', s.rowIds()));
    if (c > s.colCount) s.t.cols.push(freshIds(s.colCount, c - s.colCount, 'c', s.colIds()));
  }

  clearRange(sheetId: string, r: CellRange, what: 'contents' | 'formats' | 'all', origin: unknown) {
    const s = this.sheet(sheetId);
    this.doc.transact(() => {
      forEachKey(s, r, (k) => {
        if (what !== 'formats') {
          s.t.cells.delete(k);
          s.t.cache.delete(k);
        }
        if (what !== 'contents') s.t.fmt.delete(k);
      });
    }, origin);
  }

  /** 改样式：patch 合并进每格现有样式（字段为 undefined 表示删除该字段） */
  applyStyle(
    sheetId: string,
    r: CellRange,
    patch: Partial<CellStyle> | ((old: CellStyle, row: number, col: number) => CellStyle),
    origin: unknown,
  ) {
    const s = this.sheet(sheetId);
    this.doc.transact(() => {
      this.ensureSize(s, r.r1 + 1, r.c1 + 1);
      for (let row = r.r0; row <= r.r1; row += 1) {
        for (let col = r.c0; col <= r.c1; col += 1) {
          const k = s.key(row, col);
          if (!k) continue;
          const old = s.style(row, col) ?? {};
          const next = typeof patch === 'function' ? patch(old, row, col) : { ...old, ...patch };
          for (const key of Object.keys(next) as (keyof CellStyle)[]) {
            if (next[key] === undefined) delete next[key];
          }
          this.putStyle(s, k, next);
        }
      }
    }, origin);
  }

  /** 边框：all 全部、outer 外框、inner 内部、none 清除、top/bottom/left/right 单边 */
  setBorders(
    sheetId: string,
    r: CellRange,
    mode: 'all' | 'outer' | 'inner' | 'none' | 'top' | 'bottom' | 'left' | 'right',
    side: BorderSide,
    origin: unknown,
  ) {
    const b = { s: side.s, c: side.c };
    this.applyStyle(
      sheetId,
      r,
      (old, row, col) => {
        const next = { ...old };
        const top = row === r.r0;
        const bottom = row === r.r1;
        const left = col === r.c0;
        const right = col === r.c1;
        if (mode === 'none') {
          delete next.bt;
          delete next.bb;
          delete next.bl;
          delete next.br;
          return next;
        }
        const set = (k: 'bt' | 'bb' | 'bl' | 'br', on: boolean) => {
          if (on) next[k] = b;
        };
        if (mode === 'all') {
          set('bt', true);
          set('bb', true);
          set('bl', true);
          set('br', true);
        } else if (mode === 'outer') {
          set('bt', top);
          set('bb', bottom);
          set('bl', left);
          set('br', right);
        } else if (mode === 'inner') {
          set('bb', !bottom);
          set('br', !right);
        } else if (mode === 'top') set('bt', top);
        else if (mode === 'bottom') set('bb', bottom);
        else if (mode === 'left') set('bl', left);
        else set('br', right);
        return next;
      },
      origin,
    );
  }

  // ------------------------------------------------------------------ 写（结构）

  insertRows(sheetId: string, at: number, count: number, origin: unknown) {
    this.insertAxis(sheetId, 'row', at, count, origin);
  }
  insertCols(sheetId: string, at: number, count: number, origin: unknown) {
    this.insertAxis(sheetId, 'col', at, count, origin);
  }

  private insertAxis(
    sheetId: string,
    axis: 'row' | 'col',
    at: number,
    count: number,
    origin: unknown,
  ) {
    const s = this.sheet(sheetId);
    const max = axis === 'row' ? MAX_ROWS : MAX_COLS;
    const n = axis === 'row' ? s.rowCount : s.colCount;
    const k = Math.min(count, max - n);
    if (k <= 0) return;
    const name = s.name;
    this.doc.transact(() => {
      const arr = axis === 'row' ? s.t.rows : s.t.cols;
      const ids = axis === 'row' ? s.rowIds() : s.colIds();
      const fresh = Array.from({ length: k }, () => randomId());
      insertIdAt(arr, ids, Math.max(0, Math.min(at, ids.length)), fresh);
      // 插在合并区域内部时扩大合并（id 锚定的角会自然跟着走，插在边上时不扩）
      this.rewriteAllFormulas((raw, fsheet) => shiftFormula(raw, fsheet, name, axis, at, k));
    }, origin);
  }

  deleteRows(sheetId: string, at: number, count: number, origin: unknown) {
    this.deleteAxis(sheetId, 'row', at, count, origin);
  }
  deleteCols(sheetId: string, at: number, count: number, origin: unknown) {
    this.deleteAxis(sheetId, 'col', at, count, origin);
  }

  private deleteAxis(
    sheetId: string,
    axis: 'row' | 'col',
    at: number,
    count: number,
    origin: unknown,
  ) {
    const s = this.sheet(sheetId);
    const ids = axis === 'row' ? s.rowIds() : s.colIds();
    const n = Math.min(count, ids.length - at, ids.length - 1);
    if (n <= 0) return;
    const gone = new Set(ids.slice(at, at + n));
    const name = s.name;
    // 合并区域：被删的角挪到剩下的相邻行列；整个被删则移除
    const mergeFix: Array<[string, MergeRef | null]> = [];
    for (const m of s.merges()) {
      const lo = axis === 'row' ? m.r0 : m.c0;
      const hi = axis === 'row' ? m.r1 : m.c1;
      const del1 = at + n - 1;
      if (lo >= at && hi <= del1) {
        mergeFix.push([m.id, null]);
        continue;
      }
      if (!(lo >= at && lo <= del1) && !(hi >= at && hi <= del1)) continue;
      const nlo = lo >= at && lo <= del1 ? del1 + 1 : lo;
      const nhi = hi >= at && hi <= del1 ? at - 1 : hi;
      const old = s.t.merges.get(m.id)!;
      const next =
        axis === 'row'
          ? { ...old, r0: ids[nlo]!, r1: ids[nhi]! }
          : { ...old, c0: ids[nlo]!, c1: ids[nhi]! };
      mergeFix.push([m.id, next]);
    }
    const filter = s.filter();
    this.doc.transact(() => {
      for (const [id, next] of mergeFix) {
        if (next) s.t.merges.set(id, next);
        else s.t.merges.delete(id);
      }
      if (filter) {
        const area = s.filterArea(filter);
        if (area) {
          const lo = axis === 'row' ? area.r0 : area.c0;
          if (gone.has(axis === 'row' ? filter.r0 : filter.c0) && lo >= at && lo < at + n) {
            s.t.view.delete('filter');
          } else {
            const hiKey = axis === 'row' ? 'r1' : 'c1';
            if (gone.has(filter[hiKey])) {
              const hi = at - 1;
              if (hi >= lo) s.t.view.set('filter', { ...filter, [hiKey]: ids[hi] });
              else s.t.view.delete('filter');
            }
          }
        }
      }
      const arr = axis === 'row' ? s.t.rows : s.t.cols;
      removeIds(arr, [...gone]);
      for (const map of [s.t.cells, s.t.fmt, s.t.cache] as Y.Map<unknown>[]) {
        const dels: string[] = [];
        map.forEach((_v, k) => {
          const parts = splitIdKey(k);
          if (parts && gone.has(axis === 'row' ? parts[0] : parts[1])) dels.push(k);
        });
        for (const k of dels) map.delete(k);
      }
      const props = (axis === 'row' ? s.t.rowp : s.t.colp) as Y.Map<unknown>;
      for (const id of gone) props.delete(id);
      this.rewriteAllFormulas((raw, fsheet) => shiftFormula(raw, fsheet, name, axis, at, -n));
    }, origin);
  }

  setRowHeight(sheetId: string, rows: number[], h: number | null, origin: unknown) {
    const s = this.sheet(sheetId);
    this.doc.transact(() => {
      for (const r of rows) {
        const id = s.rowIds()[r];
        if (!id) continue;
        const old = s.t.rowp.get(id) ?? {};
        const next: RowProps = { ...old };
        if (h === null) delete next.h;
        else next.h = Math.round(h);
        setProps(s.t.rowp, id, next);
      }
    }, origin);
  }

  setColWidth(sheetId: string, cols: number[], w: number | null, origin: unknown) {
    const s = this.sheet(sheetId);
    this.doc.transact(() => {
      for (const c of cols) {
        const id = s.colIds()[c];
        if (!id) continue;
        const old = s.t.colp.get(id) ?? {};
        const next: ColProps = { ...old };
        if (w === null) delete next.w;
        else next.w = Math.round(w);
        setProps(s.t.colp, id, next);
      }
    }, origin);
  }

  setHidden(sheetId: string, axis: 'row' | 'col', idx: number[], hidden: boolean, origin: unknown) {
    const s = this.sheet(sheetId);
    this.doc.transact(() => {
      for (const i of idx) {
        const id = (axis === 'row' ? s.rowIds() : s.colIds())[i];
        if (!id) continue;
        const map = (axis === 'row' ? s.t.rowp : s.t.colp) as Y.Map<RowProps & ColProps>;
        const next = { ...(map.get(id) ?? {}) };
        if (hidden) next.hidden = true;
        else delete next.hidden;
        setProps(map, id, next);
      }
    }, origin);
  }

  merge(sheetId: string, r: CellRange, origin: unknown): void {
    const s = this.sheet(sheetId);
    if (r.r0 === r.r1 && r.c0 === r.c1) return;
    this.doc.transact(() => {
      this.ensureSize(s, r.r1 + 1, r.c1 + 1);
      // 与新区域相交的旧合并先拆掉；左上角以外的内容清空（与 Excel 一致，只保留左上角）
      for (const m of s.merges()) {
        if (m.r1 < r.r0 || m.r0 > r.r1 || m.c1 < r.c0 || m.c0 > r.c1) continue;
        s.t.merges.delete(m.id);
      }
      for (let row = r.r0; row <= r.r1; row += 1) {
        for (let col = r.c0; col <= r.c1; col += 1) {
          if (row === r.r0 && col === r.c0) continue;
          const k = s.key(row, col);
          if (k) {
            s.t.cells.delete(k);
            s.t.cache.delete(k);
          }
        }
      }
      const rows = s.rowIds();
      const cols = s.colIds();
      s.t.merges.set(randomId('m'), {
        r0: rows[r.r0]!,
        c0: cols[r.c0]!,
        r1: rows[r.r1]!,
        c1: cols[r.c1]!,
      });
    }, origin);
  }

  unmerge(sheetId: string, r: CellRange, origin: unknown): void {
    const s = this.sheet(sheetId);
    this.doc.transact(() => {
      for (const m of s.merges()) {
        if (m.r1 < r.r0 || m.r0 > r.r1 || m.c1 < r.c0 || m.c0 > r.c1) continue;
        s.t.merges.delete(m.id);
      }
    }, origin);
  }

  setFrozen(sheetId: string, rows: number, cols: number, origin: unknown): void {
    const s = this.sheet(sheetId);
    this.doc.transact(() => {
      s.t.view.set('frozenRows', Math.max(0, rows));
      s.t.view.set('frozenCols', Math.max(0, cols));
    }, origin);
  }

  setFilter(sheetId: string, area: CellRange | null, origin: unknown): void {
    const s = this.sheet(sheetId);
    this.doc.transact(() => {
      if (!area) {
        s.t.view.delete('filter');
        return;
      }
      const rows = s.rowIds();
      const cols = s.colIds();
      const f: FilterState = {
        r0: rows[area.r0]!,
        c0: cols[area.c0]!,
        r1: rows[area.r1]!,
        c1: cols[area.c1]!,
        criteria: {},
      };
      s.t.view.set('filter', f);
    }, origin);
  }

  setFilterCriteria(sheetId: string, col: number, allowed: string[] | null, origin: unknown) {
    const s = this.sheet(sheetId);
    const f = s.filter();
    const colId = s.colIds()[col];
    if (!f || !colId) return;
    const criteria = { ...f.criteria };
    if (allowed === null) delete criteria[colId];
    else criteria[colId] = allowed;
    this.doc.transact(() => s.t.view.set('filter', { ...f, criteria }), origin);
  }

  /**
   * 排序：按 keyCol 列的值重排 r 范围内的行（只动范围内的列，与 Excel 一致）。
   * 内容、样式一起搬；公式里的相对引用按行位移改写。
   */
  sortRange(
    sheetId: string,
    r: CellRange,
    keyCol: number,
    ascending: boolean,
    origin: unknown,
    compare: (a: CellValue, b: CellValue) => number,
    offset: (raw: string, dRow: number) => string,
  ): void {
    const s = this.sheet(sheetId);
    const order: number[] = [];
    for (let row = r.r0; row <= r.r1; row += 1) order.push(row);
    const keys = new Map(order.map((row) => [row, s.value(row, keyCol)]));
    order.sort((a, b) => {
      const ka = keys.get(a) ?? null;
      const kb = keys.get(b) ?? null;
      const empty = (v: CellValue) => v === null || v === '';
      if (empty(ka) || empty(kb)) return empty(ka) === empty(kb) ? a - b : empty(ka) ? 1 : -1;
      const c = compare(ka, kb);
      return (ascending ? c : -c) || a - b;
    });
    if (order.every((row, i) => row === r.r0 + i)) return;
    const snapshot = order.map((srcRow) => {
      const line: Array<{ raw: string | undefined; fmt: string | undefined }> = [];
      for (let col = r.c0; col <= r.c1; col += 1) {
        line.push({ raw: s.raw(srcRow, col), fmt: s.styleId(srcRow, col) });
      }
      return { srcRow, line };
    });
    this.doc.transact(() => {
      snapshot.forEach(({ srcRow, line }, i) => {
        const row = r.r0 + i;
        line.forEach(({ raw, fmt }, j) => {
          const k = s.key(row, r.c0 + j);
          if (!k) return;
          const next = raw && isFormula(raw) ? offset(raw, row - srcRow) : raw;
          if (next) s.t.cells.set(k, next);
          else s.t.cells.delete(k);
          s.t.cache.delete(k);
          if (fmt) s.t.fmt.set(k, fmt);
          else s.t.fmt.delete(k);
        });
      });
    }, origin);
  }
}

// -------------------------------------------------------------------- 辅助

function setProps<T extends object>(map: Y.Map<T>, id: string, next: T) {
  if (Object.keys(next).length === 0) map.delete(id);
  else map.set(id, next);
}

function forEachKey(s: SheetModel, r: CellRange, fn: (key: string) => void) {
  // 大范围（整列 / 全选）时遍历已有键更快
  const area = (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1);
  if (area > 20_000) {
    const keys = new Set<string>();
    for (const map of [s.t.cells, s.t.fmt, s.t.cache] as Y.Map<unknown>[]) {
      map.forEach((_v, k) => keys.add(k));
    }
    for (const k of keys) {
      const p = s.pos(k);
      if (p && p.row >= r.r0 && p.row <= r.r1 && p.col >= r.c0 && p.col <= r.c1) fn(k);
    }
    return;
  }
  for (let row = r.r0; row <= r.r1; row += 1) {
    for (let col = r.c0; col <= r.c1; col += 1) {
      const k = s.key(row, col);
      if (k) fn(k);
    }
  }
}

/** 末尾追加的新行/列 id：位置 i 用确定 id（r<i> / c<i>），已被占用时改用随机 id */
function freshIds(from: number, count: number, prefix: 'r' | 'c', existing: string[]): string[] {
  const used = new Set(existing);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const det = prefix === 'r' ? detRowId(from + i) : detColId(from + i);
    out.push(used.has(det) ? randomId() : det);
    used.add(out[out.length - 1]!);
  }
  return out;
}

/** 在去重后的第 at 个位置之前插入（数组里可能有重复项，要换算成原始下标） */
export function insertIdAt(arr: Y.Array<string>, deduped: string[], at: number, ids: string[]) {
  if (at >= deduped.length) {
    arr.push(ids);
    return;
  }
  const target = deduped[at]!;
  const raw = arr.toArray();
  const idx = raw.indexOf(target);
  arr.insert(idx < 0 ? raw.length : idx, ids);
}

/** 删除数组里这些 id 的全部出现（含重复项），连续的合并成一次删除 */
export function removeIds(arr: Y.Array<string>, ids: string[]) {
  const gone = new Set(ids);
  const raw = arr.toArray();
  for (let i = raw.length - 1; i >= 0;) {
    if (!gone.has(raw[i]!)) {
      i -= 1;
      continue;
    }
    let j = i;
    while (j - 1 >= 0 && gone.has(raw[j - 1]!)) j -= 1;
    arr.delete(j, i - j + 1);
    i = j - 1;
  }
}

function clearArray(arr: Y.Array<string>) {
  if (arr.length) arr.delete(0, arr.length);
}

/** 写入一张空表的行列（确定 id），不写表名 / 顺序 */
export function initSheet(doc: Y.Doc, id: string, rows: number, cols: number) {
  const t = sheetTypes(doc, id);
  if (t.rows.length === 0) t.rows.push(Array.from({ length: rows }, (_, i) => detRowId(i)));
  if (t.cols.length === 0) t.cols.push(Array.from({ length: cols }, (_, i) => detColId(i)));
}

/** 显示（格式化后的文字） */
export function displayOf(s: SheetModel, row: number, col: number): Display {
  const raw = s.raw(row, col);
  if (raw === undefined || raw === '') return { text: '' };
  return formatValue(s.value(row, col), s.numFmt(row, col));
}
