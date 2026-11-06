import { and, asc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { ApiError, newId, ulid, type AgentStepKind } from '@srh/shared';
import type { AppContext } from '../../context';
import {
  agentSessions,
  agentSteps,
  messages as messagesTable,
  projects,
  threads,
} from '../../db/schema';
import { toAgentStep, updateSession } from '../../modules/agents/service';
import { refreshThread } from '../../modules/threads/service';
import { AGENT_NAME, SYSTEM_ACTOR } from '../../modules/projects/service';
import { createMessage } from '../../modules/timeline/service';
import { recordOpsEvent } from '../../lib/ops-events';
import type { ChatMessage, ChatModel, ChatRequest, ChatToolCall } from '../llm/complete';
import { toolsFor } from '../tools';
import {
  ToolError,
  toolSpec,
  type SessionRow,
  type ToolContext,
  type ToolDef,
} from '../tools/types';
import { goalContinuation, prepareHarness } from '../harness';
import {
  clipToTokens,
  contextBudget,
  estimateTokens,
  historyBudget,
  messagesTokens,
  shrinkToolResults,
  SUMMARY_MAX_CHARS,
  turnsToKeep,
} from './budget';
import { buildSystemPrompt } from './context';
import { consumeWakeups, enqueueWake, pendingWakeups, renderWake, type WakeItem } from './wake';

/**
 * 一个 turn：取锁 → 取唤醒 → 组装上下文 → DeepSeek 工具循环（步骤落库、文字流式）→ 收尾。
 */
export const MAX_ROUNDS = 24;
/** 一轮用满步数后自动续跑的次数；再用满就停下并如实告诉成员 */
export const MAX_CONTINUATIONS = 2;
/** 剩这么多步时提醒 agent 收尾（写进度、交付已有结果） */
const WRAP_UP_AT = 4;
/** 每隔这么多步把任务目标重新放进提醒（终验 R2 #11：agent 中途凭空换成了别的任务） */
export const GOAL_REMINDER_EVERY = 8;

/**
 * 线程的任务锚点：标题 + 发起这条线程的原始消息（截断）+ /goal 目标。
 * 只给线程 agent 用；协调者和个人会话没有单一任务。
 */
export async function taskAnchor(
  ctx: AppContext,
  session: Pick<SessionRow, 'role' | 'goal'>,
  thread: { title: string; rootMessageId: string } | null,
): Promise<string | null> {
  if (!thread || session.role !== 'thread') return null;
  const [root] = await ctx.db.db
    .select({ body: messagesTable.body, authorName: messagesTable.authorName })
    .from(messagesTable)
    .where(eq(messagesTable.id, thread.rootMessageId));
  const body = root?.body.replace(/\s+/gu, ' ').trim() ?? '';
  const lines = [`线程「${thread.title}」`];
  if (body)
    lines.push(
      `发起消息（${root!.authorName}）：${body.length > 400 ? `${body.slice(0, 400)}…` : body}`,
    );
  if (session.goal) lines.push(`目标：${session.goal}`);
  return lines.join('\n');
}

export function goalReminder(anchor: string): string {
  return (
    `<system-note>提醒：你的任务只有这一件。\n${anchor}\n` +
    '对照一下：你刚才和接下来要做的每一步，是在做这件事吗？如果在做别的（没人提过的课题、和项目无关的文件），立刻停下回到任务本身；' +
    '判断要和工具结果一致。</system-note>'
  );
}
/** 停机（部署重启）时中止 turn 用的 abort reason，与成员点「停止」区分 */
export const SHUTDOWN = 'shutdown';
/** 被重启 / 崩溃打断后补发的「接着做」 */
export const RESUME_NOTE =
  '服务刚才重启，打断了你上一轮的工作（不是成员让你停的）。先看进度清单和思路里最后几步，接着把没做完的部分做完；' +
  '已经发出的回复和已经写好的内容不要重复。';
const LOCK_MS = 10 * 60 * 1000;
const TOOL_RESULT_CHARS = 12_000;
const STEP_CONTENT_CHARS = 60_000;

export interface TurnDeps {
  ctx: AppContext;
  model: ChatModel;
  instanceId: string;
  signal: AbortSignal;
}

export type TurnOutcome = 'done' | 'skipped' | 'failed' | 'stopped' | 'locked';

async function acquireLock(ctx: AppContext, sessionId: string, instanceId: string) {
  const now = new Date();
  const [row] = await ctx.db.db
    .update(agentSessions)
    .set({ lockedBy: instanceId, lockedUntil: new Date(now.getTime() + LOCK_MS) })
    .where(
      and(
        eq(agentSessions.id, sessionId),
        or(
          isNull(agentSessions.lockedUntil),
          lt(agentSessions.lockedUntil, now),
          eq(agentSessions.lockedBy, instanceId),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

async function releaseLock(ctx: AppContext, sessionId: string, instanceId: string) {
  await ctx.db.db
    .update(agentSessions)
    .set({ lockedBy: null, lockedUntil: null, currentTurnId: null })
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.lockedBy, instanceId)));
}

export async function runTurn(deps: TurnDeps, sessionId: string): Promise<TurnOutcome> {
  const { ctx, instanceId } = deps;
  const locked = await acquireLock(ctx, sessionId, instanceId);
  if (!locked) return 'locked';
  const turnId = `trn_${ulid()}`;
  try {
    const wakeRows = await pendingWakeups(ctx, sessionId);
    if (!wakeRows.some((w) => w.wakes)) {
      if (locked.status === 'queued') await updateSession(ctx, sessionId, { status: 'idle' });
      return 'skipped';
    }
    await consumeWakeups(
      ctx,
      wakeRows.map((w) => w.id),
      turnId,
    );
    const session = (await updateSession(ctx, sessionId, {
      status: 'running',
      currentTurnId: turnId,
      activity: '正在阅读新消息',
    }))!;
    if (session.threadId) await refreshThread(ctx, session.threadId);
    return await executeTurn(deps, session, turnId, wakeRows);
  } finally {
    await releaseLock(ctx, sessionId, instanceId);
  }
}

async function executeTurn(
  deps: TurnDeps,
  session: SessionRow,
  turnId: string,
  wakeRows: Awaited<ReturnType<typeof pendingWakeups>>,
): Promise<TurnOutcome> {
  const { ctx, model, signal } = deps;
  const [project] = await ctx.db.db
    .select()
    .from(projects)
    .where(eq(projects.id, session.projectId));
  const thread = session.threadId
    ? ((await ctx.db.db.select().from(threads).where(eq(threads.id, session.threadId)))[0] ?? null)
    : null;
  if (!project) return 'skipped';

  let stepIndex = 0;
  const recordStep = async (
    kind: AgentStepKind,
    content: string,
    data: Record<string, unknown> = {},
    name: string | null = null,
  ) => {
    const [row] = await ctx.db.db
      .insert(agentSteps)
      .values({
        id: newId('agentStep'),
        sessionId: session.id,
        turnId,
        index: stepIndex++,
        kind,
        name,
        content: content.slice(0, STEP_CONTENT_CHARS),
        data,
      })
      .returning();
    await ctx.bus.publish({
      projectId: session.projectId,
      threadId: session.threadId,
      type: 'agent.step',
      payload: toAgentStep(row!),
      actor: { kind: 'agent', id: session.id, name: AGENT_NAME },
    });
  };

  const wake = await renderWake(ctx, session, wakeRows);
  const harness = await prepareHarness(ctx, session, thread);
  // 计费：本轮请求人付；没有请求人（例行 / 后台唤醒）时由项目创建者付
  const billing: ChatRequest['billing'] = {
    payerUserId: wake.requesterUserId,
    projectId: session.projectId,
    note: 'agent',
  };
  // 内置工具 + harness 工具（load_skill / update_goal）+ 本会话可用的 MCP 工具；同名时内置优先
  const builtinTools = toolsFor(ctx, session.role);
  const builtinNames = new Set(builtinTools.map((t) => t.name));
  const tools = [...builtinTools, ...harness.tools.filter((t) => !builtinNames.has(t.name))];
  const tc: ToolContext = {
    ctx,
    session,
    project,
    thread,
    turnId,
    actor: { kind: 'agent', id: session.id, name: AGENT_NAME },
    requesterUserId: wake.requesterUserId,
    visible: new Set(),
    setActivity: async (text) => {
      await updateSession(ctx, session.id, { activity: text });
    },
  };
  const budget = contextBudget(ctx.config);
  const specs = tools.map(toolSpec);
  const specTokens = estimateTokens(JSON.stringify(specs));
  // system prompt 先组好：是否压缩按「整条 prompt」判断（system + 工具定义 + 历史 + 本轮唤醒）
  const buildSystem = async () =>
    // profile / skill 目录 / 目标 / MCP 说明放在稳定前缀之后，不破坏前缀缓存
    [
      await buildSystemPrompt(ctx, {
        session,
        project,
        thread,
        toolNames: tools.map((t) => t.name),
        requesterUserId: wake.requesterUserId,
        budget,
      }),
      ...harness.sections,
    ].join('\n\n');
  let system = await buildSystem();
  const wakeText = clipToTokens(
    wake.text,
    budget.wake,
    '\n…（本次唤醒内容超出预算，已截断；需要时用 read_thread / read_message 读原文）',
  );
  const wakeTokens = estimateTokens(wakeText) + specTokens;
  let history = await loadHistory(ctx, session);
  let room = historyBudget(budget, estimateTokens(system), wakeTokens);
  if (messagesTokens(history.messages) > room) {
    const keep = turnsToKeep(
      history.turns.map((t) => messagesTokens(t.messages)),
      room,
      budget,
    );
    const ok = await safeCompact(ctx, model, session, history.turns, keep, harness.route, billing);
    if (ok) {
      const fresh = (
        await ctx.db.db.select().from(agentSessions).where(eq(agentSessions.id, session.id))
      )[0]!;
      session.contextSummary = fresh.contextSummary;
      session.summaryThroughTurnId = fresh.summaryThroughTurnId;
      system = await buildSystem();
      history = await loadHistory(ctx, session);
      room = historyBudget(budget, estimateTokens(system), wakeTokens);
    }
    // 压缩失败（或压缩后仍然超）：本轮只带放得下的最近几个 turn，单个 turn 过大时由轮内裁剪兜底
    history = truncateHistory(history, room, session.id);
  }

  const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history.messages];
  const anchor = await taskAnchor(ctx, session, thread).catch(() => null);
  // 本轮新增消息从这里开始；轮内裁剪也会动更早（历史里）的工具结果
  messages.push({ role: 'user', content: wakeText });
  await recordStep('note', wakeText, { reason: wake.reason, round: 0 }, 'wake');

  const byName = new Map(tools.map((t) => [t.name, t]));
  const usage = { ...session.tokenUsage };
  let nudged = false;
  let finishedNaturally = false;
  // 本轮是不是自动续跑：只有续跑唤醒、没有新的成员消息时才累计次数
  const items = wakeRows.filter((w) => w.wakes).map((w) => w.item as unknown as WakeItem);
  const attempt = items.every((i) => i.type === 'continue')
    ? Math.max(0, ...items.map((i) => (i.type === 'continue' && !i.manual ? i.attempt : 0)))
    : 0;
  // 续跑轮一开始就把任务目标放进来：续跑没有新消息，最容易丢失方向
  if (anchor && attempt > 0) messages.push({ role: 'user', content: goalReminder(anchor) });

  try {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (signal.aborted) throw new DOMException('stopped', 'AbortError');
      // 运行中到达的新唤醒：在工具调用之间注入
      if (round > 1) {
        const fresh = (await pendingWakeups(ctx, session.id)).filter((w) => w.wakes);
        if (fresh.length) {
          await consumeWakeups(
            ctx,
            fresh.map((w) => w.id),
            turnId,
          );
          const inj = await renderWake(ctx, session, fresh);
          messages.push({ role: 'user', content: inj.text });
          await recordStep('note', inj.text, { reason: inj.reason, round }, 'wake');
        }
      }
      await ctx.db.db
        .update(agentSessions)
        .set({ lockedUntil: new Date(Date.now() + LOCK_MS) })
        .where(eq(agentSessions.id, session.id));

      // 轮内裁剪：工具往返越积越多时，把较早的工具输出换成一行占位，最近几条原样保留
      const shrunk = shrinkToolResults(messages, budget.prompt - specTokens, 4, 1);
      if (shrunk) {
        console.log(`[agent] 会话 ${session.id} 第 ${round} 步：省略了 ${shrunk} 条较早的工具输出`);
      }

      const res = await model.chat({
        messages,
        tools: specs,
        route: harness.route,
        billing,
        signal,
        onDelta: (delta) =>
          ctx.bus.ephemeral(session.projectId, 'agent.delta', {
            sessionId: session.id,
            threadId: session.threadId,
            turnId,
            delta,
          }),
      });
      usage.input += res.usage.input;
      usage.output += res.usage.output;
      usage.cached += res.usage.cached;
      // 用量实时更新（之前要等一轮结束才写，工作期间一直显示 0）
      await updateSession(ctx, session.id, { tokenUsage: { ...usage } }).catch(() => undefined);
      // 记下实际用的模型与强度（思路面板可见；切换后是否生效以此为准）
      const via = res.effort ? { model: res.model, effort: res.effort } : {};
      if (res.reasoning) await recordStep('thinking', res.reasoning, { round, ...via });
      if (res.content) await recordStep('text', res.content, { round, ...via });
      messages.push({ role: 'assistant', content: res.content || null, tool_calls: res.toolCalls });

      if (res.toolCalls.length === 0) {
        if (tc.visible.size === 0 && !nudged) {
          nudged = true;
          const note =
            '<system-note>工具之外写的文字没有人能看到。这一轮还没有对外可见的工具调用：请用 reply / post_message / update_status / react / no_reply_needed 之一结束本轮。</system-note>';
          messages.push({ role: 'user', content: note });
          await recordStep('note', note, { round }, 'nudge');
          continue;
        }
        finishedNaturally = true;
        break;
      }

      for (const call of res.toolCalls) {
        const result = await runTool(tc, byName, call, round, recordStep);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      // 本轮已经以 no_reply_needed 结束：不再继续
      if (
        tc.visible.has('no_reply_needed') &&
        res.toolCalls.every((c) => c.name === 'no_reply_needed')
      ) {
        finishedNaturally = true;
        break;
      }
      if (round === MAX_ROUNDS - WRAP_UP_AT) {
        const last = attempt >= MAX_CONTINUATIONS;
        const note = last
          ? `<system-note>这是最后一轮，只剩 ${WRAP_UP_AT} 步，之后这项工作会停下等成员。现在就交付：` +
            '先用 reply 把已经完成的成果（带链接）和还没做完的部分写清楚，再 update_status 把清单改成真实进度。不要再开新的检索或运行。</system-note>'
          : `<system-note>这一轮还剩 ${WRAP_UP_AT} 步（之后会自动接着跑一轮）。现在把已经拿到的结果落地：` +
            '写进文件或文档、update_status 把清单改成真实进度；不要再开新的检索。</system-note>';
        messages.push({ role: 'user', content: note });
        await recordStep('note', note, { round }, 'nudge');
      } else if (anchor && round % GOAL_REMINDER_EVERY === 0) {
        const note = goalReminder(anchor);
        messages.push({ role: 'user', content: note });
        await recordStep('note', note, { round }, 'goal_reminder');
      }
    }
    if (finishedNaturally) {
      // /goal 设定的持续目标还没完成：自动再推进一轮（有上限，见 agents/harness）
      const goalNote = await goalContinuation(ctx, session.id, turnId).catch(() => null);
      await finish(ctx, session, usage, goalNote ? 'queued' : 'idle');
      if (goalNote)
        await enqueueWake(ctx, session, 'continue', { type: 'system-note', text: goalNote });
      else if (tc.visible.has('reply')) await delivered(ctx, session);
      return 'done';
    }
    // 步数用满还没结束：自动续跑；续跑次数用完就如实停下
    if (attempt < MAX_CONTINUATIONS) {
      const next = attempt + 1;
      await recordStep(
        'note',
        `本轮用满了 ${MAX_ROUNDS} 步还没结束，自动续跑 ${next}/${MAX_CONTINUATIONS}`,
        { attempt: next },
        'round_limit',
      );
      await finish(ctx, session, usage, 'queued');
      await enqueueWake(ctx, session, 'continue', {
        type: 'continue',
        attempt: next,
        manual: false,
      });
      return 'done';
    }
    // 续跑次数用完：先停下等成员，不标成失败（终验 R2：只差一条交付消息时也显示「失败」）。
    // 这一轮里已经交付过（reply）就不再发系统帖，避免盖住交付消息。
    const why = `连续 ${MAX_CONTINUATIONS + 1} 轮都用满了步数（每轮 ${MAX_ROUNDS} 步）`;
    await recordStep('note', `${why}，先停下等成员`, { attempt }, 'round_limit');
    await finish(ctx, session, usage, 'idle');
    if (tc.visible.has('reply')) await delivered(ctx, session);
    else {
      await announceStop(
        ctx,
        session,
        `这项工作量比较大，${why}，先停下了。已完成的部分见进度清单和产出；点「继续」或在这里回一句，就会接着做剩下的。`,
      );
    }
    return 'done';
  } catch (err) {
    const aborted = signal.aborted || (err as Error).name === 'AbortError';
    if (signal.aborted && signal.reason === SHUTDOWN) {
      // 停机打断：不算成员中止，重启后接着做（终验 R3 D1：部署后协调者一直停在「已停止」）
      await recordStep('note', '服务重启，这一轮被打断；重启后自动接着做', {}, 'interrupted');
      await finish(ctx, session, usage, 'queued');
      await enqueueWake(ctx, session, 'resume', { type: 'system-note', text: RESUME_NOTE });
      return 'stopped';
    }
    await recordStep(
      'note',
      aborted ? '已被成员中止' : `出错：${(err as Error).message}`,
      // 带上错误码，前端据此给出入口（如余额不足 → 去充值）
      !aborted && err instanceof ApiError ? { code: err.code } : {},
      aborted ? 'stopped' : 'error',
    );
    await finish(ctx, session, usage, aborted ? 'stopped' : 'failed');
    if (!aborted) {
      console.error(`[agent] turn ${turnId} 失败`, err);
      // 运维后台：按指纹合并计数；recordOpsEvent 自己吞掉错误，不影响收尾
      void recordOpsEvent(ctx.db.db, {
        source: 'agent',
        level: 'error',
        message: `agent 回合失败：${(err as Error)?.message ?? String(err)}`,
        stack: (err as Error)?.stack,
        detail: { turnId, sessionId: session.id, projectId: session.projectId, role: session.role },
      });
      await announceStop(
        ctx,
        session,
        '这一轮出错停下了（模型接口或工具出错，详情在思路里）。点「继续」或在这里回一句，就会从停下的地方接着做。',
      ).catch(() => undefined);
    }
    return aborted ? 'stopped' : 'failed';
  }
}

async function runTool(
  tc: ToolContext,
  byName: Map<string, ToolDef>,
  call: ChatToolCall,
  round: number,
  recordStep: (
    k: AgentStepKind,
    c: string,
    d?: Record<string, unknown>,
    n?: string | null,
  ) => Promise<void>,
): Promise<string> {
  await recordStep('tool_call', call.arguments, { round, callId: call.id }, call.name);
  const def = byName.get(call.name);
  let output: unknown;
  let ok = true;
  if (!def) {
    ok = false;
    output = { error: `没有这个工具：${call.name}` };
  } else {
    try {
      const raw = call.arguments.trim() ? JSON.parse(call.arguments) : {};
      const parsed = def.schema.safeParse(raw);
      if (!parsed.success) {
        ok = false;
        output = {
          error: '参数不合法',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        };
      } else {
        output = await def.run(tc, parsed.data);
        if (def.visible) tc.visible.add(def.name);
      }
    } catch (err) {
      ok = false;
      if (err instanceof ToolError) output = { error: err.message, ...err.details };
      else if (err instanceof ApiError)
        output = { error: err.message, code: err.code, ...(err.details ?? {}) };
      else if (err instanceof SyntaxError) output = { error: `参数不是合法 JSON：${err.message}` };
      else {
        console.error(`[agent] 工具 ${call.name} 出错`, err);
        output = { error: `工具执行出错：${(err as Error).message}` };
      }
    }
  }
  const full = typeof output === 'string' ? output : JSON.stringify(output ?? { ok: true });
  await recordStep('tool_result', full, { round, callId: call.id, ok }, call.name);
  return full.length > TOOL_RESULT_CHARS
    ? `${full.slice(0, TOOL_RESULT_CHARS)}…（结果过长已截断，共 ${full.length} 字符）`
    : full;
}

/**
 * agent 停工时如实告诉成员：在它的线程 / 个人会话里发一条系统消息（协调者则发在时间线上）。
 * 系统消息不唤醒任何 agent。meta.agentStopped 供前端显示「继续」按钮。
 */
async function announceStop(ctx: AppContext, session: SessionRow, body: string) {
  await createMessage(ctx, {
    projectId: session.projectId,
    threadId: session.threadId,
    author: SYSTEM_ACTOR,
    body: session.threadId ? body : `协调者：${body}`,
    meta: { agentStopped: { sessionId: session.id } },
  });
}

/** 线程 agent 这一轮回帖交付了：唤醒协调者推进下一阶段（终验 R3 D2） */
async function delivered(ctx: AppContext, session: SessionRow) {
  const { notifyDelivered } = await import('./followups');
  await notifyDelivered(ctx, session).catch((err: unknown) =>
    console.warn('[agent] 通知协调者交付失败', err),
  );
}

async function finish(
  ctx: AppContext,
  session: SessionRow,
  usage: { input: number; output: number; cached: number },
  status: 'idle' | 'failed' | 'stopped' | 'queued',
) {
  await updateSession(ctx, session.id, {
    status,
    activity: null,
    tokenUsage: usage,
    currentTurnId: null,
  });
  if (session.threadId) {
    const claims = await import('../../modules/claims/service');
    if (status === 'queued') {
      // 自动续跑：工作还在进行，认领续期
      await claims
        .renewThreadClaims(ctx, session.projectId, session.threadId)
        .catch(() => undefined);
    } else {
      // 一轮结束（做完、出错、被中止）：agent 不在改了，认领全部放开，别让残留认领挡住别人；
      // 下一轮需要时重新认领（验收：LGTM 后残留 4 条“研协 正在改”要等 TTL 过期）
      await claims
        .releaseThreadClaims(ctx, session.projectId, session.threadId, {
          kind: 'agent',
          id: session.id,
          name: AGENT_NAME,
        })
        .catch(() => undefined);
    }
    await refreshThread(ctx, session.threadId);
  }
}

// ---------------------------------------------------------------- 历史与压缩

interface HistoryTurn {
  turnId: string;
  messages: ChatMessage[];
}

/** 从 agent_steps 重建摘要之后的各 turn（wake → assistant/tool 交替） */
export async function loadHistory(ctx: AppContext, session: SessionRow) {
  const conds = [eq(agentSteps.sessionId, session.id)];
  if (session.summaryThroughTurnId) conds.push(gt(agentSteps.turnId, session.summaryThroughTurnId));
  const rows = await ctx.db.db
    .select()
    .from(agentSteps)
    .where(and(...conds))
    .orderBy(asc(agentSteps.turnId), asc(agentSteps.index));
  const turns: HistoryTurn[] = [];
  let cur: HistoryTurn | null = null;
  let assistant: Extract<ChatMessage, { role: 'assistant' }> | null = null;
  const flush = () => {
    if (assistant && cur) cur.messages.push(assistant);
    assistant = null;
  };
  for (const s of rows) {
    if (!cur || cur.turnId !== s.turnId) {
      flush();
      cur = { turnId: s.turnId, messages: [] };
      turns.push(cur);
    }
    const round = Number((s.data as { round?: number }).round ?? 0);
    if (s.kind === 'note') {
      // 模型当时看到的提醒都要重放：唤醒、收尾提醒、任务目标提醒
      if (s.name === 'wake' || s.name === 'nudge' || s.name === 'goal_reminder') {
        flush();
        cur.messages.push({ role: 'user', content: s.content });
      }
    } else if (s.kind === 'text') {
      if (!assistant || (assistant as { round?: number }).round !== round) {
        flush();
        assistant = { role: 'assistant', content: s.content, tool_calls: [] };
        (assistant as { round?: number }).round = round;
      } else assistant.content = s.content;
    } else if (s.kind === 'tool_call') {
      if (!assistant || (assistant as { round?: number }).round !== round) {
        flush();
        assistant = { role: 'assistant', content: null, tool_calls: [] };
        (assistant as { round?: number }).round = round;
      }
      assistant.tool_calls!.push({
        id: String((s.data as { callId?: string }).callId),
        name: s.name ?? '',
        arguments: s.content,
      });
    } else if (s.kind === 'tool_result') {
      flush();
      const content =
        s.content.length > TOOL_RESULT_CHARS
          ? `${s.content.slice(0, TOOL_RESULT_CHARS)}…（截断）`
          : s.content;
      cur.messages.push({
        role: 'tool',
        tool_call_id: String((s.data as { callId?: string }).callId),
        content,
      });
    }
  }
  flush();
  // 去掉内部字段；保证每个 tool_call 都有结果（中途崩溃的 turn）
  for (const t of turns) t.messages = sanitize(t.messages);
  return { turns, messages: turns.flatMap((t) => t.messages) };
}

function sanitize(msgs: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.role === 'assistant') {
      const clean: ChatMessage = {
        role: 'assistant',
        content: m.content,
        ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
      };
      out.push(clean);
      const answered = new Set<string>();
      for (let j = i + 1; j < msgs.length && msgs[j]!.role === 'tool'; j++) {
        answered.add((msgs[j] as { tool_call_id: string }).tool_call_id);
      }
      let j = i + 1;
      for (; j < msgs.length && msgs[j]!.role === 'tool'; j++) out.push(msgs[j]!);
      for (const c of m.tool_calls ?? []) {
        if (!answered.has(c.id))
          out.push({ role: 'tool', tool_call_id: c.id, content: '{"error":"未完成"}' });
      }
      i = j - 1;
    } else if (m.role !== 'tool') out.push(m);
  }
  return out;
}

