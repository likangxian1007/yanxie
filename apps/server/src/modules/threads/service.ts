import { defaultModelId, modelCatalog } from '../../agents/llm/registry';
import { and, count, desc, eq, inArray, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import {
  ApiError,
  newId,
  type ActorRef,
  type Decision,
  type DecisionOption,
  type Page,
  type ReasoningEffort,
  type StatusBucket,
  type Thread,
  type ThreadKind,
} from '@srh/shared';
import type { AppContext } from '../../context';
import {
  agentSessions,
  decisions,
  messages,
  outputs,
  reviews,
  routines,
  threads,
  workClaims,
} from '../../db/schema';
import { createInboxItem, markInboxDoneBySource } from '../inbox/service';
import { createMessage, excerpt, getMessageRow, republishMessage } from '../timeline/service';

export type ThreadRow = typeof threads.$inferSelect;
type DecisionRow = typeof decisions.$inferSelect;
export const SYSTEM: ActorRef = { kind: 'system', id: null, name: '系统' };

async function sessionByThread(ctx: AppContext, threadIds: string[]) {
  if (threadIds.length === 0) return new Map<string, typeof agentSessions.$inferSelect>();
  const rows = await ctx.db.db
    .select()
    .from(agentSessions)
    .where(inArray(agentSessions.threadId, threadIds));
  return new Map(rows.map((r) => [r.threadId!, r]));
}

export async function toThreads(ctx: AppContext, rows: ThreadRow[]): Promise<Thread[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [sessions, counts] = await Promise.all([
    sessionByThread(ctx, ids),
    ctx.db.db
      .select({ threadId: messages.threadId, n: count() })
      .from(messages)
      .where(and(inArray(messages.threadId, ids), isNull(messages.deletedAt)))
      .groupBy(messages.threadId),
  ]);
  const countBy = new Map(counts.map((c) => [c.threadId, Number(c.n)]));
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    kind: r.kind,
    rootMessageId: r.rootMessageId,
    title: r.title,
    label: r.label,
    ownerUserId: r.ownerUserId,
    statusBucket: r.statusBucket,
    statusText: r.statusText,
    resolved: r.resolved,
    // 个人会话的根消息也在线程里，不算回复
    replyCount: Math.max(0, (countBy.get(r.id) ?? 0) - (r.kind === 'personal' ? 1 : 0)),
    forwardedAt: r.forwardedAt?.toISOString() ?? null,
    agentSessionId: sessions.get(r.id)?.id ?? null,
    lastActivityAt: r.lastActivityAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function toThread(ctx: AppContext, row: ThreadRow): Promise<Thread> {
  return (await toThreads(ctx, [row]))[0]!;
}

export async function getThreadRow(ctx: AppContext, projectId: string, threadId: string) {
  const [row] = await ctx.db.db
    .select()
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.projectId, projectId)));
  return row ?? null;
}

/** 人能否看到这个线程：项目线程所有成员可见；个人线程只有主人 */
export function threadVisibleTo(row: ThreadRow, userId: string): boolean {
  return row.kind === 'project' || row.ownerUserId === userId;
}

export async function requireVisibleThread(
  ctx: AppContext,
  projectId: string,
  threadId: string,
  userId: string,
): Promise<ThreadRow> {
  const row = await getThreadRow(ctx, projectId, threadId);
  if (!row || !threadVisibleTo(row, userId)) throw new ApiError('not_found', '线程不存在');
  return row;
}

