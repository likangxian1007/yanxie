import { index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type {
  ActorRef,
  BasisClaimType,
  BasisEvidence,
  BasisProposalKind,
  BasisProposalStatus,
  PlanKind,
  PlanStatus,
  TeamBasisStatus,
} from '@srh/shared';
import { actor, createdAt, id, ts, updatedAt } from './_helpers';
import { projects, users } from './core';

/**
 * 正式方案、探索副本与团队依据（API.md §2.20）。归属：协作功能线程（modules/plans）。
 *
 * - plans：每个项目一份正式方案（kind=official），以及任意多份探索副本（kind=exploration，
 *   由某位成员建立，从某个正式版本分叉）。content 是当前正文（Markdown）。
 * - plan_versions：方案每次落定的不可变快照。正式方案只有经负责人采纳提案才会出新版本；
 *   探索副本每次保存都留一版，探索过程可追溯。
 * - basis_proposals：统一的「提案」。kind=plan_change 改正式方案（可来自探索副本），
 *   kind=team_basis 把个人记忆 / 实验结果 / 结论纳入团队依据。草稿可由 agent 整理，成员提交，负责人审批。
 * - personal_memory：成员个人工作记忆（每项目每人若干条），只有本人和负责人能看。
 * - team_basis：采纳后生成的团队记忆副本，独立于个人记忆，带完整出处与状态。
 */
export const plans = pgTable(
  'plans',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<PlanKind>().notNull(),
    title: text('title').notNull(),
    /** 探索副本的目的 / 想尝试的方法 */
    summary: text('summary').notNull().default(''),
    content: text('content').notNull().default(''),
    /** 当前版本号（plan_versions 里最大的 version），乐观并发也用它 */
    version: integer('version').notNull().default(0),
    /** 探索副本：分叉时的正式方案版本号 */
    forkedFromVersion: integer('forked_from_version'),
    /** 探索副本的建立者（正式方案为空） */
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
    status: text('status').$type<PlanStatus>().notNull().default('active'),
    createdBy: actor('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('plans_project_idx').on(t.projectId, t.kind, t.status)],
);

export const planVersions = pgTable(
  'plan_versions',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    note: text('note').notNull().default(''),
    /** 正式方案新版本对应的提案 */
    proposalId: text('proposal_id'),
    approvedBy: jsonb('approved_by').$type<ActorRef>(),
    createdBy: actor('created_by'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('plan_versions_plan_version_uq').on(t.planId, t.version)],
);

export const basisProposals = pgTable(
  'basis_proposals',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<BasisProposalKind>().notNull(),
    status: text('status').$type<BasisProposalStatus>().notNull().default('draft'),
    title: text('title').notNull(),
    /** plan_change：新的方案全文；team_basis：建议纳入的内容 */
    content: text('content').notNull().default(''),
    rationale: text('rationale').notNull().default(''),
    impact: text('impact').notNull().default(''),
    conditions: text('conditions').notNull().default(''),
    claimType: text('claim_type').$type<BasisClaimType>(),
    evidence: jsonb('evidence').$type<BasisEvidence[]>().notNull().default([]),
    /** plan_change：基于的正式版本号（采纳时若正式方案已前进则要求作者更新） */
    basePlanVersion: integer('base_plan_version'),
    /** plan_change 来自哪个探索副本 */
    sourcePlanId: text('source_plan_id'),
    /** team_basis：替代哪条已有依据（修订） */
    supersedesBasisId: text('supersedes_basis_id'),
    /** 提出者（成员本人） */
    authorId: text('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 实际起草者（成员本人或代表他的 agent） */
    draftedBy: actor('drafted_by'),
    submittedAt: ts('submitted_at'),
    decidedBy: jsonb('decided_by').$type<ActorRef>(),
    decidedAt: ts('decided_at'),
    decisionNote: text('decision_note').notNull().default(''),
    /** 采纳结果：新的方案版本号或团队依据 id */
    resultPlanVersion: integer('result_plan_version'),
    resultBasisId: text('result_basis_id'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('basis_proposals_project_idx').on(t.projectId, t.status, t.createdAt)],
);

export const personalMemory = pgTable(
  'personal_memory',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    content: text('content').notNull().default(''),
    /** 记录者：本人或代表他的 agent */
    updatedBy: actor('updated_by'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('personal_memory_owner_idx').on(t.projectId, t.userId, t.updatedAt)],
);

export const teamBasis = pgTable(
  'team_basis',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    content: text('content').notNull(),
    claimType: text('claim_type').$type<BasisClaimType>().notNull(),
    conditions: text('conditions').notNull().default(''),
    /** 采纳时冻结的来源及版本 */
    evidence: jsonb('evidence').$type<BasisEvidence[]>().notNull().default([]),
    /** 采纳时团队正式方案的版本号 */
    planVersion: integer('plan_version'),
    proposalId: text('proposal_id').notNull(),
    proposerId: text('proposer_id').references(() => users.id, { onDelete: 'set null' }),
    proposer: actor('proposer'),
    approvedBy: actor('approved_by'),
    status: text('status').$type<TeamBasisStatus>().notNull().default('active'),
    /** 需要复核的原因（依据的方案或来源变了） */
    reviewReason: text('review_reason').notNull().default(''),
    supersededBy: text('superseded_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('team_basis_project_idx').on(t.projectId, t.status)],
);