/**
 * 压缩失败或压缩后仍放不下时的兜底：从最新往前保留放得下的整 turn，丢掉更早的（不改库，下轮再试压缩）。
 * 一个都放不下时仍保留最新一个 turn（交给轮内裁剪去缩工具输出）。
 */
export function truncateHistory(
  history: { turns: HistoryTurn[]; messages: ChatMessage[] },
  room: number,
  sessionId = '',
): { turns: HistoryTurn[]; messages: ChatMessage[] } {
  if (messagesTokens(history.messages) <= room) return history;
  let sum = 0;
  let start = history.turns.length;
  for (let i = history.turns.length - 1; i >= 0; i--) {
    const t = messagesTokens(history.turns[i]!.messages);
    if (sum + t > room && start < history.turns.length) break;
    sum += t;
    start = i;
    if (sum > room) break;
  }
  const turns = history.turns.slice(start);
  if (start > 0) {
    console.warn(
      `[agent] 会话 ${sessionId} 历史超出预算，本轮丢掉了最早的 ${start} 个 turn（未写入摘要，下轮会重试压缩）`,
    );
  }
  return { turns, messages: turns.flatMap((t) => t.messages) };
}

/** compact 的容错包装：模型调用失败时记日志、返回 false，本轮改用截断历史 */
export async function safeCompact(
  ctx: AppContext,
  model: ChatModel,
  session: SessionRow,
  turns: HistoryTurn[],
  keep: number,
  route?: ChatRequest['route'],
  billing?: ChatRequest['billing'],
): Promise<boolean> {
  try {
    return await compact(ctx, model, session, turns, keep, route, billing);
  } catch (err) {
    console.error(
      `[agent] 会话 ${session.id} 压缩历史失败，本轮改用截断的历史：`,
      (err as Error)?.message ?? err,
    );
    return false;
  }
}

