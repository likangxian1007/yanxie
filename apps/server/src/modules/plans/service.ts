import { and, desc, eq, inArray, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  ApiError,
  BasisProposalCreate,
  BasisProposalDecision,
  BasisProposalPatch,
  BasisProposalStatus,
  ExplorationCreate,
  ExplorationPatch,
  OfficialPlanInit,
  PersonalMemoryInput,
  PlanContentInput,
  TeamBasisReview,
  TeamBasisStatus,
  ulid,
  type ActorRef,
  type BasisEvidence,
  type BasisProposal,
  type PersonalMemory,
  type Plan,
  type PlanVersion,
  type PlansOverview,
  type ProjectEvent,
  type TeamBasis,
} from '@srh/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/client';
import {
  basisProposals,
  personalMemory,
  planVersions,
  plans,
  projectMembers,
  teamBasis,
  users,
} from '../../db/schema';
import { parse } from '../../lib/http';
import { assertVersion, notFound } from '../collab-common';
import { createInboxItem, markInboxDoneBySource } from '../collab-common/inbox';
import {
  personalMemoryDto,
  planDto,
  planVersionDto,
  proposalDto,
  teamBasisDto,
  type BasisProposalRow,
  type PersonalMemoryRow,
  type PlanRow,
  type TeamBasisRow,
} from './serialize';

/**
 * 正式方案、探索副本、提案、个人记忆与团队依据的业务逻辑（API.md §2.20）。
 *
 * - 正式方案（kind=official）每个项目一份，只能由负责人（owner / advisor）建立第一版，
 *   之后只有负责人采纳 plan_change 提案才会出新版本。
 * - 探索副本（kind=exploration）任何可写成员都能建，只有建立者和负责人能改；每次保存都在 plan_versions 留一版。
 * - 提案：作者本人编辑 / 提交 / 撤回；草稿只有作者能看。负责人审批（accept / reject）。
 * - 个人记忆：只有本人能写；本人和负责人能读。不发事件。
 * - 团队依据：采纳 team_basis 提案生成；方案出新版本或依据被替代时，依赖它的依据标记为待复核。
 */

/** db 或事务 */
type Executor = Pick<Db, 'select' | 'insert' | 'update' | 'delete'>;

const ids = {
  plan: () => `pln_${ulid()}`,
  planVersion: () => `plv_${ulid()}`,
  proposal: () => `bpr_${ulid()}`,
  memory: () => `pmm_${ulid()}`,
  basis: () => `tbs_${ulid()}`,
};

export const plansHref = (projectId: string, query = '') =>
  `/p/${projectId}/plans${query ? `?${query}` : ''}`;

export const ProposalListQuery = z.object({ status: BasisProposalStatus.optional() });
export const BasisListQuery = z.object({ status: TeamBasisStatus.optional() });
export const MemoryListQuery = z.object({ userId: z.string().min(1).optional() });

/** 调用方的权限：requireProject 的结果 */
export interface PlanAccess {
  actor: ActorRef;
  canManage: boolean;
}

function userIdOf(actor: ActorRef): string {
  if (actor.kind !== 'user' || !actor.id) {
    throw new ApiError('forbidden', '这个操作需要由项目成员本人完成');
  }
  return actor.id;
}

function invalid(field: string, message: string): never {
  throw new ApiError('validation_failed', message, { issues: [{ path: field, message }] });
}

function conflict(message: string, details?: Record<string, unknown>): never {
  throw new ApiError('conflict', message, details);
}

async function userRef(exec: Executor, userId: string): Promise<ActorRef> {
  const [row] = await exec
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.id, userId));
  return { kind: 'user', id: userId, name: row?.name ?? '成员' };
}

/** 负责人（owner / advisor） */
async function leadIds(ctx: AppContext, projectId: string): Promise<string[]> {
  const rows = await ctx.db.db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        inArray(projectMembers.role, ['owner', 'advisor']),
      ),
    );
  return rows.map((r) => r.userId);
}

type Ev = ProjectEvent;
const emitAll = (ctx: AppContext, evs: Ev[]) => {
  for (const ev of evs) ctx.bus.emit(ev);
};

// ---------------------------------------------------------------- 方案

async function officialRow(exec: Executor, projectId: string): Promise<PlanRow | undefined> {
  const [row] = await exec
    .select()
    .from(plans)
    .where(and(eq(plans.projectId, projectId), eq(plans.kind, 'official')))
    .limit(1);
  return row;
}

async function loadPlan(exec: Executor, projectId: string, planId: string): Promise<PlanRow> {
  const [row] = await exec
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.projectId, projectId)));
  if (!row) notFound('方案');
  return row;
}

function canEditExploration(row: PlanRow, access: PlanAccess): boolean {
  if (access.canManage) return true;
  return access.actor.kind === 'user' && row.ownerId === access.actor.id;
}

function assertExplorationWritable(row: PlanRow, access: PlanAccess) {
  if (row.kind !== 'exploration') {
    conflict('正式方案只能通过提案修改，请先在探索副本里修改后提交提案');
  }
  if (!canEditExploration(row, access)) {
    throw new ApiError('forbidden', '只有探索副本的建立者和项目负责人可以修改它');
  }
}

