import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  newId,
  NOTIFY_DEFAULT_EVENTS,
  NOTIFY_DISABLE_AFTER,
  NOTIFY_RETRY_DELAYS_SEC,
  type NotifyEventType,
  type NotifyProvider,
} from '@srh/shared';
import type { AppContext } from '../../context';
import {
  messages,
  notifyDeliveries,
  notifySubscriptions,
  projectMembers,
  projects,
  threads,
} from '../../db/schema';
import { createInboxItem } from '../collab-common/inbox';
import { buildMessage, postWebhook } from './deliver';

/**
 * 通知的"邮差"（`modules/notify/pump.ts`）。
 *
 * 两件事：
 * 1. 监听项目事件 → 找到匹配的订阅 → 往 `notify_deliveries` 里写一条待发记录（幂等）
 * 2. 定时把到期的待发记录发出去；失败按 1m/5m/30m/2h/6h 重试，5 次后放弃；
 *    订阅连续失败 NOTIFY_DISABLE_AFTER 次自动停用
 *
 * **隐私红线**（这段代码里最重要的部分）：
 * - 旁聊（`agentVisible === false`）一律不发
 * - 个人线程只发给线程主人
 * - 收件箱事件只发给该条目的主人
 * 只发标题 + 一句话 + 链接，从正文到不了通知里。
 */

const SUBSCRIBABLE = new Set<string>([
  'inbox.created',
  'message.created',
  'thread.updated',
  'decision.updated',
  'review.updated',
  'claim.conflict',
  'report.updated',
]);

/** 事件对"谁能看到"的判定结果：null = 项目内可见；string = 只有这个人能看 */
interface Audience {
  ownerUserId: string | null;
  /** true = 整条事件不该进任何通知（比如旁聊） */
  skip: boolean;
}

/**
 * 收件箱条目的来源是否允许外发通知。
 *
 * 为什么要单独查：`timeline/mentions.ts` 会给**旁聊**（`agentVisible=false`）里的 @ 也建收件箱条目，
 * 标题还嵌了原文前 40 字。只看"条目主人是我"就发，等于把旁聊片段推到群里。
 */
async function inboxSourceVisible(
  ctx: AppContext,
  kind: string,
  sourceId: string,
): Promise<boolean> {
  // 只有 @ 提醒的标题才含正文片段；其它 kind 的标题是系统生成的文案
  if (kind !== 'mention' || !sourceId) return true;
  const [row] = await ctx.db.db
    .select({
      agentVisible: messages.agentVisible,
      threadId: messages.threadId,
      deletedAt: messages.deletedAt,
    })
    .from(messages)
    .where(eq(messages.id, sourceId));
  if (!row || row.deletedAt) return false;
  if (row.agentVisible === false) return false; // 旁聊：一律不外发
  if (row.threadId) {
    const [thread] = await ctx.db.db
      .select({ kind: threads.kind })
      .from(threads)
      .where(eq(threads.id, row.threadId));
    if (thread?.kind === 'personal') return false; // 个人线程：不外发
  }
  return true;
}

async function resolveAudience(
  ctx: AppContext,
  event: { type: string; threadId: string | null; payload: unknown },
): Promise<Audience> {
  const payload = event.payload as Record<string, unknown>;

  if (event.type === 'inbox.created') {
    const owner = typeof payload.userId === 'string' ? payload.userId : null;
    if (!owner) return { ownerUserId: null, skip: true };
    const kind = typeof payload.kind === 'string' ? payload.kind : '';
    const sourceId = typeof payload.sourceId === 'string' ? payload.sourceId : '';
    const visible = await inboxSourceVisible(ctx, kind, sourceId);
    return { ownerUserId: owner, skip: !visible };
  }

  if (event.type === 'message.created' || event.type === 'thread.updated') {
    // 旁聊：协调者都看不到，绝不能进通知
    if (event.type === 'message.created' && payload.agentVisible === false) {
      return { ownerUserId: null, skip: true };
    }
    const threadId = event.threadId ?? (typeof payload.id === 'string' ? payload.id : null);
    if (threadId) {
      const [row] = await ctx.db.db
        .select({ kind: threads.kind, ownerUserId: threads.ownerUserId })
        .from(threads)
        .where(eq(threads.id, threadId));
      // 个人线程只发给主人
      if (row?.kind === 'personal') {
        return { ownerUserId: row.ownerUserId, skip: row.ownerUserId === null };
      }
    }
    return { ownerUserId: null, skip: false };
  }

  // 其余（决策卡 / 审阅 / 认领冲突 / 汇报）按项目可见处理
  return { ownerUserId: null, skip: false };
}

