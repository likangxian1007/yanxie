import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ThreadSummary, ThreadWaiting } from '@srh/shared';
import type { AppContext } from '../../context';
import { decisions, inboxItems, outputs, projectMembers, reviews, threads } from '../../db/schema';
import { requireProject } from '../auth/guard';

type WaitingKind = ThreadWaiting['kind'];
const WAITING_KINDS: WaitingKind[] = ['decision', 'review', 'mention', 'conflict'];

/** 收件箱 href 里的线程 id：/p/:pid/threads/:tid[?…] */
export function threadIdFromHref(href: string): string | null {
  const m = /\/threads\/([A-Za-z0-9_]+)/.exec(href);
  return m?.[1] ?? null;
}

/**
 * 协作台线程面板的每线程汇总：产出数、未答决策数、在等哪些成员。
 * 只看项目线程（个人会话不出现在协作台，别人的也不能暴露）；“在等谁”只算仍是成员的人。
 */
export async function threadSummaries(
  ctx: AppContext,
  projectId: string,
): Promise<ThreadSummary[]> {
  const db = ctx.db.db;
  const rows = await db
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.projectId, projectId), eq(threads.kind, 'project')));
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];

  const [outputCounts, decisionCounts, inbox, members] = await Promise.all([
    db
      .select({ threadId: outputs.threadId, n: count() })
      .from(outputs)
      .where(and(eq(outputs.projectId, projectId), inArray(outputs.threadId, ids)))
      .groupBy(outputs.threadId),
    db
      .select({ threadId: decisions.threadId, n: count() })
      .from(decisions)
      .where(
        and(
          eq(decisions.projectId, projectId),
          eq(decisions.state, 'open'),
          inArray(decisions.threadId, ids),
        ),
      )
      .groupBy(decisions.threadId),
    db
      .select({
        userId: inboxItems.userId,
        kind: inboxItems.kind,
        href: inboxItems.href,
        sourceId: inboxItems.sourceId,
        createdAt: inboxItems.createdAt,
      })
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.projectId, projectId),
          isNull(inboxItems.doneAt),
          inArray(inboxItems.kind, WAITING_KINDS),
        ),
      ),
    db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId)),
  ]);

  // 审阅条目的 href 指向审阅页：经 reviews.threadId 找回线程
  const reviewIds = inbox.filter((i) => i.kind === 'review').map((i) => i.sourceId);
  const reviewThread = new Map<string, string>();
  if (reviewIds.length > 0) {
    const rs = await db
      .select({ id: reviews.id, threadId: reviews.threadId })
      .from(reviews)
      .where(inArray(reviews.id, reviewIds));
    for (const r of rs) if (r.threadId) reviewThread.set(r.id, r.threadId);
  }

  const memberIds = new Set(members.map((m) => m.userId));
  const idSet = new Set(ids);
  const waiting = new Map<string, ThreadWaiting[]>();
  const sorted = [...inbox].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const item of sorted) {
    if (!memberIds.has(item.userId)) continue;
    const tid =
      item.kind === 'review'
        ? (reviewThread.get(item.sourceId) ?? threadIdFromHref(item.href))
        : threadIdFromHref(item.href);
    if (!tid || !idSet.has(tid)) continue;
    const list = waiting.get(tid) ?? [];
    const kind = item.kind as WaitingKind;
    if (!list.some((w) => w.userId === item.userId && w.kind === kind)) {
      list.push({ userId: item.userId, kind, since: item.createdAt.toISOString() });
    }
    waiting.set(tid, list);
  }

  const outputsBy = new Map(outputCounts.map((r) => [r.threadId, Number(r.n)]));
  const decisionsBy = new Map(decisionCounts.map((r) => [r.threadId, Number(r.n)]));
  return ids.map((id) => ({
    threadId: id,
    outputs: outputsBy.get(id) ?? 0,
    openDecisions: decisionsBy.get(id) ?? 0,
    waitingOn: waiting.get(id) ?? [],
  }));
}

/** GET P/thread-summaries（view 权限）。在 threads 模块的 register 里调用一次。 */
export function registerThreadSummaries(app: FastifyInstance) {
  const ctx = app.ctx;
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/thread-summaries',
    async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      return threadSummaries(ctx, req.params.projectId);
    },
  );
}
