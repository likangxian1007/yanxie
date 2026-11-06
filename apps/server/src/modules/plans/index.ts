import type { FastifyRequest } from 'fastify';
import type { ModuleDef } from '../types';
import { parse } from '../../lib/http';
import { requireProject, roleCan, type Capability, type Params } from '../collab-common';
import {
  BasisListQuery,
  MemoryListQuery,
  ProposalListQuery,
  archivePlan,
  createExploration,
  createMemory,
  createProposal,
  decideProposal,
  deleteMemory,
  deleteProposal,
  getBasis,
  getOverview,
  getPlan,
  getPlanVersion,
  getProposal,
  initOfficialPlan,
  listBasis,
  listMemory,
  listPlanVersions,
  listProposals,
  patchPlan,
  patchProposal,
  reviewBasis,
  savePlanContent,
  submitProposal,
  updateMemory,
  withdrawProposal,
  type PlanAccess,
} from './service';

/**
 * 正式方案、探索副本、提案、个人工作记忆与团队依据。
 * 归属：协作功能线程。端点契约见 API.md §2.20，请求体 schema 见 @srh/shared plans.ts。
 *
 *   GET    P/plans                                  PlansOverview
 *   POST   P/plans/official                         manage  OfficialPlanInit → 201 Plan（已有 409）
 *   POST   P/plans/explorations                     write   ExplorationCreate → 201 Plan
 *   GET    P/plans/:planId                          Plan
 *   PATCH  P/plans/:planId                          建立者 / manage  ExplorationPatch → Plan
 *   POST   P/plans/:planId/archive                  建立者 / manage  → Plan
 *   PUT    P/plans/:planId/content                  建立者 / manage  PlanContentInput → Plan（留一版）
 *   GET    P/plans/:planId/versions                 PlanVersion[]（新到旧）
 *   GET    P/plans/:planId/versions/:version        PlanVersion
 *   GET    P/plans/proposals?status=                BasisProposal[]（草稿只看到自己的）
 *   POST   P/plans/proposals                        write   BasisProposalCreate → 201 BasisProposal
 *   GET    P/plans/proposals/:proposalId            BasisProposal
 *   PATCH  P/plans/proposals/:proposalId            提出者  BasisProposalPatch → BasisProposal
 *   DELETE P/plans/proposals/:proposalId            提出者  204（草稿 / 已撤回）
 *   POST   P/plans/proposals/:proposalId/submit     提出者  → BasisProposal
 *   POST   P/plans/proposals/:proposalId/withdraw   提出者  → BasisProposal
 *   POST   P/plans/proposals/:proposalId/decide     manage  BasisProposalDecision → BasisProposal
 *   GET    P/plans/memory?userId=                   本人 / manage  PersonalMemory[]
 *   POST   P/plans/memory                           write   PersonalMemoryInput(baseVersion=0) → 201 PersonalMemory
 *   PUT    P/plans/memory/:memoryId                 本人    PersonalMemoryInput → PersonalMemory
 *   DELETE P/plans/memory/:memoryId                 本人    204
 *   GET    P/plans/basis?status=                    TeamBasis[]
 *   GET    P/plans/basis/:basisId                   TeamBasis
 *   POST   P/plans/basis/:basisId/review            manage  TeamBasisReview → TeamBasis
 */
type P = Params<'projectId'>;
type PL = Params<'projectId' | 'planId'>;
type PV = Params<'projectId' | 'planId' | 'version'>;
type PR = Params<'projectId' | 'proposalId'>;
type PM = Params<'projectId' | 'memoryId'>;
type PB = Params<'projectId' | 'basisId'>;

const base = '/projects/:projectId/plans';

async function access(
  req: FastifyRequest,
  projectId: string,
  cap: Capability,
): Promise<PlanAccess> {
  const { role, actor } = await requireProject(req, projectId, cap);
  return { actor, canManage: roleCan(role, 'manage') };
}

