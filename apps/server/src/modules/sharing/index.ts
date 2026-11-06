import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ApiError,
  ShareGrantInput,
  ShareGrantUpdateInput,
  ShareLinkUpdateInput,
  ShareResourceKind,
} from '@srh/shared';
import { parse } from '../../lib/http';
import { registerAudienceLoader } from '../../realtime/audience';
import { requireUser, type Params } from '../collab-common';
import type { ModuleDef } from '../types';
import {
  addGrants,
  getShareSettings,
  loadProjectAudiences,
  removeGrant,
  requireResource,
  resetLink,
  resolveShareToken,
  updateGrant,
  updateLink,
} from './service';

/**
 * 个人空间资源的分享（API.md §2.19）：
 *
 *   GET    P/shares/:kind/:id                     分享设置（kind = document | paper）
 *   PATCH  P/shares/:kind/:id/link                { scope?, level? } 链接范围与级别（所有者）
 *   POST   P/shares/:kind/:id/link/reset          重置链接，旧链接立即失效（所有者）
 *   POST   P/shares/:kind/:id/grants              { userIds?, emails?, level } 按人邀请（所有者）
 *   PATCH  P/shares/:kind/:id/grants/:userId      { level }（所有者）
 *   DELETE P/shares/:kind/:id/grants/:userId      移除（所有者）
 *   POST   /share/:token                          打开分享链接 → ShareResolveResult
 *
 * 空间移动在各自模块：POST P/docs/:docId/move、POST P/library/papers/:paperId/move。
 */
const P = '/projects/:projectId/shares/:kind/:id';
type SP = Params<'projectId' | 'kind' | 'id'>;
type GP = Params<'projectId' | 'kind' | 'id' | 'userId'>;

const kindOf = (v: string) => parse(z.object({ kind: ShareResourceKind }), { kind: v }).kind;

/**
 * 改分享设置：先要能看到（看不到 → 404），团队空间的内容不需要分享（409），
 * 个人空间只有所有者能改（403）。
 */
async function requireOwner(
  req: FastifyRequest,
  projectId: string,
  kind: ShareResourceKind,
  id: string,
) {
  const a = await requireResource(req, projectId, kind, id, 'view');
  if (a.res.space === 'team') {
    throw new ApiError(
      'conflict',
      '团队空间的内容对课题成员都可见，不需要单独分享；移到个人空间后才能设置分享',
    );
  }
  if (a.access !== 'manage') throw new ApiError('forbidden', '只有所有者能修改分享设置');
  return a;
}

export const sharingModule: ModuleDef = {
  name: 'sharing',
  owner: 'collab',
  register(app) {
    const ctx = app.ctx;
    registerAudienceLoader((projectId) => loadProjectAudiences(ctx, projectId));

    app.get<{ Params: SP }>(P, async (req) => {
      const { projectId, kind, id } = req.params;
      const a = await requireResource(req, projectId, kindOf(kind), id, 'view');
      return getShareSettings(ctx, a.res, a.access);
    });

    app.patch<{ Params: SP }>(`${P}/link`, async (req) => {
      const { projectId, kind, id } = req.params;
      const a = await requireOwner(req, projectId, kindOf(kind), id);
      return updateLink(ctx, a.user, a.res, parse(ShareLinkUpdateInput, req.body ?? {}));
    });

    app.post<{ Params: SP }>(`${P}/link/reset`, async (req) => {
      const { projectId, kind, id } = req.params;
      const a = await requireOwner(req, projectId, kindOf(kind), id);
      return resetLink(ctx, a.user, a.res);
    });

    app.post<{ Params: SP }>(`${P}/grants`, async (req) => {
      const { projectId, kind, id } = req.params;
      const a = await requireOwner(req, projectId, kindOf(kind), id);
      return addGrants(ctx, a.user, a.res, parse(ShareGrantInput, req.body ?? {}));
    });

    app.patch<{ Params: GP }>(`${P}/grants/:userId`, async (req) => {
      const { projectId, kind, id, userId } = req.params;
      const a = await requireOwner(req, projectId, kindOf(kind), id);
      const { level } = parse(ShareGrantUpdateInput, req.body ?? {});
      return updateGrant(ctx, a.user, a.res, userId, level);
    });

    app.delete<{ Params: GP }>(`${P}/grants/:userId`, async (req) => {
      const { projectId, kind, id, userId } = req.params;
      const a = await requireOwner(req, projectId, kindOf(kind), id);
      return removeGrant(ctx, a.user, a.res, userId);
    });

    app.post<{ Params: { token: string } }>('/share/:token', async (req) => {
      const user = await requireUser(req);
      return resolveShareToken(ctx, req.params.token, user);
    });
  },
};
