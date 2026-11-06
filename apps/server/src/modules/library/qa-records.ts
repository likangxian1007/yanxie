import { and, asc, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import * as Y from 'yjs';
import {
  ApiError,
  ulid,
  type ActorRef,
  type PaperQaSession,
  type PaperQaTurn,
  type PaperQaSource,
} from '@srh/shared';
import type { AppContext } from '../../context';
import {
  paperQaSessions,
  paperQaTurns,
  paperQaRevisions,
  papers,
  projects,
  projectMembers,
} from '../../db/schema';
import {
  closeDocumentConnections,
  setCollabStorage,
  withLiveDocument,
} from '../../realtime/collab';
import { paperRecordAccess } from './access';
import { memberRole } from '../collab-common/guard';
import { getPaperRow } from './service';
import { paperPdfId } from './service';
import { libraryScope, scopeOf, scopeWhere, type LibraryScopeInput } from './scope';

export type QaTx = Parameters<Parameters<AppContext['db']['db']['transaction']>[0]>[0];
export type QaRow = typeof paperQaTurns.$inferSelect;
export type QaSessionRow = typeof paperQaSessions.$inferSelect;
export const QA_RUNNING = ['queued', 'retrieving', 'generating'] as const;
export const qaRunning = (status: string) => (QA_RUNNING as readonly string[]).includes(status);
export const qaState = (question: string, answer: string) => {
  const doc = new Y.Doc();
  doc.getText('question').insert(0, question);
  doc.getText('answer').insert(0, answer);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
};
export function qaSessionDto(row: QaSessionRow): PaperQaSession {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}
export function qaTurnDto(row: QaRow): PaperQaTurn {
  const {
    ydocState: _state,
    requestId: _request,
    requestSignature: _signature,
    requestedByUserId: _requester,
    ...data
  } = row;
  return {
    ...data,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/** 私人/项目写操作均在事务中复核归属；内部任务只能按已存轮次更新状态。 */
export async function mutateQa<T>(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  actor: ActorRef,
  mode: 'edit' | 'generate' | 'internal',
  fn: (
    tx: QaTx,
    paper: typeof papers.$inferSelect,
  ) => Promise<{
    value: T;
    changes: { sessionId: string; turnId: string | null; deleted?: boolean }[];
  }>,
) {
  if (mode !== 'internal') {
    const source = await getPaperRow(ctx, scope, paperId);
    const permission = await paperRecordAccess(ctx, source, actor.id ?? '');
    if (permission !== 'none' && source.archivedAt)
      throw new ApiError('conflict', '请先恢复已归档论文');
    if (permission !== 'edit')
      throw new ApiError(permission === 'none' ? 'not_found' : 'forbidden', '无权编辑此文献记录');
  }
  const result = await ctx.db.db.transaction(async (tx) => {
    const own = libraryScope(scope);
    if (own.kind === 'project') {
      if (mode !== 'internal') {
        const [member] = await tx
          .select()
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.projectId, own.projectId),
              eq(projectMembers.userId, actor.id ?? ''),
            ),
          )
          .for('share');
        if (!member && mode === 'generate')
          throw new ApiError('not_found', '项目不存在或你已不是成员');
        if (mode === 'generate' && member?.role === 'guest')
          throw new ApiError('forbidden', '调用模型需要项目写入权限');
      }
      const [project] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, own.projectId))
        .for('update');
      if (!project || (mode !== 'internal' && project.archivedAt))
        throw new ApiError('not_found', '项目不存在或已归档');
    } else if (mode !== 'internal' && own.ownerUserId !== actor.id)
      throw new ApiError('not_found', '无权访问个人问答');
    const [paper] = await tx
      .select()
      .from(papers)
      .where(and(eq(papers.id, paperId), scopeWhere(papers, scope)))
      .for('update');
    if (!paper) throw new ApiError('not_found', '论文已删除或你没有访问权限');
    if (paper.archivedAt && mode !== 'internal')
      throw new ApiError('conflict', '请先恢复已归档论文');
    const out = await fn(tx, paper),
      events = [];
    if (paper.projectId)
      for (const change of out.changes)
        events.push(
          await ctx.bus.record(tx, {
            projectId: paper.projectId,
            type: 'paper.qa.changed',
            actor,
            payload: {
              paperId,
              sessionId: change.sessionId,
              turnId: change.turnId,
              deleted: change.deleted ?? false,
            },
          }),
        );
    return { value: out.value, events };
  });
  for (const event of result.events) ctx.bus.emit(event);
  return result.value;
}
export async function qaSession(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  id: string,
) {
  const paper = await getPaperRow(ctx, scope, paperId);
  const [session] = await ctx.db.db
    .select()
    .from(paperQaSessions)
    .where(
      and(
        eq(paperQaSessions.id, id),
        eq(paperQaSessions.paperId, paperId),
        isNull(paperQaSessions.deletedAt),
      ),
    );
  if (!session) throw new ApiError('not_found', '问答会话已删除或你没有访问权限');
  return { paper, session };
}
export async function qaTurn(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  id: string,
) {
  const paper = await getPaperRow(ctx, scope, paperId);
  const [row] = await ctx.db.db
    .select({ turn: paperQaTurns, session: paperQaSessions })
    .from(paperQaTurns)
    .innerJoin(paperQaSessions, eq(paperQaSessions.id, paperQaTurns.sessionId))
    .where(
      and(
        eq(paperQaTurns.id, id),
        eq(paperQaTurns.paperId, paperId),
        isNull(paperQaSessions.deletedAt),
      ),
    );
  if (!row) throw new ApiError('not_found', '问答已删除或你没有访问权限');
  return { ...row, paper };
}
export async function lockQaSession(tx: QaTx, paperId: string, id: string) {
  const [session] = await tx
    .select()
    .from(paperQaSessions)
    .where(
      and(
        eq(paperQaSessions.id, id),
        eq(paperQaSessions.paperId, paperId),
        isNull(paperQaSessions.deletedAt),
      ),
    )
    .for('update');
  if (!session) throw new ApiError('not_found', '问答会话已删除');
  return session;
}
export async function listQaSessions(ctx: AppContext, scope: LibraryScopeInput, paperId: string) {
  await getPaperRow(ctx, scope, paperId);
  return (
    await ctx.db.db
      .select()
      .from(paperQaSessions)
      .where(and(eq(paperQaSessions.paperId, paperId), isNull(paperQaSessions.deletedAt)))
      .orderBy(desc(paperQaSessions.updatedAt), desc(paperQaSessions.id))
  ).map(qaSessionDto);
}
export async function createQaSession(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  actor: ActorRef,
  title: string,
) {
  return mutateQa(ctx, scope, paperId, actor, 'edit', async (tx) => {
    const [row] = await tx
      .insert(paperQaSessions)
      .values({ id: `lqs_${ulid()}`, paperId, title, createdBy: actor, updatedBy: actor })
      .returning();
    return { value: qaSessionDto(row!), changes: [{ sessionId: row!.id, turnId: null }] };
  });
}
export async function renameQaSession(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  id: string,
  actor: ActorRef,
  title: string,
  version: number,
) {
  return mutateQa(ctx, scope, paperId, actor, 'edit', async (tx) => {
    const old = await lockQaSession(tx, paperId, id);
    if (old.version !== version)
      throw new ApiError('version_conflict', '会话名称已更新，请核对后重试', {
        current: qaSessionDto(old),
      });
    const [row] = await tx
      .update(paperQaSessions)
      .set({ title, version: old.version + 1, updatedBy: actor, updatedAt: new Date() })
      .where(eq(paperQaSessions.id, id))
      .returning();
    return { value: qaSessionDto(row!), changes: [{ sessionId: id, turnId: null }] };
  });
}
export async function removeQaSession(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  id: string,
  actor: ActorRef,
  version: number,
) {
  const ids = await mutateQa(ctx, scope, paperId, actor, 'edit', async (tx) => {
    const old = await lockQaSession(tx, paperId, id);
    if (old.version !== version) throw new ApiError('version_conflict', '会话已更新，请刷新后重试');
    const turns = await tx
      .select({ id: paperQaTurns.id })
      .from(paperQaTurns)
      .where(eq(paperQaTurns.sessionId, id));
    await tx
      .update(paperQaSessions)
      .set({
        deletedAt: new Date(),
        updatedAt: new Date(),
        updatedBy: actor,
        version: old.version + 1,
      })
      .where(eq(paperQaSessions.id, id));
    await tx
      .update(paperQaTurns)
      .set({ status: 'cancelled', error: '会话已删除', completedAt: new Date() })
      .where(and(eq(paperQaTurns.sessionId, id), inArray(paperQaTurns.status, [...QA_RUNNING])));
    return {
      value: turns.map((t) => t.id),
      changes: [{ sessionId: id, turnId: null, deleted: true }],
    };
  });
  for (const id of ids) closeDocumentConnections(ctx, id);
  return ids;
}

