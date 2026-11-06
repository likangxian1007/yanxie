import { and, eq } from 'drizzle-orm';
import { ApiError, ClaimCreateInput, ClaimListQuery, ClaimRenewInput } from '@srh/shared';
import { threads } from '../../db/schema';
import { parse } from '../../lib/http';
import { requireProject, type ProjectAccess } from '../auth/guard';
import type { ModuleDef } from '../types';
import {
  createClaim,
  getClaimRow,
  listClaims,
  releaseClaim,
  renewClaim,
  type ClaimRow,
} from './service';

/**
 * 认领与冲突预警（API.md §2.6，ARCHITECTURE.md §5.3）
 * 归属：后端与 agent 引擎线程。agent 经 service 直接认领；人也可以在 UI 里认领。
 *
 *   GET    /projects/:projectId/claims                 ?status=&resourceKind=&resourceRef=&threadId=
 *   POST   /projects/:projectId/claims                 ClaimCreateInput；冲突 → 409 claim_conflict
 *   POST   /projects/:projectId/claims/:claimId/renew  { ttlSec? }
 *   DELETE /projects/:projectId/claims/:claimId        释放
 */
type P = { projectId: string };
type PC = P & { claimId: string };

/** 续期 / 释放：持有者本人、代表的成员，或 owner / advisor */
function assertCanTouch(access: ProjectAccess, claim: ClaimRow) {
  const mine = claim.holder.id === access.user.id || claim.onBehalfOfUserId === access.user.id;
  if (!mine && access.role !== 'owner' && access.role !== 'advisor') {
    throw new ApiError('forbidden', '只有认领者本人或项目管理者可以操作这条认领');
  }
}

export const claimsModule: ModuleDef = {
  name: 'claims',
  owner: 'backend',
  register(app) {
    const ctx = app.ctx;

    app.get<{ Params: P }>('/projects/:projectId/claims', async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      const q = parse(ClaimListQuery, req.query);
      return listClaims(ctx, req.params.projectId, q);
    });

    app.post<{ Params: P }>('/projects/:projectId/claims', async (req, reply) => {
      const { projectId } = req.params;
      const { user, actor } = await requireProject(req, projectId, 'write');
      const input = parse(ClaimCreateInput, req.body);
      if (input.threadId) {
        const [t] = await ctx.db.db
          .select({ id: threads.id })
          .from(threads)
          .where(and(eq(threads.id, input.threadId), eq(threads.projectId, projectId)));
        if (!t) throw new ApiError('not_found', '线程不存在');
      }
      const claim = await createClaim(ctx, actor, projectId, {
        ...input,
        onBehalfOfUserId: user.id,
      });
      return reply.status(201).send(claim);
    });

    app.post<{ Params: PC }>('/projects/:projectId/claims/:claimId/renew', async (req) => {
      const { projectId, claimId } = req.params;
      const access = await requireProject(req, projectId, 'write');
      const input = parse(ClaimRenewInput, req.body ?? {});
      const claim = await getClaimRow(ctx, projectId, claimId);
      if (!claim) throw new ApiError('not_found', '认领不存在');
      assertCanTouch(access, claim);
      return renewClaim(ctx, access.actor, projectId, claimId, input.ttlSec);
    });

    app.delete<{ Params: PC }>('/projects/:projectId/claims/:claimId', async (req, reply) => {
      const { projectId, claimId } = req.params;
      const access = await requireProject(req, projectId, 'write');
      const claim = await getClaimRow(ctx, projectId, claimId);
      if (!claim) throw new ApiError('not_found', '认领不存在');
      assertCanTouch(access, claim);
      await releaseClaim(ctx, access.actor, projectId, claimId);
      return reply.status(204).send();
    });
  },
};