/** 收件箱条目类型 → 固定文案（**不得**使用条目自带的 title：@ 提醒的 title 里嵌着正文片段） */
const INBOX_PHRASE: Record<string, string> = {
  decision: '有一张决策卡等你拍板',
  review: '有人请你审阅',
  mention: '有人在团队讨论里 @ 了你',
  conflict: '出现认领冲突，需要你决定',
  assignment: '有活派给你',
  finished: '你发起的线程完成了',
  recheck: '有内容需要你复核',
};

/**
 * 把事件变成「一句话事件说明 + 链接」。
 *
 * **内容红线（本次评审确认）**：通知里**只发事件说明和链接，不发正文片段**。
 * 所以这里既不读 `payload.body`，也不读 `payload.title`（收件箱标题可能嵌着正文前 40 字），
 * 只用事件类型 / 收件箱 kind / 作者名 / 项目名拼一句固定说明。
 */
async function composeText(
  ctx: AppContext,
  event: {
    type: string;
    projectId: string;
    payload: unknown;
    actor: { name: string };
  },
): Promise<string> {
  const payload = event.payload as Record<string, unknown>;
  const [project] = await ctx.db.db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, event.projectId));
  const projectName = project?.name ?? '项目';
  const link = (href: unknown) =>
    typeof href === 'string' ? `${ctx.config.PUBLIC_URL}${href}` : ctx.config.PUBLIC_URL;

  if (event.type === 'inbox.created') {
    const kind = typeof payload.kind === 'string' ? payload.kind : '';
    const phrase = INBOX_PHRASE[kind] ?? '你有新的待处理事项';
    return `【研协 Thinkloft】「${projectName}」${phrase}\n${link(payload.href)}`;
  }
  if (event.type === 'message.created') {
    const tid = typeof payload.threadId === 'string' ? payload.threadId : null;
    const href = tid ? `/p/${event.projectId}/workspace/${tid}` : `/p/${event.projectId}`;
    return `【研协 Thinkloft】${event.actor.name} 在「${projectName}」发了新消息\n${link(href)}`;
  }
  if (event.type === 'thread.updated') {
    return `【研协 Thinkloft】「${projectName}」的线程有新进展\n${link(`/p/${event.projectId}`)}`;
  }
  if (event.type === 'decision.updated') {
    return `【研协 Thinkloft】「${projectName}」的决策卡状态变了\n${link(`/p/${event.projectId}`)}`;
  }
  if (event.type === 'review.updated') {
    return `【研协 Thinkloft】「${projectName}」的审阅状态变了\n${link(`/p/${event.projectId}`)}`;
  }
  if (event.type === 'claim.conflict') {
    return `【研协 Thinkloft】「${projectName}」出现认领冲突，请到项目里看一下\n${link(`/p/${event.projectId}`)}`;
  }
  if (event.type === 'report.updated') {
    return `【研协 Thinkloft】「${projectName}」的汇报更新了\n${link(`/p/${event.projectId}`)}`;
  }
  return `【研协 Thinkloft】「${projectName}」有新动态\n${link(`/p/${event.projectId}`)}`;
}

