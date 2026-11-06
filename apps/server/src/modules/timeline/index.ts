import type { FastifyRequest } from 'fastify';
import {
  ApiError,
  MessageCreateInput,
  MessageListQuery,
  MessageUpdateInput,
  ReactionInput,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { parse } from '../../lib/http';
import { apiTokenFor, requireProject } from '../auth/guard';
import { getFile } from '../files/service';
import { getThreadRow, threadVisibleTo } from '../threads/service';
import type { ModuleDef } from '../types';
import {
  createMessage,
  deleteMessage,
  editMessage,
  getMessage,
  getMessageRow,
  listMessages,
  setReaction,
  type NewOutput,
} from './service';

/**
 * 协作台时间线与消息（API.md §2.3）。
 * 发到时间线的 agentVisible 消息会被路由器（agents/runtime/router.ts）送给协调者。
 */
type P = { projectId: string };
type PM = P & { messageId: string };

/** 附件：fileIds → 产出（资料库）+ meta.fileIds */
export async function attachmentOutputs(
  ctx: AppContext,
  projectId: string,
  fileIds: string[],
): Promise<NewOutput[]> {
  const out: NewOutput[] = [];
  for (const id of fileIds) {
    const file = await getFile(ctx, projectId, id);
    if (!file) throw new ApiError('validation_failed', `附件不存在：${id}`);
    out.push({ kind: 'file', ref: file.id, title: file.name });
  }
  return out;
}

/** 消息所在线程对当前用户不可见（别人的个人会话）时当作不存在 */
async function requireVisibleMessage(
  req: FastifyRequest,
  projectId: string,
  messageId: string,
  userId: string,
) {
  const ctx = req.server.ctx;
  const row = await getMessageRow(ctx, projectId, messageId);
  if (!row) throw new ApiError('not_found', '消息不存在');
  if (row.threadId) {
    const t = await getThreadRow(ctx, projectId, row.threadId);
    if (!t || !threadVisibleTo(t, userId)) throw new ApiError('not_found', '消息不存在');
  }
  return row;
}

export const timelineModule: ModuleDef = {
  name: 'timeline',
  owner: 'backend',
  register(app) {
    const ctx = app.ctx;

    app.get<{ Params: P }>('/projects/:projectId/timeline', async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      const q = parse(MessageListQuery, req.query);
      return listMessages(ctx, req.params.projectId, null, q);
    });

    app.post<{ Params: P }>('/projects/:projectId/timeline', async (req, reply) => {
      const { actor } = await requireProject(req, req.params.projectId, 'write');
      const input = parse(MessageCreateInput, req.body);
      const message = await createMessage(ctx, {
        projectId: req.params.projectId,
        threadId: null,
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
      return reply.status(201).send(message);
    });

    // 单条消息：站内引用 #msg_… 要先知道它在时间线还是哪个线程里，才能跳过去
    app.get<{ Params: PM }>('/projects/:projectId/messages/:messageId', async (req) => {
      const { user } = await requireProject(req, req.params.projectId, 'view');
      await requireVisibleMessage(req, req.params.projectId, req.params.messageId, user.id);
      const message = await getMessage(ctx, req.params.projectId, req.params.messageId);
      if (!message) throw new ApiError('not_found', '消息不存在');
      return message;
    });

    app.patch<{ Params: PM }>('/projects/:projectId/messages/:messageId', async (req) => {
      const { actor, user } = await requireProject(req, req.params.projectId, 'write');
      await requireVisibleMessage(req, req.params.projectId, req.params.messageId, user.id);
      const input = parse(MessageUpdateInput, req.body);
      return editMessage(
        ctx,
        req.params.projectId,
        req.params.messageId,
        actor,
        input.body,
        input.mentions,
      );
    });

    app.delete<{ Params: PM }>('/projects/:projectId/messages/:messageId', async (req, reply) => {
      const { actor, user } = await requireProject(req, req.params.projectId, 'write');
      await requireVisibleMessage(req, req.params.projectId, req.params.messageId, user.id);
      await deleteMessage(ctx, req.params.projectId, req.params.messageId, actor);
      return reply.status(204).send();
    });

    app.put<{ Params: PM }>('/projects/:projectId/messages/:messageId/reactions', async (req) => {
      const { user } = await requireProject(req, req.params.projectId, 'write');
      await requireVisibleMessage(req, req.params.projectId, req.params.messageId, user.id);
      const input = parse(ReactionInput, req.body);
      return setReaction(
        ctx,
        req.params.projectId,
        req.params.messageId,
        { kind: 'user', id: user.id, name: user.name },
        input.emoji,
        true,
      );
    });

    app.delete<{ Params: PM & { emoji: string } }>(
      '/projects/:projectId/messages/:messageId/reactions/:emoji',
      async (req) => {
        const { user } = await requireProject(req, req.params.projectId, 'write');
        await requireVisibleMessage(req, req.params.projectId, req.params.messageId, user.id);
        return setReaction(
          ctx,
          req.params.projectId,
          req.params.messageId,
          { kind: 'user', id: user.id, name: user.name },
          decodeURIComponent(req.params.emoji),
          false,
        );
      },
    );
  },
};

function tokenMark(token: { id: string; name: string; tokenHint: string }) {
  return { id: token.id, name: token.name, hint: token.tokenHint };
}
