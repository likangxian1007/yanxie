import { and, desc, eq, gt, inArray, isNull, like, sql } from 'drizzle-orm';
import type { ActorRef, AnyProjectEvent } from '@srh/shared';
import type { AppContext } from '../../context';
import { agentSessions, agentSteps, agentWakeups, documents, threads } from '../../db/schema';
import { SYSTEM_ACTOR } from '../../modules/projects/service';
import { createMessage } from '../../modules/timeline/service';
import type { SessionRow } from '../tools/types';
import { enqueueWake } from './wake';

/**
 * 跨会话的「下一步」：平台替 agent 记住谁在等谁，免得要成员推（终验 R3）。
 *
 * - D2 线程交付 → 唤醒协调者推进下一阶段（notifyDelivered）。
 * - D5 上游产物改了 → 唤醒据它写过产出的线程去同步，并在线程里标出「可能已过期」（createDepsWatcher）。
 *   依赖关系不靠 agent 声明：会话读过（read_document / read_experiment）的东西就是上游，
 *   它建过 / 改过的文档（create_document / edit_document）就是下游。都从 agent_steps 里查，重启不丢。
 */

/** 每条线程每小时最多因交付唤醒协调者几次（防协调者与线程来回互相唤醒） */
const DELIVERY_WAKES_PER_HOUR = 6;

export async function notifyDelivered(ctx: AppContext, session: SessionRow): Promise<void> {
  if (session.role !== 'thread' || !session.threadId) return;
  const [t] = await ctx.db.db.select().from(threads).where(eq(threads.id, session.threadId));
  if (!t || t.kind !== 'project') return;
  const [coord] = await ctx.db.db
    .select()
    .from(agentSessions)
    .where(
      and(eq(agentSessions.projectId, session.projectId), eq(agentSessions.role, 'coordinator')),
    );
  if (!coord) return;
  const sameThread = sql`${agentWakeups.item}->>'threadId' = ${t.id}`;
  // 还有一条没处理的交付唤醒：合并，不重复排
  const [pending] = await ctx.db.db
    .select({ id: agentWakeups.id })
    .from(agentWakeups)
    .where(
      and(
        eq(agentWakeups.sessionId, coord.id),
        eq(agentWakeups.reason, 'thread-delivered'),
        isNull(agentWakeups.consumedAt),
        sameThread,
      ),
    )
    .limit(1);
  if (pending) return;
  const recent = await ctx.db.db
    .select({ id: agentWakeups.id })
    .from(agentWakeups)
    .where(
      and(
        eq(agentWakeups.sessionId, coord.id),
        eq(agentWakeups.reason, 'thread-delivered'),
        gt(agentWakeups.createdAt, new Date(Date.now() - 3600_000)),
        sameThread,
      ),
    );
  if (recent.length >= DELIVERY_WAKES_PER_HOUR) return;
  await enqueueWake(ctx, coord, 'thread-delivered', {
    type: 'thread-delivered',
    threadId: t.id,
    title: t.title,
    bucket: t.resolved ? 'completed' : t.statusBucket,
    statusText: t.statusText.slice(0, 1500),
  });
}

// ---------------------------------------------------------------- 上游变更 → 下游同步

const READ_TOOLS = ['read_document'];

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 这个会话建过 / 改过的文档 id */
async function writtenDocs(ctx: AppContext, sessionId: string): Promise<Set<string>> {
  const rows = await ctx.db.db
    .select({ kind: agentSteps.kind, name: agentSteps.name, content: agentSteps.content })
    .from(agentSteps)
    .where(
      and(
        eq(agentSteps.sessionId, sessionId),
        inArray(agentSteps.name, ['create_document', 'edit_document']),
        inArray(agentSteps.kind, ['tool_call', 'tool_result']),
      ),
    );
  const out = new Set<string>();
  for (const r of rows) {
    const j = parseJson(r.content);
    if (!j) continue;
    // edit_document 看调用参数；create_document 的 id 在结果里（失败的结果没有 doc_id）
    if (r.name === 'edit_document' && r.kind === 'tool_call' && typeof j.doc_id === 'string')
      out.add(j.doc_id);
    if (r.name === 'create_document' && r.kind === 'tool_result' && typeof j.doc_id === 'string')
      out.add(j.doc_id);
  }
  return out;
}

async function actorLabel(ctx: AppContext, actor: ActorRef): Promise<string> {
  if (actor.kind !== 'agent' || !actor.id) return actor.name;
  const [row] = await ctx.db.db
    .select({ title: threads.title, role: agentSessions.role })
    .from(agentSessions)
    .leftJoin(threads, eq(threads.id, agentSessions.threadId))
    .where(eq(agentSessions.id, actor.id));
  if (row?.role === 'coordinator') return `${actor.name}（协调者）`;
  return row?.title ? `${actor.name}（线程「${row.title}」）` : actor.name;
}