export async function getOverview(
  ctx: AppContext,
  access: PlanAccess,
  projectId: string,
): Promise<PlansOverview> {
  const db = ctx.db.db;
  const official = await officialRow(db, projectId);
  const explorations = await db
    .select()
    .from(plans)
    .where(and(eq(plans.projectId, projectId), eq(plans.kind, 'exploration')))
    .orderBy(desc(plans.updatedAt));
  const proposals = await listProposals(ctx, access, projectId);
  const basis = await listBasis(ctx, projectId);
  return {
    official: official ? planDto(official) : null,
    explorations: explorations.map(planDto),
    proposals,
    basis,
    canManage: access.canManage,
  };
}

export async function getPlan(ctx: AppContext, projectId: string, planId: string): Promise<Plan> {
  return planDto(await loadPlan(ctx.db.db, projectId, planId));
}

/** 负责人建立正式方案第一版（已存在时 409） */
export async function initOfficialPlan(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  input: unknown,
): Promise<Plan> {
  const data = parse(OfficialPlanInit, input);
  const { plan, evs } = await ctx.db.db.transaction(async (tx) => {
    if (await officialRow(tx, projectId)) {
      conflict('这个项目已经有正式方案了，修改请走提案');
    }
    const [row] = await tx
      .insert(plans)
      .values({
        id: ids.plan(),
        projectId,
        kind: 'official',
        title: data.title,
        content: data.content,
        version: 1,
        createdBy: actor,
      })
      .returning();
    if (!row) throw new Error('正式方案写入失败');
    const [ver] = await tx
      .insert(planVersions)
      .values({
        id: ids.planVersion(),
        projectId,
        planId: row.id,
        version: 1,
        content: data.content,
        note: data.note,
        approvedBy: actor,
        createdBy: actor,
      })
      .returning();
    if (!ver) throw new Error('方案版本写入失败');
    const plan = planDto(row);
    const evs: Ev[] = [
      await ctx.bus.record(tx, { projectId, type: 'plan.created', payload: plan, actor }),
      await ctx.bus.record(tx, {
        projectId,
        type: 'plan.version_created',
        payload: planVersionDto(ver),
        actor,
      }),
    ];
    return { plan, evs };
  });
  emitAll(ctx, evs);
  return plan;
}

/** 从当前正式版本分叉一份探索副本（没有正式方案时从空白开始） */
export async function createExploration(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  input: unknown,
): Promise<Plan> {
  const data = parse(ExplorationCreate, input);
  const ownerId = userIdOf(actor);
  const { plan, evs } = await ctx.db.db.transaction(async (tx) => {
    const official = await officialRow(tx, projectId);
    const content = official?.content ?? '';
    const [row] = await tx
      .insert(plans)
      .values({
        id: ids.plan(),
        projectId,
        kind: 'exploration',
        title: data.title,
        summary: data.summary,
        content,
        version: 1,
        forkedFromVersion: official?.version ?? null,
        ownerId,
        createdBy: actor,
      })
      .returning();
    if (!row) throw new Error('探索副本写入失败');
    const [ver] = await tx
      .insert(planVersions)
      .values({
        id: ids.planVersion(),
        projectId,
        planId: row.id,
        version: 1,
        content,
        note: official ? `从正式方案第 ${official.version} 版分叉` : '新建探索副本',
        createdBy: actor,
      })
      .returning();
    if (!ver) throw new Error('方案版本写入失败');
    const plan = planDto(row);
    const evs: Ev[] = [
      await ctx.bus.record(tx, { projectId, type: 'plan.created', payload: plan, actor }),
      await ctx.bus.record(tx, {
        projectId,
        type: 'plan.version_created',
        payload: planVersionDto(ver),
        actor,
      }),
    ];
    return { plan, evs };
  });
  emitAll(ctx, evs);
  return plan;
}

/** 改标题 / 说明 / 归档状态。正式方案只有负责人能改标题和说明。 */
export async function patchPlan(
  ctx: AppContext,
  access: PlanAccess,
  projectId: string,
  planId: string,
  input: unknown,
): Promise<Plan> {
  const data = parse(ExplorationPatch, input);
  const { actor } = access;
  const { plan, ev } = await ctx.db.db.transaction(async (tx) => {
    const current = await loadPlan(tx, projectId, planId);
    if (current.kind === 'official') {
      if (!access.canManage) throw new ApiError('forbidden', '只有项目负责人可以修改正式方案');
      if (data.status !== undefined) conflict('正式方案不能归档');
    } else {
      assertExplorationWritable(current, access);
      if (data.status !== undefined && current.status === 'merged') {
        conflict('这份探索副本已纳入正式方案，不能再改状态');
      }
    }
    const patch: Partial<PlanRow> = {};
    if (data.title !== undefined) patch.title = data.title;
    if (data.summary !== undefined) patch.summary = data.summary;
    if (data.status !== undefined) patch.status = data.status;
    let row = current;
    if (Object.keys(patch).length) {
      patch.updatedAt = new Date();
      const [updated] = await tx.update(plans).set(patch).where(eq(plans.id, planId)).returning();
      if (!updated) notFound('方案');
      row = updated;
    }
    const plan = planDto(row);
    const ev = await ctx.bus.record(tx, { projectId, type: 'plan.updated', payload: plan, actor });
    return { plan, ev };
  });
  ctx.bus.emit(ev);
  return plan;
}

