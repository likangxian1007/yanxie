import { and, asc, eq, isNull } from 'drizzle-orm';
import { AgentStepsQuery, ApiError, type AgentStopResult } from '@srh/shared';
import { agentSessions, agentWakeups } from '../../db/schema';
import { parse } from '../../lib/http';
import { runtimeHooks } from '../../agents/runtime/hooks';
import { requireProject } from '../auth/guard';
import { enqueueWake } from '../../agents/runtime/wake';
import { getThreadRow, refreshThread, threadVisibleTo } from '../threads/service';
import type { ModuleDef } from '../types';
import { getSession, listSteps, toAgentSession, updateSession } from './service';

/**
 * Agent 透明度（API.md §2.5）：导师和成员看协调者与各线程 agent 在做什么、怎么想的。
 * 个人会话的 agent 只有主人能看。
 */
type P = { projectId: string };
type PS = P & { sessionId: string };

export const agentsModule: ModuleDef = {
  name: 'agents',
  owner: 'backend',
  register(app) {
    const ctx = app.ctx;

    async function visibleSession(projectId: string, sessionId: string, userId: string) {
      const row = await getSession(ctx, projectId, sessionId);
      if (!row) throw new ApiError('not_found', 'agent 会话不存在');
      if (row.threadId) {
        const t = await getThreadRow(ctx, projectId, row.threadId);
        if (!t || !threadVisibleTo(t, userId)) throw new ApiError('not_found', 'agent 会话不存在');
      }
      return row;
    }

    app.get<{ Params: P }>('/projects/:projectId/agents', async (req) => {
      const { user } = await requireProject(req, req.params.projectId, 'view');
      const rows = await ctx.db.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.projectId, req.params.projectId))
        .orderBy(asc(agentSessions.createdAt));
      const out = [];
      for (const r of rows) {
        if (r.role === 'personal' && r.workingForUserId !== user.id) continue;
        out.push(toAgentSession(r));
      }
      return out;
    });

    app.get<{ Params: PS }>('/projects/:projectId/agents/:sessionId', async (req) => {
      const { user } = await requireProject(req, req.params.projectId, 'view');
      return toAgentSession(
        await visibleSession(req.params.projectId, req.params.sessionId, user.id),
      );
    });

    app.get<{ Params: PS }>('/projects/:projectId/agents/:sessionId/steps', async (req) => {
      const { user } = await requireProject(req, req.params.projectId, 'view');
      const row = await visibleSession(req.params.projectId, req.params.sessionId, user.id);
      return listSteps(ctx, row.id, parse(AgentStepsQuery, req.query));
    });

    /**
     * 中止当前 turn，并丢掉还没开始的唤醒（成员刚发完消息、agent 还显示空闲时也能停）。
     * 返回 AgentStopResult：stopped = turn（中止了在跑的一轮）/ queued（取消了排队的一轮）/ none。
     */
    app.post<{ Params: PS }>(
      '/projects/:projectId/agents/:sessionId/stop',
      async (req): Promise<AgentStopResult> => {
        const { user, actor } = await requireProject(req, req.params.projectId, 'write');
        const row = await visibleSession(req.params.projectId, req.params.sessionId, user.id);
        const unconsumed = and(eq(agentWakeups.sessionId, row.id), isNull(agentWakeups.consumedAt));
        // 先看有没有在排队、还没开始的唤醒（运行时的 stopSession 会把它们作废）
        const [pending] = await ctx.db.db
          .select({ id: agentWakeups.id })
          .from(agentWakeups)
          .where(and(unconsumed, eq(agentWakeups.wakes, true)))
          .limit(1);
        const aborted = runtimeHooks.stopSession ? await runtimeHooks.stopSession(row.id) : false;
        // 运行时没启动（或在别的实例上）时也要作废，免得之后又被拉起来
        await ctx.db.db
          .update(agentWakeups)
          .set({ consumedAt: new Date(), consumedTurnId: 'stopped' })
          .where(unconsumed);
        const stopped: AgentStopResult['stopped'] =
          aborted || row.status === 'running'
            ? 'turn'
            : row.status === 'queued' || pending
              ? 'queued'
              : 'none';
        if (stopped === 'none') return { ...toAgentSession(row), stopped };
        const updated = await updateSession(
          ctx,
          row.id,
          { status: 'stopped', activity: null },
          actor,
        );
        if (row.threadId) await refreshThread(ctx, row.threadId);
        return { ...toAgentSession(updated ?? row), stopped };
      },
    );

    /** 让停下（出错 / 步数用尽 / 被中止）或空闲的 agent 从上次的地方继续 */
    app.post<{ Params: PS }>('/projects/:projectId/agents/:sessionId/resume', async (req) => {
      const { user, actor } = await requireProject(req, req.params.projectId, 'write');
      const row = await visibleSession(req.params.projectId, req.params.sessionId, user.id);
      if (row.status === 'running' || row.status === 'queued') return toAgentSession(row);
      if (row.threadId) {
        const t = await getThreadRow(ctx, req.params.projectId, row.threadId);
        if (t?.resolved)
          throw new ApiError('conflict', '这个线程已经解决了，先重开再让 agent 继续');
      }
      const updated = await updateSession(ctx, row.id, { status: 'queued' }, actor);
      if (row.threadId) await refreshThread(ctx, row.threadId);
      await enqueueWake(ctx, row, 'continue', {
        type: 'continue',
        attempt: 0,
        manual: true,
        by: user.name,
      });
      return toAgentSession(updated ?? row);
    });
  },
};
