/**
 * 协作表：协同文档、看板、待办、实验记录、审阅、组会汇报。
 * 归属：协作功能线程（apps/server/src/modules/{documents,boards,todos,experiments,reviews,reports}
 * 与 apps/server/src/realtime/collab.ts）。
 */
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core';
import type {
  DocumentKind,
  ReportStats,
  ResourceSpace,
  ReportStatus,
  ReviewStatus,
  ReviewTargetKind,
  ReviewVerdict,
  TodoPriority,
} from '@srh/shared';
import { actor, createdAt, id, textArray, ts, updatedAt } from './_helpers';
import { projects, users } from './core';

/** Yjs 二进制状态 */
export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
});

export const documents = pgTable(
  'documents',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    parentId: text('parent_id'),
    kind: text('kind').$type<DocumentKind>().notNull().default('doc'),
    title: text('title').notNull().default('未命名文档'),
    icon: text('icon'),
    /** Y.encodeStateAsUpdate 的结果，由 /collab 持久化 */
    ydocState: bytea('ydoc_state'),
    /** 纯文本快照（搜索、agent 读取） */
    contentText: text('content_text').notNull().default(''),
    createdBy: actor('created_by'),
    updatedBy: jsonb('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: ts('archived_at'),
    /** team：项目共享区（旧数据都是 team）；personal：owner_user_id 的个人空间（见 sharing.ts） */
    space: text('space').$type<ResourceSpace>().notNull().default('team'),
    /** 个人空间的所有者；用户被删除时连同其个人文档一起删除 */
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    index('documents_project_idx').on(t.projectId, t.parentId),
    index('documents_space_idx').on(t.projectId, t.space, t.ownerUserId),
  ],
);

export const documentVersions = pgTable('document_versions', {
  id: id(),
  documentId: text('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  ydocState: bytea('ydoc_state').notNull(),
  createdBy: actor('created_by'),
  createdAt: createdAt(),
});

/**
 * 富文本文档的行内评论（飞书式批注）。parentId 为空的是一条评论串的首条，锚点、引用原文与
 * 解决状态都记在首条上；回复的 parentId 指向首条。锚点是两端的 Y.RelativePosition（JSON），
 * 不写进文档内容，并发编辑后各端按 Yjs 结构重新算出位置。
 */
export const documentComments = pgTable(
  'document_comments',
  {
    id: id(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    parentId: text('parent_id'),
    author: actor('author'),
    body: text('body').notNull(),
    mentions: textArray('mentions'),
    anchor: jsonb('anchor').$type<{
      start: Record<string, unknown>;
      end: Record<string, unknown>;
    }>(),
    quote: text('quote').notNull().default(''),
    resolvedAt: ts('resolved_at'),
    resolvedBy: jsonb('resolved_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('document_comments_doc_idx').on(t.documentId, t.createdAt)],
);

export const boards = pgTable('boards', {
  id: id(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

export const boardColumns = pgTable('board_columns', {
  id: id(),
  boardId: text('board_id')
    .notNull()
    .references(() => boards.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** fractional index */
  position: text('position').notNull(),
  color: integer('color'),
});

export const cards = pgTable(
  'cards',
  {
    id: id(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    columnId: text('column_id')
      .notNull()
      .references(() => boardColumns.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    position: text('position').notNull(),
    assigneeIds: textArray('assignee_ids'),
    labels: textArray('labels'),
    dueAt: ts('due_at'),
    threadId: text('thread_id'),
    version: integer('version').notNull().default(1),
    createdBy: actor('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('cards_board_idx').on(t.boardId, t.columnId, t.position)],
);

export const todos = pgTable(
  'todos',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** 成员 id 或 agent:<threadId> / agent:coordinator，不加外键 */
    assigneeId: text('assignee_id'),
    title: text('title').notNull(),
    notes: text('notes').notNull().default(''),
    done: boolean('done').notNull().default(false),
    priority: text('priority').$type<TodoPriority>().notNull().default('normal'),
    dueAt: ts('due_at'),
    position: text('position').notNull(),
    source: jsonb('source').$type<{ kind: string; id: string }>(),
    createdBy: actor('created_by'),
    createdAt: createdAt(),
    completedAt: ts('completed_at'),
  },
  (t) => [index('todos_project_idx').on(t.projectId, t.ownerUserId, t.done)],
);

export const reviews = pgTable(
  'reviews',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    targetKind: text('target_kind').$type<ReviewTargetKind>().notNull(),
    targetId: text('target_id').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    requestedBy: actor('requested_by'),
    threadId: text('thread_id'),
    status: text('status').$type<ReviewStatus>().notNull().default('open'),
    snapshot: text('snapshot'),
    /** 被同一目标的新一轮审阅取代时，指向新审阅（本审阅随之关闭） */
    supersededById: text('superseded_by_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    closedAt: ts('closed_at'),
  },
  (t) => [index('reviews_project_idx').on(t.projectId, t.status)],
);

export const reviewParticipants = pgTable(
  'review_participants',
  {
    reviewId: text('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    verdict: text('verdict').$type<ReviewVerdict>().notNull().default('pending'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.reviewId, t.userId] })],
);

export const reviewComments = pgTable('review_comments', {
  id: id(),
  reviewId: text('review_id')
    .notNull()
    .references(() => reviews.id, { onDelete: 'cascade' }),
  author: actor('author'),
  body: text('body').notNull(),
  verdict: text('verdict').$type<ReviewVerdict>(),
  anchor: jsonb('anchor').$type<Record<string, unknown>>(),
  resolved: boolean('resolved').notNull().default(false),
  createdAt: createdAt(),
});

export const reports = pgTable(
  'reports',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    periodStart: ts('period_start').notNull(),
    periodEnd: ts('period_end').notNull(),
    status: text('status').$type<ReportStatus>().notNull().default('draft'),
    content: text('content').notNull().default(''),
    documentId: text('document_id'),
    stats: jsonb('stats').$type<ReportStats>(),
    error: text('error'),
    /** 乐观并发：PATCH 带 baseVersion 时比对 */
    version: integer('version').notNull().default(1),
    createdBy: actor('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('reports_project_idx').on(t.projectId, t.createdAt)],
);
