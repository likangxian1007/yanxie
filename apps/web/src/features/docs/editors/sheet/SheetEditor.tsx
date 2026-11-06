import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { AnimatePresence } from 'motion/react';
import {
  ArrowDownAZ,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpAZ,
  ArrowUpToLine,
  BarChart3,
  Eraser,
  Eye,
  EyeOff,
  Merge,
  Paintbrush,
  Plus,
  Trash2,
} from 'lucide-react';
import { Menu, MenuItem, MenuLabel, MenuSeparator, toast } from '@/components/ui';
import { useDocAi } from '../../ai/useDocAi';
import { decodeText } from '../../import/xlsx';
import { downloadBlob, downloadText, isMac, safeFileName, setAwareness } from '../shared/dom';
import { useLocalOrigin } from '../shared/yStore';
import type { DocEditorProps } from '../types';
import { adjustDecimals, editText } from './engine/format';
import { offsetFormula, quoteSheet } from './engine/refs';
import { compareValues, isFormula } from './engine/values';
import { copyPayload, parseHtmlTable, parsePlain, type ClipGrid } from './io/clipboard';
import { csvToSheetData, sheetToCsv } from './io/csv';
import { buildPrintHtml, printHtml } from './io/print';
import { readXlsx, writeXlsx } from './io/xlsx';
import {
  colIndex,
  normRange,
  rangeLabel,
  rangeSize,
  toA1,
  type CellPos,
  type CellRange,
} from './lib/a1';
import { toCsv } from './lib/csv';
import { planFill } from './model/fill';
import { readWorkbookData, writeWorkbookData } from './model/io';
import { randomId, type CellStyle } from './model/schema';
import { displayOf, type CellWrite, type SheetModel, type Workbook } from './model/workbook';
import { SheetAiButton, SheetAnalysisCard } from './SheetAi';
import { SheetChart, type ChartKind } from './SheetChart';
import { SheetGrid, type EditingState, type GridTarget, type PeerSelection } from './SheetGrid';
import { FilterPopover, FindPanel, type FindOptions } from './SheetPanels';
import { SheetTabs, type SheetTab } from './SheetTabs';
import { SheetToolbar, type BorderMode, type FreezeMode } from './SheetToolbar';
import { DEFAULT_BORDER } from './render/palette';
import { DEFAULT_FONT_PT, ptToCssPx } from './render/style';
import { useSheetUndo, useWorkbook } from './useWorkbook';
import { tr } from '@/lib/i18n';

interface Selection {
  anchor: CellPos;
  focus: CellPos;
}

interface InternalClip {
  sheetId: string;
  text: string;
  range: CellRange;
  grid: ClipGrid;
  cut: boolean;
}

/** 正在往公式里插入引用（编辑公式时点格子 / 拖选区） */
interface RefPick {
  start: number;
  anchor: CellPos;
}

interface PeerOnSheet {
  clientId: number;
  name: string;
  color: string;
  cell?: string;
  range?: [string, string];
}

