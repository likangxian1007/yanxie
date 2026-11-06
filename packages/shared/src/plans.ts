import { z } from 'zod';
import { ActorRef } from './entities';
import { tr } from './i18n';

/**
 * 正式方案、探索副本、个人记忆与团队依据（API.md §2.20）。
 * 归属：协作功能线程（modules/plans、features/plans）。
 *
 * - 每个项目一份「团队正式方案」，只有负责人（owner / advisor）采纳提案才会生成新的正式版本。
 * - 成员可以从某个正式版本分叉「探索副本」，随意修改，不影响正式方案；要纳入时提交提案。
 * - 个人工作记忆按项目、按人保存，只有本人和负责人能看。
 * - 关键数据、实验结果、结论通过提案进入「团队依据」（团队记忆副本），带出处、审批人、条件和类型。
 * - 正式方案出新版本、或依据被替代时，依赖它的团队依据标记为待复核，并提醒提出者和负责人。
 */
const Iso = z.string().describe(tr('ISO 8601 时间'));
const Id = z.string();

export const PlanKind = z.enum(['official', 'exploration']);
export type PlanKind = z.infer<typeof PlanKind>;

export const PlanStatus = z.enum(['active', 'archived', 'merged']);
export type PlanStatus = z.infer<typeof PlanStatus>;

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  active: tr('进行中'),
  archived: tr('已归档'),
  merged: tr('已纳入正式方案'),
};

export const BasisProposalKind = z.enum(['plan_change', 'team_basis']);
export type BasisProposalKind = z.infer<typeof BasisProposalKind>;

export const BASIS_PROPOSAL_KIND_LABEL: Record<BasisProposalKind, string> = {
  plan_change: tr('修改正式方案'),
  team_basis: tr('纳入团队依据'),
};

export const BasisProposalStatus = z.enum([
  'draft',
  'submitted',
  'accepted',
  'rejected',
  'withdrawn',
]);
export type BasisProposalStatus = z.infer<typeof BasisProposalStatus>;

export const BASIS_PROPOSAL_STATUS_LABEL: Record<BasisProposalStatus, string> = {
  draft: tr('草稿'),
  submitted: tr('待审批'),
  accepted: tr('已采纳'),
  rejected: tr('未采纳'),
  withdrawn: tr('已撤回'),
};

/** 内容属于假设、实验观察还是正式决定 */
export const BasisClaimType = z.enum(['hypothesis', 'observation', 'decision']);
export type BasisClaimType = z.infer<typeof BasisClaimType>;

export const BASIS_CLAIM_TYPE_LABEL: Record<BasisClaimType, string> = {
  hypothesis: tr('假设'),
  observation: tr('实验观察'),
  decision: tr('正式决定'),
};

export const TeamBasisStatus = z.enum(['active', 'needs_review', 'superseded', 'retired']);
export type TeamBasisStatus = z.infer<typeof TeamBasisStatus>;

export const TEAM_BASIS_STATUS_LABEL: Record<TeamBasisStatus, string> = {
  active: tr('有效'),
  needs_review: tr('待复核'),
  superseded: tr('已被替代'),
  retired: tr('已停用'),
};

/** 证据来源：方案版本、实验记录、文档、文件、文献、个人记忆、团队依据、外部链接 */
export const BasisEvidenceKind = z.enum([
  'plan_version',
  'experiment',
  'document',
  'notebook',
  'file',
  'paper',
  'personal_memory',
  'team_basis',
  'link',
]);
export type BasisEvidenceKind = z.infer<typeof BasisEvidenceKind>;

export const BASIS_EVIDENCE_KIND_LABEL: Record<BasisEvidenceKind, string> = {
  plan_version: tr('方案版本'),
  experiment: tr('实验记录'),
  document: tr('文档'),
  notebook: 'Notebook',
  file: tr('文件'),
  paper: tr('文献'),
  personal_memory: tr('个人记忆'),
  team_basis: tr('团队依据'),
  link: tr('链接'),
};

