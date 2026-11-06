import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PayOrderView, TopupCheckout } from '@srh/shared';
import { creditLedger, payOrders } from '../../src/db/schema';
import {
  signWebhook,
  verifyWebhook,
  type KyrenClient,
  type KyrenOrder,
} from '../../src/modules/billing/kyren';
import { getBalance } from '../../src/modules/billing/service';
import {
  RECONCILE_MAX_AGE_MS,
  RECONCILE_MAX_CALLS,
  reconcileOpenOrders,
  setKyrenClientForTest,
} from '../../src/modules/billing/topup';
import { makeApp, signup, type Session, type TestApp } from '../helpers';

/** KyrenPay：验签、重复回调只入账一次、金额对不上不入账、退款、成功页兜底（全部用假客户端，不联网） */

const SECRET = 'whsec_test_only';

describe('verifyWebhook', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'order.paid', data: {} });
  const now = 1_800_000_000_000;
  const headers = (sig: string, ts: number) => ({
    'x-kyren-signature': sig,
    'x-kyren-timestamp': String(ts),
  });

  it('签名正确通过', () => {
    expect(verifyWebhook(SECRET, body, headers(signWebhook(SECRET, body, now), now), now).id).toBe(
      'evt_1',
    );
  });
  it('错误的密钥拒绝', () => {
    expect(() =>
      verifyWebhook(SECRET, body, headers(signWebhook('other', body, now), now), now),
    ).toThrow('bad signature');
  });
  it('超过 5 分钟的时间戳拒绝', () => {
    const old = now - 5 * 60 * 1000 - 1;
    expect(() =>
      verifyWebhook(SECRET, body, headers(signWebhook(SECRET, body, old), old), now),
    ).toThrow('stale');
  });
  it('请求体被改过拒绝', () => {
    const sig = signWebhook(SECRET, body, now);
    expect(() =>
      verifyWebhook(SECRET, body.replace('evt_1', 'evt_2'), headers(sig, now), now),
    ).toThrow('bad signature');
  });
  it('缺头或没配密钥拒绝', () => {
    expect(() => verifyWebhook(SECRET, body, {}, now)).toThrow();
    expect(() => verifyWebhook('', body, headers(signWebhook('', body, now), now), now)).toThrow();
  });
});

function fakeClient() {
  const calls: { checkouts: Record<string, unknown>[]; products: number } = {
    checkouts: [],
    products: 0,
  };
  const orders = new Map<string, KyrenOrder>();
  const checkoutState = new Map<string, { status: string; orderId: string | null }>();
  const client: KyrenClient = {
    async createCheckout(input) {
      calls.checkouts.push(input as unknown as Record<string, unknown>);
      const id = `cs_${calls.checkouts.length}`;
      checkoutState.set(id, { status: 'OPEN', orderId: null });
      return { id, url: `https://pay.example/${id}` };
    },
    async retrieveCheckout(id) {
      const s = checkoutState.get(id);
      return { id, url: '', status: s?.status, orderId: s?.orderId ?? null };
    },
    async retrieveOrder(id) {
      const o = orders.get(id);
      if (!o) throw new Error('no order');
      return o;
    },
    async listProducts() {
      return [];
    },
    async createProduct(input) {
      calls.products += 1;
      return { id: `prod_${input.metadata.sku}`, price: input.price, currency: input.currency };
    },
  };
  return { client, calls, orders, checkoutState };
}

