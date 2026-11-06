import { eq } from 'drizzle-orm';
import {
  ApiError,
  CreditAdjustInput,
  TopupInput,
  newId,
  type BillingOverview,
  type ModelPrice,
  type PayOrderView,
  type TopupCheckout,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { users } from '../../db/schema';
import { parse } from '../../lib/http';
import { envProviders } from '../../agents/llm/registry';
import { requireUser } from '../auth/guard';
import { requireAdminUser } from '../feedback';
import type { ModuleDef } from '../types';
import { verifyWebhook } from './kyren';
import { TOPUP_PACKS, creditsPerMillion, priceFor } from './pricing';
import { applyLedger, getBalance, isBillingExempt, recentLedger } from './service';
import { createTopup, orderStatus, processEvent, reconcileOpenOrders, topupEnabled } from './topup';

const RECONCILE_INTERVAL_MS = 2 * 60 * 1000;

/**
 * 按量计费与充值（API.md §2.24）
 *
 *   GET  /billing/me                  余额、充值包、价目、最近流水
 *   POST /billing/topup {sku}         建 KyrenPay 收银台，返回 {ref,url}
 *   GET  /billing/orders/:ref         成功页查单（只给下单本人；必要时向 KyrenPay 核实后入账）
 *   POST /billing/kyren-webhook       KyrenPay 回调（不登录，验签；需要原始请求体）
 *   POST /admin/credits {userId,delta,note?}  管理员手动调整
 */

function modelPrices(ctx: AppContext): ModelPrice[] {
  const markup = ctx.config.BILLING_MARKUP;
  return envProviders(ctx.config)
    .filter((p) => p.id === 'deepseek' || p.id === 'openrouter')
    .flatMap((p) =>
      p.models.map((m) => {
        const price = priceFor(m.model);
        return {
          modelId: `${p.id}/${m.model}`,
          name: m.name,
          inputPerMillion: creditsPerMillion(price.input, markup),
          outputPerMillion: creditsPerMillion(price.output, markup),
        };
      }),
    );
}

export const billingModule: ModuleDef = {
  name: 'billing',
  owner: 'backend',
  async register(app) {
    const ctx = app.ctx;

    app.get('/billing/me', async (req): Promise<BillingOverview> => {
      const user = await requireUser(req);
      const [balance, exempt, recent] = await Promise.all([
        getBalance(ctx, user.id),
        isBillingExempt(ctx, user.id),
        recentLedger(ctx, user.id, 50),
      ]);
      return {
        enabled: ctx.config.BILLING_ENABLED,
        exempt,
        balance,
        topupEnabled: topupEnabled(ctx),
        packs: TOPUP_PACKS.map((p) => ({ ...p })),
        prices: modelPrices(ctx),
        recent,
      };
    });

    app.post('/billing/topup', async (req): Promise<TopupCheckout> => {
      const user = await requireUser(req);
      const { sku } = parse(TopupInput, req.body);
      return createTopup(ctx, user, sku);
    });

    app.get<{ Params: { ref: string } }>(
      '/billing/orders/:ref',
      async (req): Promise<PayOrderView> => {
        const user = await requireUser(req);
        return orderStatus(ctx, user.id, req.params.ref);
      },
    );

    app.post('/admin/credits', async (req) => {
      await requireAdminUser(req);
      const input = parse(CreditAdjustInput, req.body);
      const [target] = await ctx.db.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.userId));
      if (!target) throw new ApiError('not_found', '用户不存在');
      await applyLedger(ctx, {
        userId: target.id,
        delta: input.delta,
        kind: 'adjust',
        ref: `adjust:${newId('credit')}`,
        note: input.note ?? null,
      });
      return { userId: target.id, balance: await getBalance(ctx, target.id) };
    });

    // 对账：webhook 未必收得到、用户也未必回成功页，每 2 分钟向 KyrenPay 核实一遍未完成的订单
    let reconciling = false;
    const reconcileTimer = setInterval(() => {
      if (reconciling) return;
      reconciling = true;
      void reconcileOpenOrders(ctx)
        .catch((err: unknown) => app.log.error(err))
        .finally(() => {
          reconciling = false;
        });
    }, RECONCILE_INTERVAL_MS);
    reconcileTimer.unref();
    app.addHook('onClose', async () => {
      clearInterval(reconcileTimer);
    });

    // webhook 要原始字节验签：在封装的子作用域里把 JSON 解析成字符串，不影响其他路由
    await app.register(async (hook) => {
      hook.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
        done(null, body),
      );
      hook.post('/billing/kyren-webhook', async (req, reply) => {
        const raw = typeof req.body === 'string' ? req.body : '';
        let event;
        try {
          event = verifyWebhook(ctx.config.KYREN_WEBHOOK_SECRET, raw, req.headers);
        } catch (err) {
          console.error('[billing] kyren webhook 验签失败', (err as Error).message);
          return reply.code(400).send({ error: 'bad signature' }); // i18n-ignore
        }
        // 处理完、写库成功后才回 2xx；出错让 Kyren 重投（入账靠 ref 幂等）
        const fresh = await processEvent(ctx, event);
        return { received: true, duplicate: !fresh };
      });
    });
  },
};
