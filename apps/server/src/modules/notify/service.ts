import { and, count, desc, eq } from 'drizzle-orm';
import {
  ApiError,
  newId,
  NOTIFY_DEFAULT_EVENTS,
  NOTIFY_PROVIDERS,
  type NotifyEventType,
  type NotifyProvider,
  type NotifySubscription,
} from '@srh/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/client';
import { notifyDeliveries, notifySubscriptions } from '../../db/schema';
import { buildMessage, postWebhook } from './deliver';

/**
 * 通知订阅的业务逻辑（`modules/notify`）。
 *
 * 三条硬规矩：
 * 1. 地址只接受三家官方域名 + 正确的路径前缀（`assertAllowedUrl`），
 *    这样"填内网地址让服务器去打"的攻击面直接不存在。
 * 2. 地址里含密钥，**只写不读**：对外只给 `urlHint`（打码）。
 * 3. 每人最多 `NOTIFY_MAX_PER_USER` 个订阅。
 */
export type NotifySubscriptionRow = typeof notifySubscriptions.$inferSelect;

/** 地址里可能承载凭证的查询参数（不限于当前 provider 的那一个，宁可多遮） */
const SENSITIVE_PARAMS = [
  'key',
  'access_token',
  'token',
  'sign',
  'signature',
  'secret',
  'hook',
  'webhook_token',
];

/**
 * 把地址里的凭证打码（列表里给用户认人用，**不能**泄露原文）。
 *
 * 规则按 provider 的凭证位置来，但**不做 early return**：
 * - 飞书：凭证是路径最后一段（`/hook/<uuid>`）；
 * - 企微 / 钉钉：凭证是 query 里的 `key` / `access_token`；
 * - 其它敏感参数（`token` / `sign` / `secret` …）一律一起遮。
 *
 * 之前的实现一旦命中 `key` 就返回，导致"飞书地址还带了个 key 参数"时路径里的 hook 全明文；
 * 本次评审指出后改为"按 provider 打码 + 全部敏感参数一起遮"。
 */
export function maskUrl(raw: string, provider?: NotifyProvider): string {
  try {
    const url = new URL(raw);
    // 1) 所有敏感查询参数都遮（不管 provider 是哪个）
    for (const k of SENSITIVE_PARAMS) {
      const v = url.searchParams.get(k);
      if (v) url.searchParams.set(k, maskSecret(v));
    }
    // 2) 飞书的凭证在路径最后一段
    if (provider === undefined || provider === 'feishu') {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length > 0) {
        parts[parts.length - 1] = maskSecret(parts[parts.length - 1]!);
        url.pathname = `/${parts.join('/')}`;
      }
    }
    return url.toString();
  } catch {
    return '（地址不合法）';
  }
}

function maskSecret(secret: string): string {
  if (secret.length <= 4) return '****';
  return `${secret.slice(0, 4)}****`;
}

/**
 * 校验群机器人地址：必须是 https、官方域名、正确的路径前缀。
 *
 * 这是本功能唯一的"出站地址"入口，改这里要格外小心：绝不允许放开到任意域名，
 * 否则必须同时引入 `websearch/net.ts` 的 fetchPublic（防 SSRF / DNS rebinding）。
 */
export function assertAllowedUrl(provider: NotifyProvider, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ApiError('validation_failed', '地址格式不对，请粘贴完整的 https:// 网址');
  }
  const spec = NOTIFY_PROVIDERS[provider];
  if (url.protocol !== 'https:') {
    throw new ApiError('validation_failed', '只接受 https:// 开头的地址');
  }
  if (url.hostname !== spec.host) {
    throw new ApiError(
      'validation_failed',
      `${spec.label}的群机器人地址应该以 https://${spec.host}${spec.pathPrefix} 开头`,
    );
  }
  if (!url.pathname.startsWith(spec.pathPrefix)) {
    throw new ApiError(
      'validation_failed',
      `这个地址不像${spec.label}的群机器人地址（路径应以 ${spec.pathPrefix} 开头）`,
    );
  }
  return url;
}

