/**
 * 个人空间资源的分享：链接设置、按人邀请、链接访问记录。
 * 归属：feat/personal-team-spaces（apps/server/src/modules/sharing）。
 *
 * 资源（documents / papers）本身的 space、owner_user_id 列在各自的表里；这里只存分享关系。
 * resource_kind + resource_id 不加外键（两类资源分属不同表），资源删除时由 sharing 模块清理。
 */
import { index, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { LinkScope, ShareLevel, ShareResourceKind } from '@srh/shared';
import { createdAt, updatedAt } from './_helpers';
import { projects, users } from './core';

/** 链接分享：每个资源最多一行；没有行 = 链接关闭（仅邀请的人）、可阅读、尚未生成 token */
export const shareLinks = pgTable(
  'share_links',
  {
    resourceKind: text('resource_kind').$type<ShareResourceKind>().notNull(),
    resourceId: text('resource_id').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    scope: text('scope').$type<LinkScope>().notNull().default('invited'),
    level: text('level').$type<ShareLevel>().notNull().default('view'),
    /** 链接里的随机串；重置时换新，旧链接与旧的访问记录随之失效 */
    token: text('token').notNull(),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.resourceKind, t.resourceId] }),
    uniqueIndex('share_links_token_uq').on(t.token),
  ],
);

/** 按人邀请 */
export const shareGrants = pgTable(
  'share_grants',
  {
    resourceKind: text('resource_kind').$type<ShareResourceKind>().notNull(),
    resourceId: text('resource_id').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    level: text('level').$type<ShareLevel>().notNull().default('view'),
    grantedBy: text('granted_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.resourceKind, t.resourceId, t.userId] }),
    index('share_grants_user_idx').on(t.userId, t.projectId),
  ],
);

/**
 * 通过链接打开过的人（记下当时的 token）。只有 token 仍是当前 token、且链接范围仍允许时才有效：
 * 关闭链接或重置链接后，这些人立即失去访问权。
 */
export const shareVisits = pgTable(
  'share_visits',
  {
    resourceKind: text('resource_kind').$type<ShareResourceKind>().notNull(),
    resourceId: text('resource_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    visitedAt: timestamp('visited_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.resourceKind, t.resourceId, t.userId] }),
    index('share_visits_user_idx').on(t.userId),
  ],
);
