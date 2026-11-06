import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { and, eq, isNull } from 'drizzle-orm';
import * as Y from 'yjs';
import {
  columnName,
  YDOC_FIELD,
  type ActorRef,
  type DocumentKind,
  type NotebookCellSnapshot,
  type SheetSnapshot,
  type VersionContent,
  type VersionTargetKind,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { documents, files, notebooks } from '../../db/schema';
import { liveDocument } from '../../realtime/collab';
import { notFound } from '../collab-common';
import { docJson, toMarkdown } from '../documents/ydoc';
import { pmBlocksToMarkdown } from '../documents/markdown';
import { ensureWorkbook, listSheets } from '../documents/sheet-model';
import { diskPath, isTextMime } from '../files/service';
import { cellsOf, readCell } from '../notebooks/nbformat';

/**
 * 版本管理读各类对象的当前状态，并转成可读表示（VersionContent）。
 * 文档 / notebook 是 Yjs：有人在线时读内存里的最新状态，否则读库；文件读磁盘。
 */

/** 文件版本最多存这么大的原始字节，再大的只记元数据（不能回滚） */
export const MAX_FILE_VERSION_BYTES = 5 * 1024 * 1024;
/** 文本文件超过这个大小就不展开对比 */
const MAX_TEXT_DIFF_BYTES = 1024 * 1024;

export interface TargetInfo {
  kind: VersionTargetKind;
  id: string;
  projectId: string;
  title: string;
  /** 文档类型（document） */
  docKind: DocumentKind | null;
  archived: boolean;
  createdBy: ActorRef;
  updatedBy: ActorRef | null;
  /** notebook 所属实验（页面入口在实验详情里） */
  experimentId?: string | null;
  /** 文件：项目内路径与 MIME */
  path?: string;
  mime?: string;
  /** 个人空间文档的所有者（团队空间 / 非文档为 null） */
  ownerUserId?: string | null;
}

export interface CurrentState {
  info: TargetInfo;
  /** Yjs 状态（document / notebook） */
  state: Uint8Array | null;
  /** 文件原始字节 */
  blob: Uint8Array | null;
  content: VersionContent;
  size: number;
}

export async function targetInfo(
  ctx: AppContext,
  projectId: string,
  kind: VersionTargetKind,
  id: string,
): Promise<TargetInfo> {
  if (kind === 'document') {
    const [row] = await ctx.db.db
      .select({
        title: documents.title,
        kind: documents.kind,
        archivedAt: documents.archivedAt,
        createdBy: documents.createdBy,
        updatedBy: documents.updatedBy,
        ownerUserId: documents.ownerUserId,
      })
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.projectId, projectId)));
    if (!row) notFound('文档');
    return {
      kind,
      id,
      projectId,
      title: row.title,
      docKind: row.kind,
      archived: !!row.archivedAt,
      createdBy: row.createdBy,
      updatedBy: (row.updatedBy as ActorRef | null) ?? null,
      ownerUserId: row.ownerUserId ?? null,
    };
  }
  if (kind === 'notebook') {
    const [row] = await ctx.db.db
      .select({
        title: notebooks.title,
        createdBy: notebooks.createdBy,
        updatedBy: notebooks.updatedBy,
      })
      .from(notebooks)
      .where(
        and(eq(notebooks.id, id), eq(notebooks.projectId, projectId), isNull(notebooks.deletedAt)),
      );
    if (!row) notFound('Notebook');
    return {
      kind,
      id,
      projectId,
      title: row.title,
      docKind: null,
      archived: false,
      experimentId: null,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy ?? null,
    };
  }
  const [row] = await ctx.db.db
    .select()
    .from(files)
    .where(and(eq(files.id, id), eq(files.projectId, projectId)));
  if (!row) notFound('文件');
  return {
    kind,
    id,
    projectId,
    title: row.name,
    docKind: null,
    archived: false,
    createdBy: row.uploadedBy,
    updatedBy: row.uploadedBy,
    path: row.path,
    mime: row.mime,
  };
}

/** 对象当前的 Yjs 状态（在线的取内存，否则取库） */
export async function currentYState(ctx: AppContext, info: TargetInfo): Promise<Uint8Array> {
  const live = liveDocument(ctx, info.id);
  if (live) return Y.encodeStateAsUpdate(live);
  const table = info.kind === 'document' ? documents : notebooks;
  const [row] = await ctx.db.db
    .select({ state: table.ydocState })
    .from(table)
    .where(eq(table.id, info.id));
  return row?.state ?? Y.encodeStateAsUpdate(new Y.Doc());
}

