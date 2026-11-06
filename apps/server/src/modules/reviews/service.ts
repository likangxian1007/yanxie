import { and, asc, count, desc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  ApiError,
  newId,
  ReviewCommentCreateInput,
  ReviewCommentUpdateInput,
  ReviewCreateInput,
  ReviewStatus,
  ReviewTargetKind,
  ReviewVerdictInput,
  type ActorRef,
  type ProjectEvent,
  type Review,
  type ReviewComment,
  type ReviewStatus as ReviewStatusT,
  type ReviewVerdict,
} from '@srh/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/client';
import {
  projectMembers,
  reviewComments,
  reviewParticipants,
  reviews,
  users,
} from '../../db/schema';
import { parse } from '../../lib/http';
import { assertLinkableThread, memberRole, notFound, roleCan } from '../collab-common';
import { createInboxItem, markInboxDoneBySource } from '../collab-common/inbox';
import { toReview, toReviewComment, type ReviewParticipantRow, type ReviewRow } from './serialize';
import { buildSnapshot } from './snapshot';

/**
 * 审阅（像 GitHub PR 的 review）业务逻辑。路由（index.ts）与 agent 工具（collab-port）共用。
 * 写操作：事务里写表 + bus.record，提交后 bus.emit；事件 threadId = 审阅的 threadId
 * （路由器据此唤醒发起审阅的线程 agent）。
 */

type Exec = Pick<Db, 'select'>;
type ReviewCreateIn = z.input<typeof ReviewCreateInput>;
type ReviewVerdictIn = z.input<typeof ReviewVerdictInput>;
type ReviewCommentCreateIn = z.input<typeof ReviewCommentCreateInput>;
type ReviewCommentUpdateIn = z.input<typeof ReviewCommentUpdateInput>;

export type ReviewWithComments = Review & { comments: ReviewComment[] };

export const ReviewListQuery = z.object({
  status: ReviewStatus.optional(),
  mine: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  targetKind: ReviewTargetKind.optional(),
  targetId: z.string().min(1).optional(),
});
export type ReviewListFilter = z.output<typeof ReviewListQuery>;

const DEFAULT_VERDICT_BODY: Partial<Record<ReviewVerdict, string>> = {
  lgtm: 'LGTM',
  changes_requested: '需要修改',
};

// 同一毫秒内生成的 ULID 随机段无序；评论按 id 排序，所以保证本进程内单调递增
let lastIdMs = 0;
function monotonicId(kind: 'review' | 'reviewComment'): string {
  const now = Math.max(Date.now(), lastIdMs + 1);
  lastIdMs = now;
  return newId(kind, now);
}

function invalid(path: string, message: string): never {
  throw new ApiError('validation_failed', message, { issues: [{ path, message }] });
}

/** 所有审阅人的结论 → 审阅状态：任一要求修改 → changes_requested；全部 LGTM → approved；否则 open。 */
export function computeReviewStatus(verdicts: ReviewVerdict[]): ReviewStatusT {
  if (verdicts.includes('changes_requested')) return 'changes_requested';
  if (verdicts.length > 0 && verdicts.every((v) => v === 'lgtm')) return 'approved';
  return 'open';
}

// ---------------------------------------------------------------- 读取

async function findRow(exec: Exec, projectId: string, reviewId: string): Promise<ReviewRow> {
  const [row] = await exec
    .select()
    .from(reviews)
    .where(and(eq(reviews.projectId, projectId), eq(reviews.id, reviewId)));
  if (!row) notFound('审阅');
  return row;
}

/** 批量组装 DTO（审阅人 + 评论数）。 */
async function hydrate(exec: Exec, rows: ReviewRow[]): Promise<Review[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const parts = await exec
    .select()
    .from(reviewParticipants)
    .where(inArray(reviewParticipants.reviewId, ids))
    .orderBy(asc(reviewParticipants.userId));
  const counts = await exec
    .select({ reviewId: reviewComments.reviewId, n: count() })
    .from(reviewComments)
    .where(inArray(reviewComments.reviewId, ids))
    .groupBy(reviewComments.reviewId);
  const partsBy = new Map<string, ReviewParticipantRow[]>();
  for (const p of parts) {
    const list = partsBy.get(p.reviewId) ?? [];
    list.push(p);
    partsBy.set(p.reviewId, list);
  }
  const countBy = new Map(counts.map((c) => [c.reviewId, Number(c.n)]));
  return rows.map((r) => toReview(r, partsBy.get(r.id) ?? [], countBy.get(r.id) ?? 0));
}