export async function archivePlan(
  ctx: AppContext,
  access: PlanAccess,
  projectId: string,
  planId: string,
): Promise<Plan> {
  return patchPlan(ctx, access, projectId, planId, { status: 'archived' });
}

/** 保存探索副本正文：乐观并发，每次保存留一版 */
export async function savePlanContent(
  ctx: AppContext,
  access: PlanAccess,
  projectId: string,
  planId: string,
  input: unknown,
): Promise<Plan> {
  const data = parse(PlanContentInput, input);
  const { actor } = access;
  const { plan, evs } = await ctx.db.db.transaction(async (tx) => {
    const current = await loadPlan(tx, projectId, planId);
    assertExplorationWritable(current, access);
    if (current.status !== 'active') conflict('只有进行中的探索副本可以修改，请先恢复它');
    assertVersion(current, data.baseVersion, planDto(current));
    const version = current.version + 1;
    const [row] = await tx
      .update(plans)
      .set({ content: data.content, version, updatedAt: new Date() })
      .where(and(eq(plans.id, planId), eq(plans.version, current.version)))
      .returning();
    if (!row) {
      throw new ApiError('version_conflict', '内容已被他人修改，已为你载入最新版本', {
        current: planDto(await loadPlan(tx, projectId, planId)),
      });
    }
    const [ver] = await tx
      .insert(planVersions)
      .values({
        id: ids.planVersion(),
        projectId,
        planId,
        version,
        content: data.content,
        note: data.note,
        createdBy: actor,
      })
      .returning();
    if (!ver) throw new Error('方案版本写入失败');
    const plan = planDto(row);
    const evs: Ev[] = [
      await ctx.bus.record(tx, { projectId, type: 'plan.updated', payload: plan, actor }),
      await ctx.bus.record(tx, {
        projectId,
        type: 'plan.version_created',
        payload: planVersionDto(ver),
        actor,
      }),
    ];
    return { plan, evs };
  });
  emitAll(ctx, evs);
  return plan;
}

export async function listPlanVersions(
  ctx: AppContext,
  projectId: string,
  planId: string,
): Promise<PlanVersion[]> {
  await loadPlan(ctx.db.db, projectId, planId);
  const rows = await ctx.db.db
    .select()
    .from(planVersions)
    .where(eq(planVersions.planId, planId))
    .orderBy(desc(planVersions.version));
  return rows.map(planVersionDto);
}

export async function getPlanVersion(
  ctx: AppContext,
  projectId: string,
  planId: string,
  versionParam: string,
): Promise<PlanVersion> {
  const version = Number(versionParam);
  if (!Number.isInteger(version) || version < 1) invalid('version', '版本号应为正整数');
  await loadPlan(ctx.db.db, projectId, planId);
  const [row] = await ctx.db.db
    .select()
    .from(planVersions)
    .where(and(eq(planVersions.planId, planId), eq(planVersions.version, version)));
  if (!row) notFound('方案版本');
  return planVersionDto(row);
}

// ---------------------------------------------------------------- 提案

/** 草稿只有作者能看；其余状态全项目可见 */
async function loadProposal(
  exec: Executor,
  access: PlanAccess,
  projectId: string,
  proposalId: string,
): Promise<BasisProposalRow> {
  const [row] = await exec
    .select()
    .from(basisProposals)
    .where(and(eq(basisProposals.id, proposalId), eq(basisProposals.projectId, projectId)));
  if (!row) notFound('提案');
  const me = access.actor.kind === 'user' ? access.actor.id : null;
  if (row.status === 'draft' && row.authorId !== me) notFound('提案');
  return row;
}

function assertAuthor(row: BasisProposalRow, actor: ActorRef) {
  if (actor.kind !== 'user' || row.authorId !== actor.id) {
    throw new ApiError('forbidden', '只有提案的提出者可以修改、提交或撤回它');
  }
}

export async function listProposals(
  ctx: AppContext,
  access: PlanAccess,
  projectId: string,
  filter: z.output<typeof ProposalListQuery> = {},
): Promise<BasisProposal[]> {
  const me = access.actor.kind === 'user' ? access.actor.id : null;
  const visible = me
    ? or(ne(basisProposals.status, 'draft'), eq(basisProposals.authorId, me))
    : ne(basisProposals.status, 'draft');
  const where = [eq(basisProposals.projectId, projectId), visible];
  if (filter.status) where.push(eq(basisProposals.status, filter.status));
  const rows = await ctx.db.db
    .select()
    .from(basisProposals)
    .where(and(...where))
    .orderBy(desc(basisProposals.createdAt));
  return rows.map(proposalDto);
}

