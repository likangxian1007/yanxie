/**
 * 反馈与运维表（feat/feedback-center）。归属：`modules/feedback`、`modules/admin`。
 *
 * - `tickets` / `ticket_messages` / `ticket_votes` / `ticket_reads`：反馈工单（编号 YX-<no>）
 * - `changelog_entries`：更新日志
 * - `ops_events`：运维事件，同一指纹合并成一行累计 count
 * - `user_notifications`：不挂项目的站内通知（inbox_items 是项目级的）
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type {
  ChangelogTag,
  FeedbackContext,
  OpsLevel,
  OpsSource,
  TicketKind,
  TicketPriority,
  TicketReplySide,
  TicketRoadmap,
  TicketSource,
  TicketStatus,
  UserNotificationKind,
} from '@srh/shared';
import { createdAt, id, jsonObject, textArray, ts, updatedAt } from './_helpers';
import { projects, users } from './core';

/** 附件元数据；本体在 STORAGE_DIR/feedback/<ticketId>/<id>.<ext> */
export interface TicketAttachmentMeta {
  id: string;
  /** image = 截图；log = 诊断日志（纯文本，只有提交人与管理员能下载） */
  kind: 'image' | 'log';
  name: string;
  mime: string;
  size: number;
  /** 相对 STORAGE_DIR/feedback 的路径 */
  path: string;
}

export const tickets = pgTable(
  'tickets',
  {
    id: id(),
    /** 自增编号，展示为 YX-<no> */
    no: serial('no').notNull(),
    kind: text('kind').$type<TicketKind>().notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    status: text('status').$type<TicketStatus>().notNull().default('open'),
    priority: text('priority').$type<TicketPriority>().notNull().default('normal'),
    roadmap: text('roadmap').$type<TicketRoadmap>().notNull().default('none'),
    source: text('source').$type<TicketSource>().notNull().default('feedback'),
    reporterUserId: text('reporter_user_id').references(() => users.id, { onDelete: 'set null' }),
    assigneeUserId: text('assignee_user_id').references(() => users.id, { onDelete: 'set null' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    context: jsonb('context').$type<FeedbackContext>(),
    attachments: jsonb('attachments')
      .$type<TicketAttachmentMeta[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    voteCount: integer('vote_count').notNull().default(0),
    lastReplyBy: text('last_reply_by').$type<TicketReplySide>().notNull().default('user'),
    lastReplyAt: ts('last_reply_at').notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    closedAt: ts('closed_at'),
  },
  (t) => [
    uniqueIndex('tickets_no_uq').on(t.no),
    index('tickets_reporter_idx').on(t.reporterUserId, t.updatedAt),
    index('tickets_status_idx').on(t.status, t.updatedAt),
    index('tickets_kind_idx').on(t.kind, t.voteCount),
  ],
);

export const ticketMessages = pgTable(
  'ticket_messages',
  {
    id: id(),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    /** null = 系统消息 */
    authorUserId: text('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    isStaff: boolean('is_staff').notNull().default(false),
    isSystem: boolean('is_system').notNull().default(false),
    body: text('body').notNull(),
    attachments: jsonb('attachments')
      .$type<TicketAttachmentMeta[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index('ticket_messages_ticket_idx').on(t.ticketId, t.createdAt)],
);

export const ticketVotes = pgTable(
  'ticket_votes',
  {
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.userId] })],
);

export const ticketReads = pgTable(
  'ticket_reads',
  {
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lastReadAt: ts('last_read_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.userId] })],
);

export const changelogEntries = pgTable(
  'changelog_entries',
  {
    id: id(),
    version: text('version').notNull(),
    title: text('title').notNull(),
    /** Markdown */
    body: text('body').notNull().default(''),
    tags: textArray('tags').$type<ChangelogTag[]>(),
    ticketIds: textArray('ticket_ids'),
    prUrl: text('pr_url'),
    /** null = 草稿 */
    publishedAt: ts('published_at'),
    authorUserId: text('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('changelog_published_idx').on(t.publishedAt)],
);

export const opsEvents = pgTable(
  'ops_events',
  {
    id: id(),
    level: text('level').$type<OpsLevel>().notNull().default('error'),
    source: text('source').$type<OpsSource>().notNull(),
    message: text('message').notNull(),
    detail: jsonObject('detail'),
    /** 合并键：source + 规范化后的消息/栈顶 的哈希 */
    fingerprint: text('fingerprint').notNull(),
    count: integer('count').notNull().default(1),
    firstAt: ts('first_at').notNull().defaultNow(),
    lastAt: ts('last_at').notNull().defaultNow(),
    ticketId: text('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('ops_events_fingerprint_uq').on(t.fingerprint),
    index('ops_events_last_idx').on(t.lastAt),
  ],
);

export const userNotifications = pgTable(
  'user_notifications',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<UserNotificationKind>().notNull(),
    title: text('title').notNull(),
    href: text('href').notNull(),
    readAt: ts('read_at'),
    createdAt: createdAt(),
  },
  (t) => [index('user_notifications_user_idx').on(t.userId, t.readAt, t.createdAt)],
);
