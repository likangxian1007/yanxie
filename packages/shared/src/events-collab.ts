import { z } from 'zod';
import {
  Board,
  BoardColumn,
  Card,
  DocComment,
  DocumentMeta,
  DocumentVersion,
  Experiment,
  ExperimentLog,
  Report,
  Review,
  ReviewComment,
  Todo,
} from './entities-collab';
import { BasisProposal, Plan, PlanVersion, TeamBasis } from './plans';

/**
 * 协作功能的事件（文档、看板、待办、实验、审阅、汇报）。
 * 归属：协作功能线程。新增事件只在本文件追加，events.ts 会自动合并。
 */
const IdOnly = z.object({ id: z.string() });

export const COLLAB_EVENT_PAYLOADS = {
  'document.created': DocumentMeta,
  'document.updated': DocumentMeta,
  'document.deleted': IdOnly,
  'document.version_created': DocumentVersion,
  'document.comment_created': DocComment,
  'document.comment_updated': DocComment,
  'document.comment_deleted': z.object({ id: z.string(), documentId: z.string() }),
  'board.created': Board,
  'board.updated': Board,
  'board.deleted': IdOnly,
  'column.created': BoardColumn,
  'column.updated': BoardColumn,
  'column.deleted': IdOnly,
  'card.created': Card,
  'card.updated': Card,
  'card.deleted': IdOnly,
  'todo.created': Todo,
  'todo.updated': Todo,
  'todo.deleted': IdOnly,
  'experiment.created': Experiment,
  'experiment.updated': Experiment,
  'experiment.deleted': IdOnly,
  'experiment.log_created': ExperimentLog,
  'review.created': Review,
  'review.updated': Review,
  'review.comment_created': ReviewComment,
  'review.comment_updated': ReviewComment,
  'report.created': Report,
  'report.updated': Report,
  'report.deleted': IdOnly,
  // 正式方案、探索副本、提案与团队依据（个人记忆不广播）
  'plan.created': Plan,
  'plan.updated': Plan,
  'plan.version_created': PlanVersion,
  'basis_proposal.created': BasisProposal,
  'basis_proposal.updated': BasisProposal,
  'basis_proposal.deleted': IdOnly,
  'team_basis.created': TeamBasis,
  'team_basis.updated': TeamBasis,
} as const;
