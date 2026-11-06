/**
 * 接入表：API 令牌（第 1 步）。归属：后端 integrations 模块（`modules/integrations`）。
 *
 * `api_tokens` 只存令牌的 SHA-256，原文只在创建响应里返回一次；
 * `token_hint` 是原文随机部分的前 8 位，列表里用来辨认是哪一个，泄露了也拼不出原文。
 */
import { index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { ApiTokenScope } from '@srh/shared';
import { createdAt, id, textArray, ts } from './_helpers';
import { users } from './core';

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** 只存 SHA-256，原文不落库 */
    tokenHash: text('token_hash').notNull(),
    /** 原文随机部分的前 8 位 */
    tokenHint: text('token_hint').notNull(),
    /** read / write */
    scopes: textArray('scopes').$type<ApiTokenScope[]>(),
    /** 空数组 = 该账号能访问的全部项目 */
    projectIds: textArray('project_ids'),
    /** null = 永不过期 */
    expiresAt: ts('expires_at'),
    lastUsedAt: ts('last_used_at'),
    /** 撤销时间；非 null 即失效 */
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('api_tokens_hash_uq').on(t.tokenHash),
    index('api_tokens_user_idx').on(t.userId),
  ],
);

/** 重试结果只对同一令牌可见；pending 在进程中断后保持阻断，避免未知结果被重复执行。 */
export const apiOperationRequests = pgTable(
  'api_operation_requests',
  {
    id: id(),
    tokenId: text('token_id')
      .notNull()
      .references(() => apiTokens.id, { onDelete: 'cascade' }),
    operationId: text('operation_id').notNull(),
    key: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    target: jsonb('target').$type<Record<string, string>>().notNull().default({}),
    status: text('status').notNull().default('pending'),
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    responseType: text('response_type'),
    createdAt: createdAt(),
    completedAt: ts('completed_at'),
  },
  (t) => [uniqueIndex('api_operation_requests_key_uq').on(t.tokenId, t.operationId, t.key)],
);

/** REST 与 MCP 共用的持久写额度。 */
export const apiTokenWriteUsage = pgTable(
  'api_token_write_usage',
  {
    tokenId: text('token_id')
      .notNull()
      .references(() => apiTokens.id, { onDelete: 'cascade' }),
    day: text('day').notNull(),
    used: integer('used').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tokenId, t.day] })],
);

/** 只存操作身份和结果，不存请求正文、令牌原文或任意路径中的分享凭证。 */
export const apiOperationAudit = pgTable(
  'api_operation_audit',
  {
    id: id(),
    requestId: text('request_id').notNull(),
    tokenId: text('token_id')
      .notNull()
      .references(() => apiTokens.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    operationId: text('operation_id').notNull(),
    target: jsonb('target').$type<Record<string, string>>().notNull().default({}),
    status: integer('status').notNull(),
    errorCode: text('error_code'),
    elapsedMs: integer('elapsed_ms').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('api_operation_audit_token_created_idx').on(t.tokenId, t.createdAt)],
);
