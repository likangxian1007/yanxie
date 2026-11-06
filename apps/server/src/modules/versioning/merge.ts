import * as Y from 'yjs';
import {
  diffSeq,
  parseCellRef,
  type DocumentKind,
  type ProposalHunk,
  type ProposalTargetKind,
} from '@srh/shared';
import { footnotesOf, markdownToPm } from '../documents/markdown';
import { pmBlocksToY } from '../documents/doc-edit';
import { docJson } from '../documents/ydoc';
import { sheetForEdit, writeCells } from '../documents/sheet-model';
import { cellsOf, findCell, makeCell } from '../notebooks/nbformat';
import { docBlocks, latexSource, notebookCells, sheetSnapshots } from './content';

/**
 * 改动提案的三方合入：base（提出时的正文）→ draft（agent 的草稿）是一组改动块；
 * 合入时把选中的改动块按位置搬到正文的当前状态（current）上。
 * 正文在某一处被人改过、改动块对不上时算冲突，这一块不动。
 *
 * 富文本按顶层块（段落、标题、列表、表格…），LaTeX 按行，表格按单元格，notebook 按单元格 id。
 */

export interface ProposalTarget {
  kind: ProposalTargetKind;
  docKind: DocumentKind | null;
}

export type ProposalFormat = 'blocks' | 'lines' | 'cells' | 'notebook';

export function proposalFormat(t: ProposalTarget): ProposalFormat | null {
  if (t.kind === 'notebook') return 'notebook';
  switch (t.docKind) {
    case 'doc':
      return 'blocks';
    case 'latex':
      return 'lines';
    case 'sheet':
      return 'cells';
    default:
      return null; // 幻灯片：agent 直接写入（见 API.md §2.18.2 边界）
  }
}

// ---------------------------------------------------------------- 序列（块 / 行）

/** 富文本的非空顶层块：文字 + 在 fragment 里的下标 */
export function nonEmptyBlocks(doc: Y.Doc): { text: string; index: number }[] {
  return docBlocks(doc)
    .map((text, index) => ({ text, index }))
    .filter((b) => b.text.trim() !== '');
}

export function latexLines(doc: Y.Doc): string[] {
  return latexSource(doc).split('\n');
}

export function sequenceOf(doc: Y.Doc, format: 'blocks' | 'lines'): string[] {
  return format === 'blocks' ? nonEmptyBlocks(doc).map((b) => b.text) : latexLines(doc);
}

/** base 下标 → current 下标（只有 base 里没变的元素有对应，其余 -1） */
function mapSeq(base: string[], cur: string[]): number[] {
  const map = new Array<number>(base.length).fill(-1);
  let i = 0;
  let j = 0;
  for (const op of diffSeq(base, cur)) {
    if (op.kind === 'same') {
      map[i] = j;
      i += 1;
      j += 1;
    } else if (op.kind === 'del') i += 1;
    else j += 1;
  }
  return map;
}

type TextHunk = Extract<ProposalHunk, { kind: 'text' }>;

interface SeqPlacement {
  hunk: TextHunk;
  /** 在 current 里替换 [start, end) */
  start: number;
  end: number;
  /** current 里这一处已经是提案的内容 */
  already: boolean;
}

function eqSlice(cur: string[], start: number, items: string[]): boolean {
  if (start < 0 || start + items.length > cur.length) return false;
  return items.every((s, k) => cur[start + k] === s);
}

/** 在 cur 里唯一出现的连续子序列的起点；没有或不唯一返回 -1 */
function uniqueIndexOf(cur: string[], items: string[]): number {
  if (!items.length) return -1;
  let found = -1;
  for (let s = 0; s + items.length <= cur.length; s += 1) {
    if (eqSlice(cur, s, items)) {
      if (found >= 0) return -1;
      found = s;
    }
  }
  return found;
}

function placeSeqHunk(
  h: TextHunk,
  base: string[],
  cur: string[],
  map: number[],
): SeqPlacement | null {
  if (h.old.length > 0) {
    const first = map[h.at] ?? -1;
    let ok = first >= 0;
    for (let k = 1; ok && k < h.old.length; k += 1) {
      if (map[h.at + k] !== first + k) ok = false;
    }
    if (ok) return { hunk: h, start: first, end: first + h.old.length, already: false };
    // 位置对不上：正文里原样找得到（而且只有一处）也行
    const s = uniqueIndexOf(cur, h.old);
    if (s >= 0) return { hunk: h, start: s, end: s + h.old.length, already: false };
    // 正文里已经是提案的内容（别人手动改成了一样的）
    const n = uniqueIndexOf(cur, h.new);
    if (n >= 0 && h.new.length) return { hunk: h, start: n, end: n + h.new.length, already: true };
    return null;
  }
  // 纯插入：插在前一个没变的元素后面；前面没有元素时插在后一个没变的元素前面
  let pos = -1;
  if (h.at === 0) pos = base.length === 0 || (map[0] ?? -1) >= 0 ? 0 : -1;
  else if ((map[h.at - 1] ?? -1) >= 0) pos = map[h.at - 1]! + 1;
  if (pos < 0 && h.at < base.length && (map[h.at] ?? -1) >= 0) pos = map[h.at]!;
  if (pos < 0) return null;
  if (eqSlice(cur, pos, h.new))
    return { hunk: h, start: pos, end: pos + h.new.length, already: true };
  return { hunk: h, start: pos, end: pos, already: false };
}

