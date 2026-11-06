import { desc, eq, sql } from 'drizzle-orm';
import { ApiError, newId, type CreditKind, type CreditLedgerEntry } from '@srh/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/client';
import { creditBalances, creditLedger, projects, users } from '../../db/schema';
import { configuredAdminEmails } from '../auth/service';
import { creditsFor, estimateCostMicros, usdToMicros } from './pricing';

/**
 * 积分账本（唯一的扣费 / 入账入口，API.md §2.24）。
 *
 * 规则：
 * - 余额变动和流水在同一事务里写；带 ref 的流水靠唯一索引幂等（重复调用只记一次）
 * - 只对平台 env provider（deepseek / openrouter 等 .env 配置的）计费；项目自配 provider 不收费
 * - 管理员（users.isAdmin 或 ADMIN_EMAILS）免扣费、不拦截，但仍记用量（delta = 0）
 * - BILLING_ENABLED=false：不拦截、不扣费，只记用量（delta = 0）
 */

export const INSUFFICIENT_CREDITS = '余额不足，请先充值';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface LedgerInput {
  userId: string;
  delta: number;
  kind: CreditKind;
  ref?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsdMicros?: number | null;
  projectId?: string | null;
  note?: string | null;
}

/**
 * 在事务里写一条流水并更新余额。ref 已存在时什么都不做，返回 false。
 */
export async function applyLedgerTx(tx: Tx | Db, input: LedgerInput): Promise<boolean> {
  if (!Number.isSafeInteger(input.delta)) throw new Error('credit delta must be an integer');
  const [row] = await tx
    .insert(creditLedger)
    .values({
      id: newId('credit'),
      userId: input.userId,
      delta: input.delta,
      kind: input.kind,
      ref: input.ref ?? null,
      model: input.model ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      costUsdMicros: input.costUsdMicros ?? null,
      projectId: input.projectId ?? null,
      note: input.note ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: creditLedger.id });
  if (!row) return false;
  await tx
    .insert(creditBalances)
    .values({ userId: input.userId, balance: input.delta })
    .onConflictDoUpdate({
      target: creditBalances.userId,
      set: { balance: sql`${creditBalances.balance} + ${input.delta}`, updatedAt: sql`now()` },
    });
  return true;
}

export async function applyLedger(ctx: AppContext, input: LedgerInput): Promise<boolean> {
  return ctx.db.db.transaction((tx) => applyLedgerTx(tx, input));
}

/** 注册赠送：每人一次（ref = signup:<userId>），首次读余额时懒发放 */
async function ensureSignupGrant(ctx: AppContext, userId: string) {
  const credits = ctx.config.BILLING_SIGNUP_CREDITS;
  if (credits <= 0) return;
  await applyLedger(ctx, {
    userId,
    delta: credits,
    kind: 'signup',
    ref: `signup:${userId}`,
    note: 'signup',
  });
}

export async function getBalance(ctx: AppContext, userId: string): Promise<number> {
  const read = async () =>
    (
      await ctx.db.db
        .select({ balance: creditBalances.balance })
        .from(creditBalances)
        .where(eq(creditBalances.userId, userId))
    )[0];
  // 余额行可能先由「计费关闭时的 0 元用量」建出来，所以按流水 ref 判断是否已赠送，而不是看有没有余额行
  if (ctx.config.BILLING_SIGNUP_CREDITS > 0) {
    const [granted] = await ctx.db.db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.ref, `signup:${userId}`))
      .limit(1);
    if (!granted) await ensureSignupGrant(ctx, userId);
  }
  const row = await read();
  return Number(row?.balance ?? 0);
}