export const BasisEvidence = z.object({
  kind: BasisEvidenceKind,
  /** 对象 id；link 时为 URL */
  ref: z.string().min(1).max(500),
  /** 获准共享的版本（方案版本号、版本 id、记录的 version 等），采纳时冻结 */
  version: z.string().max(100).optional(),
  label: z.string().max(200).default(''),
  /** 摘录 / 关键数据 */
  excerpt: z.string().max(2000).optional(),
});
export type BasisEvidence = z.infer<typeof BasisEvidence>;

// ---------------------------------------------------------------- 实体

export const Plan = z.object({
  id: Id,
  projectId: Id,
  kind: PlanKind,
  title: z.string(),
  summary: z.string(),
  content: z.string(),
  version: z.number().int(),
  forkedFromVersion: z.number().int().nullable(),
  ownerId: Id.nullable(),
  status: PlanStatus,
  createdBy: ActorRef,
  createdAt: Iso,
  updatedAt: Iso,
});
export type Plan = z.infer<typeof Plan>;

export const PlanVersion = z.object({
  id: Id,
  planId: Id,
  version: z.number().int(),
  content: z.string(),
  note: z.string(),
  proposalId: Id.nullable(),
  approvedBy: ActorRef.nullable(),
  createdBy: ActorRef,
  createdAt: Iso,
});
export type PlanVersion = z.infer<typeof PlanVersion>;

