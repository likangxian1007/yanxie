import type { BasisProposal, PersonalMemory, Plan, PlanVersion, TeamBasis } from '@srh/shared';
import type {
  basisProposals,
  personalMemory,
  planVersions,
  plans,
  teamBasis,
} from '../../db/schema';
import { iso, isoReq } from '../collab-common';

export type PlanRow = typeof plans.$inferSelect;
export type PlanVersionRow = typeof planVersions.$inferSelect;
export type BasisProposalRow = typeof basisProposals.$inferSelect;
export type PersonalMemoryRow = typeof personalMemory.$inferSelect;
export type TeamBasisRow = typeof teamBasis.$inferSelect;

export function planDto(row: PlanRow): Plan {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    content: row.content,
    version: row.version,
    forkedFromVersion: row.forkedFromVersion ?? null,
    ownerId: row.ownerId ?? null,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: isoReq(row.createdAt),
    updatedAt: isoReq(row.updatedAt),
  };
}

export function planVersionDto(row: PlanVersionRow): PlanVersion {
  return {
    id: row.id,
    planId: row.planId,
    version: row.version,
    content: row.content,
    note: row.note,
    proposalId: row.proposalId ?? null,
    approvedBy: row.approvedBy ?? null,
    createdBy: row.createdBy,
    createdAt: isoReq(row.createdAt),
  };
}

export function proposalDto(row: BasisProposalRow): BasisProposal {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    status: row.status,
    title: row.title,
    content: row.content,
    rationale: row.rationale,
    impact: row.impact,
    conditions: row.conditions,
    claimType: row.claimType ?? null,
    evidence: row.evidence ?? [],
    basePlanVersion: row.basePlanVersion ?? null,
    sourcePlanId: row.sourcePlanId ?? null,
    supersedesBasisId: row.supersedesBasisId ?? null,
    authorId: row.authorId,
    draftedBy: row.draftedBy,
    submittedAt: iso(row.submittedAt),
    decidedBy: row.decidedBy ?? null,
    decidedAt: iso(row.decidedAt),
    decisionNote: row.decisionNote,
    resultPlanVersion: row.resultPlanVersion ?? null,
    resultBasisId: row.resultBasisId ?? null,
    version: row.version,
    createdAt: isoReq(row.createdAt),
    updatedAt: isoReq(row.updatedAt),
  };
}

export function personalMemoryDto(row: PersonalMemoryRow): PersonalMemory {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    title: row.title,
    content: row.content,
    updatedBy: row.updatedBy,
    version: row.version,
    createdAt: isoReq(row.createdAt),
    updatedAt: isoReq(row.updatedAt),
  };
}

export function teamBasisDto(row: TeamBasisRow): TeamBasis {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    content: row.content,
    claimType: row.claimType,
    conditions: row.conditions,
    evidence: row.evidence ?? [],
    planVersion: row.planVersion ?? null,
    proposalId: row.proposalId,
    proposerId: row.proposerId ?? null,
    proposer: row.proposer,
    approvedBy: row.approvedBy,
    status: row.status,
    reviewReason: row.reviewReason,
    supersededBy: row.supersededBy ?? null,
    createdAt: isoReq(row.createdAt),
    updatedAt: isoReq(row.updatedAt),
  };
}
