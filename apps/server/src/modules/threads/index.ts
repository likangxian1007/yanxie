import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  ApiError,
  DecisionAnswerInput,
  MessageCreateInput,
  MessageListQuery,
  PersonalThreadCreateInput,
  ThreadForwardInput,
  ThreadListQuery,
  ThreadUpdateInput,
  type ForwardMessageMeta,
} from '@srh/shared';
import { messages, threads } from '../../db/schema';
import { modelCatalog } from '../../agents/llm/registry';
import { parse } from '../../lib/http';
import { apiTokenFor, requireProject } from '../auth/guard';
import { listProfiles } from '../harness/catalog';
import { attachmentOutputs } from '../timeline';
import { createMessage, excerpt, listMessages } from '../timeline/service';
import type { ModuleDef } from '../types';
import {
  createPersonalThread,
  deletePersonalThread,
  getDecisionRow,
  getThreadRow,
  listThreads,
  requireVisibleThread,
  settleDecision,
  toDecision,
  toThread,
  updateThread,
} from './service';
import { registerThreadSummaries } from './summary';

/**
 * 线程、个人工作区、转发、决策卡（API.md §2.4）。
 * 唤醒 agent 由路由器监听 message.created / decision.updated 完成，这里只写数据。
 */
type P = { projectId: string };
type PT = P & { threadId: string };