export async function getProposal(
  ctx: AppContext,
  access: PlanAccess,
  projectId: string,
  proposalId: string,
): Promise<BasisProposal> {
  return proposalDto(await loadProposal(ctx.db.db, access, projectId, proposalId));
}

async function loadBasisRow(
  exec: Executor,
  projectId: string,
  basisId: string,
): Promise<TeamBasisRow | undefined> {
  const [row] = await exec
    .select()
    .from(teamBasis)
    .where(and(eq(teamBasis.id, basisId), eq(teamBasis.projectId, projectId)));
  return row;
}

/** 提交前的完整性检查（草稿可以不完整） */
async function assertSubmittable(exec: Executor, projectId: string, row: BasisProposalRow) {
  if (row.kind === 'team_basis') {
    if (!row.claimType) invalid('claimType', '请标明这是假设、实验观察还是正式决定');
    if (!row.content.trim()) invalid('content', '请填写要纳入团队依据的内容');
  } else {
    if (!(await officialRow(exec, projectId))) {
      invalid('kind', '项目还没有正式方案，请先请负责人建立第一版');
    }
  }
}

export async function createProposal(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  input: unknown,
): Promise<BasisProposal> {
  const data = parse(BasisProposalCreate, input);
  const authorId = userIdOf(actor);
  const { proposal, ev } = await ctx.db.db.transaction(async (tx) => {
    let content = data.content;
    let basePlanVersion: number | null = null;
    let sourcePlanId: string | null = null;
    let supersedesBasisId: string | null = null;
    if (data.kind === 'plan_change') {
      const official = await officialRow(tx, projectId);
      if (data.sourcePlanId) {
        const [src] = await tx
          .select()
          .from(plans)
          .where(
            and(
              eq(plans.id, data.sourcePlanId),
              eq(plans.projectId, projectId),
              eq(plans.kind, 'exploration'),
            ),
          );
        if (!src) invalid('sourcePlanId', 'sourcePlanId 指向的探索副本不存在');
        sourcePlanId = src.id;
        if (!content) content = src.content;
      }
      basePlanVersion = data.basePlanVersion ?? official?.version ?? null;
      if (basePlanVersion !== null && basePlanVersion > (official?.version ?? 0)) {
        invalid('basePlanVersion', '基于的正式版本号不存在');
      }
    } else if (data.supersedesBasisId) {
      const old = await loadBasisRow(tx, projectId, data.supersedesBasisId);
      if (!old) invalid('supersedesBasisId', 'supersedesBasisId 指向的团队依据不存在');
      supersedesBasisId = old.id;
    }
    const [row] = await tx
      .insert(basisProposals)
      .values({
        id: ids.proposal(),
        projectId,
        kind: data.kind,
        status: 'draft',
        title: data.title,
        content,
        rationale: data.rationale,
        impact: data.impact,
        conditions: data.conditions,
        claimType: data.claimType ?? null,
        evidence: data.evidence,
        basePlanVersion,
        sourcePlanId,
        supersedesBasisId,
        authorId,
        draftedBy: actor,
      })
      .returning();
    if (!row) throw new Error('提案写入失败');
    let final = row;
    if (data.submit) {
      await assertSubmittable(tx, projectId, row);
      const [submitted] = await tx
        .update(basisProposals)
        .set({ status: 'submitted', submittedAt: new Date() })
        .where(eq(basisProposals.id, row.id))
        .returning();
      if (!submitted) throw new Error('提案提交失败');
      final = submitted;
    }
    const proposal = proposalDto(final);
    const ev = await ctx.bus.record(tx, {
      projectId,
      type: 'basis_proposal.created',
      payload: proposal,
      actor,
    });
    return { proposal, ev };
  });
  ctx.bus.emit(ev);
  if (proposal.status === 'submitted') await notifyReviewers(ctx, proposal);
  return proposal;
}

async function notifyReviewers(ctx: AppContext, proposal: BasisProposal) {
  const leads = await leadIds(ctx, proposal.projectId);
  for (const userId of leads) {
    if (userId === proposal.authorId) continue;
    await createInboxItem(ctx, {
      projectId: proposal.projectId,
      userId,
      kind: 'review',
      title: `待审批提案：${proposal.title}`,
      href: plansHref(proposal.projectId, `proposal=${proposal.id}`),
      sourceId: proposal.id,
    });
  }
}

