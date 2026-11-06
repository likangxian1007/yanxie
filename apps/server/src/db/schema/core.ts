/**
 * 核心表：用户、登录会话、项目、成员、邀请、文件、收件箱。
 * 归属：后端线程（apps/server/src/modules/{auth,projects,members,files,inbox}）。
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { ProjectRole, ProjectVisibility, InboxKind } from '@srh/shared';
import { actor, createdAt, id, textArray, ts, updatedAt } from './_helpers';

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    avatarColor: integer('avatar_color').notNull().default(0),
    avatarUrl: text('avatar_url'),
    isAdmin: boolean('is_admin').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email)],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 只存 token 的 SHA-256，原 token 只在 Cookie 里 */
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent'),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('auth_sessions_token_uq').on(t.tokenHash),
    index('auth_sessions_user_idx').on(t.userId),
  ],
);

export const projects = pgTable('projects', {
  id: id(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  icon: text('icon').notNull().default('🔬'),
  color: integer('color').notNull().default(0),
  instructions: text('instructions').notNull().default(''),
  visibility: text('visibility').$type<ProjectVisibility>().notNull().default('team'),
  researchDomains: textArray('research_domains'),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: ts('archived_at'),
  /** 项目事件计数器：realtime/bus.ts 在写事件的同一事务里 +1，作为 events.seq */
  eventSeq: bigint('event_seq', { mode: 'number' }).notNull().default(0),
});

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<ProjectRole>().notNull().default('member'),
    joinedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index('project_members_user_idx').on(t.userId),
  ],
);

export const invites = pgTable(
  'invites',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    email: text('email'),
    role: text('role').$type<ProjectRole>().notNull().default('member'),
    token: text('token').notNull(),
    expiresAt: ts('expires_at').notNull(),
    acceptedAt: ts('accepted_at'),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('invites_token_uq').on(t.token)],
);

/** 项目共享文件夹里的文件（上传或 agent 产出），本体在 STORAGE_DIR/<projectId>/<path>。 */
export const files = pgTable(
  'files',
  {
    id: id(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    path: text('path').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    uploadedBy: actor('uploaded_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('files_project_path_uq').on(t.projectId, t.path),
    uniqueIndex('files_owner_path_uq').on(t.ownerUserId, t.path),
    check('files_one_owner', sql`(${t.projectId} is null) <> (${t.ownerUserId} is null)`),
  ],
);

/** “待我处理”收件箱。 */
export const inboxItems = pgTable(
  'inbox_items',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<InboxKind>().notNull(),
    title: text('title').notNull(),
    href: text('href').notNull(),
    sourceId: text('source_id').notNull(),
    readAt: ts('read_at'),
    doneAt: ts('done_at'),
    createdAt: createdAt(),
  },
  (t) => [index('inbox_user_open_idx').on(t.userId, t.doneAt)],
);

/**
 * 找回密码的一次性重置令牌。归属：后端（modules/auth）。
 * 只存 token 的 SHA-256，原 token 只出现在邮件链接里；30 分钟过期，用过即删，
 * 同一用户再次申请时旧令牌全部作废（删除）。
 */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('password_resets_token_uq').on(t.tokenHash),
    index('password_resets_user_idx').on(t.userId),
  ],
);
