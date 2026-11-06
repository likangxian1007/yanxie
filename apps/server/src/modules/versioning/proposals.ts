import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import {
  ApiError,
  newId,
  notebookCellChanges,
  ProposalDecisionsInput,
  ProposalMergeInput,
  seqHunks,
  sheetCellChanges,
  shortHash,
  type ActorRef,
  type AnyProjectEvent,
  type ChangeProposal,
  type HunkDecision,
  type ProposalHunk,
  type ProposalListQuery,
  type ProposalTargetKind,
  type Review,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { agentSessions, changeProposals, projectMembers } from '../../db/schema';
import { withLiveDocument } from '../../realtime/collab';
import { notFound, SYSTEM_ACTOR } from '../collab-common';
import { closeReview, createReview, giveVerdict } from '../reviews/service';
import { docFromState, currentYState, notebookCells, sheetSnapshots, targetInfo } from './content';
import type { TargetInfo } from './content';
import {
  applyMerge,
  planMerge,
  proposalFormat,
  sequenceOf,
  type PlanContext,
  type ProposalTarget,
} from './merge';
import { saveVersion } from './service';
import { getSettings } from './settings';

/**
 * 改动提案（API.md §2.18.2）：agent 改文档 / notebook 时不直接写正文，而是在草稿上改，
 * 生成一组改动块，配一条审阅（targetKind = proposal）。成员逐块接受 / 拒绝后合入，
 * 或者审阅人全部 LGTM 后自动整体合入。同一个 agent 线程对同一对象的连续修改叠加到同一份开放的提案里。
 */
type Row = typeof changeProposals.$inferSelect;

const TEXT_PREVIEW = 4000;

function target(row: Pick<Row, 'targetKind'>, info: TargetInfo): ProposalTarget {
  return { kind: row.targetKind, docKind: info.docKind };
}

// ---------------------------------------------------------------- 改动块

/** base → draft 的改动块；prev 里同 id 的改动块保留原来的决定 */
export function computeHunks(
  t: ProposalTarget,
  baseState: Uint8Array,
  draftState: Uint8Array,
  prev: ProposalHunk[] = [],
): ProposalHunk[] {
  const format = proposalFormat(t);
  const base = docFromState(baseState);
  const draft = docFromState(draftState);
  const decided = new Map(prev.map((h) => [h.id, h.decision]));
  const seen = new Map<string, number>();
  const uid = (raw: string) => {
    const id = shortHash(raw);
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return n ? `${id}-${n}` : id;
  };
  const decision = (id: string): HunkDecision => decided.get(id) ?? 'pending';
  try {
    if (format === 'blocks' || format === 'lines') {
      return seqHunks(sequenceOf(base, format), sequenceOf(draft, format)).map((h) => {
        const id = uid(JSON.stringify([h.before, h.old, h.new]));
        return { kind: 'text' as const, id, decision: decision(id), ...h };
      });
    }
    if (format === 'cells') {
      return sheetCellChanges(sheetSnapshots(base), sheetSnapshots(draft)).map((c) => {
        const id = uid(JSON.stringify([c.sheet, c.ref, c.old, c.new]));
        return { kind: 'cell' as const, id, decision: decision(id), ...c };
      });
    }
    if (format === 'notebook') {
      return notebookCellChanges(notebookCells(base), notebookCells(draft))
        .filter((c) => c.status !== 'same')
        .map((c) => {
          const op = c.status as 'add' | 'remove' | 'modify';
          const id = uid(JSON.stringify([op, c.cellId, c.old, c.new]));
          return {
            kind: 'nb_cell' as const,
            id,
            decision: decision(id),
            op,
            cellId: c.cellId,
            cellType: c.cellType,
            old: c.old,
            new: c.new,
            afterCellId: c.afterCellId,
          };
        });
    }
    return [];
  } finally {
    base.destroy();
    draft.destroy();
  }
}

// ---------------------------------------------------------------- DTO

async function toDto(
  ctx: AppContext,
  row: Row,
  opts: { conflicts?: boolean } = {},
): Promise<ChangeProposal> {
  // 对象已被删除时仍能列出提案（标题等取空）
  const info: TargetInfo | null = await targetInfo(
    ctx,
    row.projectId,
    row.targetKind,
    row.targetId,
  ).catch(() => null);
  let conflicts: string[] = [];
  if (opts.conflicts && info && row.status === 'open') {
    const cur = docFromState(await currentYState(ctx, info));
    try {
      conflicts = planMerge(
        { target: target(row, info), baseState: row.baseState },
        cur,
        row.hunks,
      ).conflicted;
    } finally {
      cur.destroy();
    }
  }
  const format = info ? proposalFormat(target(row, info)) : null;
  return {
    id: row.id,
    projectId: row.projectId,
    targetKind: row.targetKind,
    targetId: row.targetId,
    targetTitle: info?.title ?? '（已删除）',
    docKind: info?.docKind ?? null,
    targetExperimentId: info?.experimentId ?? null,
    title: row.title,
    explanation: row.explanation,
    author: row.author,
    threadId: row.threadId,
    reviewId: row.reviewId,
    status: row.status,
    unit: format === 'blocks' ? 'block' : format === 'lines' ? 'line' : null,
    hunks: row.hunks,
    conflicts,
    mergeResult: row.mergeResult ?? null,
    mergedBy: row.mergedBy ?? null,
    mergedAt: row.mergedAt ? row.mergedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function findRow(ctx: AppContext, projectId: string, id: string): Promise<Row> {
  const [row] = await ctx.db.db
    .select()
    .from(changeProposals)
    .where(and(eq(changeProposals.id, id), eq(changeProposals.projectId, projectId)));
  if (!row) notFound('改动提案');
  return row;
}

export async function listProposals(
  ctx: AppContext,
  projectId: string,
  q: ProposalListQuery,
): Promise<ChangeProposal[]> {
  const where = [eq(changeProposals.projectId, projectId)];
  if (q.targetKind) where.push(eq(changeProposals.targetKind, q.targetKind));
  if (q.targetId) where.push(eq(changeProposals.targetId, q.targetId));
  if (q.status) where.push(eq(changeProposals.status, q.status));
  const rows = await ctx.db.db
    .select()
    .from(changeProposals)
    .where(and(...where))
    .orderBy(desc(changeProposals.updatedAt));
  return Promise.all(rows.map((r) => toDto(ctx, r)));
}

export async function getProposal(
  ctx: AppContext,
  projectId: string,
  id: string,
): Promise<ChangeProposal> {
  return toDto(ctx, await findRow(ctx, projectId, id), { conflicts: true });
}

async function publish(
  ctx: AppContext,
  actor: ActorRef,
  row: Row,
  type: 'proposal.created' | 'proposal.updated',
): Promise<ChangeProposal> {
  const dto = await toDto(ctx, row, { conflicts: true });
  await ctx.bus.publish({
    projectId: row.projectId,
    threadId: row.threadId,
    type,
    payload: dto,
    actor,
  });
  return dto;
}

// ---------------------------------------------------------------- agent 写入 → 提案

export async function agentThreadId(ctx: AppContext, actor: ActorRef): Promise<string | null> {
  if (actor.kind !== 'agent' || !actor.id) return null;
  const [s] = await ctx.db.db
    .select({ threadId: agentSessions.threadId })
    .from(agentSessions)
    .where(eq(agentSessions.id, actor.id));
  return s?.threadId ?? null;
}

/**
 * 这次写入要不要变成改动提案：agent 写、项目没开「agent 直接写入」、
 * 对象不是这个 agent 自己新建的（自己起草的新文档直接写）、类型支持提案（幻灯片不支持）。
 */
export async function shouldPropose(
  ctx: AppContext,
  actor: ActorRef,
  info: TargetInfo,
): Promise<boolean> {
  if (actor.kind !== 'agent') return false;
  if (info.kind === 'file') return false;
  if (!proposalFormat({ kind: info.kind, docKind: info.docKind })) return false;
  if (info.createdBy.kind === 'agent' && info.createdBy.id === actor.id) return false;
  const settings = await getSettings(ctx, info.projectId);
  return !settings.agentDirectWrite;
}

/** 审阅人：负责人和导师；没有就请其他成员（最多 10 人） */
async function defaultReviewers(ctx: AppContext, projectId: string): Promise<string[]> {
  const rows = await ctx.db.db
    .select({ userId: projectMembers.userId, role: projectMembers.role })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId));
  const leads = rows.filter((r) => r.role === 'owner' || r.role === 'advisor');
  const pool = leads.length ? leads : rows.filter((r) => r.role === 'member');
  return pool.map((r) => r.userId).slice(0, 10);
}

function countLine(hunks: ProposalHunk[]): string {
  return `共 ${hunks.length} 处改动`;
}

async function attachReview(ctx: AppContext, actor: ActorRef, row: Row, info: TargetInfo) {
  // 个人空间的文档：审阅人是所有者本人（负责人 / 导师看不到别人的个人空间）
  const reviewerIds = info.ownerUserId
    ? [info.ownerUserId]
    : await defaultReviewers(ctx, row.projectId);
  if (!reviewerIds.length) return;
  try {
    const review = await createReview(ctx, actor, row.projectId, {
      targetKind: 'proposal',
      targetId: row.id,
      title: `改动提案：${info.title}`.slice(0, 120),
      // 同一线程后续的修改会叠加进这份提案，说明和改动数以「改动」页签（实时）为准，这里只写固定的引导
      summary: '改动和说明见「改动」页签。可以逐条接受或拒绝，全部审阅人 LGTM 后自动合入。',
      reviewerIds,
      threadId: row.threadId,
    });
    await ctx.db.db
      .update(changeProposals)
      .set({ reviewId: review.id })
      .where(eq(changeProposals.id, row.id));
    row.reviewId = review.id;
  } catch (err) {
    console.error('[versioning] 改动提案的审阅创建失败', err);
  }
}

export interface ProposeResult {
  proposal: ChangeProposal;
  /** 草稿当前内容（给 agent 看改动附近的内容用） */
  draft: Y.Doc;
  created: boolean;
}

/**
 * 在提案草稿上执行一次修改（mutate 抛错则什么也不存）。
 * 同一 agent 线程（没有线程时同一 agent）对同一对象的开放提案存在时叠加进去。
 */
export async function proposeEdit(
  ctx: AppContext,
  actor: ActorRef,
  info: TargetInfo,
  mutate: (doc: Y.Doc) => void,
  opts: { explanation?: string } = {},
): Promise<ProposeResult> {
  const threadId = await agentThreadId(ctx, actor);
  const kind = info.kind as ProposalTargetKind;
  const sameAuthor = threadId
    ? and(eq(changeProposals.threadId, threadId), sql`${changeProposals.author}->>'kind' = 'agent'`)
    : sql`${changeProposals.author}->>'id' = ${actor.id ?? ''}`;
  const [existing] = await ctx.db.db
    .select()
    .from(changeProposals)
    .where(
      and(
        eq(changeProposals.projectId, info.projectId),
        eq(changeProposals.targetKind, kind),
        eq(changeProposals.targetId, info.id),
        eq(changeProposals.status, 'open'),
        sameAuthor,
      ),
    )
    .orderBy(desc(changeProposals.updatedAt))
    .limit(1);
  const baseState = existing?.baseState ?? (await currentYState(ctx, info));
  const draft = docFromState(existing?.draftState ?? baseState);
  draft.transact(() => mutate(draft));
  const draftState = Y.encodeStateAsUpdate(draft);
  const t = { kind, docKind: info.docKind };
  const hunks = computeHunks(t, baseState, draftState, existing?.hunks);
  const explanation = [existing?.explanation, opts.explanation?.trim()]
    .filter((s): s is string => !!s)
    .join('\n\n')
    .slice(0, TEXT_PREVIEW);
  const now = new Date();
  if (existing) {
    const [row] = await ctx.db.db
      .update(changeProposals)
      .set({ draftState, hunks, explanation, updatedAt: now })
      .where(eq(changeProposals.id, existing.id))
      .returning();
    const proposal = await publish(ctx, actor, row!, 'proposal.updated');
    return { proposal, draft, created: false };
  }
  const [row] = await ctx.db.db
    .insert(changeProposals)
    .values({
      id: newId('proposal'),
      projectId: info.projectId,
      targetKind: kind,
      targetId: info.id,
      title: `修改「${info.title}」`.slice(0, 120),
      explanation,
      author: actor,
      threadId,
      status: 'open',
      baseState,
      draftState,
      hunks,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const proposal = await publish(ctx, actor, row!, 'proposal.created');
  await attachReview(ctx, actor, row!, info);
  return { proposal: { ...proposal, reviewId: row!.reviewId }, draft, created: true };
}

/** 给 agent 的提示：改动没有进正文 */
export function proposalNotice(p: ChangeProposal, created: boolean): string {
  return (
    `这次修改${created ? '已存为一份新的' : '已叠加到'}改动提案（${p.id}，${countLine(p.hunks)}），` +
    '正文暂未改变，要等成员审阅后合入。继续修改同一对象会叠加到这份提案里；' +
    '读文档 / notebook 读到的是正文当前内容，不含提案里的改动。'
  );
}

/**
 * agent 改 notebook（agents/tools/notebooks.ts 调用）：需要走提案时在草稿上执行 mutate 并返回提示；
 * 不需要时返回 null，调用方照常直接写。
 */
export async function proposeNotebookEditIfNeeded(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  notebookId: string,
  mutate: (doc: Y.Doc) => void,
  explanation?: string,
): Promise<{ proposalId: string; notice: string } | null> {
  const info = await targetInfo(ctx, projectId, 'notebook', notebookId);
  if (!(await shouldPropose(ctx, actor, info))) return null;
  const { proposal, draft, created } = await proposeEdit(ctx, actor, info, mutate, {
    explanation,
  });
  draft.destroy();
  return { proposalId: proposal.id, notice: proposalNotice(proposal, created) };
}

// ---------------------------------------------------------------- 逐条决定、合入、关闭

export async function setDecisions(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  id: string,
  raw: unknown,
): Promise<ChangeProposal> {
  const { decisions } = ProposalDecisionsInput.parse(raw);
  return withLock(id, async () => {
    const row = await findRow(ctx, projectId, id);
    if (row.status !== 'open') throw new ApiError('conflict', '这份提案已经合入或关闭了');
    const known = new Set(row.hunks.map((h) => h.id));
    const unknown = Object.keys(decisions).filter((k) => !known.has(k));
    if (unknown.length) {
      throw new ApiError('validation_failed', `没有这些改动：${unknown.join('、')}，请刷新后重试`);
    }
    const hunks = row.hunks.map((h) =>
      decisions[h.id] ? { ...h, decision: decisions[h.id]! } : h,
    );
    const [next] = await ctx.db.db
      .update(changeProposals)
      .set({ hunks, updatedAt: new Date() })
      .where(eq(changeProposals.id, id))
      .returning();
    return publish(ctx, actor, next!, 'proposal.updated');
  });
}

const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  locks.set(key, run);
  try {
    return await run;
  } finally {
    if (locks.get(key) === run) locks.delete(key);
  }
}

async function finishReview(ctx: AppContext, projectId: string, reviewId: string | null) {
  if (!reviewId) return;
  try {
    await closeReview(ctx, SYSTEM_ACTOR, projectId, reviewId, { force: true });
  } catch (err) {
    if (!(err instanceof ApiError && err.code === 'conflict')) throw err;
  }
}

export async function mergeProposal(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  id: string,
  raw: unknown,
): Promise<ChangeProposal> {
  const input = ProposalMergeInput.parse(raw ?? {});
  if (input.lgtm) {
    const row = await findRow(ctx, projectId, id);
    if (row.reviewId && row.status === 'open') {
      // 先合入再 LGTM：LGTM 触发的自动合入会发现提案已经合入
      const merged = await mergeLocked(ctx, actor, projectId, id, input);
      try {
        await giveVerdict(ctx, actor, projectId, row.reviewId, { verdict: 'lgtm' });
      } catch {
        // 不是审阅人或审阅已关闭：只合入
      }
      return merged;
    }
  }
  return mergeLocked(ctx, actor, projectId, id, input);
}

function mergeLocked(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  id: string,
  input: { acceptPending: boolean; skipConflicts: boolean },
): Promise<ChangeProposal> {
  return withLock(id, async () => {
    const row = await findRow(ctx, projectId, id);
    if (row.status !== 'open') throw new ApiError('conflict', '这份提案已经合入或关闭了');
    const info = await targetInfo(ctx, projectId, row.targetKind, row.targetId);
    if (info.archived) throw new ApiError('conflict', '文档已归档，恢复后才能合入');
    const take = row.hunks.filter(
      (h) => h.decision === 'accepted' || (input.acceptPending && h.decision === 'pending'),
    );
    const rejected = row.hunks.filter((h) => !take.includes(h)).map((h) => h.id);
    const pctx: PlanContext = { target: target(row, info), baseState: row.baseState };

    let result: { applied: string[]; conflicted: string[] } = { applied: [], conflicted: [] };
    if (take.length) {
      // 先看冲突：有冲突且没让跳过时什么都不写
      const cur = docFromState(await currentYState(ctx, info));
      const plan = planMerge(pctx, cur, take);
      cur.destroy();
      if (plan.conflicted.length && !input.skipConflicts) {
        throw new ApiError(
          'conflict',
          `有 ${plan.conflicted.length} 处改动和正文里别人的修改冲突。可以拒绝这几处，或选择跳过冲突后合入其余部分`,
          { conflicts: plan.conflicted },
        );
      }
      await saveVersion(ctx, actor, info, {
        kind: 'pre_merge',
        note: `合入「${row.title}」之前`,
        reuseIfSame: true,
      });
      result = await withLiveDocument(ctx, info.id, actor, (doc) => {
        let r = { applied: [] as string[], conflicted: [] as string[] };
        doc.transact(() => {
          r = applyMerge(pctx, doc, take);
        });
        return r;
      });
      await saveVersion(ctx, actor, await targetInfo(ctx, projectId, info.kind, info.id), {
        kind: 'merge',
        note: `合入「${row.title}」：接受 ${result.applied.length} 处，未采纳 ${rejected.length + result.conflicted.length} 处`,
      });
    }
    const now = new Date();
    const [next] = await ctx.db.db
      .update(changeProposals)
      .set({
        status: 'merged',
        mergeResult: { applied: result.applied, rejected, conflicted: result.conflicted },
        mergedBy: actor,
        mergedAt: now,
        updatedAt: now,
      })
      .where(eq(changeProposals.id, id))
      .returning();
    const dto = await publish(ctx, actor, next!, 'proposal.updated');
    await finishReview(ctx, projectId, row.reviewId);
    return dto;
  });
}

export async function closeProposal(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  id: string,
  opts: { closeReview?: boolean } = { closeReview: true },
): Promise<ChangeProposal> {
  return withLock(id, async () => {
    const row = await findRow(ctx, projectId, id);
    if (row.status !== 'open') throw new ApiError('conflict', '这份提案已经合入或关闭了');
    const [next] = await ctx.db.db
      .update(changeProposals)
      .set({ status: 'closed', updatedAt: new Date() })
      .where(eq(changeProposals.id, id))
      .returning();
    const dto = await publish(ctx, actor, next!, 'proposal.updated');
    if (opts.closeReview) await finishReview(ctx, projectId, row.reviewId);
    return dto;
  });
}

// ---------------------------------------------------------------- 审阅联动

/** 审阅快照：改动列表的 markdown */
export async function proposalSnapshot(
  ctx: AppContext,
  projectId: string,
  id: string,
): Promise<string> {
  const p = await toDto(ctx, await findRow(ctx, projectId, id));
  const out = [`# ${p.title}`, ''];
  if (p.explanation) out.push(p.explanation, '');
  out.push(`${countLine(p.hunks)}。`, '');
  for (const [i, h] of p.hunks.entries()) {
    out.push(`## 改动 ${i + 1}`, '');
    if (h.kind === 'text') {
      out.push('```diff', ...h.old.map((s) => `- ${s}`), ...h.new.map((s) => `+ ${s}`), '```', '');
    } else if (h.kind === 'cell') {
      out.push(`${h.sheet}!${h.ref}：「${h.old}」→「${h.new}」`, '');
    } else {
      const label = h.op === 'add' ? '新增单元格' : h.op === 'remove' ? '删除单元格' : '修改单元格';
      out.push(`${label} ${h.cellId}`, '', '```diff');
      out.push(
        ...h.old
          .split('\n')
          .filter(Boolean)
          .map((s) => `- ${s}`),
      );
      out.push(
        ...h.new
          .split('\n')
          .filter(Boolean)
          .map((s) => `+ ${s}`),
        '```',
        '',
      );
    }
  }
  return out.join('\n').slice(0, 60_000);
}

/** 审阅全部 LGTM → 整体合入（没决定的视为接受，冲突的跳过）；审阅被人关闭 → 提案一并关闭 */
export function startReviewBridge(ctx: AppContext): void {
  ctx.bus.onEvent((ev: AnyProjectEvent) => {
    if (ev.type !== 'review.updated') return;
    const review = ev.payload as Review;
    if (review.targetKind !== 'proposal') return;
    if (review.status !== 'approved' && review.status !== 'closed') return;
    void (async () => {
      const [row] = await ctx.db.db
        .select({ id: changeProposals.id, status: changeProposals.status })
        .from(changeProposals)
        .where(
          and(
            eq(changeProposals.projectId, ev.projectId),
            inArray(changeProposals.id, [review.targetId]),
          ),
        );
      if (!row || row.status !== 'open') return;
      if (review.status === 'approved') {
        await mergeProposal(ctx, ev.actor, ev.projectId, row.id, {
          acceptPending: true,
          skipConflicts: true,
        });
      } else if (!review.supersededById) {
        await closeProposal(ctx, ev.actor, ev.projectId, row.id, { closeReview: false });
      }
    })().catch((err) => {
      if (err instanceof ApiError && err.code === 'conflict') return;
      console.error('[versioning] 审阅联动失败', err);
    });
  });
}
