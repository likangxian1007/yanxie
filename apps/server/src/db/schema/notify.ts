/**
 * 通知订阅表：群机器人 webhook（飞书 / 企业微信 / 钉钉）。归属：`modules/notify`。
 *
 * 两张表：
 * - `notify_subscriptions`：谁订阅了哪个群的机器人、要哪些事件、当前是否可用
 * - `notify_deliveries`：每次投递的结果与重试计划（含幂等唯一索引）
 *
 * 地址里含密钥（飞书 hook id / 企微 key），所以只写不读：接口只回 `url_hint`（打码）。
 */
import { boolean, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { NotifyDeliveryStatus, NotifyEventType, NotifyProvider } from '@srh/shared';
import { createdAt, id, jsonObject, textArray, ts } from './_helpers';
import { projects, users } from './core';

export const notifySubscriptions = pgTable(
  'notify_subscriptions',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** null = 该用户参与的所有项目 */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<NotifyProvider>().notNull().default('feishu'),
    name: text('name').notNull(),
    /**
     * 完整群机器人地址（含密钥）。**只写不读**：任何接口都不返回它，
     * 排查问题时也不要把它打进日志（日志里用 url_hint）。
     */
    url: text('url').notNull(),
    /** 打码后的地址，列表里给用户认人用 */
    urlHint: text('url_hint').notNull(),
    /** 空数组 = 默认集合（NOTIFY_DEFAULT_EVENTS） */
    eventTypes: textArray('event_types').$type<NotifyEventType[]>(),
    enabled: boolean('enabled').notNull().default(true),
    /** 连续失败次数；到 NOTIFY_DISABLE_AFTER 自动停用 */
    failureStreak: integer('failure_streak').notNull().default(0),
    disabledReason: text('disabled_reason'),
    lastSuccessAt: ts('last_success_at'),
    lastFailureAt: ts('last_failure_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notify_sub_user_idx').on(t.userId), index('notify_sub_enabled_idx').on(t.enabled)],
);

export const notifyDeliveries = pgTable(
  'notify_deliveries',
  {
    id: id(),
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => notifySubscriptions.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    /** 项目内事件序号，用来做幂等（同一条事件对同一个订阅只发一次） */
    eventSeq: integer('event_seq').notNull(),
    eventType: text('event_type').notNull(),
    /** 实际发出去的 JSON（方便排查"飞书说格式错了"） */
    payload: jsonObject('payload'),
    /** 人话摘要：就是用户在群里看到的那句话 */
    text: text('text').notNull(),
    status: text('status').$type<NotifyDeliveryStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at'),
    responseStatus: integer('response_status'),
    /** 响应体前 500 字（飞书/企微的错误原因都在 body 里） */
    responseSnippet: text('response_snippet'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('notify_deliv_idem_uq').on(t.subscriptionId, t.projectId, t.eventSeq),
    index('notify_deliv_status_idx').on(t.status, t.nextAttemptAt),
    index('notify_deliv_sub_idx').on(t.subscriptionId, t.createdAt),
  ],
);