export async function patchProposal(
  ctx: AppContext,
  access: PlanAccess,
  projectId: string,
  proposalId: string,
  input: unknown,
): Promise<BasisProposal> {
  const data = parse(BasisProposalPatch, input);
  const { actor } = access;
  const { proposal, ev } = await ctx.db.db.transaction(async (tx) => {
    const current = await loadProposal(tx, access, projectId, proposalId);
    assertAuthor(current, actor);
    if (current.status !== 'draft' && current.status !== 'submitted') {
      conflict('这份提案已经处理完了，不能再修改');
    }
    assertVersion(current, data.baseVersion, proposalDto(current));
    const patch: Partial<BasisProposalRow> = {};
    if (data.title !== undefined) patch.title = data.title;
    if (data.content !== undefined) patch.content = data.content;
    if (data.rationale !== undefined) patch.rationale = data.rationale;
    if (data.impact !== undefined) patch.impact = data.impact;
    if (data.conditions !== undefined) patch.conditions = data.conditions;
    if (data.claimType !== undefined) patch.claimType = data.claimType;
    if (data.evidence !== undefined) patch.evidence = data.evidence;
    if (data.basePlanVersion !== undefined) {
      if (current.kind !== 'plan_change') {
        invalid('basePlanVersion', '只有修改正式方案的提案有基于版本');
      }
      const official = await officialRow(tx, projectId);
      if (data.basePlanVersion > (official?.version ?? 0)) {
        invalid('basePlanVersion', '基于的正式版本号不存在');
      }
      patch.basePlanVersion = data.basePlanVersion;
    }
    const merged = { ...current, ...patch };
    if (current.status === 'submitted') await assertSubmittable(tx, projectId, merged);
    patch.version = current.version + 1;
    patch.updatedAt = new Date();
    const [row] = await tx
      .update(basisProposals)
      .set(patch)
      .where(eq(basisProposals.id, proposalId))
      .returning();
    if (!row) notFound('提案');
    const proposal = proposalDto(row);
    const ev = await ctx.bus.record(tx, {
      projectId,
      type: 'basis_proposal.updated',
      payload: proposal,
      actor,
    });
    return { proposal, ev };
  });
  ctx.bus.emit(ev);
  return proposal;
}