/**
 * 事件 → 待发记录。幂等靠 `notify_deliv_idem_uq`（同订阅 + 同项目 + 同 seq 只写一条），
 * 所以重连、重复广播都不会导致用户收到两遍。
 */
export async function enqueueEvent(
  ctx: AppContext,
  event: {
    type: string;
    projectId: string;
    seq: number;
    threadId: string | null;
    payload: unknown;
    actor: { name: string };
  },
): Promise<void> {
  if (!SUBSCRIBABLE.has(event.type)) return;

  const audience = await resolveAudience(ctx, event);
  if (audience.skip) return;

  const conditions = [
    eq(notifySubscriptions.enabled, true),
    or(isNull(notifySubscriptions.projectId), eq(notifySubscriptions.projectId, event.projectId))!,
    // 仍然要是成员（被移出项目的人不该继续收到通知）
    eq(projectMembers.projectId, event.projectId),
  ];
  if (audience.ownerUserId) conditions.push(eq(notifySubscriptions.userId, audience.ownerUserId));

  const rows = await ctx.db.db
    .select({ sub: notifySubscriptions })
    .from(notifySubscriptions)
    .innerJoin(
      projectMembers,
      and(
        eq(projectMembers.userId, notifySubscriptions.userId),
        eq(projectMembers.projectId, event.projectId),
      ),
    )
    .where(and(...conditions));
  if (rows.length === 0) return;

  const text = await composeText(ctx, event);
  const payload = { type: event.type, seq: event.seq, text };

  for (const { sub } of rows) {
    const wanted = sub.eventTypes.length > 0 ? sub.eventTypes : NOTIFY_DEFAULT_EVENTS;
    if (!wanted.includes(event.type as NotifyEventType)) continue;
    await ctx.db.db
      .insert(notifyDeliveries)
      .values({
        id: newDeliveryId(),
        subscriptionId: sub.id,
        projectId: event.projectId,
        eventSeq: event.seq,
        eventType: event.type,
        payload,
        text,
        status: 'pending',
        nextAttemptAt: new Date(),
      })
      .onConflictDoNothing();
  }
}

/** 本地生成 id */
function newDeliveryId(): string {
  return newId('notifyDelivery');
}

/**
 * 把到期的待发记录发出去。
 * 返回本轮处理了多少条（测试里可以直接调，不依赖真实定时器）。
 */
