import { z } from 'zod';
import { tr } from './i18n';

/**
 * 接入：API 令牌（第 1 步）。归属：后端 integrations 模块（`modules/integrations`）。
 *
 * 令牌 = 给外部 agent / 脚本用的「门禁卡」：`Authorization: Bearer srh_pat_…`，
 * 效果等同于该用户用 Cookie 登录，权限完全按他的角色和项目成员身份计算，不额外放大。
 *
 * 约定：
 * - 原文只在创建响应里返回一次；数据库只存 SHA-256，列表只回显 `hint`（原文的一段）。
 * - `projectIds` 为空 = 该账号能访问的全部项目；非空 = 只能碰这几张项目。
 * - `scopes` 目前只有 `read` / `write`：`read` 只能看（GET/HEAD），写操作一律 403。
 * - 管理令牌（创建 / 撤销 / 列表）只认网页登录会话，令牌本身不能再造令牌。
 */

/** 原文前缀，日志和代码里一眼能认出这是研协的令牌 */
export const API_TOKEN_PREFIX = 'srh_pat_';

export const API_TOKEN_SCOPES = ['read', 'write'] as const;
export const ApiTokenScope = z.enum(API_TOKEN_SCOPES);
export type ApiTokenScope = z.infer<typeof ApiTokenScope>;

/** 令牌列表项（永远不含原文） */
export const ApiToken = z.object({
  id: z.string(),
  name: z.string(),
  /** 原文里随机部分的头 8 位，用于在列表里认人（如 `Xk3pQ9mR`） */
  hint: z.string(),
  scopes: z.array(ApiTokenScope),
  /** 空数组 = 全部项目 */
  projectIds: z.array(z.string()),
  expiresAt: z.string().nullable(),
  /** 服务端算好的「已过期」（按服务器时钟，避免前端 Date.now() 在渲染期取值） */
  expired: z.boolean(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ApiToken = z.infer<typeof ApiToken>;

/** 同一用户最多同时保留多少个未撤销令牌 */
export const API_TOKEN_MAX_PER_USER = 20;
export const API_TOKEN_NAME_MAX = 60;
/** 有效期上限（天） */
export const API_TOKEN_MAX_DAYS = 365;

/** POST /auth/me/tokens 的请求体 */
export const ApiTokenCreateInput = z.object({
  name: z
    .string({ error: tr('请给这个令牌起个名字') })
    .trim()
    .min(1, { error: tr('请给这个令牌起个名字') })
    .max(API_TOKEN_NAME_MAX, {
      error: tr('名字最多 {API_TOKEN_NAME_MAX} 个字', { API_TOKEN_NAME_MAX }),
    }),
  scopes: z
    .array(ApiTokenScope)
    .min(1, { error: tr('至少选择一种权限') })
    .max(API_TOKEN_SCOPES.length)
    .default(['read']),
  /** 限定项目；留空 = 全部 */
  projectIds: z.array(z.string().trim().min(1)).max(200).default([]),
  /** 多少天后过期；null = 永不过期 */
  expiresInDays: z
    .number({ error: tr('有效期要填天数') })
    .int({ error: tr('有效期要填整数天') })
    .min(1, { error: tr('有效期至少 1 天') })
    .max(API_TOKEN_MAX_DAYS, {
      error: tr('有效期最多 {API_TOKEN_MAX_DAYS} 天', { API_TOKEN_MAX_DAYS }),
    })
    .nullable()
    .default(null),
});
export type ApiTokenCreateInput = z.input<typeof ApiTokenCreateInput>;

/** GET /auth/me/tokens：`enabled` 是服务端开关（API_TOKENS_ENABLED），用来解释“为什么不能用” */
export const ApiTokenList = z.object({
  enabled: z.boolean(),
  /** 服务端是否开了 MCP 接入（MCP_ENABLED）；设置页据此决定要不要显示 MCP 配置片段 */
  mcpEnabled: z.boolean(),
  tokens: z.array(ApiToken),
});
export type ApiTokenList = z.infer<typeof ApiTokenList>;

/** POST /auth/me/tokens 的响应：`token` 只在这里出现一次 */
export const ApiTokenCreated = z.object({
  token: z.string(),
  apiToken: ApiToken,
});
export type ApiTokenCreated = z.infer<typeof ApiTokenCreated>;
