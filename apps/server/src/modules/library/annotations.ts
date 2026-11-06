import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import {
  ApiError,
  ulid,
  type ActorRef,
  type PaperAnnotation,
  type PaperAnnotationCreateInput,
  type PaperAnnotationUpdateInput,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { paperAnnotations, paperNotes, papers, projectMembers, projects } from '../../db/schema';
import {
  closeDocumentConnections,
  liveDocument,
  setCollabStorage,
  withLiveDocument,
} from '../../realtime/collab';
import { paperRecordAccess } from './access';
import { memberRole } from '../collab-common/guard';
import { getPaperRow } from './service';
import { paperPdfId } from './service';
import { libraryScope, scopeOf, scopeWhere, type LibraryScopeInput } from './scope';
import { noteState, toNote } from './notes';

type AnnotationRow = typeof paperAnnotations.$inferSelect;
type PaperRow = typeof papers.$inferSelect;
type Tx = Parameters<Parameters<AppContext['db']['db']['transaction']>[0]>[0];

export function annotationMatches(
  row: Pick<AnnotationRow, 'fileId' | 'pdfSha256'>,
  paper: Pick<PaperRow, 'fileId' | 'pdfSha256'> & { privatePdfPath?: string | null },
) {
  return row.fileId === paperPdfId(paper) && row.pdfSha256 === paper.pdfSha256;
}
export function toAnnotation(
  row: AnnotationRow,
  paper: Pick<PaperRow, 'fileId' | 'pdfSha256'> & { privatePdfPath?: string | null },
): PaperAnnotation {
  const { ydocState: _state, ...rest } = row;
  return {
    ...rest,
    anchorStatus: annotationMatches(row, paper) ? 'current' : 'mismatch',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}
export async function getAnnotation(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  id: string,
  includeDeleted = false,
) {
  const paper = await getPaperRow(ctx, scope, paperId);
  const [annotation] = await ctx.db.db
    .select()
    .from(paperAnnotations)
    .where(
      and(
        eq(paperAnnotations.paperId, paperId),
        eq(paperAnnotations.id, id),
        includeDeleted ? undefined : isNull(paperAnnotations.deletedAt),
      ),
    );
  if (!annotation) throw new ApiError('not_found', '标注已删除或你没有访问权限');
  return { paper, annotation };
}
export async function listAnnotations(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  includeDeleted = false,
) {
  const paper = await getPaperRow(ctx, scope, paperId);
  const rows = await ctx.db.db
    .select()
    .from(paperAnnotations)
    .where(
      and(
        eq(paperAnnotations.paperId, paperId),
        includeDeleted ? undefined : isNull(paperAnnotations.deletedAt),
      ),
    )
    .orderBy(asc(paperAnnotations.page), asc(paperAnnotations.createdAt), asc(paperAnnotations.id));
  return rows.map((row) => toAnnotation(row, paper));
}

export async function annotationBrief(
  ctx: AppContext,
  userId: string,
  paperId: string,
  annotationId: string,
  actor: ActorRef,
  input: { title: string; sourceVersion: number },
) {
  const scope = { kind: 'personal' as const, ownerUserId: userId };
  await flushAnnotation(ctx, scope, paperId, annotationId, actor);
  return mutate(ctx, scope, paperId, actor, async (tx, paper) => {
    const row = await lockedRow(tx, paperId, annotationId);
    const live = liveDocument(ctx, row.id);
    if (
      row.version !== input.sourceVersion ||
      (live && live.getText('body').toString() !== row.body)
    )
      throw new ApiError('version_conflict', '标注已经修改，请核对最新内容后重新制作说明稿');
    const body = `# ${input.title}\n\n## 引用原文\n${row.quote}\n\n## 我的说明\n${row.body || row.label || '（请补充这段原文对团队的意义）'}\n\n## 来源\n《${paper.title}》第 ${row.page} 页；${row.kind === 'highlight' ? '高亮' : '批注'} v${row.version}；作者：${row.createdBy.name}；记录时间：${row.createdAt.toISOString()}\nPDF 指纹：${row.pdfSha256 ?? '未记录'}\n${annotationMatches(row, paper) ? '对应当前 PDF。' : '注意：原 PDF 已变化，以下内容保留历史原文，定位待复核。'}\n`;
    if (body.length > 100000)
      throw new ApiError('validation_failed', '原文与批注合计过长，请先精简批注再制作说明稿');
    const [note] = await tx
      .insert(paperNotes)
      .values({
        id: `lnt_${ulid()}`,
        paperId,
        title: input.title,
        kind: 'brief',
        body,
        ydocState: noteState(body),
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return { value: toNote(note!), changed: [] };
  });
}

/** 项目/论文/标注按固定顺序加锁，业务更新与事件同一事务提交。 */
async function mutate<T>(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  actor: ActorRef,
  action: (
    tx: Tx,
    paper: PaperRow,
  ) => Promise<{ value: T; changed: { id: string; deleted: boolean }[] }>,
) {
  const source = await getPaperRow(ctx, scope, paperId);
  const permission = await paperRecordAccess(ctx, source, actor.id ?? '');
  if (permission !== 'none' && source.archivedAt)
    throw new ApiError('conflict', '请先恢复已归档论文');
  if (permission !== 'edit')
    throw new ApiError(permission === 'none' ? 'not_found' : 'forbidden', '无权编辑此文献记录');
  const result = await ctx.db.db.transaction(async (tx) => {
    const owner = libraryScope(scope);
    if (owner.kind === 'project') {
      const [member] = await tx
        .select()
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, owner.projectId),
            eq(projectMembers.userId, actor.id ?? ''),
          ),
        )
        .for('share');
      const [project] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.id, owner.projectId), isNull(projects.archivedAt)))
        .for('update');
      if ((!member && source.space !== 'personal') || !project)
        throw new ApiError('not_found', '项目不存在或你不是成员');
    } else if (owner.ownerUserId !== actor.id) throw new ApiError('not_found', '无权访问个人标注');
    const [paper] = await tx
      .select()
      .from(papers)
      .where(and(eq(papers.id, paperId), scopeWhere(papers, scope)))
      .for('update');
    if (!paper) throw new ApiError('not_found', '论文已删除或你没有访问权限');
    if (paper.archivedAt) throw new ApiError('conflict', '请先恢复已归档论文');
    const out = await action(tx, paper);
    const events = [];
    if (paper.projectId)
      for (const change of out.changed)
        events.push(
          await ctx.bus.record(tx, {
            projectId: paper.projectId,
            type: 'paper.annotations.changed',
            payload: { paperId, annotationId: change.id, deleted: change.deleted },
            actor,
          }),
        );
    return { value: out.value, events };
  });
  for (const event of result.events) ctx.bus.emit(event);
  return result.value;
}
async function lockedRow(tx: Tx, paperId: string, id: string, deleted = false) {
  const [row] = await tx
    .select()
    .from(paperAnnotations)
    .where(
      and(
        eq(paperAnnotations.paperId, paperId),
        eq(paperAnnotations.id, id),
        deleted ? undefined : isNull(paperAnnotations.deletedAt),
      ),
    )
    .for('update');
  if (!row) throw new ApiError('not_found', '标注已删除或你没有访问权限');
  return row;
}
export async function createAnnotation(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  actor: ActorRef,
  input: PaperAnnotationCreateInput,
) {
  return mutate(ctx, scope, paperId, actor, async (tx, paper) => {
    if (!paperPdfId(paper) || input.fileId !== paperPdfId(paper))
      throw new ApiError('version_conflict', 'PDF 已变化，请重新打开论文并选择原文');
    if (paper.pageCount !== null && input.page > paper.pageCount)
      throw new ApiError('validation_failed', '选区页码超出论文范围');
    const [row] = await tx
      .insert(paperAnnotations)
      .values({
        ...input,
        id: `lan_${ulid()}`,
        paperId,
        pdfSha256: paper.pdfSha256,
        ydocState: noteState(input.body),
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return { value: toAnnotation(row!, paper), changed: [{ id: row!.id, deleted: false }] };
  });
}
export async function flushAnnotation(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  id: string,
  actor: ActorRef,
) {
  const { annotation } = await getAnnotation(ctx, scope, paperId, id);
  if (annotation.kind === 'comment') await withLiveDocument(ctx, id, actor, () => undefined);
  const latest = await getAnnotation(ctx, scope, paperId, id);
  return toAnnotation(latest.annotation, latest.paper);
}
export async function updateAnnotation(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  id: string,
  actor: ActorRef,
  input: PaperAnnotationUpdateInput,
) {
  return mutate(ctx, scope, paperId, actor, async (tx, paper) => {
    const old = await lockedRow(tx, paperId, id);
    if (old.metadataVersion !== input.baseMetadataVersion)
      throw new ApiError('version_conflict', '标注颜色或说明已被修改，请核对最新内容后重试', {
        current: toAnnotation(old, paper),
      });
    const [row] = await tx
      .update(paperAnnotations)
      .set({
        color: input.color,
        label: input.label,
        version: old.version + 1,
        metadataVersion: old.metadataVersion + 1,
        updatedBy: actor,
        updatedAt: new Date(),
      })
      .where(eq(paperAnnotations.id, id))
      .returning();
    return { value: toAnnotation(row!, paper), changed: [{ id, deleted: false }] };
  });
}
export async function removeAnnotation(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  id: string,
  actor: ActorRef,
  baseVersion: number,
) {
  await flushAnnotation(ctx, scope, paperId, id, actor);
  await mutate(ctx, scope, paperId, actor, async (tx, paper) => {
    const old = await lockedRow(tx, paperId, id);
    const live = liveDocument(ctx, id);
    if (old.version !== baseVersion || (live && live.getText('body').toString() !== old.body))
      throw new ApiError('version_conflict', '标注在确认删除前发生变化，请先核对最新内容', {
        current: toAnnotation(old, paper),
      });
    await tx
      .update(paperAnnotations)
      .set({
        deletedAt: new Date(),
        updatedAt: new Date(),
        updatedBy: actor,
        version: old.version + 1,
      })
      .where(eq(paperAnnotations.id, id));
    return { value: undefined, changed: [{ id, deleted: true }] };
  });
  closeDocumentConnections(ctx, id);
}
export async function restoreAnnotation(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  id: string,
  actor: ActorRef,
  baseVersion: number,
) {
  return mutate(ctx, scope, paperId, actor, async (tx, paper) => {
    const old = await lockedRow(tx, paperId, id, true);
    if (!old.deletedAt) throw new ApiError('conflict', '这条标注没有被删除');
    if (old.restoredToId) {
      const restored = await lockedRow(tx, paperId, old.restoredToId);
      return { value: toAnnotation(restored, paper), changed: [] };
    }
    if (old.version !== baseVersion)
      throw new ApiError('version_conflict', '删除记录已更新，请刷新后恢复');
    // 新 ID、新 Y.Doc：旧客户端迟到的离线更新不能混入恢复后的正文。
    const [row] = await tx
      .insert(paperAnnotations)
      .values({
        id: `lan_${ulid()}`,
        paperId,
        kind: old.kind,
        color: old.color,
        label: old.label,
        fileId: old.fileId,
        pdfSha256: old.pdfSha256,
        page: old.page,
        quote: old.quote,
        boxes: old.boxes,
        body: old.body,
        ydocState: noteState(old.body),
        publishedFrom: old.publishedFrom,
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    await tx
      .update(paperAnnotations)
      .set({ restoredToId: row!.id, version: old.version + 1 })
      .where(eq(paperAnnotations.id, id));
    return {
      value: toAnnotation(row!, paper),
      changed: [
        { id: row!.id, deleted: false },
        { id, deleted: true },
      ],
    };
  });
}

async function annotationAccess(
  ctx: AppContext,
  id: string,
  userId: string,
): Promise<'none' | 'view' | 'edit'> {
  const [row] = await ctx.db.db
    .select({ paper: papers })
    .from(paperAnnotations)
    .innerJoin(papers, eq(papers.id, paperAnnotations.paperId))
    .where(
      and(
        eq(paperAnnotations.id, id),
        eq(paperAnnotations.kind, 'comment'),
        isNull(paperAnnotations.deletedAt),
      ),
    );
  if (!row) return 'none';
  const p = row.paper;
  return paperRecordAccess(ctx, p, userId);
}
export function registerAnnotationStorage(ctx: AppContext) {
  const pending = new Map<string, Promise<void>>();
  const editors = new WeakMap<Y.Doc, ActorRef>();
  setCollabStorage(
    ctx,
    {
      async load(id) {
        const [row] = await ctx.db.db
          .select({ annotation: paperAnnotations, paper: papers })
          .from(paperAnnotations)
          .innerJoin(papers, eq(papers.id, paperAnnotations.paperId))
          .where(
            and(
              eq(paperAnnotations.id, id),
              eq(paperAnnotations.kind, 'comment'),
              isNull(paperAnnotations.deletedAt),
            ),
          );
        return row
          ? {
              projectId: row.paper.projectId ?? '',
              resourceId: row.paper.id,
              state: row.annotation.ydocState,
              archived: Boolean(row.paper.archivedAt),
            }
          : null;
      },
      role: (pid, uid) => memberRole(ctx, pid, uid),
      access: (id, uid) => annotationAccess(ctx, id, uid),
      changed: (doc, actor) => {
        editors.set(doc, actor);
      },
      validateUpdate(doc, update) {
        const trial = new Y.Doc();
        try {
          Y.applyUpdate(trial, Y.encodeStateAsUpdate(doc));
          Y.applyUpdate(trial, update);
          if (trial.getText('body').length > 100_000)
            throw new Error('批注正文不能超过 100000 字符');
        } finally {
          trial.destroy();
        }
      },
      async persist(id, doc, actor) {
        const task = (pending.get(id) ?? Promise.resolve())
          .catch(() => undefined)
          .then(async () => {
            const [found] = await ctx.db.db
              .select({ paper: papers })
              .from(paperAnnotations)
              .innerJoin(papers, eq(papers.id, paperAnnotations.paperId))
              .where(and(eq(paperAnnotations.id, id), isNull(paperAnnotations.deletedAt)));
            if (!found || found.paper.archivedAt) return;
            const editor = editors.get(doc) ?? actor;
            if (!editor.id || (await annotationAccess(ctx, id, editor.id)) !== 'edit') return;
            await mutate(ctx, scopeOf(found.paper), found.paper.id, editor, async (tx) => {
              const [old] = await tx
                .select()
                .from(paperAnnotations)
                .where(and(eq(paperAnnotations.id, id), isNull(paperAnnotations.deletedAt)))
                .for('update');
              if (!old) return { value: undefined, changed: [] };
              const state = Y.encodeStateAsUpdate(doc),
                body = doc.getText('body').toString();
              if (body.length > 100_000)
                throw new ApiError('bad_request', '批注正文不能超过 100000 字符');
              if (Buffer.from(state).equals(Buffer.from(old.ydocState)))
                return { value: undefined, changed: [] };
              await tx
                .update(paperAnnotations)
                .set({
                  body,
                  ydocState: state,
                  version: sql`${paperAnnotations.version} + 1`,
                  updatedAt: new Date(),
                  updatedBy: editor,
                })
                .where(and(eq(paperAnnotations.id, id), isNull(paperAnnotations.deletedAt)));
              return { value: undefined, changed: [{ id, deleted: false }] };
            });
          });
        pending.set(id, task);
        try {
          await task;
        } finally {
          if (pending.get(id) === task) pending.delete(id);
        }
      },
    },
    'lan',
  );
}