const PAGE_ROWS = 20;
const REF_TRIGGER = /[=(,+\-*/^&<>:;]\s*$/u;

/**
 * 协同表格（类 Excel，多工作表）。数据在 Y.Doc 的表格 v2 结构里（model/schema.ts，API.md §2.7.1），
 * 本地、其他成员、agent 的修改都实时渲染。每人的撤销只撤自己的修改；在线成员的选区按其颜色显示。
 */
export function SheetEditor({
  projectId,
  docId,
  meta: docMeta,
  collab,
  editable,
  onOutline,
  jumpTo,
}: DocEditorProps) {
  const { doc, provider, peers, synced } = collab;
  const { wb, version } = useWorkbook(doc, synced);
  const origin = useLocalOrigin('sheet');
  const undo = useSheetUndo(wb, origin, version);
  const tableAi = useDocAi(projectId, docId);
  const analysisAi = useDocAi(projectId, docId);

  const sheetIds = wb.sheetIds();
  const [currentId, setCurrentId] = useState<string | null>(null);
  const visibleIds = sheetIds.filter((id) => !wb.sheetInfo(id).hidden);
  const sid =
    currentId && sheetIds.includes(currentId) && !wb.sheetInfo(currentId).hidden
      ? currentId
      : (visibleIds[0] ?? sheetIds[0] ?? null);
  const sheet: SheetModel | null = sid ? wb.sheet(sid) : null;

  const [selBySheet, setSelBySheet] = useState<Record<string, Selection>>({});
  const [editing, setEditing] = useState<EditingState | null>(null);
  const editingRef = useRef<EditingState | null>(null);
  const refPick = useRef<RefPick | null>(null);
  /** 开始编辑时所在的表（编辑公式时切到别的表点格子，引用要带表名） */
  const editSheet = useRef<string | null>(null);
  const sinkRef = useRef<HTMLTextAreaElement | null>(null);
  const barRef = useRef<HTMLInputElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [clip, setClip] = useState<InternalClip | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; target: GridTarget } | null>(null);
  const [chart, setChart] = useState<{ range: CellRange; kind: ChartKind } | null>(null);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [find, setFind] = useState({ open: false, replace: false, index: 0 });
  const [findOpts, setFindOpts] = useState<FindOptions>({
    find: '',
    replace: '',
    matchCase: false,
    wholeCell: false,
    allSheets: false,
  });
  const [filterUi, setFilterUi] = useState<{ col: number; rect: DOMRect } | null>(null);
  const [nameBox, setNameBox] = useState<string | null>(null);

  const rows = sheet?.rowCount ?? 1;
  const cols = sheet?.colCount ?? 1;
  const clampPos = (p: CellPos): CellPos => ({
    row: Math.max(0, Math.min(rows - 1, p.row)),
    col: Math.max(0, Math.min(cols - 1, p.col)),
  });
  const rawSel = (sid && selBySheet[sid]) || {
    anchor: { row: 0, col: 0 },
    focus: { row: 0, col: 0 },
  };
  const anchor = clampPos(rawSel.anchor);
  const focus = clampPos(rawSel.focus);
  const range = sheet ? sheet.expandToMerges(normRange(anchor, focus)) : normRange(anchor, focus);
  const setSel = (next: Selection | ((s: Selection) => Selection)) => {
    if (!sid) return;
    setSelBySheet((all) => {
      const cur = all[sid] ?? rawSel;
      return { ...all, [sid]: typeof next === 'function' ? next(cur) : next };
    });
  };

  // 大纲：多张工作表时列出表名，点击切换
  const outlineKey = visibleIds.map((id) => wb.sheetInfo(id).name).join('\u0000');
  useEffect(() => {
    const names = outlineKey.split('\u0000');
    onOutline?.(names.length > 1 ? names.map((heading) => ({ heading, level: 1 })) : []);
  }, [onOutline, outlineKey]);
  // 大纲点击：切到第 index 张可见的表（渲染时处理，只响应新的跳转请求）
  const [seenJump, setSeenJump] = useState(jumpTo);
  if (jumpTo !== seenJump) {
    setSeenJump(jumpTo);
    const id = jumpTo ? visibleIds[jumpTo.index] : undefined;
    if (id) setCurrentId(id);
  }

  // ------------------------------------------------------------ 协作者

  // awareness：我在哪张表、活动格和选区（行列 id，插删行列后仍指向同一格）
  const awCell = sheet?.key(anchor.row, anchor.col) ?? null;
  const awFocus = sheet?.key(focus.row, focus.col) ?? null;
  useEffect(() => {
    if (!sid) return;
    setAwareness(provider, 'sheet', sid);
    setAwareness(provider, 'cell', awCell);
    setAwareness(
      provider,
      'range',
      awCell && awFocus && awFocus !== awCell ? [awCell, awFocus] : null,
    );
  }, [provider, sid, awCell, awFocus]);
  useEffect(
    () => () => {
      setAwareness(provider, 'sheet', null);
      setAwareness(provider, 'cell', null);
      setAwareness(provider, 'range', null);
    },
    [provider],
  );

  const firstId = sheetIds[0];
  const peerSheets = (() => {
    const out = new Map<string, PeerOnSheet[]>();
    for (const p of peers) {
      if (p.isSelf) continue;
      const st = p.state as { sheet?: unknown; cell?: unknown; range?: unknown };
      if (typeof st.cell !== 'string' && typeof st.sheet !== 'string') continue;
      const s = typeof st.sheet === 'string' ? st.sheet : firstId;
      if (!s) continue;
      const list = out.get(s) ?? [];
      const r = st.range;
      list.push({
        clientId: p.clientId,
        name: p.user.name,
        color: p.user.color,
        cell: typeof st.cell === 'string' ? st.cell : undefined,
        range:
          Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'string'
            ? [r[0], r[1]]
            : undefined,
      });
      out.set(s, list);
    }
    return out;
  })();

  const peerSel: PeerSelection[] = [];
  if (sheet && sid) {
    for (const p of peerSheets.get(sid) ?? []) {
      if (!p.cell) continue;
      // 新结构是 "行id:列id"；旧客户端发的是 "行:列" 下标
      const pos = sheet.pos(p.cell) ?? legacyPos(p.cell);
      if (!pos || pos.row >= rows || pos.col >= cols) continue;
      const f = p.range ? (sheet.pos(p.range[1]) ?? pos) : pos;
      peerSel.push({
        clientId: p.clientId,
        name: p.name,
        color: p.color,
        active: pos,
        range: normRange(pos, f),
      });
    }
  }

  const tabs: SheetTab[] = sheetIds.map((id) => ({
    id,
    name: wb.sheetInfo(id).name,
    hidden: wb.sheetInfo(id).hidden,
    peers: (peerSheets.get(id) ?? []).map(({ clientId, name, color }) => ({
      clientId,
      name,
      color,
    })),
  }));

  // ------------------------------------------------------------ 编辑

  const updateEditing = (next: EditingState | null) => {
    if (next && !editingRef.current) editSheet.current = sid;
    editingRef.current = next;
    setEditing(next);
    if (!next) refPick.current = null;
  };

  const focusSink = () => {
    requestAnimationFrame(() => sinkRef.current?.focus({ preventScroll: true }));
  };

  const commit = () => {
    const ed = editingRef.current;
    const target = editSheet.current ?? sid;
    if (!ed || !target) return;
    updateEditing(null);
    if (!editable) return;
    const s = wb.sheet(target);
    const sel = selBySheet[target] ?? rawSel;
    const a = target === sid ? anchor : sel.anchor;
    const raw = s.raw(a.row, a.col) ?? '';
    const shown = editText(raw, s.value(a.row, a.col), s.numFmt(a.row, a.col));
    if (ed.draft !== shown) {
      undo.stopCapturing();
      wb.setCells(target, [{ row: a.row, col: a.col, raw: ed.draft }], origin);
    }
    if (target !== sid) setCurrentId(target);
  };
  const cancel = () => {
    const target = editSheet.current;
    updateEditing(null);
    if (target && target !== sid) setCurrentId(target);
    focusSink();
  };

  /** 选中（落在合并区域里时活动格在合并区域左上角） */
  const select = (a: CellPos, f?: CellPos) => {
    const ca = clampPos(a);
    const m = sheet?.mergeAt(ca.row, ca.col);
    const anchorPos = m ? { row: m.r0, col: m.c0 } : ca;
    setSel({ anchor: anchorPos, focus: f ? clampPos(f) : anchorPos });
  };

  const stepVisible = (pos: CellPos, dr: number, dc: number): CellPos => {
    if (!sheet) return pos;
    let { row, col } = pos;
    const m = sheet.mergeAt(row, col);
    if (m) {
      if (dr > 0) row = m.r1;
      if (dr < 0) row = m.r0;
      if (dc > 0) col = m.c1;
      if (dc < 0) col = m.c0;
    }
    const n = Math.abs(dr) || Math.abs(dc);
    const sr = Math.sign(dr);
    const sc = Math.sign(dc);
    for (let i = 0; i < n; i += 1) {
      let r = row + sr;
      let c = col + sc;
      while (sr && r >= 0 && r < rows && sheet.rowHidden(r)) r += sr;
      while (sc && c >= 0 && c < cols && sheet.colHidden(c)) c += sc;
      if (r < 0 || r >= rows || c < 0 || c >= cols) break;
      row = r;
      col = c;
    }
    return { row, col };
  };

  /** Ctrl + 方向键：跳到数据区域的边缘 */
  const jumpEdge = (pos: CellPos, dr: number, dc: number): CellPos => {
    if (!sheet) return pos;
    const filled = (r: number, c: number) => (sheet.raw(r, c) ?? '') !== '';
    const inside = (r: number, c: number) => r >= 0 && r < rows && c >= 0 && c < cols;
    let { row, col } = pos;
    if (!inside(row + dr, col + dc)) return pos;
    if (filled(row, col) && filled(row + dr, col + dc)) {
      while (inside(row + dr, col + dc) && filled(row + dr, col + dc)) {
        row += dr;
        col += dc;
      }
      return { row, col };
    }
    row += dr;
    col += dc;
    while (!filled(row, col) && inside(row + dr, col + dc)) {
      row += dr;
      col += dc;
    }
    return { row, col };
  };

  const move = (dr: number, dc: number, extend = false, edge = false) => {
    if (extend) {
      const next = edge
        ? jumpEdge(focus, Math.sign(dr), Math.sign(dc))
        : stepVisible(focus, dr, dc);
      setSel({ anchor, focus: clampPos(next) });
    } else {
      const next = edge
        ? jumpEdge(anchor, Math.sign(dr), Math.sign(dc))
        : stepVisible(anchor, dr, dc);
      select(next);
    }
  };

  const startEdit = (pos: CellPos, source: 'cell' | 'bar' = 'cell') => {
    if (!editable || !sheet) return;
    select(pos);
    const raw = sheet.raw(pos.row, pos.col) ?? '';
    const draft = editText(raw, sheet.value(pos.row, pos.col), sheet.numFmt(pos.row, pos.col));
    updateEditing({ mode: 'edit', draft, source });
    if (source === 'cell') focusSink();
  };

  // ------------------------------------------------------------ 剪贴板

  const copySelection = (e: ClipboardEvent<HTMLTextAreaElement>, cut: boolean) => {
    if (!sheet || !sid) return;
    const { text, html } = copyPayload(sheet, range);
    e.clipboardData.setData('text/plain', text);
    e.clipboardData.setData('text/html', html);
    const cells: ClipGrid['cells'] = [];
    for (let r = range.r0; r <= range.r1; r += 1) {
      const line: ClipGrid['cells'][number] = [];
      for (let c = range.c0; c <= range.c1; c += 1) {
        line.push({ raw: sheet.raw(r, c) ?? '', style: sheet.style(r, c) });
      }
      cells.push(line);
    }
    const merges = sheet
      .merges()
      .filter((m) => m.r0 >= range.r0 && m.r1 <= range.r1 && m.c0 >= range.c0 && m.c1 <= range.c1)
      .map((m) => ({
        r0: m.r0 - range.r0,
        c0: m.c0 - range.c0,
        r1: m.r1 - range.r0,
        c1: m.c1 - range.c0,
      }));
    setClip({ sheetId: sid, text, range, grid: { cells, merges }, cut });
  };

  const pasteGrid = (grid: ClipGrid, internal: InternalClip | null, withStyles: boolean) => {
    if (!sheet || !sid) return;
    const h = grid.cells.length;
    const w = grid.cells.reduce((m, l) => Math.max(m, l.length), 0);
    if (!h || !w) return;
    // 选区是源区域的整数倍时平铺（Excel 行为），否则贴一份
    const sel = rangeSize(range);
    const tileR = sel.rows % h === 0 && sel.rows > h ? sel.rows / h : 1;
    const tileC = sel.cols % w === 0 && sel.cols > w ? sel.cols / w : 1;
    const writes: CellWrite[] = [];
    for (let tr = 0; tr < tileR; tr += 1) {
      for (let tc = 0; tc < tileC; tc += 1) {
        grid.cells.forEach((line, dr) =>
          line.forEach((cell, dc) => {
            const row = range.r0 + tr * h + dr;
            const col = range.c0 + tc * w + dc;
            let raw = cell.raw;
            if (internal && isFormula(raw)) {
              raw = offsetFormula(
                raw,
                row - (internal.range.r0 + dr),
                col - (internal.range.c0 + dc),
              );
            }
            writes.push({ row, col, raw, style: withStyles ? (cell.style ?? null) : undefined });
          }),
        );
      }
    }
    const target = {
      r0: range.r0,
      c0: range.c0,
      r1: range.r0 + h * tileR - 1,
      c1: range.c0 + w * tileC - 1,
    };
    undo.stopCapturing();
    doc.transact(() => {
      if (internal?.cut) {
        // 剪切：清掉源区域里没被目标覆盖的部分
        const src = wb.sheet(internal.sheetId);
        const clears: CellWrite[] = [];
        for (let r = internal.range.r0; r <= internal.range.r1; r += 1) {
          for (let c = internal.range.c0; c <= internal.range.c1; c += 1) {
            const covered =
              internal.sheetId === sid &&
              r >= target.r0 &&
              r <= target.r1 &&
              c >= target.c0 &&
              c <= target.c1;
            if (!covered && (src.raw(r, c) || src.styleId(r, c))) {
              clears.push({ row: r, col: c, raw: '', style: null });
            }
          }
        }
        wb.setCells(internal.sheetId, clears, origin);
        wb.unmerge(internal.sheetId, internal.range, origin);
      }
      wb.setCells(sid, writes, origin);
      if (withStyles) {
        wb.unmerge(sid, target, origin);
        for (const m of grid.merges) {
          for (let tr = 0; tr < tileR; tr += 1) {
            for (let tc = 0; tc < tileC; tc += 1) {
              const r0 = target.r0 + tr * h + m.r0;
              const c0 = target.c0 + tc * w + m.c0;
              wb.merge(sid, { r0, c0, r1: r0 + m.r1 - m.r0, c1: c0 + m.c1 - m.c0 }, origin);
            }
          }
        }
      }
    }, origin);
    if (internal?.cut) setClip(null);
    setSel({
      anchor: { row: target.r0, col: target.c0 },
      focus: { row: target.r1, col: target.c1 },
    });
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (editingRef.current) return;
    e.preventDefault();
    if (!editable) return;
    const text = e.clipboardData.getData('text/plain');
    const html = e.clipboardData.getData('text/html');
    const norm = (s: string) => s.replace(/\r\n/gu, '\n').replace(/\n$/u, '');
    if (clip && norm(clip.text) === norm(text)) {
      pasteGrid(clip.grid, clip, true);
      return;
    }
    const fromHtml = html ? parseHtmlTable(html) : null;
    if (fromHtml) pasteGrid(fromHtml, null, true);
    else if (text) pasteGrid(parsePlain(text), null, false);
  };

  // ------------------------------------------------------------ 样式 / 结构

  const activeStyle: CellStyle = sheet?.style(anchor.row, anchor.col) ?? {};
  const applyStyle = (patch: Partial<CellStyle>) => {
    if (!editable || !sid) return;
    undo.stopCapturing();
    wb.applyStyle(sid, range, patch, origin);
  };
  const toggleStyle = (key: 'b' | 'i' | 'u' | 's') =>
    applyStyle({ [key]: activeStyle[key] ? undefined : true });
  const setBorders = (mode: BorderMode) => {
    if (!editable || !sid) return;
    undo.stopCapturing();
    wb.setBorders(sid, range, mode, DEFAULT_BORDER, origin);
  };
  const decimals = (delta: 1 | -1) => {
    if (!sheet) return;
    applyStyle({ nf: adjustDecimals(sheet.numFmt(anchor.row, anchor.col), delta) });
  };

  const activeMerge = !!sheet
    ?.merges()
    .some((m) => !(m.r1 < range.r0 || m.r0 > range.r1 || m.c1 < range.c0 || m.c0 > range.c1));
  const toggleMerge = () => {
    if (!editable || !sid || !sheet) return;
    undo.stopCapturing();
    if (activeMerge) {
      wb.unmerge(sid, range, origin);
      return;
    }
    if (range.r0 === range.r1 && range.c0 === range.c1) return;
    let filled = 0;
    for (let r = range.r0; r <= range.r1 && filled < 2; r += 1) {
      for (let c = range.c0; c <= range.c1 && filled < 2; c += 1) if (sheet.raw(r, c)) filled += 1;
    }
    wb.merge(sid, range, origin);
    if (filled > 1) {
      toast({ title: tr('已合并单元格'), description: tr('只保留了左上角的内容。'), tone: 'info' });
    }
  };

  const freeze = (mode: FreezeMode) => {
    if (!sid) return;
    const [r, c] =
      mode === 'row'
        ? [1, 0]
        : mode === 'col'
          ? [0, 1]
          : mode === 'here'
            ? [anchor.row, anchor.col]
            : [0, 0];
    wb.setFrozen(sid, r, c, origin);
  };

  /** 排序 / 筛选作用的区域：筛选区域 > 多选选区 > 当前数据区域（首行全是文本时视为表头） */
  const dataRegion = (): { area: CellRange; header: boolean } | null => {
    if (!sheet) return null;
    const fa = sheet.filterArea();
    if (
      fa &&
      anchor.row >= fa.r0 &&
      anchor.row <= fa.r1 &&
      anchor.col >= fa.c0 &&
      anchor.col <= fa.c1
    ) {
      return { area: fa, header: true };
    }
    if (range.r0 !== range.r1 || range.c0 !== range.c1) return { area: range, header: false };
    const area = sheet.currentRegion(anchor.row, anchor.col);
    if (area.r0 === area.r1) return { area, header: false };
    let header = true;
    for (let c = area.c0; c <= area.c1; c += 1) {
      const v = sheet.value(area.r0, c);
      if (v !== null && typeof v !== 'string') header = false;
    }
    return { area, header };
  };

  const sort = (asc: boolean, col = anchor.col) => {
    if (!editable || !sid || !sheet) return;
    const reg = dataRegion();
    if (!reg) return;
    const r = { ...reg.area, r0: reg.area.r0 + (reg.header ? 1 : 0) };
    if (r.r1 <= r.r0) return;
    if (sheet.merges().some((m) => !(m.r1 < r.r0 || m.r0 > r.r1 || m.c1 < r.c0 || m.c0 > r.c1))) {
      toast({
        title: tr('没法排序'),
        description: tr('排序区域里有合并单元格，先取消合并。'),
        tone: 'warning',
      });
      return;
    }
    undo.stopCapturing();
    wb.sortRange(sid, r, col, asc, origin, compareValues, (raw, d) => offsetFormula(raw, d, 0));
  };

  const toggleFilter = () => {
    if (!editable || !sid || !sheet) return;
    if (sheet.filter()) {
      wb.setFilter(sid, null, origin);
      return;
    }
    const reg = dataRegion();
    if (!reg || reg.area.r1 <= reg.area.r0) {
      toast({
        title: tr('先选中带表头的数据区域'),
        description: tr('筛选需要至少一行表头和一行数据。'),
        tone: 'warning',
      });
      return;
    }
    wb.setFilter(sid, reg.area, origin);
  };

  const size = rangeSize(range);
  const span = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const insertRows = (where: 'above' | 'below') => {
    if (!sid) return;
    wb.insertRows(sid, where === 'above' ? range.r0 : range.r1 + 1, size.rows, origin);
    if (where === 'above')
      setSel((s) => ({
        anchor: { ...s.anchor, row: s.anchor.row + size.rows },
        focus: { ...s.focus, row: s.focus.row + size.rows },
      }));
  };
  const insertCols = (where: 'left' | 'right') => {
    if (!sid) return;
    wb.insertCols(sid, where === 'left' ? range.c0 : range.c1 + 1, size.cols, origin);
    if (where === 'left')
      setSel((s) => ({
        anchor: { ...s.anchor, col: s.anchor.col + size.cols },
        focus: { ...s.focus, col: s.focus.col + size.cols },
      }));
  };
  const deleteRows = () => {
    if (!sid) return;
    if (size.rows >= rows) {
      toast({ title: tr('至少要保留一行'), tone: 'warning' });
      return;
    }
    wb.deleteRows(sid, range.r0, size.rows, origin);
    select({ row: range.r0, col: anchor.col });
  };
  const deleteCols = () => {
    if (!sid) return;
    if (size.cols >= cols) {
      toast({ title: tr('至少要保留一列'), tone: 'warning' });
      return;
    }
    wb.deleteCols(sid, range.c0, size.cols, origin);
    select({ row: anchor.row, col: range.c0 });
  };
  const hideAxis = (axis: 'row' | 'col', hidden: boolean) => {
    if (!sid) return;
    const [a, b, n] = axis === 'row' ? [range.r0, range.r1, rows] : [range.c0, range.c1, cols];
    if (hidden && b - a + 1 >= n) return;
    const lo = hidden ? a : Math.max(0, a - 1);
    const hi = hidden ? b : Math.min(n - 1, b + 1);
    wb.setHidden(sid, axis, span(lo, hi), hidden, origin);
  };
  const clear = (what: 'contents' | 'formats' | 'all') => {
    if (!editable || !sid) return;
    undo.stopCapturing();
    wb.clearRange(sid, range, what, origin);
  };
  const growSheet = (axis: 'row' | 'col') => {
    if (!sheet) return;
    doc.transact(
      () =>
        wb.ensureSize(sheet, rows + (axis === 'row' ? 100 : 0), cols + (axis === 'col' ? 10 : 0)),
      origin,
    );
  };

  const autoFit = (col: number) => {
    if (!sheet || !sid) return;
    const g = document.createElement('canvas').getContext('2d');
    if (!g) return;
    let max = 0;
    const last = Math.min(sheet.usedBounds()?.rows ?? 0, 5000);
    for (let r = 0; r < last; r += 1) {
      if (sheet.mergeAt(r, col)) continue;
      const d = displayOf(sheet, r, col);
      if (!d.text) continue;
      const st = sheet.style(r, col);
      g.font = `${st?.b ? 700 : 400} ${ptToCssPx(st?.fs ?? DEFAULT_FONT_PT)}px Inter, "PingFang SC", "Microsoft YaHei", sans-serif`;
      for (const line of d.text.split('\n')) max = Math.max(max, g.measureText(line).width);
    }
    const whole = range.r0 === 0 && range.r1 === rows - 1 && col >= range.c0 && col <= range.c1;
    wb.setColWidth(
      sid,
      whole ? span(range.c0, range.c1) : [col],
      max ? Math.ceil(max + 12) : null,
      origin,
    );
  };

  // ------------------------------------------------------------ 查找

  // 不手动 memo：React Compiler 负责；面板关着时不计算
  const matches = find.open ? findMatches(wb, sid, findOpts, version) : [];
  const matchIndex = matches.length ? Math.min(find.index, matches.length - 1) : 0;
  const currentMatch = matches[matchIndex];

  const goMatch = (i: number) => {
    if (!matches.length) return;
    const idx = ((i % matches.length) + matches.length) % matches.length;
    const m = matches[idx]!;
    setFind((f) => ({ ...f, index: idx }));
    if (m.sheetId !== sid) setCurrentId(m.sheetId);
    const pos = { row: m.row, col: m.col };
    setSelBySheet((all) => ({ ...all, [m.sheetId]: { anchor: pos, focus: pos } }));
  };
  const replaceIn = (raw: string): string => {
    const pattern = findOpts.wholeCell ? `^${escapeRe(findOpts.find)}$` : escapeRe(findOpts.find);
    return raw.replace(
      new RegExp(pattern, findOpts.matchCase ? 'gu' : 'giu'),
      () => findOpts.replace,
    );
  };
  const replaceOne = () => {
    const m = currentMatch;
    if (!m || !editable) return;
    const raw = wb.sheet(m.sheetId).raw(m.row, m.col) ?? '';
    const next = replaceIn(raw);
    if (next !== raw) wb.setCells(m.sheetId, [{ row: m.row, col: m.col, raw: next }], origin);
    goMatch(matchIndex + (next === raw ? 1 : 0));
  };
  const replaceAll = () => {
    if (!editable) return;
    let n = 0;
    undo.stopCapturing();
    doc.transact(() => {
      const bySheet = new Map<string, CellWrite[]>();
      for (const m of matches) {
        const raw = wb.sheet(m.sheetId).raw(m.row, m.col) ?? '';
        const next = replaceIn(raw);
        if (next === raw) continue;
        n += 1;
        const list = bySheet.get(m.sheetId) ?? [];
        list.push({ row: m.row, col: m.col, raw: next });
        bySheet.set(m.sheetId, list);
      }
      bySheet.forEach((w, id) => wb.setCells(id, w, origin));
    }, origin);
    toast.success(n ? tr('已替换 {n} 处', { n }) : tr('没有可替换的内容'));
  };

  // ------------------------------------------------------------ 键盘

  const onSinkKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const ed = editingRef.current;
    const mod = e.ctrlKey || e.metaKey;
    if (e.nativeEvent.isComposing || e.key === 'Process') return;
    if (ed) {
      if (e.key === 'Enter' && e.altKey) {
        // Alt+Enter：单元格内换行
        e.preventDefault();
        const el = e.currentTarget;
        const at = el.selectionStart ?? ed.draft.length;
        const draft = `${ed.draft.slice(0, at)}\n${ed.draft.slice(el.selectionEnd ?? at)}`;
        updateEditing({ ...ed, mode: 'edit', draft });
        requestAnimationFrame(() => el.setSelectionRange(at + 1, at + 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        commit();
        move(e.shiftKey ? -1 : 1, 0);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        commit();
        move(0, e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (
        ed.mode === 'enter' &&
        e.key.startsWith('Arrow') &&
        !e.shiftKey &&
        !(ed.draft.startsWith('=') && REF_TRIGGER.test(ed.draft))
      ) {
        e.preventDefault();
        commit();
        const d = ARROWS[e.key];
        if (d) move(d[0], d[1]);
      }
      return;
    }
    const arrow = ARROWS[e.key];
    if (arrow) {
      e.preventDefault();
      move(arrow[0], arrow[1], e.shiftKey, mod);
      return;
    }
    switch (e.key) {
      case 'Tab':
        e.preventDefault();
        move(0, e.shiftKey ? -1 : 1);
        return;
      case 'Enter':
        e.preventDefault();
        move(e.shiftKey ? -1 : 1, 0);
        return;
      case 'F2':
        e.preventDefault();
        startEdit(anchor);
        return;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        clear('contents');
        return;
      case 'Home':
        e.preventDefault();
        select(mod ? { row: 0, col: 0 } : { row: anchor.row, col: 0 });
        return;
      case 'End': {
        e.preventDefault();
        const b = sheet?.usedBounds();
        select(
          mod && b ? { row: b.rows - 1, col: b.cols - 1 } : { row: anchor.row, col: cols - 1 },
        );
        return;
      }
      case 'PageDown':
      case 'PageUp':
        e.preventDefault();
        move(e.key === 'PageDown' ? PAGE_ROWS : -PAGE_ROWS, 0, e.shiftKey);
        return;
      case 'Escape':
        if (clip) setClip(null);
        else if (chart) setChart(null);
        return;
      default:
        break;
    }
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo.undo();
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        undo.redo();
      } else if (k === 'a') {
        e.preventDefault();
        setSel({ anchor: { row: 0, col: 0 }, focus: { row: rows - 1, col: cols - 1 } });
      } else if (k === 'b' || k === 'i' || k === 'u') {
        e.preventDefault();
        toggleStyle(k);
      } else if (k === '5') {
        e.preventDefault();
        toggleStyle('s');
      } else if (k === 'f' || k === 'h') {
        e.preventDefault();
        setFind((f) => ({ ...f, open: true, replace: k === 'h' && editable }));
      } else if ((k === 'd' || k === 'r') && editable && sid && sheet) {
        // Ctrl+D 向下填充、Ctrl+R 向右填充
        e.preventDefault();
        if (k === 'd' ? range.r1 === range.r0 : range.c1 === range.c0) return;
        const src = k === 'd' ? { ...range, r1: range.r0 } : { ...range, c1: range.c0 };
        undo.stopCapturing();
        wb.setCells(sid, planFill(sheet, src, range), origin);
      }
    }
  };

  const onSinkChange = (value: string) => {
    if (!editable) return;
    const ed = editingRef.current;
    refPick.current = null;
    if (ed) updateEditing({ ...ed, draft: value });
    else updateEditing({ mode: 'enter', draft: value, source: 'cell' });
  };

  // ------------------------------------------------------------ 指针

  const refText = (a: CellPos, f: CellPos) => {
    const label = rangeLabel(normRange(a, f));
    if (sid && editSheet.current && editSheet.current !== sid) {
      return `${quoteSheet(wb.sheetInfo(sid).name)}!${label}`;
    }
    return label;
  };

  const onPick = (t: GridTarget, extend: boolean) => {
    const ed = editingRef.current;
    // 编辑公式时点格子：把引用插进公式（Excel 的“点选引用”）
    if (
      ed &&
      ed.draft.startsWith('=') &&
      t.kind === 'cell' &&
      (refPick.current || REF_TRIGGER.test(ed.draft))
    ) {
      const start = refPick.current?.start ?? ed.draft.length;
      refPick.current = { start, anchor: t.pos };
      updateEditing({
        ...ed,
        mode: 'edit',
        draft: ed.draft.slice(0, start) + refText(t.pos, t.pos),
      });
      if (ed.source === 'bar') requestAnimationFrame(() => barRef.current?.focus());
      else focusSink();
      return;
    }
    if (ed) commit();
    if (t.kind === 'all') {
      setSel({ anchor: { row: 0, col: 0 }, focus: { row: rows - 1, col: cols - 1 } });
    } else if (t.kind === 'cell') {
      if (extend) setSel({ anchor, focus: clampPos(t.pos) });
      else select(t.pos);
    } else if (t.kind === 'row') {
      const a = extend ? { row: anchor.row, col: 0 } : { row: t.row, col: 0 };
      setSel({ anchor: a, focus: { row: t.row, col: cols - 1 } });
    } else {
      const a = extend ? { row: 0, col: anchor.col } : { row: 0, col: t.col };
      setSel({ anchor: a, focus: { row: rows - 1, col: t.col } });
    }
    focusSink();
  };
  const onDrag = (t: GridTarget) => {
    const ed = editingRef.current;
    const pick = refPick.current;
    if (ed && pick) {
      if (t.kind === 'cell') {
        updateEditing({
          ...ed,
          draft: ed.draft.slice(0, pick.start) + refText(pick.anchor, t.pos),
        });
      }
      return;
    }
    if (t.kind === 'all') return;
    const next =
      t.kind === 'cell'
        ? t.pos
        : t.kind === 'row'
          ? { row: t.row, col: cols - 1 }
          : { row: rows - 1, col: t.col };
    if (next.row !== rawSel.focus.row || next.col !== rawSel.focus.col) {
      setSel((s) => ({ ...s, focus: next }));
    }
  };
  const onContextMenu = (x: number, y: number, t: GridTarget) => {
    if (editingRef.current) commit();
    const inSel = (row: number, col: number) =>
      row >= range.r0 && row <= range.r1 && col >= range.c0 && col <= range.c1;
    if (t.kind === 'cell' && !inSel(t.pos.row, t.pos.col)) select(t.pos);
    else if (
      t.kind === 'row' &&
      !(t.row >= range.r0 && t.row <= range.r1 && range.c0 === 0 && range.c1 === cols - 1)
    ) {
      setSel({ anchor: { row: t.row, col: 0 }, focus: { row: t.row, col: cols - 1 } });
    } else if (
      t.kind === 'col' &&
      !(t.col >= range.c0 && t.col <= range.c1 && range.r0 === 0 && range.r1 === rows - 1)
    ) {
      setSel({ anchor: { row: 0, col: t.col }, focus: { row: rows - 1, col: t.col } });
    }
    setCtx({ x, y, target: t });
  };

  // ------------------------------------------------------------ 工作表

  const switchSheet = (id: string) => {
    const ed = editingRef.current;
    // 编辑公式时切表：继续编辑，之后点的格子带表名；否则先提交
    if (ed && !(ed.draft.startsWith('=') && (refPick.current || REF_TRIGGER.test(ed.draft)))) {
      commit();
    }
    setCurrentId(id);
    focusSink();
  };

  const addSheet = () => {
    if (!editable) return;
    const id = randomId('s');
    undo.track(id);
    wb.addSheet(origin, { id, at: sid ? sheetIds.indexOf(sid) + 1 : undefined });
    setCurrentId(id);
    focusSink();
  };

  // ------------------------------------------------------------ 导入导出 / AI

  const baseName = safeFileName(docMeta.title);
  const exportXlsx = async () => {
    try {
      const blob = await writeXlsx(readWorkbookData(wb), { creator: collab.me.name });
      downloadBlob(`${baseName}.xlsx`, blob);
    } catch {
      toast.error(tr('导出失败'), tr('生成 Excel 文件时出错了，稍后再试。'));
    }
  };
  const exportCsv = () => {
    if (!sheet) return;
    const text = sheetToCsv(sheet);
    if (!text) {
      toast({
        title: tr('这张表是空的'),
        description: tr('先填一些数据再导出。'),
        tone: 'warning',
      });
      return;
    }
    const suffix = sheetIds.length > 1 ? `-${safeFileName(sheet.name, '')}` : '';
    downloadText(`${baseName}${suffix}.csv`, text, 'text/csv;charset=utf-8');
  };
  const exportPdf = () => printHtml(buildPrintHtml(wb, docMeta.title));

  const importFile = async (file: File) => {
    const lower = file.name.toLowerCase();
    try {
      let ids: string[];
      let warnings: string[] = [];
      const base = file.name.replace(/\.[^.]+$/u, '');
      if (lower.endsWith('.xls')) {
        toast.error(tr('暂不支持旧版 .xls'), tr('在 Excel 里另存为 .xlsx 再导入。'));
        return;
      }
      if (/\.(csv|tsv|txt)$/u.test(lower)) {
        const data = csvToSheetData(decodeText(await file.arrayBuffer()), base);
        if (data.cells.length === 0) {
          toast({ title: tr('文件是空的'), tone: 'warning' });
          return;
        }
        ids = writeWorkbookData(doc, { sheets: [data] }, { mode: 'append', origin });
      } else {
        const res = await readXlsx(await file.arrayBuffer());
        warnings = res.warnings;
        ids = writeWorkbookData(doc, res.data, { mode: 'append', origin });
      }
      ids.forEach((id) => undo.track(id));
      if (ids[0]) setCurrentId(ids[0]);
      toast({
        title: tr('已导入 {count} 张工作表', { count: ids.length }),
        description: warnings.length ? warnings.join(tr('；')) : tr('作为新工作表加在了后面。'),
        tone: warnings.length ? 'warning' : 'success',
        action: { label: tr('撤销'), onClick: () => undo.undo() },
      });
    } catch (err) {
      toast.error(tr('导入失败'), err instanceof Error ? err.message : tr('没能读取这个文件。'));
    }
  };

  const insertAiGrid = (grid: string[][], at: 'origin' | 'active') => {
    if (!sid) return;
    const pos = at === 'origin' ? { row: 0, col: 0 } : anchor;
    const writes: CellWrite[] = [];
    grid.forEach((line, dr) =>
      line.forEach((value, dc) =>
        writes.push({ row: pos.row + dr, col: pos.col + dc, raw: value.trim() }),
      ),
    );
    undo.stopCapturing();
    wb.setCells(sid, writes, origin);
    const width = grid.reduce((m, l) => Math.max(m, l.length), 1);
    setSel({ anchor: pos, focus: { row: pos.row + grid.length - 1, col: pos.col + width - 1 } });
    toast.success(tr('已写入 {count} 行 × {width} 列', { count: grid.length, width }));
  };

  const analyze = () => {
    if (!sheet) return;
    const label = rangeLabel(range);
    setAnalysis(label);
    const grid: string[][] = [];
    for (let r = range.r0; r <= range.r1; r += 1) {
      const line: string[] = [];
      for (let c = range.c0; c <= range.c1; c += 1) line.push(displayOf(sheet, r, c).text);
      grid.push(line);
    }
    void analysisAi.run({
      action: 'summarize',
      selection: toCsv(grid),
      prompt: tr(
        '这是表格选区 {label} 的 CSV 数据。请用中文分析：关键发现、趋势、异常值，给出 3–6 条要点。',
        { label },
      ),
    });
  };

  const insertChart = () => {
    if (!sheet) return;
    const r =
      range.r0 === range.r1 && range.c0 === range.c1
        ? sheet.currentRegion(anchor.row, anchor.col)
        : range;
    setChart({ range: r, kind: chart?.kind ?? 'bar' });
  };
  const chartGet = (r: number, c: number) => (sheet ? sheet.value(r, c) : null);

  // ------------------------------------------------------------ 名称框

  const goTo = (text: string) => {
    const m =
      /^(?:(?:'((?:[^']|'')+)'|([^!]+))!)?\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/u.exec(
        text.trim(),
      );
    if (!m) {
      toast({
        title: tr('地址不对'),
        description: tr('输入像 B3、A1:C10 或 Sheet2!A1 这样的地址。'),
        tone: 'warning',
      });
      return;
    }
    const sheetName = m[1]?.replace(/''/gu, "'") ?? m[2];
    let target = sid;
    if (sheetName) {
      const id = wb.sheetIdByName(sheetName);
      if (!id) {
        toast({ title: tr('找不到工作表：{sheetName}', { sheetName }), tone: 'warning' });
        return;
      }
      target = id;
    }
    if (!target) return;
    const a = { row: Number(m[4]) - 1, col: colIndex(m[3]!.toUpperCase()) };
    const f = m[5] ? { row: Number(m[6]) - 1, col: colIndex(m[5].toUpperCase()) } : a;
    setCurrentId(target);
    setSelBySheet((all) => ({ ...all, [target]: { anchor: a, focus: f } }));
    // 和 Excel 一样：回车后焦点马上回到格子。必须同步聚焦——只靠 requestAnimationFrame 的话，
    // 回车后紧接着敲的字会落进名称框，随后名称框失焦把它清掉，看起来就是「输入丢了」。
    sinkRef.current?.focus({ preventScroll: true });
    // 换表时网格会重渲染，下一帧再确认一次（期间焦点已被别处拿走就不抢）
    requestAnimationFrame(() => {
      const el = document.activeElement;
      if (el !== sinkRef.current && (el === null || el === document.body || el === nameRef.current))
        sinkRef.current?.focus({ preventScroll: true });
    });
  };

  const filterValues = filterUi && sheet ? columnValues(sheet, filterUi.col, version) : [];

  if (!sheet || !sid) {
    return (
      <div className="flex flex-1 items-center justify-center text-small text-fg-muted">
        {tr('正在载入表格…')}
      </div>
    );
  }

  const mk = isMac() ? '⌘' : 'Ctrl+';
  const single = range.r0 === range.r1 && range.c0 === range.c1;
  const rangeText = single ? toA1(anchor.row, anchor.col) : rangeLabel(range);
  const activeRaw = editText(
    sheet.raw(anchor.row, anchor.col) ?? '',
    sheet.value(anchor.row, anchor.col),
    sheet.numFmt(anchor.row, anchor.col),
  );
  const filter = sheet.filter();
  const filterColId = filterUi ? sheet.colIds()[filterUi.col] : undefined;
  const ctxKind = ctx?.target.kind;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-surface">
      <SheetToolbar
        editable={editable}
        mk={mk}
        style={activeStyle}
        merged={activeMerge}
        frozen={sheet.frozen()}
        filterOn={!!filter}
        canUndo={undo.canUndo}
        canRedo={undo.canRedo}
        onUndo={() => undo.undo()}
        onRedo={() => undo.redo()}
        onStyle={applyStyle}
        onNumFmt={(code) => applyStyle({ nf: code })}
        onDecimals={decimals}
        onBorders={setBorders}
        onMerge={toggleMerge}
        onFreeze={freeze}
        onSort={(asc) => sort(asc)}
        onToggleFilter={toggleFilter}
        onFind={() => setFind((f) => ({ ...f, open: true }))}
        onChart={insertChart}
        onImport={() => fileRef.current?.click()}
        onExportXlsx={() => void exportXlsx()}
        onExportCsv={exportCsv}
        onExportPdf={exportPdf}
        ai={
          <SheetAiButton
            ai={tableAi}
            editable={editable}
            activeLabel={toA1(anchor.row, anchor.col)}
            rangeLabel={rangeText}
            rangeCells={size.rows * size.cols}
            onInsert={insertAiGrid}
            onAnalyze={analyze}
          />
        }
      />
      <input
        ref={fileRef}
        type="file"
        aria-label={tr('导入 Excel 文件')}
        accept=".xlsx,.xlsm,.csv,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void importFile(f);
        }}
      />

      {/* 名称框 + 编辑栏 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-surface px-2 sm:px-3">
        <input
          ref={nameRef}
          aria-label={tr('名称框')}
          spellCheck={false}
          autoComplete="off"
          value={nameBox ?? rangeText}
          onFocus={(e) => {
            setNameBox(rangeText);
            const el = e.currentTarget;
            requestAnimationFrame(() => el.select());
          }}
          onChange={(e) => setNameBox(e.target.value)}
          onBlur={() => setNameBox(null)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              goTo(nameBox ?? '');
              setNameBox(null);
            } else if (e.key === 'Escape') {
              setNameBox(null);
              focusSink();
            }
          }}
          className="h-7 w-16 shrink-0 rounded-sm bg-transparent px-1.5 font-mono text-small text-fg-muted outline-none focus:bg-subtle focus:text-fg sm:w-24"
        />
        <span aria-hidden className="font-serif text-small text-fg-subtle italic">
          fx
        </span>
        <input
          ref={barRef}
          aria-label={tr('编辑栏')}
          spellCheck={false}
          autoComplete="off"
          readOnly={!editable}
          className="h-7 min-w-0 flex-1 rounded-sm bg-transparent px-1.5 font-mono text-small text-fg outline-none placeholder:text-fg-subtle focus:bg-subtle"
          placeholder={editable ? tr('输入数值、文本，或以 = 开头的公式（如 =SUM(A1:A5)）') : ''}
          value={(editing ? editing.draft : activeRaw).replace(/\n/gu, '↵')}
          onFocus={() => {
            const ed = editingRef.current;
            if (!ed && editable) updateEditing({ mode: 'edit', draft: activeRaw, source: 'bar' });
            else if (ed) updateEditing({ ...ed, mode: 'edit', source: 'bar' });
          }}
          onChange={(e) => {
            const ed = editingRef.current;
            refPick.current = null;
            if (ed) updateEditing({ ...ed, draft: e.target.value.replace(/↵/gu, '\n') });
          }}
          onBlur={() => {
            // 点格子插入引用时会短暂失焦：那种情况不提交
            requestAnimationFrame(() => {
              if (
                editingRef.current?.source === 'bar' &&
                document.activeElement !== barRef.current &&
                !refPick.current
              ) {
                commit();
              }
            });
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
              move(e.shiftKey ? -1 : 1, 0);
              focusSink();
            } else if (e.key === 'Tab') {
              e.preventDefault();
              commit();
              move(0, e.shiftKey ? -1 : 1);
              focusSink();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
        />
      </div>

      <AnimatePresence initial={false}>
        {chart && (
          <SheetChart
            key="chart"
            range={chart.range}
            get={chartGet}
            version={version}
            kind={chart.kind}
            onKindChange={(kind) => setChart({ ...chart, kind })}
            onClose={() => setChart(null)}
          />
        )}
      </AnimatePresence>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <SheetGrid
          sheet={sheet}
          version={version}
          active={anchor}
          focus={focus}
          range={range}
          editing={editing}
          editable={editable}
          peers={peerSel}
          clipRange={clip && clip.sheetId === sid ? clip.range : null}
          found={find.open && currentMatch?.sheetId === sid ? currentMatch : null}
          sinkRef={sinkRef}
          onSinkKeyDown={onSinkKeyDown}
          onSinkChange={onSinkChange}
          onSinkCompositionStart={() => {
            if (editable && !editingRef.current) {
              updateEditing({ mode: 'enter', draft: '', source: 'cell' });
            }
          }}
          onSinkBlur={() => {
            requestAnimationFrame(() => {
              if (
                editingRef.current?.source === 'cell' &&
                document.activeElement !== sinkRef.current &&
                !refPick.current
              ) {
                commit();
              }
            });
          }}
          onCopy={(e) => {
            if (editingRef.current) return;
            e.preventDefault();
            copySelection(e, false);
          }}
          onCut={(e) => {
            if (editingRef.current) return;
            e.preventDefault();
            copySelection(e, editable);
          }}
          onPaste={onPaste}
          onPick={onPick}
          onDrag={onDrag}
          onEditCell={(pos) => startEdit(pos)}
          onContextMenu={onContextMenu}
          onColWidth={(col, width) => {
            const whole =
              range.r0 === 0 && range.r1 === rows - 1 && col >= range.c0 && col <= range.c1;
            wb.setColWidth(sid, whole ? span(range.c0, range.c1) : [col], width, origin);
          }}
          onRowHeight={(row, height) => {
            const whole =
              range.c0 === 0 && range.c1 === cols - 1 && row >= range.r0 && row <= range.r1;
            wb.setRowHeight(sid, whole ? span(range.r0, range.r1) : [row], height, origin);
          }}
          onAutoFit={autoFit}
          onFill={(target) => {
            if (!editable) return;
            undo.stopCapturing();
            wb.setCells(sid, planFill(sheet, range, target), origin);
            setSel({
              anchor: { row: target.r0, col: target.c0 },
              focus: { row: target.r1, col: target.c1 },
            });
            focusSink();
          }}
          onFilterButton={(col, rect) => setFilterUi({ col, rect })}
        />

        <AnimatePresence>
          {find.open && (
            <FindPanel
              key="find"
              opts={findOpts}
              onChange={(o) => {
                setFindOpts(o);
                setFind((f) => ({ ...f, index: 0 }));
              }}
              showReplace={find.replace}
              onToggleReplace={() => setFind((f) => ({ ...f, replace: !f.replace }))}
              editable={editable}
              index={matchIndex}
              total={matches.length}
              onNext={() => goMatch(matchIndex + 1)}
              onPrev={() => goMatch(matchIndex - 1)}
              onReplace={replaceOne}
              onReplaceAll={replaceAll}
              onClose={() => {
                setFind((f) => ({ ...f, open: false }));
                focusSink();
              }}
            />
          )}
          {analysis && (
            <SheetAnalysisCard
              key="analysis"
              ai={analysisAi}
              label={analysis}
              onClose={() => {
                analysisAi.stop();
                analysisAi.reset();
                setAnalysis(null);
              }}
            />
          )}
        </AnimatePresence>
      </div>

      <SheetTabs
        tabs={tabs}
        current={sid}
        editable={editable}
        onSelect={switchSheet}
        onAdd={addSheet}
        onRename={(id, name) => wb.renameSheet(id, name, origin)}
        onDelete={(id) => {
          undo.stopCapturing();
          if (wb.deleteSheet(id, origin)) {
            toast({
              title: tr('已删除工作表'),
              tone: 'info',
              action: { label: tr('撤销'), onClick: () => undo.undo() },
            });
          }
        }}
        onDuplicate={(id) => {
          const nid = wb.duplicateSheet(id, origin);
          undo.track(nid);
          setCurrentId(nid);
        }}
        onMove={(id, to) => wb.moveSheet(id, to, origin)}
        onHide={(id, hidden) => {
          if (!wb.setSheetHidden(id, hidden, origin)) {
            toast({ title: tr('至少要保留一张可见的工作表'), tone: 'warning' });
          }
        }}
      />

      {filterUi && filter && (
        <FilterPopover
          key={`${sid}:${filterUi.col}`}
          anchor={filterUi.rect}
          title={sheet.raw(sheet.filterArea()?.r0 ?? 0, filterUi.col) ?? ''}
          values={filterValues}
          allowed={filterColId ? (filter.criteria[filterColId] ?? null) : null}
          onApply={(allowed) => {
            wb.setFilterCriteria(sid, filterUi.col, allowed, origin);
            setFilterUi(null);
            focusSink();
          }}
          onSort={(asc) => {
            sort(asc, filterUi.col);
            setFilterUi(null);
          }}
          onClose={() => setFilterUi(null)}
        />
      )}

      {/* 右键菜单：锚在鼠标位置的 1px 元素上 */}
      <Menu
        label={tr('单元格操作')}
        open={ctx !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCtx(null);
            focusSink();
          }
        }}
        trigger={
          <span
            aria-hidden
            className="pointer-events-none fixed size-px"
            style={{ left: ctx?.x ?? -10, top: ctx?.y ?? -10 }}
          />
        }
      >
        <MenuLabel>{rangeText}</MenuLabel>
        {editable && (
          <>
            {ctxKind !== 'col' && (
              <>
                <MenuItem
                  icon={<ArrowUpToLine strokeWidth={1.75} />}
                  onSelect={() => insertRows('above')}
                >
                  {tr('在上方插入 {rows} 行', { rows: size.rows })}
                </MenuItem>
                <MenuItem
                  icon={<ArrowDownToLine strokeWidth={1.75} />}
                  onSelect={() => insertRows('below')}
                >
                  {tr('在下方插入 {rows} 行', { rows: size.rows })}
                </MenuItem>
              </>
            )}
            {ctxKind !== 'row' && (
              <>
                <MenuItem
                  icon={<ArrowLeftToLine strokeWidth={1.75} />}
                  onSelect={() => insertCols('left')}
                >
                  {tr('在左侧插入 {cols} 列', { cols: size.cols })}
                </MenuItem>
                <MenuItem
                  icon={<ArrowRightToLine strokeWidth={1.75} />}
                  onSelect={() => insertCols('right')}
                >
                  {tr('在右侧插入 {cols} 列', { cols: size.cols })}
                </MenuItem>
              </>
            )}
            <MenuSeparator />
            {ctxKind !== 'col' && (
              <MenuItem icon={<Trash2 strokeWidth={1.75} />} danger onSelect={deleteRows}>
                {tr('删除行')}
              </MenuItem>
            )}
            {ctxKind !== 'row' && (
              <MenuItem icon={<Trash2 strokeWidth={1.75} />} danger onSelect={deleteCols}>
                {tr('删除列')}
              </MenuItem>
            )}
            <MenuSeparator />
            {ctxKind === 'row' && (
              <>
                <MenuItem
                  icon={<EyeOff strokeWidth={1.75} />}
                  onSelect={() => hideAxis('row', true)}
                >
                  {tr('隐藏行')}
                </MenuItem>
                <MenuItem icon={<Eye strokeWidth={1.75} />} onSelect={() => hideAxis('row', false)}>
                  {tr('取消隐藏行')}
                </MenuItem>
                <MenuItem
                  onSelect={() => wb.setRowHeight(sid, span(range.r0, range.r1), null, origin)}
                >
                  {tr('恢复默认行高')}
                </MenuItem>
              </>
            )}
            {ctxKind === 'col' && (
              <>
                <MenuItem
                  icon={<EyeOff strokeWidth={1.75} />}
                  onSelect={() => hideAxis('col', true)}
                >
                  {tr('隐藏列')}
                </MenuItem>
                <MenuItem icon={<Eye strokeWidth={1.75} />} onSelect={() => hideAxis('col', false)}>
                  {tr('取消隐藏列')}
                </MenuItem>
                <MenuItem onSelect={() => autoFit(range.c0)}>{tr('自适应列宽')}</MenuItem>
              </>
            )}
            {ctxKind === 'cell' && (
              <>
                <MenuItem icon={<Merge strokeWidth={1.75} />} onSelect={toggleMerge}>
                  {activeMerge ? tr('取消合并') : tr('合并单元格')}
                </MenuItem>
                <MenuItem icon={<ArrowDownAZ strokeWidth={1.75} />} onSelect={() => sort(true)}>
                  {tr('升序排列')}
                </MenuItem>
                <MenuItem icon={<ArrowUpAZ strokeWidth={1.75} />} onSelect={() => sort(false)}>
                  {tr('降序排列')}
                </MenuItem>
              </>
            )}
            <MenuSeparator />
            <MenuItem
              icon={<Eraser strokeWidth={1.75} />}
              shortcut="Del"
              onSelect={() => clear('contents')}
            >
              {tr('清除内容')}
            </MenuItem>
            <MenuItem icon={<Paintbrush strokeWidth={1.75} />} onSelect={() => clear('formats')}>
              {tr('清除格式')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Plus strokeWidth={1.75} />} onSelect={() => growSheet('row')}>
              {tr('在末尾添加 100 行')}
            </MenuItem>
            <MenuItem icon={<Plus strokeWidth={1.75} />} onSelect={() => growSheet('col')}>
              {tr('在末尾添加 10 列')}
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        <MenuItem icon={<BarChart3 strokeWidth={1.75} />} onSelect={insertChart}>
          {tr('用选区插入图表')}
        </MenuItem>
      </Menu>
    </div>
  );
}