export async function recentLedger(
  ctx: AppContext,
  userId: string,
  limit = 50,
): Promise<CreditLedgerEntry[]> {
  const rows = await ctx.db.db
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId))
    .orderBy(desc(creditLedger.createdAt), desc(creditLedger.id))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    delta: Number(r.delta),
    kind: r.kind,
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    projectId: r.projectId,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** 管理员免扣费 */
export async function isBillingExempt(ctx: AppContext, userId: string): Promise<boolean> {
  const [u] = await ctx.db.db
    .select({ isAdmin: users.isAdmin, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (!u) return false;
  if (u.isAdmin) return true;
  return configuredAdminEmails(ctx.config.ADMIN_EMAILS).has(u.email.trim().toLowerCase());
}

/** 调用方传给模型层的计费信息 */
export interface BillingContext {
  /** 触发这次调用的用户；后台 / 例行任务传 null，由 projectId 找项目创建者 */
  payerUserId?: string | null;
  projectId?: string | null;
  /** 来源说明（agent / library / docs …） */
  note?: string;
}

/** 付款人：触发者，否则项目创建者 */
export async function resolvePayer(
  ctx: AppContext,
  billing: BillingContext | undefined,
): Promise<string | null> {
  if (!billing) return null;
  if (billing.payerUserId) return billing.payerUserId;
  if (!billing.projectId) return null;
  const [p] = await ctx.db.db
    .select({ createdBy: projects.createdBy })
    .from(projects)
    .where(eq(projects.id, billing.projectId));
  return p?.createdBy ?? null;
}

export interface ProviderRef {
  id: string;
  source: 'env' | 'project';
}

/** 只有平台 provider 收费 */
export function isChargeable(provider: ProviderRef | null | undefined): boolean {
  return provider?.source === 'env';
}

/**
 * 调用模型之前的余额闸门：余额 <= 0 拒绝（单次调用可以把余额扣成小负数）。
 * 计费关闭、项目 provider、管理员、没有付款人时放行。
 */
export async function assertCanSpend(
  ctx: AppContext,
  provider: ProviderRef | null | undefined,
  billing: BillingContext | undefined,
): Promise<void> {
  if (!ctx.config.BILLING_ENABLED || !isChargeable(provider)) return;
  const payer = await resolvePayer(ctx, billing);
  if (!payer) return;
  if (await isBillingExempt(ctx, payer)) return;
  if ((await getBalance(ctx, payer)) <= 0)
    throw new ApiError('insufficient_credits', INSUFFICIENT_CREDITS, { balance: 0 });
}

export interface UsageInput {
  provider: ProviderRef | null | undefined;
  /** 模型名（发给接口的） */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** 上游返回的真实成本（美元），OpenRouter usage.cost */
  costUsd?: number | null;
}

/**
 * 唯一的扣费函数：每次模型调用结束后调用（流式也一样，用量来自最后一个 chunk）。
 * 失败只打日志，不影响用户拿到结果（已经花出去的钱靠流水对账）。
 * 返回实际扣掉的积分。
 */
export async function chargeUsage(
  ctx: AppContext,
  billing: BillingContext | undefined,
  usage: UsageInput,
): Promise<number> {
  try {
    if (!isChargeable(usage.provider)) return 0;
    const payer = await resolvePayer(ctx, billing);
    if (!payer) return 0;
    const tokens = Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens);
    if (tokens <= 0 && !usage.costUsd) return 0;
    const fromUpstream = usage.costUsd ? usdToMicros(usage.costUsd) : 0;
    const costMicros =
      fromUpstream > 0
        ? fromUpstream
        : estimateCostMicros(usage.model, usage.inputTokens, usage.outputTokens);
    const credits = creditsFor(costMicros, ctx.config.BILLING_MARKUP, tokens);
    const charge = ctx.config.BILLING_ENABLED && !(await isBillingExempt(ctx, payer)) ? credits : 0;
    if (charge > 0) await getBalance(ctx, payer); // 先补发注册赠送，避免先扣后送的顺序问题
    await applyLedger(ctx, {
      userId: payer,
      delta: -charge,
      kind: 'usage',
      model: `${usage.provider!.id}/${usage.model}`,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsdMicros: costMicros,
      projectId: billing?.projectId ?? null,
      note: billing?.note ?? null,
    });
    return charge;
  } catch (err) {
    console.error('[billing] 记账失败', (err as Error).message);
    return 0;
  }
}
