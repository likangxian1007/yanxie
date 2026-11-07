import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ApiError, BillingOverview } from '@srh/shared';
import { creditLedger, users } from '../../src/db/schema';
import {
  INSUFFICIENT_CREDITS,
  applyLedger,
  assertCanSpend,
  chargeUsage,
  getBalance,
} from '../../src/modules/billing/service';
import { makeApp, sessionFor, signup, type Session, type TestApp } from '../helpers';

/** 积分账本：闸门、扣费、项目 provider 不收费、管理员免扣、计费关闭只记账 */

const ENV = { id: 'openrouter', source: 'env' as const };
const PROJECT = { id: 'my-own', source: 'project' as const };

async function usageRows(t: TestApp, userId: string) {
  return t.db.db.select().from(creditLedger).where(eq(creditLedger.userId, userId));
}

describe('billing enabled', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp({ BILLING_ENABLED: 'true', BILLING_SIGNUP_CREDITS: '0' });
  }, 60_000);
  afterAll(() => t.close());

  it('余额 <= 0 时拒绝，单次调用可以扣成小负数', async () => {
    const s = await signup(t.app);
    const ctx = t.app.ctx;
    const billing = { payerUserId: s.user.id };
    expect(await getBalance(ctx, s.user.id)).toBe(0);
    const err = await assertCanSpend(ctx, ENV, billing).catch((e: ApiError) => e);
    expect(err).toMatchObject({ code: 'insufficient_credits', message: INSUFFICIENT_CREDITS });

    await applyLedger(ctx, { userId: s.user.id, delta: 2, kind: 'adjust', ref: 'adj:t1' });
    await expect(assertCanSpend(ctx, ENV, billing)).resolves.toBeUndefined();
    // 1000 输出 tokens × claude 10 美元/百万 = 0.01 美元 × 1.6 = 16 积分
    const charged = await chargeUsage(ctx, billing, {
      provider: ENV,
      model: 'anthropic/claude-sonnet-5.5',
      inputTokens: 0,
      outputTokens: 1000,
    });
    expect(charged).toBe(16);
    expect(await getBalance(ctx, s.user.id)).toBe(-14);
    await expect(assertCanSpend(ctx, ENV, billing)).rejects.toMatchObject({
      code: 'insufficient_credits',
    });
  });

  it('优先用上游返回的真实成本', async () => {
    const s = await signup(t.app);
    const ctx = t.app.ctx;
    const charged = await chargeUsage(
      ctx,
      { payerUserId: s.user.id, note: 'agent' },
      { provider: ENV, model: 'z-ai/glm-5.3', inputTokens: 5, outputTokens: 5, costUsd: 0.0123 },
    );
    // 0.0123 × 1.6 × 1000 = 19.68 → 20
    expect(charged).toBe(20);
    const [row] = await usageRows(t, s.user.id);
    expect(row).toMatchObject({
      delta: -20,
      kind: 'usage',
      model: 'openrouter/z-ai/glm-5.3',
      costUsdMicros: 12_300,
      note: 'agent',
    });
  });

  it('项目自配 provider 不拦截、不扣费、不记账', async () => {
    const s = await signup(t.app);
    const ctx = t.app.ctx;
    const billing = { payerUserId: s.user.id };
    await expect(assertCanSpend(ctx, PROJECT, billing)).resolves.toBeUndefined();
    const charged = await chargeUsage(ctx, billing, {
      provider: PROJECT,
      model: 'gpt-5.6-terra',
      inputTokens: 100_000,
      outputTokens: 100_000,
    });
    expect(charged).toBe(0);
    expect(await usageRows(t, s.user.id)).toHaveLength(0);
    expect(await getBalance(ctx, s.user.id)).toBe(0);
  });

  it('管理员免扣费、不拦截，但用量照记（delta 0）', async () => {
    const s = await signup(t.app);
    await t.db.db.update(users).set({ isAdmin: true }).where(eq(users.id, s.user.id));
    const ctx = t.app.ctx;
    const billing = { payerUserId: s.user.id };
    await expect(assertCanSpend(ctx, ENV, billing)).resolves.toBeUndefined();
    const charged = await chargeUsage(ctx, billing, {
      provider: ENV,
      model: 'deepseek-v4-pro',
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(charged).toBe(0);
    const rows = await usageRows(t, s.user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ delta: 0, inputTokens: 1000, outputTokens: 1000 });
    expect(await getBalance(ctx, s.user.id)).toBe(0);
  });

  it('后台任务（没有触发者）扣项目创建者', async () => {
    const owner = await signup(t.app);
    const p = await owner.req('POST', '/projects', { name: '计费项目' });
    const projectId = p.json<{ id: string }>().id;
    const ctx = t.app.ctx;
    await expect(assertCanSpend(ctx, ENV, { projectId })).rejects.toMatchObject({
      code: 'insufficient_credits',
    });
    await chargeUsage(
      ctx,
      { projectId, note: 'report' },
      { provider: ENV, model: 'deepseek-flash', inputTokens: 10, outputTokens: 10 },
    );
    expect(await getBalance(ctx, owner.user.id)).toBe(-1);
  });

  it('同一个 ref 只记一次', async () => {
    const s = await signup(t.app);
    const ctx = t.app.ctx;
    const once = { userId: s.user.id, delta: 100, kind: 'adjust' as const, ref: 'adj:dup' };
    expect(await applyLedger(ctx, once)).toBe(true);
    expect(await applyLedger(ctx, once)).toBe(false);
    expect(await getBalance(ctx, s.user.id)).toBe(100);
  });

  it('管理员手动调整；普通用户无权', async () => {
    const s = await signup(t.app);
    const plain = await signup(t.app);
    await t.db.db.update(users).set({ isAdmin: true }).where(eq(users.id, s.user.id));
    const admin = sessionFor(t.app, { ...s.user, isAdmin: true }, s.cookie);
    const denied = await plain.req('POST', '/admin/credits', { userId: plain.user.id, delta: 5 });
    expect(denied.statusCode).toBe(403);
    const ok = await admin.req('POST', '/admin/credits', {
      userId: plain.user.id,
      delta: 1234,
      note: '补偿',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ userId: plain.user.id, balance: 1234 });
    const me = (await plain.req('GET', '/billing/me')).json<BillingOverview>();
    expect(me).toMatchObject({ enabled: true, exempt: false, balance: 1234, topupEnabled: false });
    expect(me.recent[0]).toMatchObject({ delta: 1234, kind: 'adjust', note: '补偿' });
  });
});