export function toNotifySubscription(row: NotifySubscriptionRow): NotifySubscription {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    urlHint: row.urlHint,
    projectId: row.projectId,
    eventTypes: (row.eventTypes.length > 0
      ? row.eventTypes
      : NOTIFY_DEFAULT_EVENTS) as NotifyEventType[],
    enabled: row.enabled,
    failureStreak: row.failureStreak,
    disabledReason: row.disabledReason,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listSubscriptions(db: Db, userId: string): Promise<NotifySubscription[]> {
  const rows = await db
    .select()
    .from(notifySubscriptions)
    .where(eq(notifySubscriptions.userId, userId))
    .orderBy(desc(notifySubscriptions.createdAt));
  return rows.map(toNotifySubscription);
}

async function getOwn(ctx: AppContext, userId: string, id: string): Promise<NotifySubscriptionRow> {
  const [row] = await ctx.db.db
    .select()
    .from(notifySubscriptions)
    .where(and(eq(notifySubscriptions.id, id), eq(notifySubscriptions.userId, userId)));
  if (!row) throw new ApiError('not_found', '订阅不存在');
  return row;
}

export interface CreateSubscriptionInput {
  name: string;
  provider: NotifyProvider;
  url: string;
  projectId: string | null;
  eventTypes: NotifyEventType[];
}

export async function createSubscription(
  ctx: AppContext,
  userId: string,
  input: CreateSubscriptionInput,
): Promise<NotifySubscription> {
  const url = assertAllowedUrl(input.provider, input.url);

  const [{ n } = { n: 0 }] = await ctx.db.db
    .select({ n: count() })
    .from(notifySubscriptions)
    .where(eq(notifySubscriptions.userId, userId));
  if (Number(n) >= ctx.config.NOTIFY_MAX_PER_USER) {
    throw new ApiError(
      'conflict',
      `最多同时保留 ${ctx.config.NOTIFY_MAX_PER_USER} 个通知订阅，请先删掉不用的`,
    );
  }

  const [row] = await ctx.db.db
    .insert(notifySubscriptions)
    .values({
      id: newId('notifySubscription'),
      userId,
      projectId: input.projectId,
      provider: input.provider,
      name: input.name,
      url: url.toString(),
      urlHint: maskUrl(url.toString(), input.provider),
      eventTypes: input.eventTypes,
    })
    .returning();
  if (!row) throw new ApiError('internal', '订阅创建失败');
  return toNotifySubscription(row);
}

export async function updateSubscription(
  ctx: AppContext,
  userId: string,
  id: string,
  patch: {
    name?: string | undefined;
    url?: string | undefined;
    eventTypes?: NotifyEventType[] | undefined;
    enabled?: boolean | undefined;
  },
): Promise<NotifySubscription> {
  const row = await getOwn(ctx, userId, id);
  const values: Partial<typeof notifySubscriptions.$inferInsert> = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.eventTypes !== undefined) values.eventTypes = patch.eventTypes;
  if (patch.url !== undefined) {
    const url = assertAllowedUrl(row.provider, patch.url);
    values.url = url.toString();
    values.urlHint = maskUrl(url.toString(), row.provider);
  }
  if (patch.enabled !== undefined) {
    values.enabled = patch.enabled;
    // 手动重新打开时把失败计数和停用原因清掉
    if (patch.enabled) {
      values.failureStreak = 0;
      values.disabledReason = null;
    }
  }
  const [updated] = await ctx.db.db
    .update(notifySubscriptions)
    .set(values)
    .where(eq(notifySubscriptions.id, row.id))
    .returning();
  return toNotifySubscription(updated ?? row);
}

export async function deleteSubscription(
  ctx: AppContext,
  userId: string,
  id: string,
): Promise<void> {
  const row = await getOwn(ctx, userId, id);
  await ctx.db.db.delete(notifySubscriptions).where(eq(notifySubscriptions.id, row.id));
}

/** 发一条测试消息（不走队列，直接发，结果立刻返回给用户） */
export async function sendTestMessage(
  ctx: AppContext,
  userId: string,
  id: string,
): Promise<{ ok: boolean; message: string }> {
  const row = await getOwn(ctx, userId, id);
  const text = `【研协 Thinkloft】这是一条测试消息：你的${NOTIFY_PROVIDERS[row.provider].label}通知已接通。\n如果你在群里看到了这句话，说明配置成功。`;
  const result = await postWebhook(row.url, buildMessage(row.provider, text), row.provider);
  if (result.ok) {
    await ctx.db.db
      .update(notifySubscriptions)
      .set({ lastSuccessAt: new Date(), failureStreak: 0 })
      .where(eq(notifySubscriptions.id, row.id));
    return { ok: true, message: '测试消息已发送，去群里看看' };
  }
  await ctx.db.db
    .update(notifySubscriptions)
    .set({ lastFailureAt: new Date() })
    .where(eq(notifySubscriptions.id, row.id));
  return {
    ok: false,
    message: `发送失败：${result.error ?? '未知原因'}${
      result.snippet ? `（平台返回：${result.snippet.slice(0, 160)}）` : ''
    }`,
  };
}

/** 投递记录（面板用，最近 N 条） */
export async function listDeliveries(ctx: AppContext, userId: string, subscriptionId: string) {
  await getOwn(ctx, userId, subscriptionId);
  return ctx.db.db
    .select()
    .from(notifyDeliveries)
    .where(eq(notifyDeliveries.subscriptionId, subscriptionId))
    .orderBy(desc(notifyDeliveries.createdAt))
    .limit(50);
}
