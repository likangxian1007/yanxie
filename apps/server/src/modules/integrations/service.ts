import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  API_TOKEN_MAX_PER_USER,
  API_TOKEN_PREFIX,
  ApiError,
  newId,
  type ApiToken,
  type ApiTokenScope,
} from '@srh/shared';
import type { AppConfig } from '../../config';
import type { AppContext } from '../../context';
import type { Db } from '../../db/client';
import { apiTokens, projectMembers, users } from '../../db/schema';
import { waitText, WindowCounter } from '../auth/rate-limit';
import type { UserRow } from '../auth/service';
import { operationInvocation } from './invocation-context';

/**
 * API 令牌：生成、校验、限流、最后使用时间（API.md §2.21）。
 *
 * - 原文 `srh_pat_<43 位 base64url>` 只在创建响应里出现一次；库里只存 SHA-256。
 * - 校验顺序：哈希命中 → 未撤销 → 未过期 → 限流 → 记一次使用。任何一步不过都当 401，
 *   不告诉调用方“是哪一步错了”（避免拿它探测令牌是否存在）。
 * - 限流按令牌 id 计数，进程内存滑动窗口（与登录限流同一套 WindowCounter）；
 *   多实例部署时要换成共享存储，接口不变。
 * - `last_used_at` 每 60 秒最多写一次，避免每个请求都更新一行。
 */
export type ApiTokenRow = typeof apiTokens.$inferSelect;

const TOKEN_BYTES = 32;
const HINT_LEN = 8;
const LAST_USED_WRITE_MS = 60_000;

export interface CreateTokenInput {
  name: string;
  scopes: ApiTokenScope[];
  projectIds: string[];
  expiresInDays: number | null;
}

export interface BearerAuth {
  token: ApiTokenRow;
  user: UserRow;
}

export function hashApiToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** 生成一个新令牌：原文、哈希、列表用的 hint */
export function generateApiToken(): { token: string; hash: string; hint: string } {
  const secret = randomBytes(TOKEN_BYTES).toString('base64url');
  const token = `${API_TOKEN_PREFIX}${secret}`;
  return { token, hash: hashApiToken(token), hint: secret.slice(0, HINT_LEN) };
}

/** 从 `Authorization` 头里取出 Bearer 令牌；不是 Bearer 方案返回 null */
export function bearerFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/iu.exec(header.trim());
  return match?.[1] ?? null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 只读令牌只能看：非 GET/HEAD/OPTIONS 一律 403。Cookie 登录与可写令牌不受影响。
 *
 * 放在这里而不是各 guard 里各写一遍，是因为 REST 有两条身份链：
 * `modules/auth/guard.ts`（项目、消息、收件箱…）和 `modules/collab-common/guard.ts`
 * （看板、待办、文档、审阅、版本…）。漏掉任何一条，`read` 令牌都能从那条链写进去。
 */
export function assertTokenCanWrite(
  token: { scopes: readonly string[] } | null | undefined,
  method: string,
): void {
  if (!token || SAFE_METHODS.has(method) || token.scopes.includes('write')) return;
  throw new ApiError('forbidden', '这个令牌只有只读权限，不能修改内容');
}

/** 资源级路由与无 projectId 路由同样必须叠加令牌围栏。 */
export function assertTokenProject(
  token: { projectIds: readonly string[] } | null | undefined,
  projectId: string,
): void {
  if (token && token.projectIds.length > 0 && !token.projectIds.includes(projectId)) {
    throw new ApiError('not_found', '项目不存在，或你不是它的成员');
  }
}

// 单进程的长连接撤销通知；与当前实时总线相同的部署边界。
const connections = new WeakMap<object, Map<string, Set<() => void>>>();

function closeTokenConnections(config: AppConfig, tokenId: string): void {
  for (const close of connections.get(config)?.get(tokenId) ?? []) close();
}

