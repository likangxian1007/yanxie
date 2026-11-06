import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import type { KernelStatus, NbOutput, NotebookCellType, NotebookRun } from '@srh/shared';

/**
 * Notebook 的 Y.Doc 读写（布局见 packages/shared/src/notebooks.ts）：
 *   cells: Y.Array<Y.Map>  { id, type, source: Y.Text, outputs: Y.Array, execution_count, metadata: Y.Map }
 *   runs:  Y.Map<cellId → NotebookRun>    kernel: Y.Map    meta: Y.Map
 * 客户端负责结构编辑（增删、移动、改类型、清空输出、折叠）；输出和执行计数由服务端写。
 */

export interface CellView {
  id: string;
  type: NotebookCellType;
  map: Y.Map<unknown>;
  text: Y.Text;
  source: string;
  outputs: NbOutput[];
  executionCount: number | null;
  /** 输出折叠（nbformat metadata.collapsed） */
  outputsHidden: boolean;
  /** 代码折叠（jupyter.source_hidden） */
  sourceHidden: boolean;
}

export interface KernelView {
  status: KernelStatus;
  executionCount: number;
  error: string | null;
}

export interface NotebookView {
  cells: CellView[];
  runs: Record<string, NotebookRun>;
  kernel: KernelView;
}

export const cellsOf = (doc: Y.Doc) => doc.getArray<Y.Map<unknown>>('cells');

function readMeta(m: Y.Map<unknown>, key: string): unknown {
  const meta = m.get('metadata');
  return meta instanceof Y.Map ? meta.get(key) : undefined;
}

function viewCell(m: Y.Map<unknown>): CellView {
  let text = m.get('source');
  if (!(text instanceof Y.Text)) text = new Y.Text(String(text ?? ''));
  const outs = m.get('outputs');
  const jupyter = readMeta(m, 'jupyter') as { source_hidden?: boolean } | undefined;
  return {
    id: String(m.get('id') ?? ''),
    type: (m.get('type') as NotebookCellType) ?? 'code',
    map: m,
    text: text as Y.Text,
    source: (text as Y.Text).toString(),
    outputs: outs instanceof Y.Array ? (outs.toArray() as NbOutput[]) : [],
    executionCount: (m.get('execution_count') as number | null | undefined) ?? null,
    outputsHidden: readMeta(m, 'collapsed') === true,
    sourceHidden: Boolean(jupyter?.source_hidden),
  };
}

export function readView(doc: Y.Doc): NotebookView {
  const k = doc.getMap<unknown>('kernel');
  return {
    cells: cellsOf(doc).toArray().map(viewCell),
    runs: doc.getMap<NotebookRun>('runs').toJSON() as Record<string, NotebookRun>,
    kernel: {
      status: (k.get('status') as KernelStatus | undefined) ?? 'none',
      executionCount: (k.get('executionCount') as number | undefined) ?? 0,
      error: (k.get('error') as string | null | undefined) ?? null,
    },
  };
}

/**
 * 本地的结构修改（增删单元格、改类型、折叠…）要立即进视图：
 * 命令模式连按 B、M、D D 时，下一个键必须看到上一个键的结果，否则会落到旧的 / 第一个单元格上。
 * 文字输入（Y.Text）和远端修改仍然一帧合并一次。
 */
export function isLocalStructural(events: Y.YEvent<Y.AbstractType<unknown>>[], txn: Y.Transaction) {
  return txn.local && events.some((e) => !(e.target instanceof Y.Text));
}

/** 订阅整本 notebook（文字输入只在 source 变化时重算，一帧合并一次） */
export function useNotebookView(doc: Y.Doc | null): NotebookView | null {
  const [view, setView] = useState<NotebookView | null>(() => (doc ? readView(doc) : null));
  useEffect(() => {
    if (!doc) return;
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setView(readView(doc));
      });
    };
    const onCells = (events: Y.YEvent<Y.AbstractType<unknown>>[], txn: Y.Transaction) => {
      if (!isLocalStructural(events, txn)) return update();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      setView(readView(doc));
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 首次同步
    setView(readView(doc));
    const cells = cellsOf(doc);
    const runs = doc.getMap('runs');
    const kernel = doc.getMap('kernel');
    cells.observeDeep(onCells);
    runs.observe(update);
    kernel.observe(update);
    return () => {
      cancelAnimationFrame(frame);
      cells.unobserveDeep(onCells);
      runs.unobserve(update);
      kernel.unobserve(update);
    };
  }, [doc]);
  return view;
}

// ---------------------------------------------------------------- 结构编辑

export function newCellId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface PlainCell {
  id: string;
  type: NotebookCellType;
  source: string;
  outputs: NbOutput[];
  executionCount: number | null;
  metadata: Record<string, unknown>;
}

function makeCell(c: Partial<PlainCell> & { type: NotebookCellType }): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set('id', c.id ?? newCellId());
  m.set('type', c.type);
  m.set('source', new Y.Text(c.source ?? ''));
  const outs = new Y.Array<unknown>();
  if (c.type === 'code' && c.outputs?.length) outs.push(c.outputs);
  m.set('outputs', outs);
  m.set('execution_count', c.type === 'code' ? (c.executionCount ?? null) : null);
  const meta = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(c.metadata ?? {})) meta.set(k, v);
  m.set('metadata', meta);
  return m;
}

export function plainOf(cell: CellView): PlainCell {
  const meta = cell.map.get('metadata');
  return {
    id: cell.id,
    type: cell.type,
    source: cell.text.toString(),
    outputs: cell.outputs,
    executionCount: cell.executionCount,
    metadata: meta instanceof Y.Map ? (meta.toJSON() as Record<string, unknown>) : {},
  };
}