export async function currentQaSources(
  ctx: AppContext,
  scope: LibraryScopeInput,
  sources: PaperQaSource[],
) {
  const ids = sources.flatMap((s) => (s.paperId ? [s.paperId] : []));
  if (!ids.length) return sources;
  const current = await ctx.db.db
    .select()
    .from(papers)
    .where(and(inArray(papers.id, ids), scopeWhere(papers, scope)));
  return sources.map((s) => {
    if (s.status === 'unshared') return s;
    const paper = current.find((p) => p.id === s.paperId);
    const status = !paper
      ? 'missing'
      : paperPdfId(paper) !== s.fileId || paper.pdfSha256 !== s.pdfSha256
        ? 'changed'
        : s.status;
    return { ...s, status } as PaperQaSource;
  });
}
export async function listQaTurns(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  sessionId: string,
) {
  const { paper } = await qaSession(ctx, scope, paperId, sessionId);
  const rows = await ctx.db.db
    .select()
    .from(paperQaTurns)
    .where(eq(paperQaTurns.sessionId, sessionId))
    .orderBy(asc(paperQaTurns.createdAt), asc(paperQaTurns.id));
  return Promise.all(
    rows.map(async (row) => ({
      ...qaTurnDto(row),
      selection: currentSelection(row, paper),
      sources: await currentQaSources(ctx, scope, row.sources),
    })),
  );
}
export async function flushQaTurn(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  id: string,
  actor: ActorRef,
) {
  const { turn } = await qaTurn(ctx, scope, paperId, id);
  if (turn.status === 'done') await withLiveDocument(ctx, id, actor, () => undefined);
  const latest = await qaTurn(ctx, scope, paperId, id);
  return {
    ...qaTurnDto(latest.turn),
    selection: currentSelection(latest.turn, latest.paper),
    sources: await currentQaSources(ctx, scope, latest.turn.sources),
  };
}
function currentSelection(row: QaRow, paper: typeof papers.$inferSelect) {
  if (!row.selection || row.selection.status !== 'available') return row.selection;
  return {
    ...row.selection,
    status: !paperPdfId(paper)
      ? ('missing' as const)
      : row.selection.fileId !== paperPdfId(paper) || row.selection.pdfSha256 !== paper.pdfSha256
        ? ('changed' as const)
        : ('available' as const),
  };
}
export async function qaRevisions(
  ctx: AppContext,
  scope: LibraryScopeInput,
  paperId: string,
  id: string,
  before?: number,
) {
  await qaTurn(ctx, scope, paperId, id);
  const rows = await ctx.db.db
    .select()
    .from(paperQaRevisions)
    .where(
      and(
        eq(paperQaRevisions.turnId, id),
        before ? lt(paperQaRevisions.version, before) : undefined,
      ),
    )
    .orderBy(desc(paperQaRevisions.version))
    .limit(50);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}
