import { and, desc, eq, gte, sql } from 'drizzle-orm';
import {
  ApiError,
  newId,
  type CreditKind,
  type CreditLedgerEntry,
  type CreditWallet,
} from '@srh/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/client';
import {
  creditBalances,
  creditLedger,
  projectCreditBalances,
  projectCreditCaps,
  projects,
  users,
} from '../../db/schema';
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
  /** 默认 personal；team 时变动 projectId 的团队余额（userId 记付款成员） */
  wallet?: CreditWallet;
  turnRef?: string | null;
}

/**
 * 在事务里写一条流水并更新余额。ref 已存在时什么都不做，返回 false。
 */
export async function applyLedgerTx(tx: Tx | Db, input: LedgerInput): Promise<boolean> {
  if (!Number.isSafeInteger(input.delta)) throw new Error('credit delta must be an integer');
  const wallet = input.wallet ?? 'personal';
  if (wallet === 'team' && !input.projectId) throw new Error('team ledger needs projectId');
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
      wallet,
      turnRef: input.turnRef ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: creditLedger.id });
  if (!row) return false;
  if (wallet === 'team') {
    await tx
      .insert(projectCreditBalances)
      .values({ projectId: input.projectId!, balance: input.delta })
      .onConflictDoUpdate({
        target: projectCreditBalances.projectId,
        set: {
          balance: sql`${projectCreditBalances.balance} + ${input.delta}`,
          updatedAt: sql`now()`,
        },
      });
    return true;
  }
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

/**
 * 注册赠送：每人一次（ref = signup:<userId>），首次读余额时懒发放。
 * 赠送额调高后（例如 500 → 2800），已领过的老用户补差一次（ref = signup-topup:<userId>）。
 */
async function ensureSignupGrant(ctx: AppContext, userId: string) {
  const credits = ctx.config.BILLING_SIGNUP_CREDITS;
  if (credits <= 0) return;
  // 余额行可能先由「计费关闭时的 0 元用量」建出来，所以按流水判断是否已赠送，而不是看有没有余额行
  const [granted] = await ctx.db.db
    .select({
      total: sql<string | null>`sum(${creditLedger.delta})`,
      count: sql<number>`count(*)::int`,
      topped: sql<number>`count(*) filter (where ${creditLedger.ref} = ${`signup-topup:${userId}`})::int`,
    })
    .from(creditLedger)
    .where(and(eq(creditLedger.userId, userId), eq(creditLedger.kind, 'signup')));
  const count = Number(granted?.count ?? 0);
  if (count === 0) {
    await applyLedger(ctx, {
      userId,
      delta: credits,
      kind: 'signup',
      ref: `signup:${userId}`,
      note: 'signup',
    });
    return;
  }
  if (Number(granted?.topped ?? 0) > 0) return;
  const missing = credits - Number(granted?.total ?? 0);
  if (missing <= 0) return;
  await applyLedger(ctx, {
    userId,
    delta: missing,
    kind: 'signup',
    ref: `signup-topup:${userId}`,
    note: 'signup-topup',
  });
}

export async function getBalance(ctx: AppContext, userId: string): Promise<number> {
  await ensureSignupGrant(ctx, userId);
  const [row] = await ctx.db.db
    .select({ balance: creditBalances.balance })
    .from(creditBalances)
    .where(eq(creditBalances.userId, userId));
  return Number(row?.balance ?? 0);
}

export async function getTeamBalance(ctx: AppContext, projectId: string): Promise<number> {
  const [row] = await ctx.db.db
    .select({ balance: projectCreditBalances.balance })
    .from(projectCreditBalances)
    .where(eq(projectCreditBalances.projectId, projectId));
  return Number(row?.balance ?? 0);
}

/** 本月（UTC）起点 */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** 成员本月用掉的团队积分（项目 → 成员 → 积分） */
export async function teamMonthUsage(
  ctx: AppContext,
  projectId: string,
  userId?: string,
): Promise<Map<string, number>> {
  const rows = await ctx.db.db
    .select({
      userId: creditLedger.userId,
      used: sql<string>`coalesce(sum(-${creditLedger.delta}), 0)`,
    })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.projectId, projectId),
        eq(creditLedger.wallet, 'team'),
        eq(creditLedger.kind, 'usage'),
        gte(creditLedger.createdAt, monthStart()),
        ...(userId ? [eq(creditLedger.userId, userId)] : []),
      ),
    )
    .groupBy(creditLedger.userId);
  return new Map(rows.map((r) => [r.userId, Number(r.used)]));
}

