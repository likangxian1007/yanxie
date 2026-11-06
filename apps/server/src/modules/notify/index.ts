import {
  ApiError,
  NotifySubscriptionCreateInput,
  NotifySubscriptionUpdateInput,
  type NotifyOverview,
  type NotifySubscription,
} from '@srh/shared';
import { parse } from '../../lib/http';
import { requireProject, requireUser } from '../auth/guard';
import type { ModuleDef } from '../types';
import {
  createSubscription,
  deleteSubscription,
  listDeliveries,
  listSubscriptions,
  sendTestMessage,
  toNotifySubscription,
  updateSubscription,
} from './service';

/**
 * 接入：通知订阅（飞书 / 企业微信 / 钉钉 群机器人）。归属：后端 notify 模块。
 *
 *   GET    /auth/me/notify              我的订阅列表（地址只回打码版）+ 服务端开关
 *   POST   /auth/me/notify              新建（只允许三家官方域名）
 *   PATCH  /auth/me/notify/:id          改名 / 改地址 / 改事件 / 开关
 *   DELETE /auth/me/notify/:id          删除
 *   POST   /auth/me/notify/:id/test     发一条测试消息（立刻返回结果）
 *   GET    /auth/me/notify/:id/deliveries  最近的投递记录
 *
 * 全部只认网页登录会话（令牌那套在另一个 PR 里）。总开关 NOTIFY_ENABLED 关闭时：
 * 列表照常可读（方便看历史），新建/改/测试返回 403。
 */
export const notifyModule: ModuleDef = {
  name: 'notify',
  owner: 'backend',
  register(app) {
    const ctx = app.ctx;

    /** 开关关闭时不允许"新增/修改/测试"，但允许查看与删除（收拾残局） */
    const requireEnabled = () => {
      if (!ctx.config.NOTIFY_ENABLED) {
        throw new ApiError(
          'forbidden',
          '通知功能未开启，请联系管理员在服务器上设置 NOTIFY_ENABLED=true',
        );
      }
    };

    /** 绑定到某个项目时，必须是该项目成员（否则等于越权看别人的消息） */
    const assertProjectMember = async (
      projectId: string,
      req: Parameters<typeof requireProject>[0],
    ) => {
      await requireProject(req, projectId, 'view');
    };

    app.get('/auth/me/notify', async (req): Promise<NotifyOverview> => {
      const user = await requireUser(req);
      return {
        enabled: ctx.config.NOTIFY_ENABLED,
        subscriptions: await listSubscriptions(ctx.db.db, user.id),
      };
    });

    app.post('/auth/me/notify', async (req, reply) => {
      const user = await requireUser(req);
      requireEnabled();
      const input = parse(NotifySubscriptionCreateInput, req.body);
      if (input.projectId) await assertProjectMember(input.projectId, req);
      const created = await createSubscription(ctx, user.id, {
        name: input.name,
        provider: input.provider,
        url: input.url,
        projectId: input.projectId,
        eventTypes: input.eventTypes,
      });
      return reply.status(201).send(created);
    });

    app.patch<{ Params: { id: string } }>('/auth/me/notify/:id', async (req) => {
      const user = await requireUser(req);
      requireEnabled();
      const input = parse(NotifySubscriptionUpdateInput, req.body);
      return updateSubscription(ctx, user.id, req.params.id, input);
    });

    app.delete<{ Params: { id: string } }>('/auth/me/notify/:id', async (req, reply) => {
      const user = await requireUser(req);
      await deleteSubscription(ctx, user.id, req.params.id);
      return reply.status(204).send();
    });

    app.post<{ Params: { id: string } }>('/auth/me/notify/:id/test', async (req) => {
      const user = await requireUser(req);
      requireEnabled();
      return sendTestMessage(ctx, user.id, req.params.id);
    });

    app.get<{ Params: { id: string } }>('/auth/me/notify/:id/deliveries', async (req) => {
      const user = await requireUser(req);
      const rows = await listDeliveries(ctx, user.id, req.params.id);
      return rows.map((r) => ({
        id: r.id,
        subscriptionId: r.subscriptionId,
        eventType: r.eventType,
        text: r.text,
        status: r.status,
        attempts: r.attempts,
        responseStatus: r.responseStatus,
        error: r.error,
        nextAttemptAt: r.nextAttemptAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      }));
    });
  },
};

export type { NotifySubscription };
export { toNotifySubscription };