export async function listThreads(
  ctx: AppContext,
  projectId: string,
  viewerUserId: string | null,
  q: {
    kind?: ThreadKind | undefined;
    bucket?: StatusBucket | undefined;
    resolved?: boolean | undefined;
    cursor?: string | undefined;
    limit: number;
  },
): Promise<Page<Thread>> {
  const conds: SQL[] = [eq(threads.projectId, projectId)];
  const kind = q.kind ?? 'project';
  conds.push(eq(threads.kind, kind));
  // 个人会话只返回自己的；agent（viewer=null）只能列项目线程
  if (kind === 'personal') {
    if (!viewerUserId) return { items: [], nextCursor: null };
    conds.push(eq(threads.ownerUserId, viewerUserId));
  }
  if (q.bucket) conds.push(eq(threads.statusBucket, q.bucket));
  if (q.resolved !== undefined) conds.push(eq(threads.resolved, q.resolved));
  if (q.cursor) conds.push(lt(threads.id, q.cursor));
  const rows = await ctx.db.db
    .select()
    .from(threads)
    .where(and(...conds))
    .orderBy(desc(threads.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return {
    items: await toThreads(ctx, page),
    nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

async function publishThread(ctx: AppContext, row: ThreadRow, actor: ActorRef, created = false) {
  const thread = await toThread(ctx, row);
  await ctx.bus.publish({
    projectId: row.projectId,
    threadId: row.id,
    type: created ? 'thread.created' : 'thread.updated',
    payload: thread,
    actor,
  });
  return thread;
}

/**
 * 新建项目线程（start_thread）。根消息唯一约束保证幂等：同一锚点已有线程时返回 { alreadyRunning: true }。
 * 同时建该线程的 agent 会话（working_for = 请求人）。
 */
export async function createProjectThread(
  ctx: AppContext,
  input: {
    projectId: string;
    rootMessageId: string;
    title: string;
    workingForUserId: string | null;
    actor: ActorRef;
  },
): Promise<{ thread: Thread; sessionId: string; alreadyRunning: boolean }> {
  const [existing] = await ctx.db.db
    .select()
    .from(threads)
    .where(eq(threads.rootMessageId, input.rootMessageId));
  if (existing) {
    const t = await toThread(ctx, existing);
    return { thread: t, sessionId: t.agentSessionId ?? '', alreadyRunning: true };
  }
  const id = newId('thread');
  const sessionId = newId('agentSession');
  try {
    const row = await ctx.db.db.transaction(async (tx) => {
      const [t] = await tx
        .insert(threads)
        .values({
          id,
          projectId: input.projectId,
          kind: 'project',
          rootMessageId: input.rootMessageId,
          title: input.title,
          ownerUserId: input.workingForUserId,
          statusBucket: 'working',
        })
        .returning();
      await tx.insert(agentSessions).values({
        id: sessionId,
        projectId: input.projectId,
        threadId: id,
        role: 'thread',
        status: 'queued',
        model: defaultModelId(ctx.config),
        workingForUserId: input.workingForUserId,
      });
      return t!;
    });
    const thread = await publishThread(ctx, row, input.actor, true);
    // 根消息的 rootOfThreadId 变了，推一次 message.updated 让时间线显示线程卡片
    const root = await getMessageRow(ctx, input.projectId, input.rootMessageId);
    if (root) await republishMessage(ctx, root, SYSTEM);
    return { thread, sessionId, alreadyRunning: false };
  } catch (err) {
    // 并发的另一个 start_thread 抢先了
    const [dup] = await ctx.db.db
      .select()
      .from(threads)
      .where(eq(threads.rootMessageId, input.rootMessageId));
    if (dup) {
      const t = await toThread(ctx, dup);
      return { thread: t, sessionId: t.agentSessionId ?? '', alreadyRunning: true };
    }
    throw err;
  }
}

/** 个人工作区新会话：线程 + 第一条消息（根消息在线程内，不上时间线）+ 个人 agent 会话 */
export async function createPersonalThread(
  ctx: AppContext,
  input: {
    projectId: string;
    user: { id: string; name: string };
    body: string;
    title?: string | undefined;
    /** 已校验过的 profile slug；null = 不用 profile */
    profile?: string | null | undefined;
    /** 已校验过的模型；未指定时沿用已有新会话默认 */
    model?: string | undefined;
    effort?: ReasoningEffort | null | undefined;
  },
): Promise<Thread> {
  const catalog = await modelCatalog(ctx, input.projectId);
  const available = catalog.providers.filter((p) => p.enabled).flatMap((p) => p.models);
  if (input.model && !available.some((m) => m.id === input.model))
    throw new ApiError('validation_failed', '所选模型在当前项目不可用，请重新选择');
  const initialModel = input.model || catalog.defaultModel || defaultModelId(ctx.config);
  const id = newId('thread');
  const msgId = newId('message');
  const title = input.title?.trim() || excerpt(input.body, 24);
  const actor: ActorRef = { kind: 'user', id: input.user.id, name: input.user.name };
  const row = await ctx.db.db.transaction(async (tx) => {
    const [t] = await tx
      .insert(threads)
      .values({
        id,
        projectId: input.projectId,
        kind: 'personal',
        rootMessageId: msgId,
        title,
        ownerUserId: input.user.id,
        statusBucket: 'working',
      })
      .returning();
    await tx.insert(agentSessions).values({
      id: newId('agentSession'),
      projectId: input.projectId,
      threadId: id,
      role: 'personal',
      status: 'queued',
      model: initialModel,
      effort: input.effort ?? null,
      workingForUserId: input.user.id,
      profile: input.profile ?? null,
    });
    return t!;
  });
  // 先发 thread.created，再发根消息（访问策略据此知道这是个人线程）
  const thread = await publishThread(ctx, row, actor, true);
  await createMessage(ctx, {
    id: msgId,
    projectId: input.projectId,
    threadId: id,
    author: actor,
    body: input.body,
  });
  return { ...thread, replyCount: 0 };
}

/**
 * 重新计算分栏（服务端规则，ARCHITECTURE §7.2.7），必要时刷新活跃时间，变化时发 thread.updated。
 *   resolved → completed；会话 failed → failed；会话 queued/running → working；
 *   有未答决策卡或 agent 发起、仍未结束的审阅 → blocked；最后一条消息出自 agent → review_ready；否则 idle。
 */
export async function refreshThread(
  ctx: AppContext,
  threadId: string,
  opts: { touch?: boolean; actor?: ActorRef; force?: boolean } = {},
): Promise<Thread | null> {
  const [row] = await ctx.db.db.select().from(threads).where(eq(threads.id, threadId));
  if (!row) return null;
  const bucket = await computeBucket(ctx, row);
  const changed = bucket !== row.statusBucket;
  if (!changed && !opts.touch && !opts.force) return null;
  const [updated] = await ctx.db.db
    .update(threads)
    .set({
      statusBucket: bucket,
      ...(opts.touch ? { lastActivityAt: new Date() } : {}),
    })
    .where(eq(threads.id, threadId))
    .returning();
  return publishThread(ctx, updated!, opts.actor ?? SYSTEM);
}

/** 一条消息是否以问题结尾（忽略结尾的链接、附件行和空白） */
export function endsWithQuestion(body: string): boolean {
  const lines = body
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter((l) => l && !/^!?\[[^\]]*\]\([^)]*\)$/u.test(l));
  const tail = lines.at(-1) ?? '';
  return /[?？]\s*[)）」』"”]*$/u.test(tail);
}

async function computeBucket(ctx: AppContext, row: ThreadRow): Promise<StatusBucket> {
  if (row.resolved) return 'completed';
  const [session] = await ctx.db.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.threadId, row.id));
  if (session?.status === 'failed') return 'failed';
  if (session && (session.status === 'running' || session.status === 'queued')) return 'working';
  const [openDecision] = await ctx.db.db
    .select({ id: decisions.id })
    .from(decisions)
    .where(and(eq(decisions.threadId, row.id), eq(decisions.state, 'open')))
    .limit(1);
  if (openDecision) return 'blocked';
  if (session) {
    const [openReview] = await ctx.db.db
      .select({ id: reviews.id })
      .from(reviews)
      .where(
        and(
          eq(reviews.projectId, row.projectId),
          inArray(reviews.status, ['open', 'changes_requested']),
          sql`${reviews.requestedBy}->>'id' = ${session.id}`,
        ),
      )
      .limit(1);
    if (openReview) return 'blocked';
  }
  const [last] = await ctx.db.db
    .select({ kind: messages.authorKind, body: messages.body, msgKind: messages.kind })
    .from(messages)
    .where(
      and(eq(messages.threadId, row.id), isNull(messages.deletedAt), ne(messages.kind, 'activity')),
    )
    .orderBy(desc(messages.id))
    .limit(1);
  if (last?.kind !== 'agent') return 'idle';
  // 个人问答会话没有「交付待验收」这回事（终验 R2：3 个个人问答全被标成待审阅）
  if (row.kind === 'personal') return 'idle';
  // 最后一条回复在问成员问题：是在等人回答，不是交付待验收
  // （决策卡已回答时不算：卡片本身由上面的 openDecision 判断）
  if (last.msgKind === 'text' && endsWithQuestion(last.body)) return 'blocked';
  return 'review_ready';
}