const ARROWS: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

type Match = { sheetId: string; row: number; col: number };

/** 查找：原始输入或显示文字匹配；version 让内容变化时重新计算 */
function findMatches(
  wb: Workbook,
  sid: string | null,
  opts: FindOptions,
  version: number,
): Match[] {
  void version;
  const out: Match[] = [];
  if (!opts.find) return out;
  const fold = (s: string) => (opts.matchCase ? s : s.toLowerCase());
  const needle = fold(opts.find);
  const test = (s: string) => (opts.wholeCell ? fold(s) === needle : fold(s).includes(needle));
  const ids = opts.allSheets ? wb.sheetIds() : sid ? [sid] : [];
  for (const id of ids) {
    const s = wb.sheet(id);
    const found: CellPos[] = [];
    s.t.cells.forEach((raw, key) => {
      const p = s.pos(key);
      if (!p || s.rowHidden(p.row) || s.colHidden(p.col)) return;
      if (test(raw) || test(displayOf(s, p.row, p.col).text)) found.push(p);
    });
    found.sort((a, b) => a.row - b.row || a.col - b.col);
    for (const p of found) out.push({ sheetId: id, ...p });
  }
  return out;
}

/** 筛选面板：筛选区域里某一列（表头以下、未手动隐藏的行）的显示值与次数 */
function columnValues(sheet: SheetModel, col: number, version: number) {
  void version;
  const area = sheet.filterArea();
  if (!area) return [];
  const counts = new Map<string, number>();
  for (let r = area.r0 + 1; r <= area.r1; r += 1) {
    if (sheet.rowProps(r)?.hidden) continue;
    const text = displayOf(sheet, r, col).text;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => compareValues(a.text, b.text));
}

function legacyPos(key: string): CellPos | null {
  const m = /^(\d+):(\d+)$/u.exec(key);
  return m ? { row: Number(m[1]), col: Number(m[2]) } : null;
}