export async function submitProposal(
  ctx: AppContext,
  access: PlanAccess,
  projectId: string,
  proposalId: string,
): Promise<BasisProposal> {
  const { actor } = access;
  const { proposal, ev } = await ctx.db.db.transaction(async (tx) => {
    const current = await loadProposal(tx, access, projectId, proposalId);
    assertAuthor(current, actor);
    if (current.status !== 'draft' && current.status !== 'withdrawn') {
      conflict(current.status === 'submitted' ? '这份提案已经提交了' : '这份提案已经处理完了');
    }
    await assertSubmittable(tx, projectId, current);
    const [row] = await tx
      .update(basisProposals)
      .set({
        status: 'submitted',
        submittedAt: new Date(),
        version: current.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(basisProposals.id, proposalId))
      .returning();
    if (!row) notFound('提案');
    const proposal = proposalDto(row);
    const ev = await ctx.bus.record(tx, {
      projectId,
      type: 'basis_proposal.updated',
      payload: proposal,
      actor,
    });
    return { proposal, ev };
  });
  ctx.bus.emit(ev);
  await notifyReviewers(ctx, proposal);
  return proposal;
}

export async function withdrawProposal(
  ctx: AppContext,
  access: PlanAccess,
  projectId: string,
  proposalId: string,
): Promise<BasisProposal> {
  const { actor } = access;
  const { proposal, ev } = await ctx.db.db.transaction(async (tx) => {
    const current = await loadProposal(tx, access, projectId, proposalId);
    assertAuthor(current, actor);
    if (current.status !== 'submitted') conflict('只有待审批的提案可以撤回');
    const [row] = await tx
      .update(basisProposals)
      .set({ status: 'withdrawn', version: current.version + 1, updatedAt: new Date() })
      .where(eq(basisProposals.id, proposalId))
      .returning();
    if (!row) notFound('提案');
    const proposal = proposalDto(row);
    const ev = await ctx.bus.record(tx, {
      projectId,
      type: 'basis_proposal.updated',
      payload: proposal,
      actor,
    });
    return { proposal, ev };
  });
  ctx.bus.emit(ev);
  await markInboxDoneBySource(ctx, projectId, proposalId, actor);
  return proposal;
}

/** 删除草稿或已撤回的提案（作者本人） */
export async function deleteProposal(
  ctx: AppContext,
  access: PlanAccess,
  projectId: string,
  proposalId: string,
): Promise<void> {
  const { actor } = access;
  const ev = await ctx.db.db.transaction(async (tx) => {
    const current = await loadProposal(tx, access, projectId, proposalId);
    assertAuthor(current, actor);
    if (current.status !== 'draft' && current.status !== 'withdrawn') {
      conflict('只有草稿或已撤回的提案可以删除');
    }
    await tx.delete(basisProposals).where(eq(basisProposals.id, proposalId));
    return ctx.bus.record(tx, {
      projectId,
      type: 'basis_proposal.deleted',
      payload: { id: proposalId },
      actor,
    });
  });
  ctx.bus.emit(ev);
  await markInboxDoneBySource(ctx, projectId, proposalId, actor);
}

/** 标记为待复核的依据（提交后发复核提醒） */
interface Flagged {
  basis: TeamBasis;
}

/**
 * 把依赖关系变了的有效依据改成待复核。
 * - newPlanVersion：planVersion 低于新版本的依据；
 * - supersededBasisId：证据引用了被替代依据的依据。
 */
async function flagDependents(
  ctx: AppContext,
  tx: Executor,
  actor: ActorRef,
  projectId: string,
  trigger: { newPlanVersion?: number; supersededBasisId?: string; reason: string },
  excludeIds: string[] = [],
): Promise<{ flagged: Flagged[]; evs: Ev[] }> {
  const active = await tx
    .select()
    .from(teamBasis)
    .where(and(eq(teamBasis.projectId, projectId), eq(teamBasis.status, 'active')));
  const hits = active.filter((row) => {
    if (excludeIds.includes(row.id)) return false;
    if (
      trigger.newPlanVersion !== undefined &&
      row.planVersion !== null &&
      row.planVersion < trigger.newPlanVersion
    ) {
      return true;
    }
    if (trigger.supersededBasisId) {
      return (row.evidence ?? []).some(
        (e) => e.kind === 'team_basis' && e.ref === trigger.supersededBasisId,
      );
    }
    return false;
  });
  const flagged: Flagged[] = [];
  const evs: Ev[] = [];
  for (const row of hits) {
    const [updated] = await tx
      .update(teamBasis)
      .set({ status: 'needs_review', reviewReason: trigger.reason, updatedAt: new Date() })
      .where(eq(teamBasis.id, row.id))
      .returning();
    if (!updated) continue;
    const basis = teamBasisDto(updated);
    flagged.push({ basis });
    evs.push(
      await ctx.bus.record(tx, { projectId, type: 'team_basis.updated', payload: basis, actor }),
    );
  }
  return { flagged, evs };
}

/** 复核提醒：发给依据的提出者和负责人 */
async function notifyRecheck(ctx: AppContext, projectId: string, flagged: Flagged[]) {
  if (!flagged.length) return;
  const leads = await leadIds(ctx, projectId);
  for (const { basis } of flagged) {
    const targets = new Set(leads);
    if (basis.proposerId) targets.add(basis.proposerId);
    for (const userId of targets) {
      await createInboxItem(ctx, {
        projectId,
        userId,
        kind: 'recheck',
        title: `依据需复核：${basis.title}`,
        href: plansHref(projectId, `basis=${basis.id}`),
        sourceId: basis.id,
      });
    }
  }
}

/** 采纳时冻结证据的版本：没写版本的，按当前状态补上 */
async function freezeEvidence(
  exec: Executor,
  projectId: string,
  evidence: BasisEvidence[],
  officialVersion: number | null,
): Promise<BasisEvidence[]> {
  const out: BasisEvidence[] = [];
  for (const e of evidence) {
    if (e.version) {
      out.push(e);
      continue;
    }
    let version: string | undefined;
    if (e.kind === 'plan_version' && officialVersion !== null) {
      version = String(officialVersion);
    } else if (e.kind === 'team_basis') {
      const row = await loadBasisRow(exec, projectId, e.ref);
      if (row) version = row.updatedAt.toISOString();
    } else if (e.kind === 'personal_memory') {
      const [row] = await exec
        .select({ version: personalMemory.version })
        .from(personalMemory)
        .where(and(eq(personalMemory.id, e.ref), eq(personalMemory.projectId, projectId)));
      if (row) version = String(row.version);
    }
    out.push(version ? { ...e, version } : e);
  }
  return out;
}

export async function decideProposal(
  ctx: AppContext,
  access: PlanAccess,
  projectId: string,
  proposalId: string,
  input: unknown,
): Promise<BasisProposal> {
  const data = parse(BasisProposalDecision, input);
  const { actor } = access;
  const { proposal, evs, flagged } = await ctx.db.db.transaction(async (tx) => {
    const current = await loadProposal(tx, access, projectId, proposalId);
    if (current.status !== 'submitted') conflict('只有待审批的提案可以审批');
    const evs: Ev[] = [];
    let flagged: Flagged[] = [];
    const patch: Partial<BasisProposalRow> = {
      decidedBy: actor,
      decidedAt: new Date(),
      decisionNote: data.note,
      version: current.version + 1,
      updatedAt: new Date(),
    };

    if (data.decision === 'reject') {
      patch.status = 'rejected';
    } else if (current.kind === 'plan_change') {
      const official = await officialRow(tx, projectId);
      if (!official) conflict('项目还没有正式方案');
      if (current.basePlanVersion !== official.version) {
        throw new ApiError(
          'version_conflict',
          `正式方案已更新到第 ${official.version} 版，这份提案基于第 ${current.basePlanVersion ?? 0} 版，请提出者基于最新版本更新后再审批`,
          { current: planDto(official) },
        );
      }
      const version = official.version + 1;
      const [planRow] = await tx
        .update(plans)
        .set({ content: current.content, version, updatedAt: new Date() })
        .where(and(eq(plans.id, official.id), eq(plans.version, official.version)))
        .returning();
      if (!planRow) {
        throw new ApiError('version_conflict', '正式方案刚被更新，请刷新后再审批', {
          current: planDto(official),
        });
      }
      const [ver] = await tx
        .insert(planVersions)
        .values({
          id: ids.planVersion(),
          projectId,
          planId: official.id,
          version,
          content: current.content,
          note: current.title,
          proposalId: current.id,
          approvedBy: actor,
          createdBy: await userRef(tx, current.authorId),
        })
        .returning();
      if (!ver) throw new Error('方案版本写入失败');
      evs.push(
        await ctx.bus.record(tx, {
          projectId,
          type: 'plan.updated',
          payload: planDto(planRow),
          actor,
        }),
        await ctx.bus.record(tx, {
          projectId,
          type: 'plan.version_created',
          payload: planVersionDto(ver),
          actor,
        }),
      );
      if (current.sourcePlanId) {
        const [src] = await tx
          .update(plans)
          .set({ status: 'merged', updatedAt: new Date() })
          .where(
            and(
              eq(plans.id, current.sourcePlanId),
              eq(plans.projectId, projectId),
              eq(plans.kind, 'exploration'),
            ),
          )
          .returning();
        if (src) {
          evs.push(
            await ctx.bus.record(tx, {
              projectId,
              type: 'plan.updated',
              payload: planDto(src),
              actor,
            }),
          );
        }
      }
      patch.status = 'accepted';
      patch.resultPlanVersion = version;
      const res = await flagDependents(ctx, tx, actor, projectId, {
        newPlanVersion: version,
        reason: `正式方案已更新到第 ${version} 版（提案「${current.title}」），请确认这条依据是否仍然成立`,
      });
      flagged = res.flagged;
      evs.push(...res.evs);
    } else {
      if (!current.claimType) invalid('claimType', '请标明这是假设、实验观察还是正式决定');
      const official = await officialRow(tx, projectId);
      const officialVersion = official?.version ?? null;
      let old: TeamBasisRow | undefined;
      if (current.supersedesBasisId) {
        old = await loadBasisRow(tx, projectId, current.supersedesBasisId);
        if (!old) conflict('要替代的团队依据已不存在');
        if (old.status === 'superseded' || old.status === 'retired') {
          conflict('要替代的团队依据已被替代或停用，请提出者更新提案');
        }
      }
      const basisId = ids.basis();
      const [row] = await tx
        .insert(teamBasis)
        .values({
          id: basisId,
          projectId,
          title: current.title,
          content: current.content,
          claimType: current.claimType,
          conditions: current.conditions,
          evidence: await freezeEvidence(tx, projectId, current.evidence ?? [], officialVersion),
          planVersion: officialVersion,
          proposalId: current.id,
          proposerId: current.authorId,
          proposer: await userRef(tx, current.authorId),
          approvedBy: actor,
        })
        .returning();
      if (!row) throw new Error('团队依据写入失败');
      evs.push(
        await ctx.bus.record(tx, {
          projectId,
          type: 'team_basis.created',
          payload: teamBasisDto(row),
          actor,
        }),
      );
      if (old) {
        const [sup] = await tx
          .update(teamBasis)
          .set({ status: 'superseded', supersededBy: basisId, updatedAt: new Date() })
          .where(eq(teamBasis.id, old.id))
          .returning();
        if (sup) {
          evs.push(
            await ctx.bus.record(tx, {
              projectId,
              type: 'team_basis.updated',
              payload: teamBasisDto(sup),
              actor,
            }),
          );
        }
        const res = await flagDependents(
          ctx,
          tx,
          actor,
          projectId,
          {
            supersededBasisId: old.id,
            reason: `引用的团队依据「${old.title}」已被「${current.title}」替代，请确认这条依据是否仍然成立`,
          },
          [basisId],
        );
        flagged = res.flagged;
        evs.push(...res.evs);
      }
      patch.status = 'accepted';
      patch.resultBasisId = basisId;
    }

    const [row] = await tx
      .update(basisProposals)
      .set(patch)
      .where(eq(basisProposals.id, proposalId))
      .returning();
    if (!row) notFound('提案');
    const proposal = proposalDto(row);
    evs.push(
      await ctx.bus.record(tx, {
        projectId,
        type: 'basis_proposal.updated',
        payload: proposal,
        actor,
      }),
    );
    return { proposal, evs, flagged };
  });
  emitAll(ctx, evs);
  await markInboxDoneBySource(ctx, projectId, proposalId, actor);
  await notifyRecheck(ctx, projectId, flagged);
  return proposal;
}

// ---------------------------------------------------------------- 团队依据

export async function listBasis(
  ctx: AppContext,
  projectId: string,
  filter: z.output<typeof BasisListQuery> = {},
): Promise<TeamBasis[]> {
  const where = [eq(teamBasis.projectId, projectId)];
  if (filter.status) where.push(eq(teamBasis.status, filter.status));
  const rows = await ctx.db.db
    .select()
    .from(teamBasis)
    .where(and(...where))
    .orderBy(desc(teamBasis.createdAt));
  return rows.map(teamBasisDto);
}

export async function getBasis(
  ctx: AppContext,
  projectId: string,
  basisId: string,
): Promise<TeamBasis> {
  const row = await loadBasisRow(ctx.db.db, projectId, basisId);
  if (!row) notFound('团队依据');
  return teamBasisDto(row);
}

/** 负责人复核：confirm = 仍然成立（回到有效），retire = 停用 */
export async function reviewBasis(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  basisId: string,
  input: unknown,
): Promise<TeamBasis> {
  const data = parse(TeamBasisReview, input);
  const { basis, ev } = await ctx.db.db.transaction(async (tx) => {
    const current = await loadBasisRow(tx, projectId, basisId);
    if (!current) notFound('团队依据');
    if (current.status === 'superseded' || current.status === 'retired') {
      conflict('这条依据已被替代或停用');
    }
    if (data.action === 'confirm' && current.status !== 'needs_review') {
      conflict('这条依据不需要复核');
    }
    const official = await officialRow(tx, projectId);
    const patch: Partial<TeamBasisRow> =
      data.action === 'confirm'
        ? {
            status: 'active',
            reviewReason: '',
            // 确认仍然成立：依赖的方案版本跟到当前版本，下次方案更新再提醒
            planVersion: official?.version ?? current.planVersion,
            updatedAt: new Date(),
          }
        : {
            status: 'retired',
            reviewReason: data.note || current.reviewReason,
            updatedAt: new Date(),
          };
    const [row] = await tx
      .update(teamBasis)
      .set(patch)
      .where(eq(teamBasis.id, basisId))
      .returning();
    if (!row) notFound('团队依据');
    const basis = teamBasisDto(row);
    const ev = await ctx.bus.record(tx, {
      projectId,
      type: 'team_basis.updated',
      payload: basis,
      actor,
    });
    return { basis, ev };
  });
  ctx.bus.emit(ev);
  await markInboxDoneBySource(ctx, projectId, basisId, actor);
  return basis;
}

// ---------------------------------------------------------------- 个人记忆

export async function listMemory(
  ctx: AppContext,
  access: PlanAccess,
  projectId: string,
  filter: z.output<typeof MemoryListQuery> = {},
): Promise<PersonalMemory[]> {
  const me = userIdOf(access.actor);
  const target = filter.userId ?? me;
  if (target !== me && !access.canManage) {
    throw new ApiError('forbidden', '个人工作记忆只有本人和项目负责人能看');
  }
  const rows = await ctx.db.db
    .select()
    .from(personalMemory)
    .where(and(eq(personalMemory.projectId, projectId), eq(personalMemory.userId, target)))
    .orderBy(desc(personalMemory.updatedAt));
  return rows.map(personalMemoryDto);
}

/** 本人的记忆；负责人能看但不能改（403），其他人 404 */
async function loadOwnMemory(
  exec: Executor,
  access: PlanAccess,
  projectId: string,
  memoryId: string,
): Promise<PersonalMemoryRow> {
  const me = userIdOf(access.actor);
  const [row] = await exec
    .select()
    .from(personalMemory)
    .where(and(eq(personalMemory.id, memoryId), eq(personalMemory.projectId, projectId)));
  if (!row) notFound('个人记忆');
  if (row.userId !== me) {
    if (access.canManage) throw new ApiError('forbidden', '个人工作记忆只有本人可以修改');
    notFound('个人记忆');
  }
  return row;
}

export async function createMemory(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  input: unknown,
): Promise<PersonalMemory> {
  const data = parse(PersonalMemoryInput, input);
  const userId = userIdOf(actor);
  if (data.baseVersion !== 0) invalid('baseVersion', '新建个人记忆时 baseVersion 应为 0');
  const [row] = await ctx.db.db
    .insert(personalMemory)
    .values({
      id: ids.memory(),
      projectId,
      userId,
      title: data.title,
      content: data.content,
      updatedBy: actor,
    })
    .returning();
  if (!row) throw new Error('个人记忆写入失败');
  return personalMemoryDto(row);
}

export async function updateMemory(
  ctx: AppContext,
  access: PlanAccess,
  projectId: string,
  memoryId: string,
  input: unknown,
): Promise<PersonalMemory> {
  const data = parse(PersonalMemoryInput, input);
  return ctx.db.db.transaction(async (tx) => {
    const current = await loadOwnMemory(tx, access, projectId, memoryId);
    assertVersion(current, data.baseVersion, personalMemoryDto(current));
    const [row] = await tx
      .update(personalMemory)
      .set({
        title: data.title,
        content: data.content,
        updatedBy: access.actor,
        version: current.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(personalMemory.id, memoryId), eq(personalMemory.version, current.version)))
      .returning();
    if (!row) {
      throw new ApiError('version_conflict', '内容已被修改，已为你载入最新版本', {
        current: personalMemoryDto(current),
      });
    }
    return personalMemoryDto(row);
  });
}

export async function deleteMemory(
  ctx: AppContext,
  access: PlanAccess,
  projectId: string,
  memoryId: string,
): Promise<void> {
  await ctx.db.db.transaction(async (tx) => {
    await loadOwnMemory(tx, access, projectId, memoryId);
    await tx.delete(personalMemory).where(eq(personalMemory.id, memoryId));
  });
}