/** 上游 ref 被 actor 改了：找出读过它、并据此写过别的文档的会话，唤醒它们去同步 */
export async function notifyDownstream(
  ctx: AppContext,
  projectId: string,
  ref: string,
  refKind: 'document' | 'experiment',
  title: string,
  actor: ActorRef,
): Promise<string[]> {
  const reads = await ctx.db.db
    .select({ sessionId: agentSteps.sessionId, at: sql<Date>`max(${agentSteps.createdAt})` })
    .from(agentSteps)
    .innerJoin(agentSessions, eq(agentSessions.id, agentSteps.sessionId))
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        inArray(agentSessions.role, ['thread', 'personal']),
        eq(agentSteps.kind, 'tool_call'),
        inArray(agentSteps.name, READ_TOOLS),
        like(agentSteps.content, `%${ref}%`),
      ),
    )
    .groupBy(agentSteps.sessionId);
  const woken: string[] = [];
  for (const r of reads) {
    if (actor.kind === 'agent' && actor.id === r.sessionId) continue;
    const [s] = await ctx.db.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, r.sessionId));
    if (!s) continue;
    const written = await writtenDocs(ctx, s.id);
    written.delete(ref);
    if (written.size === 0) continue;
    const downstream = await ctx.db.db
      .select({ id: documents.id, title: documents.title })
      .from(documents)
      .where(
        and(
          eq(documents.projectId, projectId),
          inArray(documents.id, [...written]),
          isNull(documents.archivedAt),
        ),
      );
    if (downstream.length === 0) continue;
    // 上次读之后已经提醒过、它还没重新读：不重复提醒
    const lastRead = new Date(r.at);
    const [already] = await ctx.db.db
      .select({ id: agentWakeups.id })
      .from(agentWakeups)
      .where(
        and(
          eq(agentWakeups.sessionId, s.id),
          eq(agentWakeups.reason, 'upstream-changed'),
          gt(agentWakeups.createdAt, lastRead),
          sql`${agentWakeups.item}->>'ref' = ${ref}`,
        ),
      )
      .orderBy(desc(agentWakeups.id))
      .limit(1);
    if (already) continue;
    const by = await actorLabel(ctx, actor);
    if (s.threadId) {
      const names = downstream.map((d) => `「${d.title}」`).join('、');
      await createMessage(ctx, {
        projectId,
        threadId: s.threadId,
        author: SYSTEM_ACTOR,
        body: `「${title}」刚被${by}修改。这条线程依据它写的${names}可能已经过期，agent 正在核对并同步。`,
        meta: { upstreamChanged: { ref, refKind, downstream: downstream.map((d) => d.id) } },
      }).catch((err: unknown) => console.warn('[agent] 过期提示发送失败', err));
    }
    await enqueueWake(ctx, s, 'upstream-changed', {
      type: 'upstream-changed',
      ref,
      refKind,
      title,
      by,
      downstream,
    });
    woken.push(s.id);
  }
  return woken;
}

export interface DepsWatcher {
  onEvent: (event: AnyProjectEvent) => void;
  stop: () => void;
  /** 立即处理所有等待中的变更（测试用） */
  flush: () => Promise<void>;
}

/**
 * 监听文档 / 实验的内容变更，防抖后（默认 2 分钟，等改的人改完）通知下游。
 * 改的人是正在跑的 agent 时，等它这一轮结束再通知，免得下游同步到改了一半的版本。
 */
export function createDepsWatcher(
  ctx: AppContext,
  opts: { debounceMs?: number | undefined } = {},
): DepsWatcher {
  const debounceMs = opts.debounceMs ?? 120_000;
  type Pending = {
    projectId: string;
    ref: string;
    refKind: 'document' | 'experiment';
    title: string;
    actor: ActorRef;
    timer: ReturnType<typeof setTimeout>;
  };
  const pending = new Map<string, Pending>();
  let stopped = false;

  async function fire(key: string) {
    const p = pending.get(key);
    if (!p || stopped) return;
    if (p.actor.kind === 'agent' && p.actor.id) {
      const [s] = await ctx.db.db
        .select({ status: agentSessions.status })
        .from(agentSessions)
        .where(eq(agentSessions.id, p.actor.id));
      if (s && (s.status === 'running' || s.status === 'queued')) {
        p.timer = setTimeout(() => void fire(key), Math.min(debounceMs, 30_000));
        p.timer.unref?.();
        return;
      }
    }
    pending.delete(key);
    await notifyDownstream(ctx, p.projectId, p.ref, p.refKind, p.title, p.actor).catch(
      (err: unknown) => console.warn('[agent] 通知下游失败', err),
    );
  }

  function schedule(input: Omit<Pending, 'timer'>) {
    const key = `${input.projectId}:${input.ref}`;
    const prev = pending.get(key);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => void fire(key), debounceMs);
    timer.unref?.();
    pending.set(key, { ...input, timer });
  }

  return {
    onEvent(event) {
      if (stopped) return;
      if (event.type === 'document.updated') {
        const p = event.payload as {
          id: string;
          title: string;
          archivedAt: string | null;
          updatedAt: string;
        };
        if (p.archivedAt) return;
        // 改名 / 移动 / 图标也发 document.updated，但不改 updatedAt：只看刚写过内容的
        if (Math.abs(Date.now() - Date.parse(p.updatedAt)) > 15_000) return;
        schedule({
          projectId: event.projectId,
          ref: p.id,
          refKind: 'document',
          title: p.title,
          actor: event.actor,
        });
      }
    },
    stop() {
      stopped = true;
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
    },
    async flush() {
      for (const key of [...pending.keys()]) {
        const p = pending.get(key);
        if (p) clearTimeout(p.timer);
        await fire(key);
      }
    },
  };
}
