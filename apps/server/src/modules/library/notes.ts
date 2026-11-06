import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import {
  ApiError,
  ulid,
  type ActorRef,
  type PaperNote,
  type PaperNoteCreateInput,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { paperNotes, papers } from '../../db/schema';
import {
  closeDocumentConnections,
  setCollabStorage,
  withLiveDocument,
} from '../../realtime/collab';
import { paperRecordAccess } from './access';
import { memberRole } from '../collab-common/guard';
import { getPaperRow } from './service';
import type { LibraryScopeInput } from './scope';

export function noteState(body: string): Uint8Array {
  // 发布时只用当前正文新建 Y.Doc，绝不复制含已删除私人文字的 CRDT 历史。
  const doc = new Y.Doc();
  doc.getText('body').insert(0, body);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}
export function toNote(row: typeof paperNotes.$inferSelect): PaperNote {
  return {
    id: row.id,
    paperId: row.paperId,
    title: row.title,
    kind: row.kind,
    body: row.body,
    version: row.version,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    publishedFrom: row.publishedFrom,
  };
}
export async function getNote(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  noteId: string,
) {
  await getPaperRow(ctx, scope, paperId);
  const [note] = await ctx.db.db
    .select()
    .from(paperNotes)
    .where(
      and(eq(paperNotes.id, noteId), eq(paperNotes.paperId, paperId), isNull(paperNotes.deletedAt)),
    );
  if (!note) throw new ApiError('not_found', '笔记已删除或你没有访问权限');
  return note;
}
export async function listNotes(ctx: AppContext, scope: LibraryScopeInput, paperId: string) {
  await getPaperRow(ctx, scope, paperId);
  return (
    await ctx.db.db
      .select()
      .from(paperNotes)
      .where(and(eq(paperNotes.paperId, paperId), isNull(paperNotes.deletedAt)))
      .orderBy(asc(paperNotes.createdAt))
  ).map(toNote);
}
export async function notifyNote(
  ctx: AppContext,
  paperId: string,
  noteId: string,
  actor: ActorRef,
  deleted = false,
) {
  const [paper] = await ctx.db.db.select().from(papers).where(eq(papers.id, paperId));
  if (paper?.projectId)
    await ctx.bus.publish({
      projectId: paper.projectId,
      type: 'paper.notes.changed',
      payload: { paperId, noteId, deleted },
      actor,
    });
}
export async function createNote(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  actor: ActorRef,
  input: PaperNoteCreateInput,
) {
  const paper = await getPaperRow(ctx, scope, paperId);
  if (paper.archivedAt) throw new ApiError('conflict', '请先恢复已归档论文');
  const [note] = await ctx.db.db
    .insert(paperNotes)
    .values({
      id: `lnt_${ulid()}`,
      paperId,
      ...input,
      ydocState: noteState(input.body),
      createdBy: actor,
      updatedBy: actor,
    })
    .returning();
  await notifyNote(ctx, paperId, note!.id, actor);
  return toNote(note!);
}
export async function flushNote(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  noteId: string,
  actor: ActorRef,
) {
  await getNote(ctx, scope, paperId, noteId);
  await withLiveDocument(ctx, noteId, actor, () => undefined);
  return toNote(await getNote(ctx, scope, paperId, noteId));
}
export async function noteAccess(
  ctx: AppContext,
  noteId: string,
  userId: string,
): Promise<'none' | 'view' | 'edit'> {
  const [row] = await ctx.db.db
    .select({ paper: papers })
    .from(paperNotes)
    .innerJoin(papers, eq(papers.id, paperNotes.paperId))
    .where(and(eq(paperNotes.id, noteId), isNull(paperNotes.deletedAt)));
  if (!row) return 'none';
  const p = row.paper;
  return paperRecordAccess(ctx, p, userId);
}
export function registerNoteStorage(ctx: AppContext) {
  const pending = new Map<string, Promise<void>>();
  const editors = new WeakMap<Y.Doc, ActorRef>();
  setCollabStorage(
    ctx,
    {
      async load(id) {
        const [row] = await ctx.db.db
          .select({ note: paperNotes, paper: papers })
          .from(paperNotes)
          .innerJoin(papers, eq(papers.id, paperNotes.paperId))
          .where(and(eq(paperNotes.id, id), isNull(paperNotes.deletedAt)));
        return row
          ? {
              projectId: row.paper.projectId ?? '',
              resourceId: row.paper.id,
              state: row.note.ydocState,
              archived: Boolean(row.paper.archivedAt),
            }
          : null;
      },
      role: (projectId, userId) => memberRole(ctx, projectId, userId),
      access: (id, userId) => noteAccess(ctx, id, userId),
      changed: (doc, actor) => {
        editors.set(doc, actor);
      },
      validateUpdate(doc, update) {
        const trial = new Y.Doc();
        try {
          Y.applyUpdate(trial, Y.encodeStateAsUpdate(doc));
          Y.applyUpdate(trial, update);
          if (trial.getText('body').length > 100_000)
            throw new Error('笔记正文不能超过 100000 字符');
        } finally {
          trial.destroy();
        }
      },
      async persist(id, doc, actor) {
        // 多个浏览器同时点保存时串行取最新状态，避免较早的异步保存覆盖较新的正文。
        const task = (pending.get(id) ?? Promise.resolve())
          .catch(() => undefined)
          .then(async () => {
            const state = Y.encodeStateAsUpdate(doc);
            const body = doc.getText('body').toString();
            const editor = editors.get(doc) ?? actor;
            if (!editor.id || (await noteAccess(ctx, id, editor.id)) !== 'edit') return;
            if (body.length > 100_000)
              throw new ApiError('bad_request', '笔记正文不能超过 100000 字符');
            // 只更新现存行，不 upsert；删除后的迟到保存不会复活笔记。
            const [updated] = await ctx.db.db
              .update(paperNotes)
              .set({
                body,
                ydocState: state,
                version: sql`${paperNotes.version} + 1`,
                updatedAt: new Date(),
                updatedBy: editor,
              })
              .where(
                and(
                  eq(paperNotes.id, id),
                  isNull(paperNotes.deletedAt),
                  sql`${paperNotes.ydocState} <> ${Buffer.from(state)}`,
                ),
              )
              .returning();
            if (updated) await notifyNote(ctx, updated.paperId, id, actor);
          });
        pending.set(id, task);
        try {
          await task;
        } finally {
          if (pending.get(id) === task) pending.delete(id);
        }
      },
    },
    'lnt',
  );
}
export async function removeNote(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  noteId: string,
  actor: ActorRef,
) {
  const paper = await getPaperRow(ctx, scope, paperId);
  if (paper.archivedAt) throw new ApiError('conflict', '请先恢复已归档论文');
  await getNote(ctx, scope, paperId, noteId);
  await ctx.db.db
    .update(paperNotes)
    .set({ deletedAt: new Date(), updatedBy: actor })
    .where(eq(paperNotes.id, noteId));
  closeDocumentConnections(ctx, noteId);
  await notifyNote(ctx, paperId, noteId, actor, true);
}