export async function updateThread(
  ctx: AppContext,
  row: ThreadRow,
  patch: {
    title?: string | undefined;
    label?: string | null | undefined;
    resolved?: boolean | undefined;
    statusText?: string | undefined;
  },
  actor: ActorRef,
): Promise<Thread> {
  const set: Partial<ThreadRow> = {};
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.statusText !== undefined) set.statusText = patch.statusText;
  if (patch.resolved !== undefined) set.resolved = patch.resolved;
  if (Object.keys(set).length === 0) return toThread(ctx, row);
  const [updated] = await ctx.db.db
    .update(threads)
    .set({ ...set, lastActivityAt: new Date() })
    .where(eq(threads.id, row.id))
    .returning();
  let result = updated!;
  const bucket = await computeBucket(ctx, result);
  if (bucket !== result.statusBucket) {
    [result] = (await ctx.db.db
      .update(threads)
      .set({ statusBucket: bucket })
      .where(eq(threads.id, row.id))
      .returning()) as [ThreadRow];
  }
  if (patch.resolved === true && !row.resolved) await onResolved(ctx, result, actor);
  return publishThread(ctx, result, actor);
}

/**
 * 删除个人会话（只有主人能删；项目线程是团队共享的记录，只能归档=解决，不能删）。
 * agent 正在回复时拒绝（409），避免运行中的 turn 写进已删的会话。
 * 一并删掉会话里的消息（级联决策卡、反应）、产出、认领；指向它的定时任务改为唤醒协调者。
 */