function indexOf(doc: Y.Doc, id: string): number {
  const arr = cellsOf(doc);
  for (let i = 0; i < arr.length; i++) if (arr.get(i).get('id') === id) return i;
  return -1;
}

/** 在 index 处插入新单元格，返回 id */
export function insertCell(
  doc: Y.Doc,
  index: number,
  type: NotebookCellType = 'code',
  source = '',
): string {
  const m = makeCell({ type, source });
  const arr = cellsOf(doc);
  arr.insert(Math.max(0, Math.min(index, arr.length)), [m]);
  return String(m.get('id'));
}

/** 粘贴 / 撤销删除：插入一组单元格（重复 id 换新的） */
export function insertPlainCells(doc: Y.Doc, index: number, cells: PlainCell[]): string[] {
  const existing = new Set(
    cellsOf(doc)
      .toArray()
      .map((m) => String(m.get('id'))),
  );
  const maps = cells.map((c) => makeCell({ ...c, id: existing.has(c.id) ? newCellId() : c.id }));
  doc.transact(() => cellsOf(doc).insert(Math.max(0, index), maps));
  return maps.map((m) => String(m.get('id')));
}

export function deleteCells(doc: Y.Doc, ids: string[]) {
  doc.transact(() => {
    for (const id of ids) {
      const i = indexOf(doc, id);
      if (i >= 0) cellsOf(doc).delete(i, 1);
    }
    // 永远至少留一个单元格（Jupyter 也是）
    if (cellsOf(doc).length === 0) cellsOf(doc).insert(0, [makeCell({ type: 'code' })]);
  });
}

/** 上下移动：Y.Array 没有 move，删掉再插入一个内容相同的新 Map（id 不变） */
export function moveCell(doc: Y.Doc, id: string, delta: -1 | 1): boolean {
  const arr = cellsOf(doc);
  const i = indexOf(doc, id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= arr.length) return false;
  doc.transact(() => {
    const plain = plainOf(viewCell(arr.get(i)));
    arr.delete(i, 1);
    arr.insert(j, [makeCell(plain)]);
  });
  return true;
}

export function setCellType(doc: Y.Doc, id: string, type: NotebookCellType) {
  const i = indexOf(doc, id);
  if (i < 0) return;
  const m = cellsOf(doc).get(i);
  if (m.get('type') === type) return;
  doc.transact(() => {
    m.set('type', type);
    const outs = m.get('outputs');
    if (outs instanceof Y.Array && outs.length) outs.delete(0, outs.length);
    m.set('execution_count', null);
  });
}

export function clearOutputs(doc: Y.Doc, ids?: string[]) {
  const want = ids ? new Set(ids) : null;
  doc.transact(() => {
    for (const m of cellsOf(doc).toArray()) {
      if (want && !want.has(String(m.get('id')))) continue;
      const outs = m.get('outputs');
      if (outs instanceof Y.Array && outs.length) outs.delete(0, outs.length);
      if (m.get('type') === 'code' && m.get('execution_count') !== null)
        m.set('execution_count', null);
    }
  });
}

function metaOf(m: Y.Map<unknown>): Y.Map<unknown> {
  let meta = m.get('metadata');
  if (!(meta instanceof Y.Map)) {
    meta = new Y.Map<unknown>();
    m.set('metadata', meta);
  }
  return meta as Y.Map<unknown>;
}

export function toggleOutputs(doc: Y.Doc, id: string, hidden?: boolean) {
  const i = indexOf(doc, id);
  if (i < 0) return;
  const meta = metaOf(cellsOf(doc).get(i));
  meta.set('collapsed', hidden ?? meta.get('collapsed') !== true);
}

export function toggleSource(doc: Y.Doc, id: string, hidden?: boolean) {
  const i = indexOf(doc, id);
  if (i < 0) return;
  const meta = metaOf(cellsOf(doc).get(i));
  const j = (meta.get('jupyter') as Record<string, unknown> | undefined) ?? {};
  meta.set('jupyter', { ...j, source_hidden: hidden ?? !j.source_hidden });
}

/** 把一个单元格在光标处拆成两个（Ctrl+Shift+-） */
export function splitCell(doc: Y.Doc, id: string, at: number): string | null {
  const i = indexOf(doc, id);
  if (i < 0) return null;
  const m = cellsOf(doc).get(i);
  const text = m.get('source') as Y.Text;
  const tail = text.toString().slice(at);
  let newId: string | null = null;
  doc.transact(() => {
    text.delete(at, text.length - at);
    newId = insertCell(
      doc,
      i + 1,
      (m.get('type') as NotebookCellType) ?? 'code',
      tail.replace(/^\n/, ''),
    );
  });
  return newId;
}

/** 合并选中的单元格（Shift+M）到第一个 */
export function mergeCells(doc: Y.Doc, ids: string[]) {
  if (ids.length < 2) return;
  const order = ids
    .map((id) => indexOf(doc, id))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  const arr = cellsOf(doc);
  const first = order[0];
  if (first === undefined) return;
  doc.transact(() => {
    const target = arr.get(first).get('source') as Y.Text;
    const extra = order
      .slice(1)
      .map((i) => (arr.get(i).get('source') as Y.Text).toString())
      .join('\n\n');
    target.insert(target.length, `\n\n${extra}`);
    for (const i of order.slice(1).reverse()) arr.delete(i, 1);
  });
}