async function findCollabTurn(ctx: AppContext, id: string) {
  const [row] = await ctx.db.db
    .select({ turn: paperQaTurns, paper: papers })
    .from(paperQaTurns)
    .innerJoin(paperQaSessions, eq(paperQaSessions.id, paperQaTurns.sessionId))
    .innerJoin(papers, eq(papers.id, paperQaTurns.paperId))
    .where(
      and(
        eq(paperQaTurns.id, id),
        eq(paperQaTurns.status, 'done'),
        isNull(paperQaSessions.deletedAt),
      ),
    );
  return row;
}
async function qaAccess(
  ctx: AppContext,
  id: string,
  userId: string,
): Promise<'none' | 'edit' | 'view'> {
  const row = await findCollabTurn(ctx, id);
  if (!row) return 'none';
  const { paper } = row;
  return paperRecordAccess(ctx, paper, userId);
}
export function registerQaStorage(ctx: AppContext) {
  const pending = new Map<string, Promise<void>>(),
    editors = new WeakMap<Y.Doc, ActorRef>();
  setCollabStorage(
    ctx,
    {
      async load(id) {
        const row = await findCollabTurn(ctx, id);
        return row
          ? {
              projectId: row.paper.projectId ?? '',
              resourceId: row.paper.id,
              state: row.turn.ydocState,
              archived: Boolean(row.paper.archivedAt),
            }
          : null;
      },
      role: (pid, uid) => memberRole(ctx, pid, uid),
      access: (id, uid) => qaAccess(ctx, id, uid),
      changed(doc, actor) {
        editors.set(doc, actor);
      },
      validateUpdate(doc, update) {
        const trial = new Y.Doc();
        try {
          Y.applyUpdate(trial, Y.encodeStateAsUpdate(doc));
          Y.applyUpdate(trial, update);
          if (trial.getText('question').length > 8000 || trial.getText('answer').length > 100000)
            throw new Error('问答正文超过长度限制');
        } finally {
          trial.destroy();
        }
      },
      async persist(id, doc, actor) {
        const task = (pending.get(id) ?? Promise.resolve())
          .catch(() => undefined)
          .then(async () => {
            const found = await findCollabTurn(ctx, id),
              editor = editors.get(doc) ?? actor;
            if (!found || !editor.id || (await qaAccess(ctx, id, editor.id)) !== 'edit') return;
            await mutateQa(
              ctx,
              scopeOf(found.paper),
              found.paper.id,
              editor,
              'edit',
              async (tx) => {
                await lockQaSession(tx, found.paper.id, found.turn.sessionId);
                const [old] = await tx
                  .select()
                  .from(paperQaTurns)
                  .where(eq(paperQaTurns.id, id))
                  .for('update');
                if (!old || old.status !== 'done') return { value: undefined, changes: [] };
                const state = Y.encodeStateAsUpdate(doc),
                  question = doc.getText('question').toString(),
                  answer = doc.getText('answer').toString();
                if (question.length > 8000 || answer.length > 100000)
                  throw new ApiError('bad_request', '问答正文超过长度限制');
                if (old.ydocState && Buffer.from(old.ydocState).equals(Buffer.from(state)))
                  return { value: undefined, changes: [] };
                const changed = question !== old.question || answer !== old.answer;
                await tx
                  .update(paperQaTurns)
                  .set({
                    ydocState: state,
                    question,
                    answer,
                    ...(changed
                      ? { version: old.version + 1, updatedAt: new Date(), updatedBy: editor }
                      : {}),
                  })
                  .where(eq(paperQaTurns.id, id));
                if (changed) {
                  await tx.insert(paperQaRevisions).values({
                    id: `lqr_${ulid()}`,
                    turnId: id,
                    version: old.version + 1,
                    question,
                    answer,
                    actor: editor,
                    kind: 'edited',
                  });
                  await tx
                    .update(paperQaSessions)
                    .set({ updatedAt: new Date() })
                    .where(eq(paperQaSessions.id, old.sessionId));
                }
                return {
                  value: undefined,
                  changes: changed ? [{ sessionId: old.sessionId, turnId: id }] : [],
                };
              },
            );
          });
        pending.set(id, task);
        try {
          await task;
        } finally {
          if (pending.get(id) === task) pending.delete(id);
        }
      },
    },
    'lqt',
  );
}