export async function deletePersonalThread(ctx: AppContext, row: ThreadRow, actor: ActorRef) {
  if (row.kind !== 'personal') throw new ApiError('forbidden', '项目线程不能删除，可以归档');
  const [session] = await ctx.db.db
    .select({ status: agentSessions.status })
    .from(agentSessions)
    .where(eq(agentSessions.threadId, row.id));
  if (session && (session.status === 'running' || session.status === 'queued')) {
    throw new ApiError('conflict', 'agent 正在回复，先停下再删除');
  }
  await ctx.db.db.transaction(async (tx) => {
    await tx.delete(messages).where(eq(messages.threadId, row.id));
    await tx.delete(outputs).where(eq(outputs.threadId, row.id));
    await tx.delete(workClaims).where(eq(workClaims.threadId, row.id));
    await tx
      .update(routines)
      .set({ targetThreadId: null })
      .where(eq(routines.targetThreadId, row.id));
    await tx.delete(threads).where(eq(threads.id, row.id));
  });
  await ctx.bus.publish({
    projectId: row.projectId,
    threadId: row.id,
    type: 'thread.deleted',
    payload: { id: row.id },
    actor,
  });
}

/** 线程解决：释放认领、给发起人发“已完成”收件箱、关掉本线程未答决策卡的收件箱 */
async function onResolved(ctx: AppContext, row: ThreadRow, actor: ActorRef) {
  const { releaseThreadClaims } = await import('../claims/service');
  await releaseThreadClaims(ctx, row.projectId, row.id, actor);
  if (row.kind === 'project' && row.ownerUserId && actor.id !== row.ownerUserId) {
    await createInboxItem(ctx, {
      projectId: row.projectId,
      userId: row.ownerUserId,
      kind: 'finished',
      title: `「${row.title}」已完成`,
      href: `/p/${row.projectId}/threads/${row.id}`,
      sourceId: row.id,
    });
  }
}

// ---------------------------------------------------------------- 决策卡

