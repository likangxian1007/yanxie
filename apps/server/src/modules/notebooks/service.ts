import { and, desc, eq, isNull } from 'drizzle-orm';
import * as Y from 'yjs';
import {
  ApiError,
  newId,
  NotebookCreateInput,
  NotebookUpdateInput,
  type ActorRef,
  type Notebook,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { notebooks } from '../../db/schema';
import { parse } from '../../lib/http';
import { closeDocumentConnections, liveDocument, withLiveDocument } from '../../realtime/collab';
import { notFound } from '../collab-common';
import {
  cellsOf,
  fromIpynb,
  initNotebook,
  readNotebook,
  replaceNotebook,
  type PlainNotebook,
} from './nbformat';

type NotebookRow = typeof notebooks.$inferSelect;

export function toNotebook(row: NotebookRow): Notebook {
  return {
    id: row.id,
    projectId: row.projectId,
    experimentId: null,
    title: row.title,
    language: row.language,
    cellCount: row.cellCount,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function findNotebookRow(
  ctx: AppContext,
  projectId: string,
  id: string,
): Promise<NotebookRow> {
  const [row] = await ctx.db.db
    .select()
    .from(notebooks)
    .where(
      and(eq(notebooks.id, id), eq(notebooks.projectId, projectId), isNull(notebooks.deletedAt)),
    );
  if (!row) notFound('Notebook');
  return row;
}

export async function getNotebook(ctx: AppContext, projectId: string, id: string) {
  return toNotebook(await findNotebookRow(ctx, projectId, id));
}

export async function listNotebooks(
  ctx: AppContext,
  projectId: string,
  filter: { experimentId?: string } = {},
): Promise<Notebook[]> {
  const conds = [eq(notebooks.projectId, projectId), isNull(notebooks.deletedAt)];
  if (filter.experimentId) throw new ApiError('validation_failed', '实验功能已移除');
  const rows = await ctx.db.db
    .select()
    .from(notebooks)
    .where(and(...conds))
    .orderBy(desc(notebooks.updatedAt));
  return rows.map(toNotebook);
}

export async function createNotebook(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  raw: NotebookCreateInput,
): Promise<Notebook> {
  const input = parse(NotebookCreateInput, raw);
  if (input.experimentId) throw new ApiError('validation_failed', '实验功能已移除');
  const doc = new Y.Doc();
  if (input.ipynb !== undefined) {
    const nb = fromIpynb(input.ipynb);
    doc.transact(() => {
      doc.getMap('meta').set('language', 'python');
      replaceNotebook(doc, nb);
    });
  } else {
    initNotebook(doc);
  }
  const now = new Date();
  const event = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(notebooks)
      .values({
        id: newId('notebook'),
        projectId,
        title: input.title,
        language: 'python',
        cellCount: cellsOf(doc).length,
        ydocState: Y.encodeStateAsUpdate(doc),
        createdBy: actor,
        updatedBy: actor,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return ctx.bus.record(tx, {
      projectId,
      type: 'notebook.created',
      payload: toNotebook(row!),
      actor,
    });
  });
  ctx.bus.emit(event);
  return event.payload as Notebook;
}

export async function updateNotebook(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  id: string,
  raw: NotebookUpdateInput,
): Promise<Notebook> {
  const input = parse(NotebookUpdateInput, raw);
  await findNotebookRow(ctx, projectId, id);
  const event = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx
      .update(notebooks)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        updatedBy: actor,
        updatedAt: new Date(),
      })
      .where(eq(notebooks.id, id))
      .returning();
    return ctx.bus.record(tx, {
      projectId,
      type: 'notebook.updated',
      payload: toNotebook(row!),
      actor,
    });
  });
  ctx.bus.emit(event);
  return event.payload as Notebook;
}

export async function deleteNotebook(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  id: string,
) {
  await findNotebookRow(ctx, projectId, id);
  const event = await ctx.db.db.transaction(async (tx) => {
    await tx.update(notebooks).set({ deletedAt: new Date() }).where(eq(notebooks.id, id));
    return ctx.bus.record(tx, { projectId, type: 'notebook.deleted', payload: { id }, actor });
  });
  ctx.bus.emit(event);
  closeDocumentConnections(ctx, id);
}

/** /collab 落库：Y.Doc 状态 + 单元格数 */
export async function persistNotebook(ctx: AppContext, id: string, doc: Y.Doc, actor: ActorRef) {
  const [current] = await ctx.db.db
    .select({ projectId: notebooks.projectId })
    .from(notebooks)
    .where(eq(notebooks.id, id));
  if (!current) return;
  const event = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx
      .update(notebooks)
      .set({
        ydocState: Y.encodeStateAsUpdate(doc),
        cellCount: cellsOf(doc).length,
        updatedBy: actor.kind === 'system' ? undefined : actor,
        updatedAt: new Date(),
      })
      .where(eq(notebooks.id, id))
      .returning();
    return ctx.bus.record(tx, {
      projectId: current.projectId,
      type: 'notebook.updated',
      payload: toNotebook(row!),
      actor,
    });
  });
  ctx.bus.emit(event);
}

/** 读当前内容（有人在线编辑时读内存里的，否则读库） */
export async function readPlainNotebook(
  ctx: AppContext,
  projectId: string,
  id: string,
): Promise<{ meta: Notebook; nb: PlainNotebook }> {
  const row = await findNotebookRow(ctx, projectId, id);
  const live = liveDocument(ctx, id);
  if (live) return { meta: toNotebook(row), nb: readNotebook(live) };
  const doc = new Y.Doc();
  if (row.ydocState) Y.applyUpdate(doc, row.ydocState);
  return { meta: toNotebook(row), nb: readNotebook(doc) };
}

/** 用 .ipynb 整体替换（在线的人实时看到） */
export async function importIpynb(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  id: string,
  ipynb: unknown,
) {
  await findNotebookRow(ctx, projectId, id);
  const nb = fromIpynb(ipynb);
  await withLiveDocument(ctx, id, actor, (doc) => replaceNotebook(doc, nb));
  return getNotebook(ctx, projectId, id);
}
