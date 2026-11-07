import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { BillingOverview, ProjectBillingView, TopupCheckout, TurnCredits } from '@srh/shared';
import { creditLedger, payOrders } from '../../src/db/schema';
import type { KyrenClient } from '../../src/modules/billing/kyren';
import {
  applyLedger,
  assertCanSpend,
  chargeUsage,
  getBalance,
  getTeamBalance,
} from '../../src/modules/billing/service';
import { fulfillPaid, setKyrenClientForTest } from '../../src/modules/billing/topup';
import { makeApp, setupProject, signup, type TestApp } from '../helpers';

/** 团队积分：注册补差、团队优先、上限回落个人、转入、团队充值、个人库只扣个人、每轮消耗 */

const ENV = { id: 'openrouter', source: 'env' as const };
// 1000 输出 tokens × claude 10 美元/百万 × 1.6 = 16 积分
const USAGE = {
  provider: ENV,
  model: 'anthropic/claude-sonnet-5.5',
  inputTokens: 0,
  outputTokens: 1000,
};

describe('signup bonus top-up', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp({ BILLING_ENABLED: 'true' });
  }, 60_000);
  afterAll(() => t.close());

  it('新用户直接拿 2800', async () => {
    const s = await signup(t.app);
    expect(await getBalance(t.app.ctx, s.user.id)).toBe(2800);
  });

  it('老用户领过 500 的补差 2300，只补一次', async () => {
    const s = await signup(t.app);
    const ctx = t.app.ctx;
    // 模拟旧版本发的 500
    await applyLedger(ctx, {
      userId: s.user.id,
      delta: 500,
      kind: 'signup',
      ref: `signup:${s.user.id}`,
    });
    expect(await getBalance(ctx, s.user.id)).toBe(2800);
    expect(await getBalance(ctx, s.user.id)).toBe(2800);
    const rows = await t.db.db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.userId, s.user.id), eq(creditLedger.kind, 'signup')));
    expect(rows.map((r) => [r.ref, r.delta]).sort()).toEqual([
      [`signup-topup:${s.user.id}`, 2300],
      [`signup:${s.user.id}`, 500],
    ]);
  });
});