export const BasisProposal = z.object({
  id: Id,
  projectId: Id,
  kind: BasisProposalKind,
  status: BasisProposalStatus,
  title: z.string(),
  content: z.string(),
  rationale: z.string(),
  impact: z.string(),
  conditions: z.string(),
  claimType: BasisClaimType.nullable(),
  evidence: z.array(BasisEvidence),
  basePlanVersion: z.number().int().nullable(),
  sourcePlanId: Id.nullable(),
  supersedesBasisId: Id.nullable(),
  authorId: Id,
  draftedBy: ActorRef,
  submittedAt: Iso.nullable(),
  decidedBy: ActorRef.nullable(),
  decidedAt: Iso.nullable(),
  decisionNote: z.string(),
  resultPlanVersion: z.number().int().nullable(),
  resultBasisId: Id.nullable(),
  version: z.number().int(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type BasisProposal = z.infer<typeof BasisProposal>;

export const PersonalMemory = z.object({
  id: Id,
  projectId: Id,
  userId: Id,
  title: z.string(),
  content: z.string(),
  updatedBy: ActorRef,
  version: z.number().int(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type PersonalMemory = z.infer<typeof PersonalMemory>;

export const TeamBasis = z.object({
  id: Id,
  projectId: Id,
  title: z.string(),
  content: z.string(),
  claimType: BasisClaimType,
  conditions: z.string(),
  evidence: z.array(BasisEvidence),
  planVersion: z.number().int().nullable(),
  proposalId: Id,
  proposerId: Id.nullable(),
  proposer: ActorRef,
  approvedBy: ActorRef,
  status: TeamBasisStatus,
  reviewReason: z.string(),
  supersededBy: Id.nullable(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type TeamBasis = z.infer<typeof TeamBasis>;

// ---------------------------------------------------------------- 输入

export const PlanContentInput = z.object({
  content: z.string().max(200_000),
  note: z.string().max(500).default(''),
  /** 乐观并发：当前 version */
  baseVersion: z.number().int().min(0),
});
export type PlanContentInput = z.infer<typeof PlanContentInput>;

/** 正式方案尚未建立时，由负责人直接建立第一版 */
export const OfficialPlanInit = z.object({
  title: z.string().min(1).max(200).default(tr('团队正式方案')),
  content: z.string().max(200_000),
  note: z.string().max(500).default(tr('建立正式方案')),
});
export type OfficialPlanInit = z.infer<typeof OfficialPlanInit>;

export const ExplorationCreate = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().max(2000).default(''),
});
export type ExplorationCreate = z.infer<typeof ExplorationCreate>;

export const ExplorationPatch = z.object({
  title: z.string().min(1).max(200).optional(),
  summary: z.string().max(2000).optional(),
  status: z.enum(['active', 'archived']).optional(),
});
export type ExplorationPatch = z.infer<typeof ExplorationPatch>;

export const BasisProposalCreate = z.object({
  kind: BasisProposalKind,
  title: z.string().min(1).max(200),
  content: z.string().max(200_000).default(''),
  rationale: z.string().max(10_000).default(''),
  impact: z.string().max(10_000).default(''),
  conditions: z.string().max(10_000).default(''),
  claimType: BasisClaimType.optional(),
  evidence: z.array(BasisEvidence).max(50).default([]),
  /** plan_change：基于的正式版本号；不填取当前版本 */
  basePlanVersion: z.number().int().min(0).optional(),
  /** plan_change：来自哪个探索副本（content 不填时取副本全文） */
  sourcePlanId: z.string().optional(),
  supersedesBasisId: z.string().optional(),
  /** 直接提交（否则保存为草稿） */
  submit: z.boolean().default(false),
});
export type BasisProposalCreate = z.infer<typeof BasisProposalCreate>;

export const BasisProposalPatch = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().max(200_000).optional(),
  rationale: z.string().max(10_000).optional(),
  impact: z.string().max(10_000).optional(),
  conditions: z.string().max(10_000).optional(),
  claimType: BasisClaimType.optional(),
  evidence: z.array(BasisEvidence).max(50).optional(),
  basePlanVersion: z.number().int().min(0).optional(),
  baseVersion: z.number().int().min(1),
});
export type BasisProposalPatch = z.infer<typeof BasisProposalPatch>;

export const BasisProposalDecision = z.object({
  decision: z.enum(['accept', 'reject']),
  note: z.string().max(2000).default(''),
});
export type BasisProposalDecision = z.infer<typeof BasisProposalDecision>;

export const PersonalMemoryInput = z.object({
  title: z.string().min(1).max(200),
  content: z.string().max(50_000),
  /** 0 = 新建 */
  baseVersion: z.number().int().min(0),
});
export type PersonalMemoryInput = z.infer<typeof PersonalMemoryInput>;

export const TeamBasisReview = z.object({
  action: z.enum(['confirm', 'retire']),
  note: z.string().max(2000).default(''),
});
export type TeamBasisReview = z.infer<typeof TeamBasisReview>;

/** 方案页总览：一次取齐首屏需要的东西 */
export const PlansOverview = z.object({
  official: Plan.nullable(),
  explorations: z.array(Plan),
  proposals: z.array(BasisProposal),
  basis: z.array(TeamBasis),
  canManage: z.boolean(),
});
export type PlansOverview = z.infer<typeof PlansOverview>;

// ---------------------------------------------------------------- 纯函数

/** 简单行级 diff（LCS），前后端共用：展示「具体改动」 */
export type LineDiffOp = { op: 'eq' | 'add' | 'del'; text: string };

export function lineDiff(before: string, after: string): LineDiffOp[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  // 超大文本退化为整段替换，避免 O(n*m) 内存
  if (n * m > 4_000_000) {
    return [
      ...a.map((text) => ({ op: 'del' as const, text })),
      ...b.map((text) => ({ op: 'add' as const, text })),
    ];
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: LineDiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: 'eq', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ op: 'del', text: a[i]! });
      i++;
    } else {
      out.push({ op: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ op: 'del', text: a[i++]! });
  while (j < m) out.push({ op: 'add', text: b[j++]! });
  return out;
}

export function diffStats(ops: LineDiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.op === 'add') added++;
    else if (o.op === 'del') removed++;
  }
  return { added, removed };
}