/** 在握手后跟踪令牌生命周期；撤销与到期同时关闭 /ws 和 /collab。 */
export async function watchApiTokenSocket(req: FastifyRequest, socket: WebSocket): Promise<void> {
  const auth = await bearerAuthFor(req);
  if (!auth || socket.readyState !== socket.OPEN) return;
  const ctx = req.server.ctx;
  let byToken = connections.get(ctx.config);
  if (!byToken) connections.set(ctx.config, (byToken = new Map()));
  let listeners = byToken.get(auth.token.id);
  if (!listeners) byToken.set(auth.token.id, (listeners = new Set()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (timer) clearTimeout(timer);
    socket.close(4401, 'API token expired or revoked');
  };
  listeners.add(close);
  socket.once('close', () => {
    if (timer) clearTimeout(timer);
    listeners.delete(close);
    if (listeners.size === 0) byToken.delete(auth.token.id);
  });
  // 先登记再查库，覆盖身份解析与注册监听之间发生撤销的竞态。
  const [row] = await ctx.db.db.select().from(apiTokens).where(eq(apiTokens.id, auth.token.id));
  if (!row || row.revokedAt || !ctx.config.API_TOKENS_ENABLED) {
    close();
    return;
  }
  const scheduleExpiry = () => {
    if (!row.expiresAt || socket.readyState !== socket.OPEN) return;
    const remaining = row.expiresAt.getTime() - Date.now();
    if (remaining <= 0) close();
    else {
      // Node 的定时器上限约为 24 天，长期令牌需分段等待。
      timer = setTimeout(scheduleExpiry, Math.min(remaining, 2_147_483_647));
      timer.unref();
    }
  };
  scheduleExpiry();
}

export function toApiToken(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    name: row.name,
    hint: row.tokenHint,
    scopes: row.scopes,
    projectIds: row.projectIds,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    // 过期判定放服务端做（与 authenticateBearer 用的是同一把时钟），前端只负责显示
    expired: row.expiresAt !== null && row.expiresAt.getTime() <= Date.now(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listApiTokens(db: Db, userId: string): Promise<ApiToken[]> {
  const rows = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id));
  return rows.map(toApiToken);
}

/** 新建令牌，返回原文（只此一次）与列表项。项目限定时必须是本人的项目。 */
export async function createApiToken(
  ctx: AppContext,
  userId: string,
  input: CreateTokenInput,
): Promise<{ token: string; apiToken: ApiToken }> {
  const projectIds = [...new Set(input.projectIds)];
  if (projectIds.length > 0) {
    const mine = await ctx.db.db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(and(eq(projectMembers.userId, userId), inArray(projectMembers.projectId, projectIds)));
    const allowed = new Set(mine.map((r) => r.projectId));
    const bad = projectIds.filter((id) => !allowed.has(id));
    if (bad.length > 0) {
      throw new ApiError('validation_failed', '有项目不存在，或者你不是该项目的成员', {
        issues: bad.map((id) => ({ path: 'projectIds', message: `没有权限：${id}` })),
      });
    }
  }

  const [live] = await ctx.db.db
    .select({ n: count() })
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
  if (Number(live?.n ?? 0) >= API_TOKEN_MAX_PER_USER) {
    throw new ApiError(
      'conflict',
      `最多同时保留 ${API_TOKEN_MAX_PER_USER} 个令牌，请先撤销不用的再新建`,
    );
  }

  const { token, hash, hint } = generateApiToken();
  const [row] = await ctx.db.db
    .insert(apiTokens)
    .values({
      id: newId('apiToken'),
      userId,
      name: input.name,
      tokenHash: hash,
      tokenHint: hint,
      scopes: input.scopes,
      projectIds,
      expiresAt:
        input.expiresInDays === null
          ? null
          : new Date(Date.now() + input.expiresInDays * 24 * 3600 * 1000),
    })
    .returning();
  if (!row) throw new ApiError('internal', '令牌创建失败');
  return { token, apiToken: toApiToken(row) };
}

/** 撤销：只能撤自己的；已经撤销过再撤一次也算成功（幂等）。 */
export async function revokeApiToken(
  ctx: AppContext,
  userId: string,
  tokenId: string,
): Promise<ApiToken> {
  const [row] = await ctx.db.db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId)));
  if (!row) throw new ApiError('not_found', '令牌不存在');
  if (row.revokedAt) {
    closeTokenConnections(ctx.config, row.id);
    return toApiToken(row);
  }
  const [updated] = await ctx.db.db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(eq(apiTokens.id, row.id))
    .returning();
  closeTokenConnections(ctx.config, row.id);
  return toApiToken(updated ?? row);
}