export function toDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    messageId: row.messageId,
    threadId: row.threadId,
    question: row.question,
    context: row.context,
    options: row.options,
    recommended: row.recommended,
    reason: row.reason,
    state: row.state,
    chosen: row.chosen,
    chosenBy: row.chosenBy ?? null,
    answeredAt: row.answeredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createDecision(
  ctx: AppContext,
  input: {
    projectId: string;
    threadId: string;
    actor: ActorRef;
    question: string;
    context?: string | undefined;
    options: DecisionOption[];
    recommended: number;
    reason?: string | undefined;
    /** 收件箱发给谁（线程为之工作的成员） */
    notifyUserId: string | null;
  },
): Promise<Decision> {
  if (input.recommended < 0 || input.recommended >= input.options.length) {
    throw new ApiError('bad_request', 'recommended 超出选项范围');
  }
  const decisionId = newId('decision');
  const messageId = newId('message');
  const draft: Decision = {
    id: decisionId,
    messageId,
    threadId: input.threadId,
    question: input.question,
    context: input.context ?? null,
    options: input.options,
    recommended: input.recommended,
    reason: input.reason ?? null,
    state: 'open',
    chosen: null,
    chosenBy: null,
    answeredAt: null,
    createdAt: new Date().toISOString(),
  };
  // 先写消息（decision 外键指向它），再写决策行
  await ctx.db.db.insert(messages).values({
    id: messageId,
    projectId: input.projectId,
    threadId: input.threadId,
    authorKind: input.actor.kind,
    authorId: input.actor.id,
    authorName: input.actor.name,
    kind: 'decision',
    body: input.question,
    meta: { decision: draft },
  });
  const [row] = await ctx.db.db
    .insert(decisions)
    .values({
      id: decisionId,
      messageId,
      projectId: input.projectId,
      threadId: input.threadId,
      question: input.question,
      context: input.context ?? null,
      options: input.options,
      recommended: input.recommended,
      reason: input.reason ?? null,
    })
    .returning();
  const decision = toDecision(row!);
  await ctx.db.db.update(messages).set({ meta: { decision } }).where(eq(messages.id, messageId));
  const msgRow = (await getMessageRow(ctx, input.projectId, messageId))!;
  const { toMessages } = await import('../timeline/service');
  const [message] = await toMessages(ctx, [msgRow]);
  await ctx.bus.publish({
    projectId: input.projectId,
    threadId: input.threadId,
    type: 'message.created',
    payload: message!,
    actor: input.actor,
  });
  await ctx.bus.publish({
    projectId: input.projectId,
    threadId: input.threadId,
    type: 'decision.created',
    payload: decision,
    actor: input.actor,
  });
  if (input.notifyUserId) {
    await createInboxItem(ctx, {
      projectId: input.projectId,
      userId: input.notifyUserId,
      kind: 'decision',
      title: input.question,
      href: `/p/${input.projectId}/threads/${input.threadId}?decision=${decisionId}`,
      sourceId: decisionId,
    });
  }
  await refreshThread(ctx, input.threadId, { touch: true });
  return decision;
}

export async function getDecisionRow(ctx: AppContext, projectId: string, decisionId: string) {
  const [row] = await ctx.db.db
    .select()
    .from(decisions)
    .where(and(eq(decisions.id, decisionId), eq(decisions.projectId, projectId)));
  return row ?? null;
}

/**
 * 回答（chosen 为序号）或撤回（chosen=null）决策卡。
 * 已被成员点选的卡片不能被 agent 改写；agent 只能以 close_decision 记录成员的文字回答。
 */
export async function settleDecision(
  ctx: AppContext,
  row: DecisionRow,
  chosen: number | null,
  actor: ActorRef,
): Promise<Decision> {
  if (row.state !== 'open') {
    if (actor.kind === 'user' && row.state === 'withdrawn' && chosen !== null) {
      // 成员仍可回答已撤回的卡片
    } else {
      throw new ApiError('conflict', '这张决策卡已经回答过了', { current: toDecision(row) });
    }
  }
  if (chosen !== null && (chosen < 0 || chosen >= row.options.length)) {
    throw new ApiError('validation_failed', '没有这个选项');
  }
  const [updated] = await ctx.db.db
    .update(decisions)
    .set(
      chosen === null
        ? { state: 'withdrawn', answeredAt: new Date(), chosenBy: actor }
        : { state: 'answered', chosen, chosenBy: actor, answeredAt: new Date() },
    )
    // 原子：只有状态仍是刚读到的那个时才写入；并发回答时后到的那个 409
    .where(and(eq(decisions.id, row.id), eq(decisions.state, row.state)))
    .returning();
  if (!updated) {
    const [current] = await ctx.db.db.select().from(decisions).where(eq(decisions.id, row.id));
    throw new ApiError('conflict', '这张决策卡已经回答过了', {
      ...(current ? { current: toDecision(current) } : {}),
    });
  }
  const decision = toDecision(updated);
  const [msg] = await ctx.db.db
    .update(messages)
    .set({ meta: { decision } })
    .where(eq(messages.id, row.messageId))
    .returning();
  if (msg) await republishMessage(ctx, msg, actor);
  await ctx.bus.publish({
    projectId: row.projectId,
    threadId: row.threadId,
    type: 'decision.updated',
    payload: decision,
    actor,
  });
  await markInboxDoneBySource(ctx, row.id, { kind: 'decision' });
  if (row.threadId) await refreshThread(ctx, row.threadId);
  return decision;
}
