import { randomBytes } from 'node:crypto';
import * as Y from 'yjs';
import { ApiError, type NbOutput, type NotebookCellType } from '@srh/shared';

/**
 * Notebook 的 Y.Doc 布局（见 @srh/shared notebooks.ts）与 nbformat v4 的互转。
 * 普通对象形式 PlainNotebook 是两者之间的中间格式，导出、agent 工具、测试都用它。
 */
export interface PlainCell {
  id: string;
  type: NotebookCellType;
  source: string;
  outputs: NbOutput[];
  executionCount: number | null;
  metadata: Record<string, unknown>;
  /** markdown 单元格的附件（nbformat attachments） */
  attachments?: Record<string, unknown>;
}

export interface PlainNotebook {
  cells: PlainCell[];
  metadata: Record<string, unknown>;
}

export const DEFAULT_METADATA = {
  kernelspec: { name: 'python3', display_name: 'Python 3 (ipykernel)', language: 'python' },
  language_info: { name: 'python', file_extension: '.py', mimetype: 'text/x-python' },
};

export function newCellId(): string {
  return randomBytes(6).toString('hex');
}

// ---------------------------------------------------------------- Y.Doc

export function cellsOf(doc: Y.Doc): Y.Array<Y.Map<unknown>> {
  return doc.getArray<Y.Map<unknown>>('cells');
}

export function makeCell(cell: Partial<PlainCell> & { type: NotebookCellType }): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set('id', cell.id ?? newCellId());
  m.set('type', cell.type);
  m.set('source', new Y.Text(cell.source ?? ''));
  const outputs = new Y.Array<NbOutput>();
  if (cell.outputs?.length) outputs.push(cell.outputs);
  m.set('outputs', outputs);
  m.set('execution_count', cell.executionCount ?? null);
  const meta = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(cell.metadata ?? {})) meta.set(k, v);
  m.set('metadata', meta);
  if (cell.attachments && Object.keys(cell.attachments).length) {
    m.set('attachments', cell.attachments);
  }
  return m;
}

export function readCell(m: Y.Map<unknown>): PlainCell {
  const source = m.get('source');
  const outputs = m.get('outputs');
  const meta = m.get('metadata');
  const attachments = m.get('attachments') as Record<string, unknown> | undefined;
  return {
    id: String(m.get('id') ?? ''),
    type: (m.get('type') as NotebookCellType) ?? 'code',
    source: source instanceof Y.Text ? source.toString() : String(source ?? ''),
    outputs: outputs instanceof Y.Array ? (outputs.toArray() as NbOutput[]) : [],
    executionCount: (m.get('execution_count') as number | null | undefined) ?? null,
    metadata: meta instanceof Y.Map ? (meta.toJSON() as Record<string, unknown>) : {},
    ...(attachments ? { attachments } : {}),
  };
}

export function readNotebook(doc: Y.Doc): PlainNotebook {
  const meta = doc.getMap<unknown>('meta');
  const nbMeta = (meta.get('metadata') as Record<string, unknown> | undefined) ?? DEFAULT_METADATA;
  return { cells: cellsOf(doc).toArray().map(readCell), metadata: nbMeta };
}

export function findCell(
  doc: Y.Doc,
  cellId: string,
): { index: number; cell: Y.Map<unknown> } | null {
  const arr = cellsOf(doc);
  for (let i = 0; i < arr.length; i += 1) {
    const c = arr.get(i);
    if (c.get('id') === cellId) return { index: i, cell: c };
  }
  return null;
}

/** 整本替换（导入 .ipynb）。在调用方的事务里执行。 */
export function replaceNotebook(doc: Y.Doc, nb: PlainNotebook) {
  const arr = cellsOf(doc);
  if (arr.length) arr.delete(0, arr.length);
  arr.push(nb.cells.map((c) => makeCell(c)));
  doc.getMap('meta').set('metadata', nb.metadata);
  doc.getMap('runs').clear();
}

/** 新建 notebook 的初始内容：一个空代码单元格 */
export function initNotebook(doc: Y.Doc, language = 'python') {
  doc.transact(() => {
    const meta = doc.getMap('meta');
    meta.set('language', language);
    meta.set('metadata', DEFAULT_METADATA);
    cellsOf(doc).push([makeCell({ type: 'code' })]);
  });
}

// ---------------------------------------------------------------- nbformat v4

type Multiline = string | string[];
const joinML = (v: Multiline | undefined | null): string =>
  Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '';

/** nbformat 习惯把多行文本存成行数组（每行带 \n） */
export function splitML(s: string): string[] {
  if (!s) return [];
  const lines = s.split(/(?<=\n)/);
  return lines;
}