export async function memberCap(
  ctx: AppContext,
  projectId: string,
  userId: string,
): Promise<number | null> {
  const [row] = await ctx.db.db
    .select({ cap: projectCreditCaps.monthlyCap })
    .from(projectCreditCaps)
    .where(and(eq(projectCreditCaps.projectId, projectId), eq(projectCreditCaps.userId, userId)));
  return row ? Number(row.cap) : null;
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
    wallet: r.wallet,
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
  /** personal：只扣个人积分（个人库、个人会话），不碰团队积分 */
  scope?: 'personal';
  /** agent 一轮的 turnId，记到用量流水上 */
  turnRef?: string | null;
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

export interface WalletChoice {
  wallet: CreditWallet;
  /** 个人钱包的主人 / 团队钱包的付款成员 */
  payer: string;
  projectId: string | null;
  /** 选中钱包的余额 */
  balance: number;
}

/**
 * 这次调用扣哪个钱包：项目上下文里团队余额 > 0 且成员未超本月上限 → 团队；否则付款人个人。
 * 个人库 / 个人会话（scope = personal）只扣个人。没有付款人时返回 null。
 */
export async function resolveWallet(
  ctx: AppContext,
  billing: BillingContext | undefined,
): Promise<WalletChoice | null> {
  const payer = await resolvePayer(ctx, billing);
  if (!payer) return null;
  const projectId = billing?.projectId ?? null;
  if (projectId && billing?.scope !== 'personal') {
    const team = await getTeamBalance(ctx, projectId);
    if (team > 0) {
      const cap = await memberCap(ctx, projectId, payer);
      const used =
        cap === null ? 0 : ((await teamMonthUsage(ctx, projectId, payer)).get(payer) ?? 0);
      if (cap === null || used < cap) return { wallet: 'team', payer, projectId, balance: team };
    }
  }
  return { wallet: 'personal', payer, projectId, balance: await getBalance(ctx, payer) };
}

/**
 * 个人积分转入团队：一个事务里写两条流水（个人 -N、团队 +N），余额不够整笔拒绝。
 * ref 由调用方给（幂等）。
 */
export async function transferToTeam(
  ctx: AppContext,
  input: { userId: string; projectId: string; credits: number; ref: string },
): Promise<{ personalBalance: number; teamBalance: number }> {
  if (!Number.isSafeInteger(input.credits) || input.credits <= 0)
    throw new ApiError('validation_failed', '转入数量要是正整数');
  await getBalance(ctx, input.userId); // 先补发注册赠送
  await ctx.db.db.transaction(async (tx) => {
    // 锁住个人余额行，防止并发转出把余额扣成负数
    const [row] = await tx
      .select({ balance: creditBalances.balance })
      .from(creditBalances)
      .where(eq(creditBalances.userId, input.userId))
      .for('update');
    const have = Number(row?.balance ?? 0);
    if (have < input.credits)
      throw new ApiError('insufficient_credits', '个人积分不够转入这么多', { balance: have });
    const out = await applyLedgerTx(tx, {
      userId: input.userId,
      delta: -input.credits,
      kind: 'transfer',
      ref: `${input.ref}:out`,
      projectId: input.projectId,
      note: 'to-team',
    });
    if (!out) return; // 重复请求
    await applyLedgerTx(tx, {
      userId: input.userId,
      delta: input.credits,
      kind: 'transfer',
      ref: `${input.ref}:in`,
      projectId: input.projectId,
      wallet: 'team',
      note: 'from-personal',
    });
  });
  return {
    personalBalance: await getBalance(ctx, input.userId),
    teamBalance: await getTeamBalance(ctx, input.projectId),
  };
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
  const choice = await resolveWallet(ctx, billing);
  if (!choice || choice.balance <= 0)
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
    // 真扣费时选钱包（resolveWallet 会先补发注册赠送）；不扣费只记个人用量
    const choice = charge > 0 ? await resolveWallet(ctx, billing) : null;
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
      wallet: choice?.wallet ?? 'personal',
      turnRef: billing?.turnRef ?? null,
    });
    return charge;
  } catch (err) {
    console.error('[billing] 记账失败', (err as Error).message);
    return 0;
  }
}
