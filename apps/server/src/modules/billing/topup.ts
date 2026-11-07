import { randomBytes } from 'node:crypto';
import { and, asc, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { ApiError, newId, type PayOrderView, type TopupCheckout } from '@srh/shared';
import type { AppContext } from '../../context';
import { kyrenEvents, kyrenProducts, payOrders } from '../../db/schema';
import { dollarsToCents, makeKyrenClient, type KyrenClient, type KyrenEvent } from './kyren';
import { TOPUP_PACKS, type TopupPackDef } from './pricing';
import { applyLedgerTx } from './service';

/**
 * KyrenPay 充值（真钱，没有沙箱）。入账只有一个入口 fulfillPaid，
 * webhook 和成功页兜底都走它；单赢家更新（status created→paid）+ 流水 ref 唯一，重复到达只记一次。
 */

const injected = new WeakMap<AppContext, KyrenClient | null>();

/** 测试注入假客户端（传 null 恢复） */
export function setKyrenClientForTest(ctx: AppContext, client: KyrenClient | null) {
  if (client) injected.set(ctx, client);
  else injected.delete(ctx);
}

export function kyrenClient(ctx: AppContext): KyrenClient | null {
  const test = injected.get(ctx);
  if (test) return test;
  if (!ctx.config.KYREN_API_KEY) return null;
  return makeKyrenClient({ apiKey: ctx.config.KYREN_API_KEY, baseUrl: ctx.config.KYREN_BASE_URL });
}

export function topupEnabled(ctx: AppContext): boolean {
  return kyrenClient(ctx) !== null;
}

export function packFor(sku: string): TopupPackDef | undefined {
  return TOPUP_PACKS.find((p) => p.sku === sku);
}

/** 每个充值包一个 KyrenPay 商品：先查本地表，再按 metadata.sku 在远端找，都没有才创建 */
async function productFor(ctx: AppContext, client: KyrenClient, pack: TopupPackDef) {
  const [row] = await ctx.db.db.select().from(kyrenProducts).where(eq(kyrenProducts.sku, pack.sku));
  if (row && row.price === pack.price && row.currency === pack.currency) return row.productId;
  const remote = (await client.listProducts()).find(
    (p) =>
      p.metadata?.sku === pack.sku &&
      (p.price === undefined || dollarsToCents(p.price) === dollarsToCents(pack.price)),
  );
  const productId =
    remote?.id ??
    (
      await client.createProduct({
        name: `${ctx.config.KYREN_MERCHANT_NAME} ${pack.credits} credits`, // i18n-ignore
        description: `${pack.credits} credits`, // i18n-ignore
        price: pack.price,
        currency: pack.currency,
        metadata: { sku: pack.sku },
      })
    ).id;
  await ctx.db.db
    .insert(kyrenProducts)
    .values({ sku: pack.sku, productId, price: pack.price, currency: pack.currency })
    .onConflictDoUpdate({
      target: kyrenProducts.sku,
      set: { productId, price: pack.price, currency: pack.currency },
    });
  return productId;
}

function newRef() {
  return `po_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;
}

export async function createTopup(
  ctx: AppContext,
  user: { id: string; email: string },
  sku: string,
  /** 充到团队：调用方已校验 owner / admin */
  team?: { projectId: string } | null,
): Promise<TopupCheckout> {
  const client = kyrenClient(ctx);
  if (!client) throw new ApiError('payment_unavailable', '在线充值暂未开放');
  const pack = packFor(sku);
  if (!pack) throw new ApiError('validation_failed', '没有这个充值包');
  const productId = await productFor(ctx, client, pack);
  const ref = newRef();
  const base = ctx.config.PUBLIC_URL.replace(/\/+$/u, '');
  // 订单先落库再建收银台：webhook 可能比我们拿到响应还早
  await ctx.db.db.insert(payOrders).values({
    id: newId('payOrder'),
    ref,
    userId: user.id,
    sku: pack.sku,
    credits: pack.credits,
    amountCents: dollarsToCents(pack.price),
    currency: pack.currency,
    productId,
    wallet: team ? 'team' : 'personal',
    projectId: team?.projectId ?? null,
  });
  const cs = await client.createCheckout({
    productId,
    successUrl: `${base}/billing?ref=${encodeURIComponent(ref)}`,
    cancelUrl: `${base}/billing`,
    email: user.email,
    merchantName: ctx.config.KYREN_MERCHANT_NAME,
    ref,
    metadata: {
      sku: pack.sku,
      userId: user.id,
      ...(team ? { wallet: 'team', projectId: team.projectId } : {}),
    },
  });
  await ctx.db.db.update(payOrders).set({ kyrenCheckoutId: cs.id }).where(eq(payOrders.ref, ref));
  return { ref, url: cs.url };
}

type OrderRow = typeof payOrders.$inferSelect;

/** 订单充到哪个钱包；团队订单的项目被删了就退回下单人个人 */
function walletOf(order: OrderRow) {
  return order.wallet === 'team' && order.projectId
    ? { wallet: 'team' as const, projectId: order.projectId }
    : { wallet: 'personal' as const };
}

async function markReview(ctx: AppContext, ref: string, note: string) {
  console.error(`[billing] 充值订单 ${ref} 需人工复核：${note}`);
  await ctx.db.db.update(payOrders).set({ reviewNote: note }).where(eq(payOrders.ref, ref));
}

export interface PaidFacts {
  ref: string;
  orderId: string | null;
  productId: string | null | undefined;
  amount: string | null | undefined;
  currency: string | null | undefined;
}

export type FulfillResult = 'credited' | 'already' | 'mismatch' | 'unknown';

/** 金额字符串 → 整数分；格式不对返回 null（当作金额不符） */
function safeCents(amount: string | null | undefined): number | null {
  if (amount == null) return null;
  try {
    return dollarsToCents(amount);
  } catch {
    return null;
  }
}

/**
 * 唯一的入账函数。条件全对上才入账：订单存在且状态 created、金额（分）、币种、商品都和下单时一致。
 * 对不上：记 review_note，不入账，订单留给人工。
 */
export async function fulfillPaid(ctx: AppContext, facts: PaidFacts): Promise<FulfillResult> {
  const [order] = await ctx.db.db.select().from(payOrders).where(eq(payOrders.ref, facts.ref));
  if (!order) {
    console.error(`[billing] order.paid 找不到订单 ref=${facts.ref} order_id=${facts.orderId}`);
    return 'unknown';
  }
  if (order.status !== 'created') return order.status === 'paid' ? 'already' : 'mismatch';
  const cents = safeCents(facts.amount);
  const problems: string[] = [];
  if (cents !== order.amountCents) problems.push(`amount ${facts.amount} != ${order.amountCents}c`);
  if ((facts.currency ?? '').toUpperCase() !== order.currency.toUpperCase())
    problems.push(`currency ${facts.currency} != ${order.currency}`);
  if (facts.productId !== order.productId)
    problems.push(`product ${facts.productId} != ${order.productId}`);
  if (problems.length) {
    await markReview(ctx, order.ref, problems.join('; '));
    return 'mismatch';
  }
  return ctx.db.db.transaction(async (tx) => {
    const won = await tx
      .update(payOrders)
      .set({ status: 'paid', paidAt: new Date(), kyrenOrderId: facts.orderId })
      .where(and(eq(payOrders.ref, order.ref), eq(payOrders.status, 'created')))
      .returning({ id: payOrders.id });
    if (!won.length) return 'already' as const;
    await applyLedgerTx(tx, {
      userId: order.userId,
      delta: order.credits,
      kind: 'topup',
      ref: `topup:${order.ref}`,
      note: order.sku,
      ...walletOf(order),
    });
    return 'credited' as const;
  });
}

/** 退款：按退款金额占原价的比例扣回积分（向上取整，可扣成负数） */
async function handleRefund(ctx: AppContext, order: OrderRow, event: KyrenEvent) {
  const d = event.data;
  let refunded: number;
  let original: number;
  try {
    refunded = dollarsToCents(d.refunded_amount ?? d.amount ?? '');
    original = d.original_amount ? dollarsToCents(d.original_amount) : order.amountCents;
  } catch {
    await markReview(ctx, order.ref, `refund amount unparsable: ${String(d.refunded_amount)}`);
    return;
  }
  if (order.status !== 'paid' && order.status !== 'refunded') {
    await markReview(ctx, order.ref, `refund on order in status ${order.status}`);
    return;
  }
  if (original <= 0 || refunded <= 0) return;
  const credits = Math.ceil((order.credits * Math.min(refunded, original)) / original);
  const refundId = d.refund_id ?? event.id;
  await ctx.db.db.transaction(async (tx) => {
    await applyLedgerTx(tx, {
      userId: order.userId,
      delta: -credits,
      kind: 'refund',
      ref: `refund:${refundId}`,
      note: order.ref,
      ...walletOf(order),
    });
    await tx.update(payOrders).set({ status: 'refunded' }).where(eq(payOrders.id, order.id));
  });
}

/**
 * 处理一条已验签的事件。事件 id 去重；业务处理和事件登记都完成后才返回（调用方随后回 2xx）。
 * 返回 false 表示是重复事件。
 */
export async function processEvent(ctx: AppContext, event: KyrenEvent): Promise<boolean> {
  const [seen] = await ctx.db.db
    .select({ id: kyrenEvents.id })
    .from(kyrenEvents)
    .where(eq(kyrenEvents.id, event.id));
  if (seen) return false;
  const d = event.data;
  const ref = typeof d.metadata?.ref === 'string' ? d.metadata.ref : null;
  const [order] = ref
    ? await ctx.db.db.select().from(payOrders).where(eq(payOrders.ref, ref))
    : [undefined];
  switch (event.type) {
    case 'order.paid':
      if (!ref) console.error(`[billing] order.paid 没有 metadata.ref order_id=${d.order_id}`);
      else
        await fulfillPaid(ctx, {
          ref,
          orderId: d.order_id ?? null,
          productId: d.product_id,
          amount: d.amount,
          currency: d.currency,
        });
      break;
    case 'order.refunded':
      if (order) await handleRefund(ctx, order, event);
      else console.error(`[billing] order.refunded 找不到订单 ref=${ref} order_id=${d.order_id}`);
      break;
    case 'order.closed':
      if (order?.status === 'created')
        await ctx.db.db
          .update(payOrders)
          .set({ status: 'failed' })
          .where(and(eq(payOrders.id, order.id), eq(payOrders.status, 'created')));
      break;
    default:
      break;
  }
  // 业务写完再登记事件：中途失败时对方重投还能重试（入账本身靠 ref 幂等）
  await ctx.db.db
    .insert(kyrenEvents)
    .values({ id: event.id, type: event.type })
    .onConflictDoNothing();
  return true;
}

function toView(o: OrderRow): PayOrderView {
  return {
    ref: o.ref,
    sku: o.sku,
    credits: Number(o.credits),
    status: o.status,
    createdAt: o.createdAt.toISOString(),
    paidAt: o.paidAt?.toISOString() ?? null,
    wallet: o.wallet,
    projectId: o.projectId,
  };
}

/**
 * 向 KyrenPay 核实一张 created 订单：收银台 COMPLETE → 查订单 → fulfillPaid（与 webhook 同一个幂等入账函数）；
 * EXPIRED → 标记 failed。返回本次调用 KyrenPay 的次数（限流计数用）。出错只记日志。
 */
export async function reconcileOrder(
  ctx: AppContext,
  client: KyrenClient,
  order: OrderRow,
): Promise<number> {
  if (order.status !== 'created' || !order.kyrenCheckoutId) return 0;
  let calls = 0;
  try {
    calls++;
    const cs = await client.retrieveCheckout(order.kyrenCheckoutId);
    if (cs.status === 'EXPIRED') {
      await ctx.db.db
        .update(payOrders)
        .set({ status: 'failed' })
        .where(and(eq(payOrders.ref, order.ref), eq(payOrders.status, 'created')));
      return calls;
    }
    if (cs.status !== 'COMPLETE' || !cs.orderId) return calls;
    calls++;
    const o = await client.retrieveOrder(cs.orderId);
    const metaRef = typeof o.metadata?.ref === 'string' ? o.metadata.ref : order.ref;
    // 订单状态明确不是已付（退款 / 关闭等）时不入账
    const unpaid =
      o.status !== undefined && !/^(paid|complete|completed|succeeded|success)$/iu.test(o.status);
    if (unpaid) console.error(`[billing] 核对订单 ${order.ref} 状态 ${o.status}，不入账`);
    else if (metaRef === order.ref)
      await fulfillPaid(ctx, {
        ref: order.ref,
        orderId: o.id ?? cs.orderId,
        productId: o.productId ?? null,
        amount: o.amount ?? null,
        currency: o.currency ?? null,
      });
    else await markReview(ctx, order.ref, `order metadata.ref ${metaRef} mismatch`);
  } catch (err) {
    console.error('[billing] 查询 KyrenPay 订单失败', (err as Error).message);
  }
  return calls;
}

/** 对账只看 25 小时内的订单（收银台早已过期的不再查） */
export const RECONCILE_MAX_AGE_MS = 25 * 60 * 60 * 1000;
/** 每轮最多调用 KyrenPay 的次数（限流） */
export const RECONCILE_MAX_CALLS = 20;

/**
 * 对账：webhook 可能收不到（商户只能配一个回调地址），用户也可能不回成功页，
 * 所以定时把 created 订单逐个向 KyrenPay 核实。最老的先查，每轮最多 ~20 次调用。
 */
export async function reconcileOpenOrders(
  ctx: AppContext,
  now = Date.now(),
): Promise<{ checked: number; calls: number }> {
  const client = kyrenClient(ctx);
  if (!client) return { checked: 0, calls: 0 };
  const rows = await ctx.db.db
    .select()
    .from(payOrders)
    .where(
      and(
        eq(payOrders.status, 'created'),
        isNotNull(payOrders.kyrenCheckoutId),
        // 已标记人工复核的不再自动查（避免每轮重复占用限流额度）
        isNull(payOrders.reviewNote),
        gt(payOrders.createdAt, new Date(now - RECONCILE_MAX_AGE_MS)),
      ),
    )
    .orderBy(asc(payOrders.createdAt))
    .limit(RECONCILE_MAX_CALLS);
  let calls = 0;
  let checked = 0;
  for (const row of rows) {
    if (calls + 2 > RECONCILE_MAX_CALLS) break;
    calls += await reconcileOrder(ctx, client, row);
    checked++;
  }
  return { checked, calls };
}

/**
 * 成功页兜底：只给下单本人看。订单还是 created 时向 KyrenPay 核实（reconcileOrder），
 * 绝不凭 successUrl 本身入账。
 */
export async function orderStatus(
  ctx: AppContext,
  userId: string,
  ref: string,
): Promise<PayOrderView> {
  const read = async () =>
    (
      await ctx.db.db
        .select()
        .from(payOrders)
        .where(and(eq(payOrders.ref, ref), eq(payOrders.userId, userId)))
    )[0];
  const order = await read();
  if (!order) throw new ApiError('not_found', '订单不存在');
  const client = kyrenClient(ctx);
  if (order.status === 'created' && order.kyrenCheckoutId && client) {
    await reconcileOrder(ctx, client, order);
    return toView((await read()) ?? order);
  }
  return toView(order);
}