export const threadsModule: ModuleDef = {
  name: 'threads',
  owner: 'backend',
  register(app) {
    const ctx = app.ctx;
    registerThreadSummaries(app);

    app.get<{ Params: P }>('/projects/:projectId/threads', async (req) => {
      const { user } = await requireProject(req, req.params.projectId, 'view');
      const q = parse(ThreadListQuery, req.query);
      return listThreads(ctx, req.params.projectId, user.id, q);
    });

    app.post<{ Params: P }>('/projects/:projectId/threads', async (req, reply) => {
      const { user } = await requireProject(req, req.params.projectId, 'write');
      const input = parse(PersonalThreadCreateInput, req.body);
      // 首轮唤醒之前校验配置，失败时不创建线程或会话。
      const catalog =
        input.model !== undefined ? await modelCatalog(ctx, req.params.projectId) : null;
      if (
        input.model !== undefined &&
        input.model !== null &&
        !catalog?.providers.some(
          (provider) =>
            provider.enabled && provider.models.some((model) => model.id === input.model),
        )
      ) {
        throw new ApiError('validation_failed', `没有这个模型：${input.model}`, {
          issues: [{ path: 'model', message: '模型不存在或已停用' }],
        });
      }
      if (input.profile) {
        const profiles = await listProfiles(ctx, req.params.projectId, user.id);
        if (!profiles.some((p) => p.slug === input.profile))
          throw new ApiError('validation_failed', `没有这个 profile：${input.profile}`, {
            issues: [{ path: 'profile', message: 'profile 不存在' }],
          });
      }
      const thread = await createPersonalThread(ctx, {
        projectId: req.params.projectId,
        user,
        body: input.body,
        title: input.title,
        profile: input.profile ?? null,
        model: input.model === null ? catalog?.defaultModel || undefined : input.model,
        effort: input.effort,
      });
      return reply.status(201).send(thread);
    });

    app.get<{ Params: PT }>('/projects/:projectId/threads/:threadId', async (req) => {
      const { user } = await requireProject(req, req.params.projectId, 'view');
      const row = await requireVisibleThread(
        ctx,
        req.params.projectId,
        req.params.threadId,
        user.id,
      );
      return toThread(ctx, row);
    });

    app.patch<{ Params: PT }>('/projects/:projectId/threads/:threadId', async (req) => {
      const { user, actor } = await requireProject(req, req.params.projectId, 'write');
      const row = await requireVisibleThread(
        ctx,
        req.params.projectId,
        req.params.threadId,
        user.id,
      );
      const input = parse(ThreadUpdateInput, req.body);
      return updateThread(ctx, row, input, actor);
    });

    // 删除个人会话（只有主人；别人的个人会话一律 404，项目线程 403）
    app.delete<{ Params: PT }>('/projects/:projectId/threads/:threadId', async (req, reply) => {
      const { user, actor } = await requireProject(req, req.params.projectId, 'write');
      const row = await requireVisibleThread(
        ctx,
        req.params.projectId,
        req.params.threadId,
        user.id,
      );
      await deletePersonalThread(ctx, row, actor);
      return reply.status(204).send();
    });

    app.get<{ Params: PT }>('/projects/:projectId/threads/:threadId/messages', async (req) => {
      const { user } = await requireProject(req, req.params.projectId, 'view');
      await requireVisibleThread(ctx, req.params.projectId, req.params.threadId, user.id);
      const q = parse(MessageListQuery, req.query);
      return listMessages(ctx, req.params.projectId, req.params.threadId, q);
    });

    app.post<{ Params: PT }>(
      '/projects/:projectId/threads/:threadId/messages',
      async (req, reply) => {
        const { user, actor } = await requireProject(req, req.params.projectId, 'write');
        const row = await requireVisibleThread(
          ctx,
          req.params.projectId,
          req.params.threadId,
          user.id,
        );
        const input = parse(MessageCreateInput, req.body);
        const message = await createMessage(ctx, {
          projectId: req.params.projectId,
          threadId: row.id,
          author: actor,
          body: input.body,
          mentions: input.mentions,
          agentVisible: input.agentVisible,
          meta: {
            ...(input.fileIds.length ? { fileIds: input.fileIds } : {}),
            ...((await apiTokenFor(req)) ? { viaToken: tokenMark((await apiTokenFor(req))!) } : {}),
          },
          outputs: await attachmentOutputs(ctx, req.params.projectId, input.fileIds),
        });
        // 成员在已解决的线程里发言 = 重开
        if (row.resolved && input.agentVisible) {
          await updateThread(ctx, row, { resolved: false }, actor);
        }
        return reply.status(201).send(message);
      },
    );

    // 个人会话 → 时间线上的转发卡片（附言是成员原话；摘要是会话最近内容的摘录，视为数据）
    app.post<{ Params: PT }>(
      '/projects/:projectId/threads/:threadId/forward',
      async (req, reply) => {
        const { user, actor } = await requireProject(req, req.params.projectId, 'write');
        const row = await getThreadRow(ctx, req.params.projectId, req.params.threadId);
        if (!row || row.kind !== 'personal' || row.ownerUserId !== user.id) {
          throw new ApiError('not_found', '个人会话不存在');
        }
        const input = parse(ThreadForwardInput, req.body);
        const recent = await ctx.db.db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.threadId, row.id),
              isNull(messages.deletedAt),
              eq(messages.agentVisible, true),
            ),
          )
          .orderBy(desc(messages.id))
          .limit(6);
        const summary = recent
          .reverse()
          .map((m) => `${m.authorName}：${excerpt(m.body, 160)}`)
          .join('\n');
        const meta: ForwardMessageMeta = {
          threadId: row.id,
          threadTitle: row.title,
          summary,
          forwardedBy: actor,
        };
        const message = await createMessage(ctx, {
          projectId: row.projectId,
          threadId: null,
          author: actor,
          kind: 'forward',
          body: input.note,
          meta,
        });
        const [updated] = await ctx.db.db
          .update(threads)
          .set({ forwardedAt: new Date() })
          .where(eq(threads.id, row.id))
          .returning();
        await ctx.bus.publish({
          projectId: row.projectId,
          threadId: row.id,
          type: 'thread.updated',
          payload: await toThread(ctx, updated!),
          actor,
        });
        return reply.status(201).send(message);
      },
    );

    // 单张决策卡：站内引用 #dec_… 跳到卡片所在的消息（messageId / threadId）
    app.get<{ Params: P & { decisionId: string } }>(
      '/projects/:projectId/decisions/:decisionId',
      async (req) => {
        const { user } = await requireProject(req, req.params.projectId, 'view');
        const row = await getDecisionRow(ctx, req.params.projectId, req.params.decisionId);
        if (!row) throw new ApiError('not_found', '决策卡不存在');
        if (row.threadId) {
          await requireVisibleThread(ctx, req.params.projectId, row.threadId, user.id);
        }
        return toDecision(row);
      },
    );

    app.post<{ Params: P & { decisionId: string } }>(
      '/projects/:projectId/decisions/:decisionId/answer',
      async (req) => {
        const { user, actor } = await requireProject(req, req.params.projectId, 'write');
        const row = await getDecisionRow(ctx, req.params.projectId, req.params.decisionId);
        if (!row) throw new ApiError('not_found', '决策卡不存在');
        if (row.threadId) {
          await requireVisibleThread(ctx, req.params.projectId, row.threadId, user.id);
        }
        const input = parse(DecisionAnswerInput, req.body);
        return settleDecision(ctx, row, input.chosen, actor);
      },
    );
  },
};

function tokenMark(token: { id: string; name: string; tokenHint: string }) {
  return { id: token.id, name: token.name, hint: token.tokenHint };
}