const COMPACT_SYSTEM =
  '你在为一个科研协作 agent 压缩它的对话历史。写一份中文摘要，保留：成员的请求与原话要点（标明是谁）、已作出的决定、已完成与未完成的工作、产出物的 id 和链接、持有的认领、待回答的问题。' +
  `只写事实，不写推测；整份摘要不超过 ${SUMMARY_MAX_CHARS} 字（超出部分会被截掉）。已有摘要里仍然有效的内容要保留下来。`;

function renderTranscript(msgs: ChatMessage[]): string[] {
  return msgs.map((m) => {
    if (m.role === 'assistant') {
      const calls = (m.tool_calls ?? []).map((c) => `调用 ${c.name}(${c.arguments.slice(0, 600)})`);
      return `[assistant] ${m.content ?? ''}\n${calls.join('\n')}`;
    }
    return `[${m.role}] ${(m.content ?? '').slice(0, 3000)}`;
  });
}

/** 按 token 预算把转录行切成若干块（单行超过预算时自己截断成一块） */
function chunkLines(lines: string[], maxTokens: number): string[] {
  const chunks: string[] = [];
  let cur: string[] = [];
  let tokens = 0;
  for (const raw of lines) {
    const line = clipToTokens(raw, maxTokens, '…（截断）');
    const t = estimateTokens(line) + 1;
    if (cur.length && tokens + t > maxTokens) {
      chunks.push(cur.join('\n'));
      cur = [];
      tokens = 0;
    }
    cur.push(line);
    tokens += t;
  }
  if (cur.length) chunks.push(cur.join('\n'));
  return chunks;
}