async function toDto(exec: Exec, row: ReviewRow): Promise<Review> {
  const [dto] = await hydrate(exec, [row]);
  if (!dto) throw new Error('审阅组装失败');
  return dto;
}

export async function listReviews(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  filter: Partial<ReviewListFilter> = {},
): Promise<Review[]> {
  const db = ctx.db.db;
  const where: SQL[] = [eq(reviews.projectId, projectId)];
  if (filter.status) where.push(eq(reviews.status, filter.status));
  if (filter.targetKind) where.push(eq(reviews.targetKind, filter.targetKind));
  if (filter.targetId) where.push(eq(reviews.targetId, filter.targetId));
  if (filter.mine) {
    const me = actor.id ?? '';
    const mine = or(
      sql`${reviews.requestedBy}->>'id' = ${me}`,
      inArray(
        reviews.id,
        db
          .select({ id: reviewParticipants.reviewId })
          .from(reviewParticipants)
          .where(eq(reviewParticipants.userId, me)),
      ),
    );
    if (mine) where.push(mine);
  }
  const rows = await db
    .select()
    .from(reviews)
    .where(and(...where))
    .orderBy(desc(reviews.updatedAt), desc(reviews.id));
  return hydrate(db, rows);
}

/** 审阅 + 全部评论（时间正序）。 */
export async function getReview(
  ctx: AppContext,
  projectId: string,
  reviewId: string,
): Promise<ReviewWithComments> {
  const db = ctx.db.db;
  const row = await findRow(db, projectId, reviewId);
  const comments = await db
    .select()
    .from(reviewComments)
    .where(eq(reviewComments.reviewId, row.id))
    .orderBy(asc(reviewComments.createdAt), asc(reviewComments.id));
  return { ...(await toDto(db, row)), comments: comments.map(toReviewComment) };
}

// ---------------------------------------------------------------- 发起