describe('team wallet', () => {
  let t: TestApp;
  let fakeCheckouts = 0;
  beforeAll(async () => {
    t = await makeApp({ BILLING_ENABLED: 'true', BILLING_SIGNUP_CREDITS: '1000' });
    const client: KyrenClient = {
      async createCheckout() {
        fakeCheckouts += 1;
        return { id: `cs_${fakeCheckouts}`, url: `https://pay.example/${fakeCheckouts}` };
      },
      async retrieveCheckout(id) {
        return { id, url: '', status: 'OPEN', orderId: null };
      },
      async retrieveOrder() {
        throw new Error('no');
      },
      async listProducts() {
        return [];
      },
      async createProduct(input) {
        return { id: `prod_${input.metadata.sku}`, price: input.price, currency: input.currency };
      },
    };
    setKyrenClientForTest(t.app.ctx, client);
  }, 60_000);
  afterAll(() => t.close());

  it('转入团队：两条流水、原子；余额不够整笔拒绝；非管理者 403', async () => {
    const { project, owner, others } = await setupProject(t.app, ['member']);
    const [member] = others;
    const ctx = t.app.ctx;
    const res = await owner.req('POST', `/billing/projects/${project.id}/transfer`, {
      credits: 400,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ personalBalance: 600, teamBalance: 400 });
    const rows = await t.db.db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.userId, owner.user.id), eq(creditLedger.kind, 'transfer')));
    expect(rows.map((r) => [r.wallet, r.delta]).sort()).toEqual([
      ['personal', -400],
      ['team', 400],
    ]);

    const tooMuch = await owner.req('POST', `/billing/projects/${project.id}/transfer`, {
      credits: 601,
    });
    expect(tooMuch.statusCode).toBe(402);
    expect(await getBalance(ctx, owner.user.id)).toBe(600);
    expect(await getTeamBalance(ctx, project.id)).toBe(400);

    const denied = await member!.req('POST', `/billing/projects/${project.id}/transfer`, {
      credits: 1,
    });
    expect(denied.statusCode).toBe(403);
    const bad = await owner.req('POST', `/billing/projects/${project.id}/transfer`, {
      credits: 0,
    });
    expect(bad.statusCode).toBe(422);
    const outsider = await signup(t.app);
    expect((await outsider.req('GET', `/billing/projects/${project.id}`)).statusCode).toBe(404);
  });

  it('项目里先扣团队；超过成员月上限回落个人', async () => {
    const { project, owner, others } = await setupProject(t.app, ['member']);
    const member = others[0]!;
    const ctx = t.app.ctx;
    await owner.req('POST', `/billing/projects/${project.id}/transfer`, { credits: 500 });
    const billing = { payerUserId: member.user.id, projectId: project.id, note: 'agent' };
    await chargeUsage(ctx, billing, USAGE);
    expect(await getTeamBalance(ctx, project.id)).toBe(484);
    expect(await getBalance(ctx, member.user.id)).toBe(1000);

    const cap = await owner.req(
      'PUT',
      `/billing/projects/${project.id}/members/${member.user.id}/cap`,
      { monthlyCap: 20 },
    );
    expect(cap.statusCode).toBe(200);
    await chargeUsage(ctx, billing, USAGE); // 用了 16 < 20：仍扣团队
    expect(await getTeamBalance(ctx, project.id)).toBe(468);
    await chargeUsage(ctx, billing, USAGE); // 32 ≥ 20：回落个人
    expect(await getTeamBalance(ctx, project.id)).toBe(468);
    expect(await getBalance(ctx, member.user.id)).toBe(984);

    const view = (
      await owner.req('GET', `/billing/projects/${project.id}`)
    ).json<ProjectBillingView>();
    expect(view.balance).toBe(468);
    expect(view.members?.find((m) => m.userId === member.user.id)).toMatchObject({
      monthUsed: 32,
      monthlyCap: 20,
    });
    const mine = (
      await member.req('GET', `/billing/projects/${project.id}`)
    ).json<ProjectBillingView>();
    expect(mine).toMatchObject({ source: 'personal', members: null, monthUsed: 32 });

    // 成员不能设上限；去掉上限后又扣团队
    expect(
      (
        await member.req('PUT', `/billing/projects/${project.id}/members/${member.user.id}/cap`, {
          monthlyCap: null,
        })
      ).statusCode,
    ).toBe(403);
    await owner.req('PUT', `/billing/projects/${project.id}/members/${member.user.id}/cap`, {
      monthlyCap: null,
    });
    await chargeUsage(ctx, billing, USAGE);
    expect(await getTeamBalance(ctx, project.id)).toBe(452);

    const me = (await member.req('GET', '/billing/me')).json<BillingOverview>();
    expect(me.teams).toEqual([
      expect.objectContaining({ projectId: project.id, balance: 452, canManage: false }),
    ]);
  });

  it('团队余额用完回落个人；都为 0 时拦截', async () => {
    const { project, others } = await setupProject(t.app, ['member']);
    const member = others[0]!;
    const ctx = t.app.ctx;
    const billing = { payerUserId: member.user.id, projectId: project.id };
    await applyLedger(ctx, {
      userId: member.user.id,
      delta: -1000,
      kind: 'adjust',
      ref: `adj:zero:${member.user.id}`,
    });
    await expect(assertCanSpend(ctx, ENV, billing)).rejects.toMatchObject({
      code: 'insufficient_credits',
    });
    await applyLedger(ctx, {
      userId: member.user.id,
      delta: 5,
      kind: 'adjust',
      ref: 'adj:team',
      wallet: 'team',
      projectId: project.id,
    });
    await expect(assertCanSpend(ctx, ENV, billing)).resolves.toBeUndefined();
  });

  it('个人库 / 个人会话只扣个人，即使项目团队有余额', async () => {
    const { project, owner } = await setupProject(t.app, []);
    const ctx = t.app.ctx;
    await owner.req('POST', `/billing/projects/${project.id}/transfer`, { credits: 100 });
    await chargeUsage(
      ctx,
      { payerUserId: owner.user.id, projectId: project.id, scope: 'personal' },
      USAGE,
    );
    expect(await getTeamBalance(ctx, project.id)).toBe(100);
    expect(await getBalance(ctx, owner.user.id)).toBe(884);
  });

  it('后台任务（没有触发者）先扣团队', async () => {
    const { project, owner } = await setupProject(t.app, []);
    const ctx = t.app.ctx;
    await owner.req('POST', `/billing/projects/${project.id}/transfer`, { credits: 100 });
    await chargeUsage(ctx, { projectId: project.id, note: 'report' }, USAGE);
    expect(await getTeamBalance(ctx, project.id)).toBe(84);
    expect(await getBalance(ctx, owner.user.id)).toBe(900);
  });

  it('为团队充值：订单记 wallet=team，入账到团队余额；成员不能为团队充值', async () => {
    const { project, owner, others } = await setupProject(t.app, ['member']);
    const ctx = t.app.ctx;
    const denied = await others[0]!.req('POST', '/billing/topup', {
      sku: 'credits-10',
      wallet: 'team',
      projectId: project.id,
    });
    expect(denied.statusCode).toBe(403);
    const res = await owner.req('POST', '/billing/topup', {
      sku: 'credits-10',
      wallet: 'team',
      projectId: project.id,
    });
    expect(res.statusCode).toBe(200);
    const { ref } = res.json<TopupCheckout>();
    const [order] = await t.db.db.select().from(payOrders).where(eq(payOrders.ref, ref));
    expect(order).toMatchObject({ wallet: 'team', projectId: project.id });
    const before = await getBalance(ctx, owner.user.id);
    expect(
      await fulfillPaid(ctx, {
        ref,
        orderId: 'ord_team',
        productId: order!.productId,
        amount: '10.00',
        currency: 'USD',
      }),
    ).toBe('credited');
    expect(await getTeamBalance(ctx, project.id)).toBe(10_500);
    expect(await getBalance(ctx, owner.user.id)).toBe(before);
  });

  it('每轮消耗：按 turnRef 汇总', async () => {
    const { project, owner } = await setupProject(t.app, []);
    const ctx = t.app.ctx;
    const billing = { payerUserId: owner.user.id, projectId: project.id, turnRef: 'turn_a' };
    await chargeUsage(ctx, billing, USAGE);
    await chargeUsage(ctx, billing, { ...USAGE, inputTokens: 10 });
    await chargeUsage(ctx, { ...billing, turnRef: 'turn_b' }, USAGE);
    const res = await owner.req('GET', `/billing/projects/${project.id}/turns?ids=turn_a,turn_x`);
    expect(res.statusCode).toBe(200);
    const [a] = res.json<TurnCredits[]>();
    expect(res.json<TurnCredits[]>()).toHaveLength(1);
    expect(a).toMatchObject({ turnId: 'turn_a', outputTokens: 2000, inputTokens: 10 });
    expect(a!.credits).toBeGreaterThanOrEqual(32);
  });
});