/**
 * 把较早的 turn 并入摘要，保留最近 keep 个（可以是 0）。
 * 转录太长时分块依次并入：每块都带着上一块产出的摘要，不会静默丢掉中间的内容。
 * 摘要长度上限 = prompt 里说的上限 = 入库截断的上限（SUMMARY_MAX_CHARS）。
 */
export async function compact(
  ctx: AppContext,
  model: ChatModel,
  session: SessionRow,
  turns: HistoryTurn[],
  keep = 2,
  route?: ChatRequest['route'],
  billing?: ChatRequest['billing'],
): Promise<boolean> {
  keep = Math.max(0, keep);
  if (turns.length <= keep) return false;
  const old = turns.slice(0, turns.length - keep);
  const budget = contextBudget(ctx.config);
  const chunks = chunkLines(renderTranscript(old.flatMap((t) => t.messages)), budget.compactChunk);
  let summary = session.contextSummary || '';
  for (let i = 0; i < chunks.length; i++) {
    const part = chunks.length > 1 ? `（第 ${i + 1}/${chunks.length} 段）` : '';
    const res = await model.chat({
      route,
      billing: billing ?? { projectId: session.projectId, note: 'agent-compact' },
      messages: [
        { role: 'system', content: COMPACT_SYSTEM },
        {
          role: 'user',
          content: `已有摘要：\n${summary || '（无）'}\n\n需要并入的对话${part}：\n${chunks[i]}`,
        },
      ],
    });
    const next = res.content.trim();
    if (!next) throw new Error('压缩模型返回了空摘要');
    summary = next.slice(0, SUMMARY_MAX_CHARS);
  }
  await ctx.db.db
    .update(agentSessions)
    .set({
      contextSummary: summary,
      summaryThroughTurnId: old[old.length - 1]!.turnId,
    })
    .where(eq(agentSessions.id, session.id));
  return true;
}