export async function flushPending(ctx: AppContext, limit = 20): Promise<number> {
  const rows = await ctx.db.db
    .select({ d: notifyDeliveries, s: notifySubscriptions })
    .from(notifyDeliveries)
    .innerJoin(notifySubscriptions, eq(notifySubscriptions.id, notifyDeliveries.subscriptionId))
    .where(
      and(
        inArray(notifyDeliveries.status, ['pending', 'failed']),
        or(
          isNull(notifyDeliveries.nextAttemptAt),
          lte(notifyDeliveries.nextAttemptAt, new Date()),
        )!,
      ),
    )
    .limit(limit);

  for (const { d, s } of rows) {
    // 发送前必须重新核验：入队时是成员，不代表现在还是（期间可能被移出项目或项目归档）。
    // 失权就终止投递，不能把项目内容继续推给他配置的群。
    const [stillMember] = await ctx.db.db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .innerJoin(
        projects,
        and(eq(projects.id, projectMembers.projectId), isNull(projects.archivedAt)),
      )
      .where(and(eq(projectMembers.projectId, d.projectId), eq(projectMembers.userId, s.userId)));
    if (!stillMember) {
      await ctx.db.db
        .update(notifyDeliveries)
        .set({ status: 'dropped', error: '已失去项目访问权限，终止投递', nextAttemptAt: null })
        .where(eq(notifyDeliveries.id, d.id));
      continue;
    }

    if (!s.enabled) {
      await ctx.db.db
        .update(notifyDeliveries)
        .set({ status: 'dropped', error: '订阅已停用' })
        .where(eq(notifyDeliveries.id, d.id));
      continue;
    }

    const result = await postWebhook(
      s.url,
      buildMessage(s.provider as NotifyProvider, d.text),
      s.provider as NotifyProvider,
    );
    const attempts = d.attempts + 1;

    if (result.ok) {
      await ctx.db.db
        .update(notifyDeliveries)
        .set({
          status: 'success',
          attempts,
          responseStatus: result.status,
          responseSnippet: result.snippet,
          error: null,
          nextAttemptAt: null,
        })
        .where(eq(notifyDeliveries.id, d.id));
      await ctx.db.db
        .update(notifySubscriptions)
        .set({ lastSuccessAt: new Date(), failureStreak: 0 })
        .where(eq(notifySubscriptions.id, s.id));
      continue;
    }

    const isLast = attempts >= NOTIFY_RETRY_DELAYS_SEC.length;
    const delay =
      NOTIFY_RETRY_DELAYS_SEC[Math.min(attempts - 1, NOTIFY_RETRY_DELAYS_SEC.length - 1)]!;
    await ctx.db.db
      .update(notifyDeliveries)
      .set({
        status: isLast ? 'dropped' : 'failed',
        attempts,
        responseStatus: result.status,
        responseSnippet: result.snippet,
        error: result.error ?? '发送失败',
        nextAttemptAt: isLast ? null : new Date(Date.now() + delay * 1000),
      })
      .where(eq(notifyDeliveries.id, d.id));

    const [updated] = await ctx.db.db
      .update(notifySubscriptions)
      .set({
        lastFailureAt: new Date(),
        failureStreak: sql`${notifySubscriptions.failureStreak} + 1`,
      })
      .where(eq(notifySubscriptions.id, s.id))
      .returning();

    // 连续失败太多次：自动停用，避免继续骚扰平台；并在主人收件箱留一条提醒
    if (updated && updated.failureStreak >= NOTIFY_DISABLE_AFTER && updated.enabled) {
      const reason = `连续失败 ${updated.failureStreak} 次，已自动停用`;
      await ctx.db.db
        .update(notifySubscriptions)
        .set({ enabled: false, disabledReason: reason })
        .where(eq(notifySubscriptions.id, s.id));
      // 收件箱提醒（用 sourceId 去重：同一个订阅反复停用只留一条）
      await createInboxItem(
        ctx,
        {
          projectId: d.projectId,
          userId: s.userId,
          kind: 'recheck',
          title: `你的通知订阅「${s.name}」${reason}，去设置里检查一下地址`,
          href: `/p/${d.projectId}/settings?tab=notify`,
          sourceId: `nsub:${s.id}`,
        },
        { kind: 'system', id: 'notify', name: '研协通知' },
      ).catch((err: unknown) => console.error('[notify] inbox reminder failed', err));
    }
  }
  return rows.length;
}

/**
 * 启动投递器：订阅事件总线 + 定时冲刷。
 * 返回停止函数（`app.onClose` 里调用）。
 */
export function startNotifyPump(ctx: AppContext): () => void {
  const stopBus = ctx.bus.onEvent((event) => {
    if (!ctx.config.NOTIFY_ENABLED) return;
    void enqueueEvent(ctx, event as never)
      .then(() => flushNow())
      .catch((err: unknown) => console.error('[notify] enqueue failed', err));
  });

  let flushing = false;
  async function flushNow(): Promise<void> {
    if (flushing || !ctx.config.NOTIFY_ENABLED) return;
    flushing = true;
    try {
      await flushPending(ctx);
    } catch (err) {
      console.error('[notify] flush failed', err);
    } finally {
      flushing = false;
    }
  }

  // 重试靠这个定时器；15 秒一轮，1 分钟级别的退避足够准
  const timer = setInterval(() => void flushNow(), 15_000);
  if (typeof timer.unref === 'function') timer.unref();

  return () => {
    clearInterval(timer);
    stopBus();
  };
}