const TEXT_MIME = /^(text\/|application\/(json|javascript|x-latex)|image\/svg\+xml)/;

function normalizeBundle(data: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [mime, v] of Object.entries(data ?? {})) {
    if (mime === 'application/json' || mime.endsWith('+json')) out[mime] = v;
    else if (Array.isArray(v)) out[mime] = v.join('');
    else out[mime] = v;
  }
  return out;
}

function bundleForIpynb(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [mime, v] of Object.entries(data)) {
    if (typeof v === 'string' && TEXT_MIME.test(mime) && !mime.endsWith('json')) {
      out[mime] = splitML(v);
    } else out[mime] = v;
  }
  return out;
}

function normalizeOutput(o: Record<string, unknown>): NbOutput | null {
  switch (o.output_type) {
    case 'stream':
      return {
        output_type: 'stream',
        name: o.name === 'stderr' ? 'stderr' : 'stdout',
        text: joinML(o.text as Multiline),
      };
    case 'display_data':
      return {
        output_type: 'display_data',
        data: normalizeBundle(o.data as Record<string, unknown>),
        metadata: (o.metadata as Record<string, unknown>) ?? {},
      };
    case 'execute_result':
      return {
        output_type: 'execute_result',
        execution_count: (o.execution_count as number | null) ?? null,
        data: normalizeBundle(o.data as Record<string, unknown>),
        metadata: (o.metadata as Record<string, unknown>) ?? {},
      };
    case 'error':
      return {
        output_type: 'error',
        ename: String(o.ename ?? ''),
        evalue: String(o.evalue ?? ''),
        traceback: Array.isArray(o.traceback) ? (o.traceback as string[]) : [],
      };
    default:
      return null;
  }
}

export function fromIpynb(input: unknown): PlainNotebook {
  let json: unknown = input;
  if (typeof input === 'string') {
    try {
      json = JSON.parse(input);
    } catch {
      throw new ApiError('validation_failed', '不是有效的 .ipynb 文件（JSON 解析失败）');
    }
  }
  const nb = json as {
    nbformat?: number;
    cells?: Record<string, unknown>[];
    metadata?: Record<string, unknown>;
    worksheets?: unknown;
  };
  if (!nb || typeof nb !== 'object' || !Array.isArray(nb.cells)) {
    if (nb && (nb as { worksheets?: unknown }).worksheets) {
      throw new ApiError(
        'validation_failed',
        '这是 nbformat 3 的旧格式，请先用 Jupyter 另存为新版',
      );
    }
    throw new ApiError('validation_failed', '不是有效的 .ipynb 文件（缺少 cells）');
  }
  const seen = new Set<string>();
  const cells: PlainCell[] = nb.cells.map((c) => {
    const type: NotebookCellType =
      c.cell_type === 'markdown' ? 'markdown' : c.cell_type === 'raw' ? 'raw' : 'code';
    let id = typeof c.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(c.id) ? c.id : newCellId();
    if (seen.has(id)) id = newCellId();
    seen.add(id);
    const outputs =
      type === 'code' && Array.isArray(c.outputs)
        ? (c.outputs as Record<string, unknown>[])
            .map(normalizeOutput)
            .filter((o): o is NbOutput => o !== null)
        : [];
    const metadata = (c.metadata as Record<string, unknown>) ?? {};
    return {
      id,
      type,
      source: joinML(c.source as Multiline),
      outputs,
      executionCount: type === 'code' ? ((c.execution_count as number | null) ?? null) : null,
      metadata,
      ...(c.attachments ? { attachments: c.attachments as Record<string, unknown> } : {}),
    };
  });
  return { cells, metadata: { ...DEFAULT_METADATA, ...(nb.metadata ?? {}) } };
}

export function toIpynb(nb: PlainNotebook): Record<string, unknown> {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: nb.metadata,
    cells: nb.cells.map((c) => {
      const base = {
        id: c.id,
        cell_type: c.type,
        metadata: c.metadata,
        source: splitML(c.source),
      };
      if (c.type === 'code') {
        return {
          ...base,
          execution_count: c.executionCount,
          outputs: c.outputs.map((o) => {
            if (o.output_type === 'stream') return { ...o, text: splitML(o.text) };
            if (o.output_type === 'display_data') {
              return {
                output_type: o.output_type,
                data: bundleForIpynb(o.data),
                metadata: o.metadata,
              };
            }
            if (o.output_type === 'execute_result') {
              return { ...o, data: bundleForIpynb(o.data) };
            }
            return o;
          }),
        };
      }
      return c.attachments ? { ...base, attachments: c.attachments } : base;
    }),
  };
}
