import {
  ApiError,
  ApiTokenCreateInput,
  type ApiTokenCreated,
  type ApiTokenList,
} from '@srh/shared';
import { parse } from '../../lib/http';
import { requireInteractiveUser } from '../auth/guard';
import type { ModuleDef } from '../types';
import { createApiToken, listApiTokens, revokeApiToken } from './service';
import { registerTransferRoutes } from './transfers';
import { registerNotebookIntegrationRoutes } from './notebook-routes';
import { registerResultRoutes } from './results';
import { operationCatalog } from '../../app';
import { requireUser } from '../auth/guard';

/**
 * 接入：API 令牌管理（API.md §2.21）。归属：后端 integrations 模块。
 *
 *   GET    /auth/me/tokens        我的令牌（只回 hint，不回原文）+ 服务端开关状态
 *   POST   /auth/me/tokens        新建，响应里带一次原文
 *   DELETE /auth/me/tokens/:id    撤销（幂等）
 *
 * 三个接口都只认网页登录会话：令牌本身不能创建或撤销令牌（否则一张泄露的令牌可以给自己续命）。
 * 总开关 API_TOKENS_ENABLED 关闭时：列表和撤销照常（方便收拾残局），新建返回 403。
 */
export const integrationsModule: ModuleDef = {
  name: 'integrations',
  owner: 'backend',
  register(app) {
    const ctx = app.ctx;
    registerTransferRoutes(app);
    registerNotebookIntegrationRoutes(app);
    registerResultRoutes(app);
    app.get('/integrations/operations', async (req) => {
      await requireUser(req);
      return {
        items: operationCatalog(ctx)
          .list()
          .filter((op) => op.access === 'open'),
        coverage: operationCatalog(ctx).coverage(),
      };
    });

    app.get('/auth/me/tokens', async (req): Promise<ApiTokenList> => {
      const user = await requireInteractiveUser(req);
      return {
        enabled: ctx.config.API_TOKENS_ENABLED,
        mcpEnabled: ctx.config.MCP_ENABLED,
        tokens: await listApiTokens(ctx.db.db, user.id),
      };
    });

    app.post('/auth/me/tokens', async (req, reply) => {
      const user = await requireInteractiveUser(req);
      if (!ctx.config.API_TOKENS_ENABLED) {
        throw new ApiError(
          'forbidden',
          'API 令牌功能未开启，请联系管理员在服务器上设置 API_TOKENS_ENABLED=true',
        );
      }
      const input = parse(ApiTokenCreateInput, req.body);
      const created: ApiTokenCreated = await createApiToken(ctx, user.id, {
        name: input.name,
        scopes: input.scopes,
        projectIds: input.projectIds,
        expiresInDays: input.expiresInDays,
      });
      return reply.status(201).send(created);
    });

    app.delete<{ Params: { tokenId: string } }>('/auth/me/tokens/:tokenId', async (req, reply) => {
      const user = await requireInteractiveUser(req);
      await revokeApiToken(ctx, user.id, req.params.tokenId);
      return reply.status(204).send();
    });
  },
};