// ---------------------------------------------------------------- 计划与应用

export interface MergePlan {
  /** 能合入的改动块 id */
  ok: string[];
  /** 正文已经和提案一致的（算合入，什么也不写） */
  already: string[];
  conflicted: string[];
}

export interface PlanContext {
  target: ProposalTarget;
  baseState: Uint8Array;
}

function baseDocOf(state: Uint8Array): Y.Doc {
  const d = new Y.Doc();
  if (state.length) Y.applyUpdate(d, state);
  return d;
}

function seqPlacements(
  ctx: PlanContext,
  format: 'blocks' | 'lines',
  current: Y.Doc,
  hunks: TextHunk[],
): { placed: SeqPlacement[]; conflicted: string[] } {
  const baseDoc = baseDocOf(ctx.baseState);
  const base = sequenceOf(baseDoc, format);
  baseDoc.destroy();
  const cur = sequenceOf(current, format);
  const map = mapSeq(base, cur);
  const placed: SeqPlacement[] = [];
  const conflicted: string[] = [];
  for (const h of hunks) {
    const p = placeSeqHunk(h, base, cur, map);
    if (!p) conflicted.push(h.id);
    else if (placed.some((q) => !q.already && !p.already && p.start < q.end && q.start < p.end)) {
      conflicted.push(h.id); // 两块落到了同一处
    } else placed.push(p);
  }
  return { placed, conflicted };
}

type CellHunk = Extract<ProposalHunk, { kind: 'cell' }>;
type NbHunk = Extract<ProposalHunk, { kind: 'nb_cell' }>;

function cellState(current: Y.Doc, h: CellHunk): 'ok' | 'already' | 'conflict' {
  const snaps = sheetSnapshots(current);
  const sheet = snaps.find((s) => s.name === h.sheet);
  const value = sheet ? (sheet.cells[h.ref] ?? '') : '';
  if (value === h.new) return 'already';
  if (!sheet && h.old !== '') return 'conflict';
  return value === h.old ? 'ok' : 'conflict';
}

function nbState(current: Y.Doc, h: NbHunk): 'ok' | 'already' | 'conflict' {
  const cells = notebookCells(current);
  const c = cells.find((x) => x.id === h.cellId);
  if (h.op === 'add') {
    if (c) return c.source === h.new ? 'already' : 'conflict';
    return 'ok';
  }
  if (h.op === 'remove') {
    if (!c) return 'already';
    return c.source === h.old ? 'ok' : 'conflict';
  }
  if (!c) return 'conflict';
  if (c.source === h.new) return 'already';
  return c.source === h.old ? 'ok' : 'conflict';
}

/** 只算计划（不改 current）：哪些改动块能合入、哪些冲突 */
export function planMerge(ctx: PlanContext, current: Y.Doc, hunks: ProposalHunk[]): MergePlan {
  const plan: MergePlan = { ok: [], already: [], conflicted: [] };
  const format = proposalFormat(ctx.target);
  if (format === 'blocks' || format === 'lines') {
    const text = hunks.filter((h): h is TextHunk => h.kind === 'text');
    const { placed, conflicted } = seqPlacements(ctx, format, current, text);
    for (const p of placed) (p.already ? plan.already : plan.ok).push(p.hunk.id);
    plan.conflicted.push(...conflicted);
    return plan;
  }
  if (format === 'cells') {
    // sheetSnapshots 会就地迁移旧结构：在副本上算
    const copy = baseDocOf(Y.encodeStateAsUpdate(current));
    for (const h of hunks) {
      if (h.kind !== 'cell') continue;
      const s = cellState(copy, h);
      (s === 'ok' ? plan.ok : s === 'already' ? plan.already : plan.conflicted).push(h.id);
    }
    copy.destroy();
    return plan;
  }
  if (format === 'notebook') {
    for (const h of hunks) {
      if (h.kind !== 'nb_cell') continue;
      const s = nbState(current, h);
      (s === 'ok' ? plan.ok : s === 'already' ? plan.already : plan.conflicted).push(h.id);
    }
  }
  return plan;
}

