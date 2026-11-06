import { randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { agentSessions, agentWakeups, threads } from '../../db/schema';
import { updateSession } from '../../modules/agents/service';
import { listDueRoutines, markRoutineRan } from '../../modules/routines/service';
import { createLlmClient } from '../llm/client';
import { createChatModel, createRoutedChatModel, type ChatModel } from '../llm/complete';
import { closeAllMcp, closeIdleMcp } from '../mcp/manager';
import { runtimeHooks } from './hooks';
import { createDepsWatcher } from './followups';
import { createRouter } from './router';
import { compact, loadHistory, RESUME_NOTE, runTurn, SHUTDOWN } from './turn';
import { enqueueWake, onWake } from './wake';

/**
 * agent 运行时：路由器（总线 → 唤醒）+ 调度器（每会话串行、全局并发上限）+ 停滞看守 + 定时任务。
 * 始终注册路由；调用时读取项目/平台模型，所以通过界面添加模型后不需要重启。
 * 没有可用模型的请求会明确失败，成员配置好模型后可重新发送。
 */
export interface AgentRuntimeOptions {
  /** 测试注入脚本化模型；不传则用 DeepSeek */
  model?: ChatModel;
  maxConcurrent?: number;
  /** 看守与定时任务的检查间隔 */
  tickMs?: number;
  stallMs?: number;
  /** 上游文档 / 实验改动后等多久再通知下游（默认 2 分钟） */
  depsDebounceMs?: number;
}

export interface AgentRuntime {
  stop: () => Promise<void>;
  /** 等所有排队与运行中的 turn 结束（测试用） */
  idle: () => Promise<void>;
  kick: (sessionId: string) => void;
  /** 立即处理等待中的上游变更通知（测试用） */
  flushDeps: () => Promise<void>;
}

export function startAgentRuntime(
  ctx: AppContext,
  opts: AgentRuntimeOptions = {},
): AgentRuntime | null {
  let model = opts.model;
  if (!model) {
    const llm = createLlmClient(ctx.config);
    // 每次请求按会话的模型 / 强度路由（agents/llm/registry.ts）
    model = createRoutedChatModel(ctx, llm ? createChatModel(llm) : null);
  }
  const chat = model;
  const instanceId = `inst_${randomBytes(6).toString('hex')}`;
  const maxConcurrent = opts.maxConcurrent ?? 4;
  const stallMs = opts.stallMs ?? 20 * 60 * 1000;
  const router = createRouter(ctx);
  const deps = createDepsWatcher(ctx, { debounceMs: opts.depsDebounceMs });

  const running = new Map<string, AbortController>();
  const again = new Set<string>();
  const queue: string[] = [];
  let stopped = false;
  let idleWaiters: (() => void)[] = [];
  let pendingRoutes = 0;

  const checkIdle = () => {
    if (running.size === 0 && queue.length === 0 && pendingRoutes === 0) {
      const w = idleWaiters;
      idleWaiters = [];
      w.forEach((fn) => fn());
    }
  };

  function kick(sessionId: string) {
    if (stopped) return;
    if (running.has(sessionId)) {
      again.add(sessionId);
      return;
    }
    if (!queue.includes(sessionId)) queue.push(sessionId);
    pump();
    // 并发已满、还在排队：标成 queued，线程卡片显示“排队中”
    if (queue.includes(sessionId)) void markQueued(sessionId);
  }

  async function markQueued(sessionId: string) {
    const [s] = await ctx.db.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId));
    if (
      s &&
      !running.has(sessionId) &&
      (s.status === 'idle' || s.status === 'failed' || s.status === 'stopped')
    ) {
      await updateSession(ctx, sessionId, { status: 'queued' }).catch(() => undefined);
      if (s.threadId) {
        const { refreshThread } = await import('../../modules/threads/service');
        await refreshThread(ctx, s.threadId).catch(() => undefined);
      }
    }
  }

  function pump() {
    while (!stopped && running.size < maxConcurrent && queue.length) {
      const sessionId = queue.shift()!;
      if (running.has(sessionId)) {
        again.add(sessionId);
        continue;
      }
      const ac = new AbortController();
      running.set(sessionId, ac);
      void runTurn({ ctx, model: chat, instanceId, signal: ac.signal }, sessionId)
        .catch((err: unknown) => console.error('[agent] 调度出错', err))
        .then(async (outcome) => {
          running.delete(sessionId);
          if (outcome === 'failed') await onFailed(sessionId);
          // turn 运行中又来了唤醒，或还有没消费的：再跑一轮
          if (again.delete(sessionId) || (await hasPending(sessionId))) {
            if (outcome !== 'locked') queue.push(sessionId);
          }
          pump();
          checkIdle();
        });
    }
    checkIdle();
  }

  async function hasPending(sessionId: string) {
    const [row] = await ctx.db.db
      .select({ id: agentWakeups.id })
      .from(agentWakeups)
      .where(
        and(
          eq(agentWakeups.sessionId, sessionId),
          isNull(agentWakeups.consumedAt),
          eq(agentWakeups.wakes, true),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  /** 线程 agent 失败：告诉协调者（stalled-thread） */
  async function onFailed(sessionId: string) {
    const [s] = await ctx.db.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId));
    if (!s?.threadId || s.role !== 'thread') return;
    await notifyStalled(s.projectId, s.threadId, '线程 agent 的上一轮出错失败了');
  }

  async function notifyStalled(projectId: string, threadId: string, why: string) {
    const [coord] = await ctx.db.db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.projectId, projectId), eq(agentSessions.role, 'coordinator')));
    const [t] = await ctx.db.db.select().from(threads).where(eq(threads.id, threadId));
    if (!coord || !t || t.resolved) return;
    await enqueueWake(ctx, coord, 'stalled-thread', {
      type: 'stalled',
      threadId,
      title: t.title,
      why,
    });
  }

  // 路由：总线事件 → 唤醒
  const offEvent = ctx.bus.onEvent((event) => {
    deps.onEvent(event);
    pendingRoutes += 1;
    void router
      .route(event)
      .catch((err: unknown) => console.error('[agent] 路由出错', err))
      .finally(() => {
        pendingRoutes -= 1;
        checkIdle();
      });
  });
  const offWake = onWake(kick);

  // 停滞看守 + 定时任务 + 崩溃恢复
  const stalledNotified = new Set<string>();
  async function tick() {
    const now = new Date();
    closeIdleMcp();
    // 过期锁（进程崩溃）：复位为 idle
    const stale = await ctx.db.db
      .update(agentSessions)
      .set({ lockedBy: null, lockedUntil: null, status: 'idle', currentTurnId: null })
      .where(
        and(
          lt(agentSessions.lockedUntil, now),
          inArray(agentSessions.status, ['running', 'queued']),
        ),
      )
      .returning({ id: agentSessions.id, projectId: agentSessions.projectId });
    // 进程崩溃时那一轮的唤醒已经消费掉了：补一条「接着做」，不然复位后没人叫醒它（终验 R3 D1）
    for (const s of stale) {
      if (running.has(s.id)) continue;
      await enqueueWake(ctx, { id: s.id, projectId: s.projectId }, 'resume', {
        type: 'system-note',
        text: RESUME_NOTE,
      });
    }

    // 线程 working 超过 stallMs 没有动静
    const stuck = await ctx.db.db
      .select()
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.role, 'thread'),
          eq(agentSessions.status, 'running'),
          lt(agentSessions.lastActivityAt, new Date(now.getTime() - stallMs)),
        ),
      );
    for (const s of stuck) {
      const key = `${s.id}:${s.lastActivityAt.getTime()}`;
      if (stalledNotified.has(key) || !s.threadId) continue;
      stalledNotified.add(key);
      await notifyStalled(
        s.projectId,
        s.threadId,
        `线程 agent 已经 ${Math.round(stallMs / 60000)} 分钟没有新步骤`,
      );
    }

    // 定时任务
    for (const r of await listDueRoutines(ctx, now)) {
      const target = r.targetThreadId
        ? (
            await ctx.db.db
              .select()
              .from(agentSessions)
              .where(eq(agentSessions.threadId, r.targetThreadId))
          )[0]
        : (
            await ctx.db.db
              .select()
              .from(agentSessions)
              .where(
                and(
                  eq(agentSessions.projectId, r.projectId),
                  eq(agentSessions.role, 'coordinator'),
                ),
              )
          )[0];
      await markRoutineRan(ctx, r.id, now);
      if (target) {
        await enqueueWake(ctx, target, 'routine', {
          type: 'routine',
          routineId: r.id,
          title: r.title,
          prompt: r.prompt,
        });
      }
    }
  }
  const timer = setInterval(() => {
    void tick().catch((err: unknown) => console.error('[agent] 看守出错', err));
  }, opts.tickMs ?? 30_000);
  timer.unref();

  // 启动时：接着处理积压的唤醒
  void (async () => {
    // 上一个进程没来得及收尾（被强杀、停机超时）：还标着 running 的会话复位，并补一条「接着做」。
    // 只有一个应用进程，启动时不会有别的实例在跑 turn。
    const orphaned = await ctx.db.db
      .update(agentSessions)
      .set({ lockedBy: null, lockedUntil: null, status: 'queued', currentTurnId: null })
      .where(eq(agentSessions.status, 'running'))
      .returning({ id: agentSessions.id, projectId: agentSessions.projectId });
    for (const s of orphaned) {
      await enqueueWake(ctx, s, 'resume', { type: 'system-note', text: RESUME_NOTE });
    }
    const rows = await ctx.db.db
      .selectDistinct({ id: agentWakeups.sessionId })
      .from(agentWakeups)
      .where(and(isNull(agentWakeups.consumedAt), eq(agentWakeups.wakes, true)));
    rows.forEach((r) => kick(r.id));
  })().catch((err: unknown) => console.error('[agent] 恢复积压唤醒失败', err));

  runtimeHooks.stopSession = async (sessionId) => {
    const ac = running.get(sessionId);
    ac?.abort();
    const i = queue.indexOf(sessionId);
    if (i >= 0) queue.splice(i, 1);
    // 跑的过程中又来的唤醒也不再续跑
    again.delete(sessionId);
    // 丢弃未处理的唤醒，避免停下后立刻又被拉起来
    await ctx.db.db
      .update(agentWakeups)
      .set({ consumedAt: new Date(), consumedTurnId: 'stopped' })
      .where(and(eq(agentWakeups.sessionId, sessionId), isNull(agentWakeups.consumedAt)));
    return Boolean(ac);
  };
  runtimeHooks.compactSession = async (sessionId) => {
    const [s] = await ctx.db.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId));
    if (!s) return false;
    const history = await loadHistory(ctx, s);
    return compact(ctx, chat, s, history.turns, 1, {
      projectId: s.projectId,
      modelId: s.model,
      effort: 'off',
    });
  };
  runtimeHooks.fireRoutine = async (_ctx, routine) => {
    const target = routine.targetThreadId
      ? (
          await ctx.db.db
            .select()
            .from(agentSessions)
            .where(eq(agentSessions.threadId, routine.targetThreadId))
        )[0]
      : (
          await ctx.db.db
            .select()
            .from(agentSessions)
            .where(
              and(
                eq(agentSessions.projectId, routine.projectId),
                eq(agentSessions.role, 'coordinator'),
              ),
            )
        )[0];
    if (!target) return;
    await markRoutineRan(ctx, routine.id, new Date());
    await enqueueWake(ctx, target, 'routine', {
      type: 'routine',
      routineId: routine.id,
      title: routine.title,
      prompt: routine.prompt,
    });
  };

  return {
    kick,
    flushDeps: () => deps.flush(),
    idle: () =>
      new Promise<void>((resolve) => {
        // 让刚发出的事件先进路由
        setTimeout(() => {
          if (running.size === 0 && queue.length === 0 && pendingRoutes === 0) resolve();
          else idleWaiters.push(resolve);
        }, 20);
      }),
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      offEvent();
      offWake();
      delete runtimeHooks.stopSession;
      delete runtimeHooks.fireRoutine;
      delete runtimeHooks.compactSession;
      void closeAllMcp();
      deps.stop();
      // 停机（部署重启）打断的一轮：turn 收尾时记成 queued 并补一条「接着做」，重启后自动恢复（终验 R3 D1）
      for (const ac of running.values()) ac.abort(SHUTDOWN);
      const deadline = Date.now() + 5000;
      while (running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    },
  };
}