export const plansModule: ModuleDef = {
  name: 'plans',
  owner: 'collab',
  register(app) {
    const { ctx } = app;

    app.get<{ Params: P }>(base, async (req) => {
      const { projectId } = req.params;
      return getOverview(ctx, await access(req, projectId, 'view'), projectId);
    });

    app.post<{ Params: P }>(`${base}/official`, async (req, reply) => {
      const { projectId } = req.params;
      const { actor } = await access(req, projectId, 'manage');
      return reply.status(201).send(await initOfficialPlan(ctx, actor, projectId, req.body ?? {}));
    });

    app.post<{ Params: P }>(`${base}/explorations`, async (req, reply) => {
      const { projectId } = req.params;
      const { actor } = await access(req, projectId, 'write');
      return reply.status(201).send(await createExploration(ctx, actor, projectId, req.body ?? {}));
    });

    // ---- 提案（静态路径，先于 :planId 匹配）
    app.get<{ Params: P }>(`${base}/proposals`, async (req) => {
      const { projectId } = req.params;
      const a = await access(req, projectId, 'view');
      return listProposals(ctx, a, projectId, parse(ProposalListQuery, req.query ?? {}));
    });

    app.post<{ Params: P }>(`${base}/proposals`, async (req, reply) => {
      const { projectId } = req.params;
      const { actor } = await access(req, projectId, 'write');
      return reply.status(201).send(await createProposal(ctx, actor, projectId, req.body ?? {}));
    });

    app.get<{ Params: PR }>(`${base}/proposals/:proposalId`, async (req) => {
      const { projectId, proposalId } = req.params;
      return getProposal(ctx, await access(req, projectId, 'view'), projectId, proposalId);
    });

    app.patch<{ Params: PR }>(`${base}/proposals/:proposalId`, async (req) => {
      const { projectId, proposalId } = req.params;
      const a = await access(req, projectId, 'write');
      return patchProposal(ctx, a, projectId, proposalId, req.body ?? {});
    });

    app.delete<{ Params: PR }>(`${base}/proposals/:proposalId`, async (req, reply) => {
      const { projectId, proposalId } = req.params;
      await deleteProposal(ctx, await access(req, projectId, 'write'), projectId, proposalId);
      return reply.status(204).send();
    });

    app.post<{ Params: PR }>(`${base}/proposals/:proposalId/submit`, async (req) => {
      const { projectId, proposalId } = req.params;
      return submitProposal(ctx, await access(req, projectId, 'write'), projectId, proposalId);
    });

    app.post<{ Params: PR }>(`${base}/proposals/:proposalId/withdraw`, async (req) => {
      const { projectId, proposalId } = req.params;
      return withdrawProposal(ctx, await access(req, projectId, 'write'), projectId, proposalId);
    });

    app.post<{ Params: PR }>(`${base}/proposals/:proposalId/decide`, async (req) => {
      const { projectId, proposalId } = req.params;
      const a = await access(req, projectId, 'manage');
      return decideProposal(ctx, a, projectId, proposalId, req.body ?? {});
    });

    // ---- 个人工作记忆（不发事件）
    app.get<{ Params: P }>(`${base}/memory`, async (req) => {
      const { projectId } = req.params;
      const a = await access(req, projectId, 'view');
      return listMemory(ctx, a, projectId, parse(MemoryListQuery, req.query ?? {}));
    });

    app.post<{ Params: P }>(`${base}/memory`, async (req, reply) => {
      const { projectId } = req.params;
      const { actor } = await access(req, projectId, 'write');
      return reply.status(201).send(await createMemory(ctx, actor, projectId, req.body ?? {}));
    });

    app.put<{ Params: PM }>(`${base}/memory/:memoryId`, async (req) => {
      const { projectId, memoryId } = req.params;
      const a = await access(req, projectId, 'write');
      return updateMemory(ctx, a, projectId, memoryId, req.body ?? {});
    });

    app.delete<{ Params: PM }>(`${base}/memory/:memoryId`, async (req, reply) => {
      const { projectId, memoryId } = req.params;
      await deleteMemory(ctx, await access(req, projectId, 'write'), projectId, memoryId);
      return reply.status(204).send();
    });

    // ---- 团队依据
    app.get<{ Params: P }>(`${base}/basis`, async (req) => {
      const { projectId } = req.params;
      await access(req, projectId, 'view');
      return listBasis(ctx, projectId, parse(BasisListQuery, req.query ?? {}));
    });

    app.get<{ Params: PB }>(`${base}/basis/:basisId`, async (req) => {
      const { projectId, basisId } = req.params;
      await access(req, projectId, 'view');
      return getBasis(ctx, projectId, basisId);
    });

    app.post<{ Params: PB }>(`${base}/basis/:basisId/review`, async (req) => {
      const { projectId, basisId } = req.params;
      const { actor } = await access(req, projectId, 'manage');
      return reviewBasis(ctx, actor, projectId, basisId, req.body ?? {});
    });

    // ---- 方案与版本
    app.get<{ Params: PL }>(`${base}/:planId`, async (req) => {
      const { projectId, planId } = req.params;
      await access(req, projectId, 'view');
      return getPlan(ctx, projectId, planId);
    });

    app.patch<{ Params: PL }>(`${base}/:planId`, async (req) => {
      const { projectId, planId } = req.params;
      const a = await access(req, projectId, 'write');
      return patchPlan(ctx, a, projectId, planId, req.body ?? {});
    });

    app.post<{ Params: PL }>(`${base}/:planId/archive`, async (req) => {
      const { projectId, planId } = req.params;
      return archivePlan(ctx, await access(req, projectId, 'write'), projectId, planId);
    });

    app.put<{ Params: PL }>(`${base}/:planId/content`, async (req) => {
      const { projectId, planId } = req.params;
      const a = await access(req, projectId, 'write');
      return savePlanContent(ctx, a, projectId, planId, req.body ?? {});
    });

    app.get<{ Params: PL }>(`${base}/:planId/versions`, async (req) => {
      const { projectId, planId } = req.params;
      await access(req, projectId, 'view');
      return listPlanVersions(ctx, projectId, planId);
    });

    app.get<{ Params: PV }>(`${base}/:planId/versions/:version`, async (req) => {
      const { projectId, planId, version } = req.params;
      await access(req, projectId, 'view');
      return getPlanVersion(ctx, projectId, planId, version);
    });
  },
};