function replaceYText(text: Y.Text, next: string) {
  const prev = text.toString();
  if (prev === next) return;
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start += 1;
  let endP = prev.length;
  let endN = next.length;
  while (endP > start && endN > start && prev[endP - 1] === next[endN - 1]) {
    endP -= 1;
    endN -= 1;
  }
  if (endP > start) text.delete(start, endP - start);
  if (endN > start) text.insert(start, next.slice(start, endN));
}

/**
 * 把 hunks（调用方已筛好：只含要合入的）应用到 current（在调用方的事务里）。
 * 返回实际合入（含「已经一致」）与冲突的 id。
 */
export function applyMerge(
  ctx: PlanContext,
  current: Y.Doc,
  hunks: ProposalHunk[],
): { applied: string[]; conflicted: string[] } {
  const format = proposalFormat(ctx.target);
  const applied: string[] = [];
  const conflicted: string[] = [];
  if (format === 'blocks' || format === 'lines') {
    const text = hunks.filter((h): h is TextHunk => h.kind === 'text');
    const { placed, conflicted: c } = seqPlacements(ctx, format, current, text);
    conflicted.push(...c);
    // 从后往前改，前面的位置不变
    const todo = placed
      .filter((p) => !p.already)
      .sort((a, b) => b.start - a.start || b.end - a.end);
    if (format === 'lines') {
      const lines = latexLines(current);
      for (const p of todo) lines.splice(p.start, p.end - p.start, ...p.hunk.new);
      replaceYText(current.getText('source'), lines.join('\n'));
    } else {
      const frag = current.getXmlFragment('default');
      const blocks = nonEmptyBlocks(current);
      const notes = footnotesOf(docJson(current));
      for (const p of todo) {
        const nodes = p.hunk.new.length
          ? pmBlocksToY(markdownToPm(p.hunk.new.join('\n\n'), notes).content ?? [])
          : [];
        if (p.end > p.start) {
          const from = blocks[p.start]!.index;
          const to = blocks[p.end - 1]!.index;
          frag.delete(from, to - from + 1);
          if (nodes.length) frag.insert(from, nodes);
        } else {
          const at = p.start === 0 ? 0 : blocks[p.start - 1]!.index + 1;
          if (nodes.length) frag.insert(at, nodes);
        }
      }
    }
    applied.push(...placed.map((p) => p.hunk.id));
    return { applied, conflicted };
  }
  if (format === 'cells') {
    for (const h of hunks) {
      if (h.kind !== 'cell') continue;
      const s = cellState(current, h);
      if (s === 'conflict') {
        conflicted.push(h.id);
        continue;
      }
      if (s === 'ok') {
        const pos = parseCellRef(h.ref);
        if (!pos) {
          conflicted.push(h.id);
          continue;
        }
        const sheet = sheetForEdit(current, h.sheet, true);
        writeCells(current, sheet, [{ r: pos.row, c: pos.col, value: h.new }]);
      }
      applied.push(h.id);
    }
    return { applied, conflicted };
  }
  if (format === 'notebook') {
    const arr = cellsOf(current);
    // 先删改、后新增：新增按草稿顺序插在前一个单元格后面
    for (const h of hunks) {
      if (h.kind !== 'nb_cell' || h.op === 'add') continue;
      const s = nbState(current, h);
      if (s === 'conflict') {
        conflicted.push(h.id);
        continue;
      }
      if (s === 'ok') {
        const f = findCell(current, h.cellId)!;
        if (h.op === 'remove') arr.delete(f.index, 1);
        else {
          const src = f.cell.get('source');
          if (src instanceof Y.Text) replaceYText(src, h.new);
          else f.cell.set('source', new Y.Text(h.new));
          if (f.cell.get('type') !== h.cellType) f.cell.set('type', h.cellType);
        }
      }
      applied.push(h.id);
    }
    for (const h of hunks) {
      if (h.kind !== 'nb_cell' || h.op !== 'add') continue;
      const s = nbState(current, h);
      if (s === 'conflict') {
        conflicted.push(h.id);
        continue;
      }
      if (s === 'ok') {
        let at = 0;
        if (h.afterCellId) {
          const f = findCell(current, h.afterCellId);
          at = f ? f.index + 1 : arr.length;
        }
        arr.insert(at, [
          makeCell({
            id: h.cellId,
            type: h.cellType === 'markdown' || h.cellType === 'raw' ? h.cellType : 'code',
            source: h.new,
          }),
        ]);
      }
      applied.push(h.id);
    }
    if (arr.length === 0) arr.insert(0, [makeCell({ type: 'code' })]);
  }
  return { applied, conflicted };
}