export function docFromState(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  if (state.length) Y.applyUpdate(doc, state);
  return doc;
}

// ---------------------------------------------------------------- Y.Doc → 可读表示

/** 富文本的顶层块（每块一段 markdown；与 fragment 的子节点一一对应） */
export function docBlocks(doc: Y.Doc): string[] {
  return pmBlocksToMarkdown(docJson(doc));
}

export function latexSource(doc: Y.Doc): string {
  return doc.getText(YDOC_FIELD.latex).toString();
}

/** 表格每张工作表的非空单元格（A1 → 原始输入）。会就地迁移旧结构，只能用在自己持有的副本上 */
export function sheetSnapshots(doc: Y.Doc): SheetSnapshot[] {
  doc.transact(() => ensureWorkbook(doc));
  return listSheets(doc).map((s) => {
    const rowIndex = new Map(s.rows.map((id, i) => [id, i]));
    const colIndex = new Map(s.cols.map((id, i) => [id, i]));
    const cells: Record<string, string> = {};
    s.cells.forEach((v, key) => {
      const raw = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
      if (!raw) return;
      const i = key.indexOf(':');
      const r = rowIndex.get(key.slice(0, i));
      const c = colIndex.get(key.slice(i + 1));
      if (r === undefined || c === undefined) return;
      cells[`${columnName(c)}${r + 1}`] = raw;
    });
    return { name: s.name, cells };
  });
}

export function notebookCells(doc: Y.Doc): NotebookCellSnapshot[] {
  return cellsOf(doc)
    .toArray()
    .map((m) => {
      const c = readCell(m);
      return { id: c.id, type: c.type, source: c.source };
    });
}

export function ydocContent(
  doc: Y.Doc,
  kind: 'document' | 'notebook',
  docKind: DocumentKind | null,
): VersionContent {
  if (kind === 'notebook') return { format: 'notebook', cells: notebookCells(doc) };
  switch (docKind) {
    case 'sheet':
      return { format: 'sheet', sheets: sheetSnapshots(doc) };
    case 'latex':
      return { format: 'text', unit: 'line', language: 'latex', text: latexSource(doc) };
    case 'slides':
      return {
        format: 'text',
        unit: 'block',
        language: 'markdown',
        text: toMarkdown(doc, 'slides'),
      };
    default:
      return { format: 'text', unit: 'block', language: 'markdown', text: toMarkdown(doc, 'doc') };
  }
}

export function contentSize(content: VersionContent): number {
  if (content.format === 'binary') return content.size;
  return Buffer.byteLength(JSON.stringify(content), 'utf8');
}

export function hashOf(content: VersionContent, blob?: Uint8Array | null): string {
  const h = createHash('sha1').update(JSON.stringify(content));
  if (blob) h.update(blob);
  return h.digest('base64');
}

export function fileContent(blob: Uint8Array, mime: string, size: number): VersionContent {
  if (isTextMime(mime) && size <= MAX_TEXT_DIFF_BYTES) {
    return {
      format: 'text',
      unit: 'line',
      language: mime === 'text/markdown' ? 'markdown' : mime === 'text/x-tex' ? 'latex' : 'plain',
      text: new TextDecoder('utf-8').decode(blob),
    };
  }
  return { format: 'binary', size, mime };
}

/** 读对象当前的完整状态（存版本、对比「当前」用） */
export async function readCurrent(ctx: AppContext, info: TargetInfo): Promise<CurrentState> {
  if (info.kind === 'file') {
    let bytes: Buffer;
    try {
      bytes = await readFile(diskPath(ctx, info.projectId, info.path!));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') notFound('文件内容');
      throw err;
    }
    const content = fileContent(bytes, info.mime!, bytes.length);
    return {
      info,
      state: null,
      blob: bytes.length <= MAX_FILE_VERSION_BYTES ? new Uint8Array(bytes) : null,
      content,
      size: bytes.length,
    };
  }
  const state = await currentYState(ctx, info);
  const doc = docFromState(state);
  try {
    const content = ydocContent(doc, info.kind, info.docKind);
    return { info, state, blob: null, content, size: contentSize(content) };
  } finally {
    doc.destroy();
  }
}