async function validateReviewers(ctx: AppContext, projectId: string, ids: string[]) {
  const rows = await ctx.db.db
    .select({ userId: projectMembers.userId, role: projectMembers.role, name: users.name })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(and(eq(projectMembers.projectId, projectId), inArray(projectMembers.userId, ids)));
  const byId = new Map(rows.map((r) => [r.userId, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    invalid('reviewerIds', `审阅人必须是本项目成员，这些人不在项目里：${missing.join('、')}`);
  }
  const guests = rows.filter((r) => !roleCan(r.role, 'write'));
  if (guests.length > 0) {
    invalid(
      'reviewerIds',
      `访客不能审阅：${guests.map((g) => g.name).join('、')}。可以请项目负责人调整他们的角色`,
    );
  }
}

export async function createReview(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  rawInput: ReviewCreateIn,
): Promise<Review> {
  const input = parse(ReviewCreateInput, rawInput);
  const db = ctx.db.db;
  const reviewerIds = [...new Set(input.reviewerIds)];
  await validateReviewers(ctx, projectId, reviewerIds);
  await assertLinkableThread(db, actor, projectId, input.threadId);
  const snapshot = await buildSnapshot(ctx, actor, projectId, input.targetKind, input.targetId);

  const id = monotonicId('review');
  const event = await db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .insert(reviews)
      .values({
        id,
        projectId,
        targetKind: input.targetKind,
        targetId: input.targetId,
        title: input.title,
        summary: input.summary,
        requestedBy: actor,
        threadId: input.threadId,
        status: 'open',
        snapshot,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error('审阅写入失败');
    const parts = await tx
      .insert(reviewParticipants)
      .values(
        reviewerIds.map((userId) => ({
          reviewId: id,
          userId,
          verdict: 'pending' as const,
          updatedAt: now,
        })),
      )
      .returning();
    const dto = toReview(
      row,
      [...parts].sort((a, b) => a.userId.localeCompare(b.userId)),
      0,
    );
    // 同一目标上、同一发起方（同一人；agent 则按同一线程）还没关闭的旧审阅：被这一轮取代，
    // 关闭并指向新审阅（像 PR 推了新提交后重新请求审阅）。别人对同一目标发起的审阅不动。
    const sameRequester = or(
      actor.id
        ? and(
            sql`${reviews.requestedBy}->>'kind' = ${actor.kind}`,
            sql`${reviews.requestedBy}->>'id' = ${actor.id}`,
          )
        : undefined,
      actor.kind === 'agent' && input.threadId
        ? and(eq(reviews.threadId, input.threadId), sql`${reviews.requestedBy}->>'kind' = 'agent'`)
        : undefined,
    );
    const older = await tx
      .update(reviews)
      .set({ status: 'closed', supersededById: id, closedAt: now, updatedAt: now })
      .where(
        and(
          eq(reviews.projectId, projectId),
          eq(reviews.targetKind, input.targetKind),
          eq(reviews.targetId, input.targetId),
          ne(reviews.id, id),
          ne(reviews.status, 'closed'),
          sameRequester ?? sql`false`,
        ),
      )
      .returning();
    const supersededEvents = [];
    for (const old of older) {
      const oldDto = await toDto(tx, old);
      supersededEvents.push(
        await ctx.bus.record(tx, {
          projectId,
          threadId: oldDto.threadId,
          type: 'review.updated',
          payload: oldDto,
          actor,
        }),
      );
    }
    const created = await ctx.bus.record(tx, {
      projectId,
      threadId: dto.threadId,
      type: 'review.created',
      payload: dto,
      actor,
    });
    return { created, supersededEvents };
  });
  for (const e of event.supersededEvents) ctx.bus.emit(e as ProjectEvent);
  ctx.bus.emit(event.created as ProjectEvent);
  // 旧审阅的“请你审阅”待办随之完成
  for (const e of event.supersededEvents) {
    await markInboxDoneBySource(ctx, projectId, (e.payload as Review).id, actor);
  }

  const review = event.created.payload as Review;
  for (const userId of reviewerIds) {
    if (actor.kind === 'user' && actor.id === userId) continue;
    await createInboxItem(
      ctx,
      {
        projectId,
        userId,
        kind: 'review',
        title: `「${review.title}」请你审阅`,
        href: `/p/${projectId}/reviews/${review.id}`,
        sourceId: review.id,
      },
      actor,
    );
  }
  return review;
}

// ---------------------------------------------------------------- 结论与评论

export async function giveVerdict(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  reviewId: string,
  rawInput: ReviewVerdictIn,
): Promise<Review> {
  const input = parse(ReviewVerdictInput, rawInput);
  const db = ctx.db.db;
  const userId = actor.kind === 'user' ? actor.id : null;
  const comment = input.comment?.trim() ?? '';
  const writeComment = comment.length > 0 || input.verdict !== 'commented';

  const events = await db.transaction(async (tx) => {
    // 锁住审阅行：与并发的关闭 / 其他人的结论串行，关闭状态和最终 status 都以锁内读到的为准
    const [review] = await tx
      .select()
      .from(reviews)
      .where(and(eq(reviews.projectId, projectId), eq(reviews.id, reviewId)))
      .for('update');
    if (!review) notFound('审阅');
    const [me] = userId
      ? await tx
          .select()
          .from(reviewParticipants)
          .where(
            and(eq(reviewParticipants.reviewId, review.id), eq(reviewParticipants.userId, userId)),
          )
      : [];
    if (!userId || !me) throw new ApiError('forbidden', '只有被邀请的审阅人可以给出结论');
    if (review.status === 'closed') {
      throw new ApiError('conflict', '这个审阅已经关闭，不能再给出结论。如需继续，请重新发起审阅');
    }

    const now = new Date();
    await tx
      .update(reviewParticipants)
      // 和 GitHub 一样：只评论不会撤销自己之前的 LGTM / 要求修改
      .set({
        verdict:
          input.verdict === 'commented' &&
          (me.verdict === 'lgtm' || me.verdict === 'changes_requested')
            ? me.verdict
            : input.verdict,
        updatedAt: now,
      })
      .where(
        and(eq(reviewParticipants.reviewId, review.id), eq(reviewParticipants.userId, userId)),
      );

    const out: ProjectEvent[] = [];
    if (writeComment) {
      const [c] = await tx
        .insert(reviewComments)
        .values({
          id: monotonicId('reviewComment'),
          reviewId: review.id,
          author: actor,
          body: comment || (DEFAULT_VERDICT_BODY[input.verdict] ?? ''),
          verdict: input.verdict,
          anchor: null,
          createdAt: now,
        })
        .returning();
      if (!c) throw new Error('审阅评论写入失败');
      out.push(
        (await ctx.bus.record(tx, {
          projectId,
          threadId: review.threadId,
          type: 'review.comment_created',
          payload: toReviewComment(c),
          actor,
        })) as ProjectEvent,
      );
    }

    const all = await tx
      .select({ verdict: reviewParticipants.verdict })
      .from(reviewParticipants)
      .where(eq(reviewParticipants.reviewId, review.id));
    const status = computeReviewStatus(all.map((p) => p.verdict));
    const [row] = await tx
      .update(reviews)
      .set({ status, updatedAt: now })
      .where(eq(reviews.id, review.id))
      .returning();
    if (!row) notFound('审阅');
    const dto = await toDto(tx, row);
    const updated = await ctx.bus.record(tx, {
      projectId,
      threadId: dto.threadId,
      type: 'review.updated',
      payload: dto,
      actor,
    });
    out.push(updated as ProjectEvent);
    return { out, dto: updated.payload, userId };
  });
  for (const ev of events.out) ctx.bus.emit(ev);

  if (input.verdict === 'lgtm' || input.verdict === 'changes_requested') {
    await markInboxDoneBySource(ctx, projectId, reviewId, actor, events.userId);
  }
  return events.dto;
}

export async function addComment(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  reviewId: string,
  rawInput: ReviewCommentCreateIn,
): Promise<ReviewComment> {
  const input = parse(ReviewCommentCreateInput, rawInput);
  const db = ctx.db.db;
  const review = await findRow(db, projectId, reviewId);

  const result = await db.transaction(async (tx) => {
    const now = new Date();
    const [c] = await tx
      .insert(reviewComments)
      .values({
        id: monotonicId('reviewComment'),
        reviewId: review.id,
        author: actor,
        body: input.body,
        verdict: null,
        anchor: input.anchor,
        createdAt: now,
      })
      .returning();
    if (!c) throw new Error('审阅评论写入失败');
    const [row] = await tx
      .update(reviews)
      .set({ updatedAt: now })
      .where(eq(reviews.id, review.id))
      .returning();
    if (!row) notFound('审阅');
    const created = await ctx.bus.record(tx, {
      projectId,
      threadId: review.threadId,
      type: 'review.comment_created',
      payload: toReviewComment(c),
      actor,
    });
    const updated = await ctx.bus.record(tx, {
      projectId,
      threadId: review.threadId,
      type: 'review.updated',
      payload: await toDto(tx, row),
      actor,
    });
    return { created, updated };
  });
  ctx.bus.emit(result.created as ProjectEvent);
  ctx.bus.emit(result.updated as ProjectEvent);
  return result.created.payload;
}

export async function updateComment(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  reviewId: string,
  commentId: string,
  rawInput: ReviewCommentUpdateIn,
): Promise<ReviewComment> {
  const input = parse(ReviewCommentUpdateInput, rawInput);
  const db = ctx.db.db;
  const review = await findRow(db, projectId, reviewId);

  const event = await db.transaction(async (tx) => {
    const [c] = await tx
      .update(reviewComments)
      .set({ resolved: input.resolved })
      .where(and(eq(reviewComments.reviewId, review.id), eq(reviewComments.id, commentId)))
      .returning();
    if (!c) notFound('评论');
    return ctx.bus.record(tx, {
      projectId,
      threadId: review.threadId,
      type: 'review.comment_updated',
      payload: toReviewComment(c),
      actor,
    });
  });
  ctx.bus.emit(event as ProjectEvent);
  return event.payload;
}

// ---------------------------------------------------------------- 关闭

/** 发起人或负责人/导师（manage）可以关闭。 */
async function canClose(ctx: AppContext, actor: ActorRef, projectId: string, review: ReviewRow) {
  if (actor.id && review.requestedBy.kind === actor.kind && review.requestedBy.id === actor.id) {
    return true;
  }
  if (actor.kind !== 'user' || !actor.id) return false;
  const role = await memberRole(ctx, projectId, actor.id);
  return role !== null && roleCan(role, 'manage');
}

export async function closeReview(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  reviewId: string,
  /** force：系统关闭（改动提案合入后关掉它的审阅），不检查权限 */
  opts: { force?: boolean } = {},
): Promise<Review> {
  const db = ctx.db.db;
  const review = await findRow(db, projectId, reviewId);
  if (!opts.force && !(await canClose(ctx, actor, projectId, review))) {
    throw new ApiError('forbidden', '只有审阅的发起人、项目负责人或导师可以关闭审阅');
  }
  if (review.status === 'closed') throw new ApiError('conflict', '这个审阅已经关闭了');

  const event = await db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .update(reviews)
      .set({ status: 'closed', closedAt: now, updatedAt: now })
      .where(eq(reviews.id, review.id))
      .returning();
    if (!row) notFound('审阅');
    const dto = await toDto(tx, row);
    return ctx.bus.record(tx, {
      projectId,
      threadId: dto.threadId,
      type: 'review.updated',
      payload: dto,
      actor,
    });
  });
  ctx.bus.emit(event as ProjectEvent);
  await markInboxDoneBySource(ctx, projectId, review.id, actor);
  return event.payload;
}