describe('KyrenPay top-up', () => {
  let t: TestApp;
  let s: Session;
  let fake: ReturnType<typeof fakeClient>;
  let evt = 0;

  beforeAll(async () => {
    t = await makeApp({
      BILLING_ENABLED: 'true',
      BILLING_SIGNUP_CREDITS: '0',
      KYREN_WEBHOOK_SECRET: SECRET,
      PUBLIC_URL: 'https://yanxie.example.com/app',
    });
    fake = fakeClient();
    setKyrenClientForTest(t.app.ctx, fake.client);
    s = await signup(t.app);
  }, 60_000);
  afterAll(() => t.close());

  async function topup(sku = 'credits-10', who = s) {
    const res = await who.req('POST', '/billing/topup', { sku });
    expect(res.statusCode).toBe(200);
    return res.json<TopupCheckout>();
  }

  async function webhook(event: object, opts: { secret?: string } = {}) {
    const raw = JSON.stringify(event);
    const ts = Date.now();
    return t.app.inject({
      method: 'POST',
      url: '/api/v1/billing/kyren-webhook',
      headers: {
        'content-type': 'application/json',
        'x-kyren-signature': signWebhook(opts.secret ?? SECRET, raw, ts),
        'x-kyren-timestamp': String(ts),
      },
      payload: raw,
    });
  }

  const paid = (ref: string, over: Record<string, unknown> = {}) => ({
    id: `evt_${++evt}`,
    type: 'order.paid',
    data: {
      order_id: `ord_${ref}`,
      product_id: 'prod_credits-10',
      amount: '10.00',
      currency: 'USD',
      metadata: { ref },
      ...over,
    },
  });

  it('建收银台：先落订单，成功页回到 /app/billing?ref=，商品只建一次', async () => {
    const a = await topup();
    await topup();
    expect(a.url).toMatch(/^https:\/\/pay\.example\//u);
    expect(fake.calls.products).toBe(1);
    expect(fake.calls.checkouts[0]).toMatchObject({
      productId: 'prod_credits-10',
      successUrl: `https://yanxie.example.com/app/billing?ref=${a.ref}`,
      ref: a.ref,
    });
    const [order] = await t.db.db.select().from(payOrders).where(eq(payOrders.ref, a.ref));
    expect(order).toMatchObject({ status: 'created', amountCents: 1000, credits: 10_500 });
    expect((await s.req('POST', '/billing/topup', { sku: 'nope' })).statusCode).toBe(422);
  });

  it('签名错误回 400，不入账', async () => {
    const { ref } = await topup();
    const before = await getBalance(t.app.ctx, s.user.id);
    const res = await webhook(paid(ref), { secret: 'wrong' });
    expect(res.statusCode).toBe(400);
    expect(await getBalance(t.app.ctx, s.user.id)).toBe(before);
  });

  it('重复回调只入账一次（同一事件重投、不同事件同一订单）', async () => {
    const { ref } = await topup();
    const before = await getBalance(t.app.ctx, s.user.id);
    const e = paid(ref);
    const r1 = await webhook(e);
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ received: true, duplicate: false });
    expect((await webhook(e)).json()).toEqual({ received: true, duplicate: true });
    expect((await webhook(paid(ref))).statusCode).toBe(200);
    expect(await getBalance(t.app.ctx, s.user.id)).toBe(before + 10_500);
    const rows = await t.db.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.ref, `topup:${ref}`));
    expect(rows).toHaveLength(1);
    const view = (await s.req('GET', `/billing/orders/${ref}`)).json<PayOrderView>();
    expect(view.status).toBe('paid');
  });

  it('金额 / 币种 / 商品对不上：不入账，订单留待复核', async () => {
    const before = await getBalance(t.app.ctx, s.user.id);
    for (const over of [
      { amount: '1.00' },
      { amount: '10.001' },
      { currency: 'EUR' },
      { product_id: 'prod_credits-30' },
    ]) {
      const { ref } = await topup();
      expect((await webhook(paid(ref, over))).statusCode).toBe(200);
      const [order] = await t.db.db.select().from(payOrders).where(eq(payOrders.ref, ref));
      expect(order?.status).toBe('created');
      expect(order?.reviewNote).toBeTruthy();
    }
    expect(await getBalance(t.app.ctx, s.user.id)).toBe(before);
  });

  it('不认识的 ref 不入账', async () => {
    const before = await getBalance(t.app.ctx, s.user.id);
    expect((await webhook(paid('po_forged'))).statusCode).toBe(200);
    expect(await getBalance(t.app.ctx, s.user.id)).toBe(before);
  });

  it('退款按比例扣回，同一退款只扣一次，余额可为负', async () => {
    const u = await signup(t.app);
    const { ref } = await topup('credits-10', u);
    await webhook(paid(ref));
    expect(await getBalance(t.app.ctx, u.user.id)).toBe(10_500);
    const refund = {
      id: `evt_${++evt}`,
      type: 'order.refunded',
      data: {
        order_id: `ord_${ref}`,
        refund_id: 'rf_1',
        refunded_amount: '3.00',
        original_amount: '10.00',
        currency: 'USD',
        metadata: { ref },
      },
    };
    expect((await webhook(refund)).statusCode).toBe(200);
    // 10500 × 300/1000 = 3150
    expect(await getBalance(t.app.ctx, u.user.id)).toBe(7350);
    await webhook({ ...refund, id: `evt_${++evt}` });
    expect(await getBalance(t.app.ctx, u.user.id)).toBe(7350);
    // 已经花掉一部分后全额退款：扣成负数
    await webhook({
      id: `evt_${++evt}`,
      type: 'order.refunded',
      data: { ...refund.data, refund_id: 'rf_2', refunded_amount: '10.00' },
    });
    expect(await getBalance(t.app.ctx, u.user.id)).toBe(7350 - 10_500);
    const [order] = await t.db.db.select().from(payOrders).where(eq(payOrders.ref, ref));
    expect(order?.status).toBe('refunded');
  });

  it('成功页兜底：只给本人看；向 KyrenPay 核实后才入账', async () => {
    const u = await signup(t.app);
    const other = await signup(t.app);
    const { ref } = await topup('credits-5', u);
    // 收银台还没完成：不入账
    let view = (await u.req('GET', `/billing/orders/${ref}`)).json<PayOrderView>();
    expect(view.status).toBe('created');
    expect(await getBalance(t.app.ctx, u.user.id)).toBe(0);
    // 别人查不到
    expect((await other.req('GET', `/billing/orders/${ref}`)).statusCode).toBe(404);

    const [order] = await t.db.db.select().from(payOrders).where(eq(payOrders.ref, ref));
    fake.checkoutState.set(order!.kyrenCheckoutId!, { status: 'COMPLETE', orderId: 'ord_x' });
    fake.orders.set('ord_x', {
      id: 'ord_x',
      productId: 'prod_credits-5',
      amount: '5.00',
      currency: 'USD',
      metadata: { ref },
    });
    view = (await u.req('GET', `/billing/orders/${ref}`)).json<PayOrderView>();
    expect(view.status).toBe('paid');
    expect(await getBalance(t.app.ctx, u.user.id)).toBe(5000);
    // 之后 webhook 再到也不重复
    await webhook(paid(ref, { order_id: 'ord_x', product_id: 'prod_credits-5', amount: '5.00' }));
    expect(await getBalance(t.app.ctx, u.user.id)).toBe(5000);
  });

  it('兜底查到的订单金额不对：不入账', async () => {
    const u = await signup(t.app);
    const { ref } = await topup('credits-5', u);
    const [order] = await t.db.db.select().from(payOrders).where(eq(payOrders.ref, ref));
    fake.checkoutState.set(order!.kyrenCheckoutId!, { status: 'COMPLETE', orderId: 'ord_y' });
    fake.orders.set('ord_y', {
      id: 'ord_y',
      productId: 'prod_credits-5',
      amount: '0.50',
      currency: 'USD',
      metadata: { ref },
    });
    const view = (await u.req('GET', `/billing/orders/${ref}`)).json<PayOrderView>();
    expect(view.status).toBe('created');
    expect(await getBalance(t.app.ctx, u.user.id)).toBe(0);
  });
});

