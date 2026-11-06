import { boolean, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import type {
  ActorRef,
  ProposalHunk,
  ProposalMergeResult,
  ProposalStatus,
  ProposalTargetKind,
  VersionKind,
  VersionTargetKind,
} from '@srh/shared';
import { actor, createdAt, id, ts, updatedAt } from './_helpers';
import { projects } from './core';
import { bytea } from './collab';

/**
 * 版本管理（API.md §2.17）。归属：版本管理线程（modules/versioning）。
 *
 * - versions：文档 / notebook / 项目文件的历史版本。Yjs 对象存整份状态（Y.encodeStateAsUpdate），
 *   文件存原始字节；text 是可读表示（对比、预览不用再解 Yjs），content_hash 用来跳过没变化的自动快照。
 * - change_proposals：agent 的改动提案。base_state 是提出时正文的状态，draft_state 是 agent 写完的草稿，
 *   hunks 是两者之间的改动块和每块的接受 / 拒绝决定。
 * - versioning_settings：每个项目一行（agent 是否直接写入、关联的 GitHub 仓库）。
 */
export const versions = pgTable(
  'versions',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    targetKind: text('target_kind').$type<VersionTargetKind>().notNull(),
    targetId: text('target_id').notNull(),
    kind: text('kind').$type<VersionKind>().notNull(),
    note: text('note').notNull().default(''),
    /** Yjs 状态（document / notebook） */
    state: bytea('state'),
    /** 文件原始字节（file） */
    blob: bytea('blob'),
    /** 可读表示：VersionContent 的 JSON */
    content: jsonb('content').notNull(),
    contentHash: text('content_hash').notNull(),
    size: integer('size').notNull().default(0),
    createdBy: actor('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('versions_target_idx').on(t.projectId, t.targetKind, t.targetId, t.createdAt)],
);

export const changeProposals = pgTable(
  'change_proposals',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    targetKind: text('target_kind').$type<ProposalTargetKind>().notNull(),
    targetId: text('target_id').notNull(),
    title: text('title').notNull(),
    explanation: text('explanation').notNull().default(''),
    author: actor('author'),
    threadId: text('thread_id'),
    reviewId: text('review_id'),
    status: text('status').$type<ProposalStatus>().notNull().default('open'),
    baseState: bytea('base_state').notNull(),
    draftState: bytea('draft_state').notNull(),
    hunks: jsonb('hunks').$type<ProposalHunk[]>().notNull(),
    mergeResult: jsonb('merge_result').$type<ProposalMergeResult>(),
    mergedBy: jsonb('merged_by').$type<ActorRef>(),
    mergedAt: ts('merged_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('change_proposals_target_idx').on(t.projectId, t.targetKind, t.targetId),
    index('change_proposals_review_idx').on(t.reviewId),
  ],
);

export const versioningSettings = pgTable('versioning_settings', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  agentDirectWrite: boolean('agent_direct_write').notNull().default(false),
  githubRepo: text('github_repo'),
  githubBranch: text('github_branch').notNull().default('main'),
  githubToken: text('github_token'),
  updatedBy: jsonb('updated_by').$type<ActorRef>(),
  updatedAt: updatedAt(),
});