// ---------------------------------------------------------------- 每个应用实例一份的限流器

/** 同一个 AppConfig 对象 = 同一个应用实例；测试之间因此互不影响 */
const limiters = new WeakMap<object, WindowCounter>();
const lastUsedWrites = new WeakMap<object, Map<string, number>>();

function limiterFor(config: AppConfig): WindowCounter {
  let limiter = limiters.get(config);
  if (!limiter) {
    limiter = new WindowCounter(config.API_TOKENS_RATE_PER_MINUTE, 60_000, 5_000);
    limiters.set(config, limiter);
  }
  return limiter;
}

/** 每张令牌每分钟的调用上限；超了抛 429（带 Retry-After 秒数） */
export function checkApiTokenRate(config: AppConfig, tokenId: string): void {
  const limiter = limiterFor(config);
  const wait = limiter.blockedFor(tokenId);
  if (wait !== null) {
    throw new ApiError('rate_limited', `这个令牌调用太频繁，请 ${waitText(wait)}后再试`, {
      retryAfterSec: wait,
      retryAfter: wait,
    });
  }
  limiter.hit(tokenId);
}

/** 记录最后使用时间（每张令牌最多每 60 秒写一次库） */
export async function touchApiToken(ctx: AppContext, tokenId: string): Promise<void> {
  let written = lastUsedWrites.get(ctx.config);
  if (!written) {
    written = new Map();
    lastUsedWrites.set(ctx.config, written);
  }
  const now = Date.now();
  const prev = written.get(tokenId) ?? 0;
  if (now - prev < LAST_USED_WRITE_MS) return;
  written.set(tokenId, now);
  await ctx.db.db
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiTokens.id, tokenId));
}

/**
 * 用 Bearer 原文换出「令牌 + 用户」。无效 / 已撤销 / 已过期一律 401，文案不区分原因。
 * 调用前请确认 API_TOKENS_ENABLED 已打开（模块与 guard 各判一次，避免绕过）。
 */
export async function authenticateBearer(ctx: AppContext, raw: string): Promise<BearerAuth> {
  const [row] = await ctx.db.db
    .select({ token: apiTokens, user: users })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(eq(apiTokens.tokenHash, hashApiToken(raw)));
  if (!row) throw new ApiError('unauthorized', 'API 令牌无效或已被撤销');
  if (row.token.revokedAt) throw new ApiError('unauthorized', 'API 令牌无效或已被撤销');
  if (row.token.expiresAt && row.token.expiresAt.getTime() <= Date.now()) {
    throw new ApiError('unauthorized', 'API 令牌已过期，请重新生成');
  }
  checkApiTokenRate(ctx.config, row.token.id);
  await touchApiToken(ctx, row.token.id);
  return { token: row.token, user: row.user };
}

/** 同一个请求里只解析一次：REST 守卫、实时通道、协作模块都从这里拿，避免重复查库和重复限流。 */
const requestCache = new WeakMap<FastifyRequest, BearerAuth | null>();

export async function bearerAuthFor(req: FastifyRequest): Promise<BearerAuth | null> {
  const cached = requestCache.get(req);
  if (cached !== undefined) return cached;
  const raw = bearerFromHeader(req.headers.authorization);
  if (!raw) {
    requestCache.set(req, null);
    return null;
  }
  if (!req.server.ctx.config.API_TOKENS_ENABLED) {
    throw new ApiError('unauthorized', 'API 令牌功能未开启（API_TOKENS_ENABLED）');
  }
  const invocation = operationInvocation.getStore();
  if (invocation && invocation.method === req.method && invocation.url === req.url) {
    requestCache.set(req, invocation.auth);
    return invocation.auth;
  }
  const auth = await authenticateBearer(req.server.ctx, raw);
  requestCache.set(req, auth);
  return auth;
}