describe('KyrenPay reconcile worker', () => {
  let t: TestApp;
  let fake: ReturnType<typeof fakeClient>;
  let apiCalls = 0;

  beforeAll(async () => {
    t = await makeApp({
      BILLING_ENABLED: 'true',
      BILLING_SIGNUP_CREDITS: '0',
      KYREN_WEBHOOK_SECRET: SECRET,
    });
    fake = fakeClient();
    const counted: KyrenClient = {
      ...fake.client,
      retrieveCheckout: (id) => {
        apiCalls++;
        return fake.client.retrieveCheckout(id);
      },
      retrieveOrder: (id) => {
        apiCalls++;
        return fake.client.retrieveOrder(id);
      },
    };
    setKyrenClientForTest(t.app.ctx, counted);
  }, 60_000);
  afterAll(() => t.close());

  async function openOrder(who: Session, sku = 'credits-5') {
    const res = await who.req('POST', '/billing/topup', { sku });
    const { ref } = res.json<TopupCheckout>();
    const [order] = await t.db.db.select().from(payOrders).where(eq(payOrders.ref, ref));
    return order!;
  }

  function complete(checkoutId: string, ref: string, orderId: string) {
    fake.checkoutState.set(checkoutId, { status: 'COMPLETE', orderId });
    fake.orders.set(orderId, {
      id: orderId,
      productId: 'prod_credits-5',
      amount: '5.00',
      currency: 'USD',
      metadata: { ref },
    });
  }

  async function statusOf(ref: string) {
    const [o] = await t.db.db.select().from(payOrders).where(eq(payOrders.ref, ref));
    return o?.status;
  }

  it('对账入账一次；再对账 + webhook 迟到也只入账一次', async () => {
    const u = await signup(t.app);
    const order = await openOrder(u);
    // 收银台还开着：不入账
    await reconcileOpenOrders(t.app.ctx);
    expect(await statusOf(order.ref)).toBe('created');

    complete(order.kyrenCheckoutId!, order.ref, 'ord_r1');
    await reconcileOpenOrders(t.app.ctx);
    expect(await getBalance(t.app.ctx, u.user.id)).toBe(5000);
    await reconcileOpenOrders(t.app.ctx);

    const raw = JSON.stringify({
      id: 'evt_late',
      type: 'order.paid',
      data: {
        order_id: 'ord_r1',
        product_id: 'prod_credits-5',
        amount: '5.00',
        currency: 'USD',
        metadata: { ref: order.ref },
      },
    });
    const ts = Date.now();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/billing/kyren-webhook',
      headers: {
        'content-type': 'application/json',
        'x-kyren-signature': signWebhook(SECRET, raw, ts),
        'x-kyren-timestamp': String(ts),
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect(await getBalance(t.app.ctx, u.user.id)).toBe(5000);
    const rows = await t.db.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.ref, `topup:${order.ref}`));
    expect(rows).toHaveLength(1);
    expect(await statusOf(order.ref)).toBe('paid');
  });

  it('收银台过期的订单标记为 failed，不入账', async () => {
    const u = await signup(t.app);
    const order = await openOrder(u);
    fake.checkoutState.set(order.kyrenCheckoutId!, { status: 'EXPIRED', orderId: null });
    await reconcileOpenOrders(t.app.ctx);
    expect(await statusOf(order.ref)).toBe('failed');
    expect(await getBalance(t.app.ctx, u.user.id)).toBe(0);
  });

  it('只查 25 小时内的订单，最老的先查，每轮最多 ~20 次调用', async () => {
    const u = await signup(t.app);
    const old = await openOrder(u);
    await t.db.db
      .update(payOrders)
      .set({ createdAt: new Date(Date.now() - RECONCILE_MAX_AGE_MS - 60_000) })
      .where(eq(payOrders.ref, old.ref));
    // 太老的订单即使已过期也不会被查到（仍是 created）
    fake.checkoutState.set(old.kyrenCheckoutId!, { status: 'EXPIRED', orderId: null });
    const fresh = [];
    for (let i = 0; i < 25; i++) fresh.push(await openOrder(u));
    apiCalls = 0;
    const r = await reconcileOpenOrders(t.app.ctx);
    expect(apiCalls).toBeLessThanOrEqual(RECONCILE_MAX_CALLS);
    expect(r.calls).toBe(apiCalls);
    expect(r.checked).toBeGreaterThan(0);
    expect(await statusOf(old.ref)).toBe('created');
    // 最老的先查：把最早的一张标成过期，本轮就会被处理
    fake.checkoutState.set(fresh[0]!.kyrenCheckoutId!, { status: 'EXPIRED', orderId: null });
    await reconcileOpenOrders(t.app.ctx);
    expect(await statusOf(fresh[0]!.ref)).toBe('failed');
  });
});

describe('KyrenPay not configured', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  }, 60_000);
  afterAll(() => t.close());

  it('没配 key：充值入口关闭，下单回 503', async () => {
    const s = await signup(t.app);
    const me = (await s.req('GET', '/billing/me')).json<{ topupEnabled: boolean }>();
    expect(me.topupEnabled).toBe(false);
    const res = await s.req('POST', '/billing/topup', { sku: 'credits-5' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'payment_unavailable' } });
  });
});