describe('billing disabled (default)', () => {
  let t: TestApp;
  let s: Session;
  beforeAll(async () => {
    t = await makeApp();
    s = await signup(t.app);
  }, 60_000);
  afterAll(() => t.close());

  it('不拦截、不扣费，只记用量；注册赠送一次', async () => {
    const ctx = t.app.ctx;
    const billing = { payerUserId: s.user.id };
    expect(await getBalance(ctx, s.user.id)).toBe(2800);
    expect(await getBalance(ctx, s.user.id)).toBe(2800);
    await applyLedger(ctx, { userId: s.user.id, delta: -2900, kind: 'adjust', ref: 'adj:neg' });
    await expect(assertCanSpend(ctx, ENV, billing)).resolves.toBeUndefined();
    const charged = await chargeUsage(ctx, billing, {
      provider: ENV,
      model: 'qwen/qwen3.7-plus',
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(charged).toBe(0);
    expect(await getBalance(ctx, s.user.id)).toBe(-100);
    const rows = await usageRows(t, s.user.id);
    expect(rows.filter((r) => r.kind === 'signup')).toHaveLength(1);
    expect(rows.find((r) => r.kind === 'usage')).toMatchObject({ delta: 0, costUsdMicros: 1600 });
  });

  it('老用户先有 0 元用量（余额行已存在）也能补发一次注册赠送', async () => {
    const ctx = t.app.ctx;
    const other = await signup(t.app);
    await chargeUsage(
      ctx,
      { payerUserId: other.user.id },
      { provider: ENV, model: 'qwen/qwen3.7-plus', inputTokens: 10, outputTokens: 10 },
    );
    expect(await getBalance(ctx, other.user.id)).toBe(2800);
    expect(await getBalance(ctx, other.user.id)).toBe(2800);
    const rows = await usageRows(t, other.user.id);
    expect(rows.filter((r) => r.kind === 'signup')).toHaveLength(1);
  });
});
