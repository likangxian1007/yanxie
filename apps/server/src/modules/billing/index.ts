import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  ApiError,
  CreditAdjustInput,
  CreditTransferInput,
  MemberCapInput,
  TopupInput,
  newId,
  type BillingOverview,
  type ModelPrice,
  type PayOrderView,
  type ProjectBillingView,
  type ProjectRole,
  type TeamMemberUsage,
  type TeamWalletSummary,
  type TopupCheckout,
  type TurnCredits,
} from '@srh/shared';
import type { AppContext } from '../../context';
import {
  creditLedger,
  projectCreditBalances,
  projectCreditCaps,
  projectMembers,
  projects,
  users,
} from '../../db/schema';
import { parse } from '../../lib/http';
import { envProviders } from '../../agents/llm/registry';
import { can, requireProject, requireUser } from '../auth/guard';
import { requireAdminUser } from '../feedback';
import type { ModuleDef } from '../types';
import { verifyWebhook } from './kyren';
import { TOPUP_PACKS, creditsPerMillion, priceFor } from './pricing';
import {
  applyLedger,
  getBalance,
  getTeamBalance,
  isBillingExempt,
  memberCap,
  recentLedger,
  resolveWallet,
  teamMonthUsage,
  transferToTeam,
} from './service';
import { createTopup, orderStatus, processEvent, reconcileOpenOrders, topupEnabled } from './topup';

const RECONCILE_INTERVAL_MS = 2 * 60 * 1000;

/**
 * 按量计费与充值（API.md §2.24）
 *
 *   GET  /billing/me                  余额、充值包、价目、最近流水
 *   POST /billing/topup {sku,wallet?,projectId?}  建 KyrenPay 收银台，返回 {ref,url}
 *   GET  /billing/projects/:id        团队积分 + 我会扣哪个钱包（成员）；成员用量（owner/advisor）
 *   POST /billing/projects/:id/transfer {credits}           个人积分转入团队（owner/advisor）
 *   PUT  /billing/projects/:id/members/:userId/cap {monthlyCap}  成员月上限（owner/advisor）
 *   GET  /billing/projects/:id/turns?ids=a,b                每轮 agent 消耗的积分
 *   GET  /billing/orders/:ref         成功页查单（只给下单本人；必要时向 KyrenPay 核实后入账）
 *   POST /billing/kyren-webhook       KyrenPay 回调（不登录，验签；需要原始请求体）
 *   POST /admin/credits {userId,delta,note?}  管理员手动调整
 */

/** 我所在项目的团队积分：有余额、有上限，或我能管理的项目 */
async function teamWallets(ctx: AppContext, userId: string): Promise<TeamWalletSummary[]> {
  const rows = await ctx.db.db
    .select({
      projectId: projects.id,
      projectName: projects.name,
      role: projectMembers.role,
      balance: projectCreditBalances.balance,
      cap: projectCreditCaps.monthlyCap,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .leftJoin(projectCreditBalances, eq(projectCreditBalances.projectId, projects.id))
    .leftJoin(
      projectCreditCaps,
      and(eq(projectCreditCaps.projectId, projects.id), eq(projectCreditCaps.userId, userId)),
    )
    .where(and(eq(projectMembers.userId, userId), isNull(projects.archivedAt)))
    .orderBy(asc(projects.name));
  const out: TeamWalletSummary[] = [];
  for (const r of rows) {
    const canManage = can(r.role, 'manage');
    const balance = Number(r.balance ?? 0);
    if (!canManage && balance === 0 && r.cap === null) continue;
    const used = (await teamMonthUsage(ctx, r.projectId, userId)).get(userId) ?? 0;
    out.push({
      projectId: r.projectId,
      projectName: r.projectName,
      canManage,
      balance,
      monthUsed: used,
      monthlyCap: r.cap === null ? null : Number(r.cap),
    });
  }
  return out;
}

async function projectBilling(
  ctx: AppContext,
  userId: string,
  project: { id: string; name: string },
  role: ProjectRole,
): Promise<ProjectBillingView> {
  const canManage = can(role, 'manage');
  const [personalBalance, exempt, balance, usage, cap, choice] = await Promise.all([
    getBalance(ctx, userId),
    isBillingExempt(ctx, userId),
    getTeamBalance(ctx, project.id),
    teamMonthUsage(ctx, project.id),
    memberCap(ctx, project.id, userId),
    resolveWallet(ctx, { payerUserId: userId, projectId: project.id }),
  ]);
  let members: TeamMemberUsage[] | null = null;
  if (canManage) {
    const rows = await ctx.db.db
      .select({
        userId: projectMembers.userId,
        name: users.name,
        role: projectMembers.role,
        cap: projectCreditCaps.monthlyCap,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .leftJoin(
        projectCreditCaps,
        and(
          eq(projectCreditCaps.projectId, projectMembers.projectId),
          eq(projectCreditCaps.userId, projectMembers.userId),
        ),
      )
      .where(eq(projectMembers.projectId, project.id))
      .orderBy(asc(projectMembers.joinedAt));
    members = rows.map((r) => ({
      userId: r.userId,
      name: r.name,
      role: r.role,
      monthUsed: usage.get(r.userId) ?? 0,
      monthlyCap: r.cap === null ? null : Number(r.cap),
    }));
  }
  return {
    enabled: ctx.config.BILLING_ENABLED,
    exempt,
    projectId: project.id,
    projectName: project.name,
    canManage,
    balance,
    monthUsed: usage.get(userId) ?? 0,
    monthlyCap: cap,
    personalBalance,
    source: choice?.wallet ?? 'personal',
    members,
  };
}

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
      const [balance, exempt, recent, teams] = await Promise.all([
        getBalance(ctx, user.id),
        isBillingExempt(ctx, user.id),
        recentLedger(ctx, user.id, 50),
        teamWallets(ctx, user.id),
      ]);
      return {
        teams,
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
      const input = parse(TopupInput, req.body);
      if (input.wallet === 'team') {
        if (!input.projectId) throw new ApiError('validation_failed', '为团队充值要指定项目');
        await requireProject(req, input.projectId, 'manage');
        return createTopup(ctx, user, input.sku, { projectId: input.projectId });
      }
      return createTopup(ctx, user, input.sku);
    });

    app.get<{ Params: { id: string } }>(
      '/billing/projects/:id',
      async (req): Promise<ProjectBillingView> => {
        const access = await requireProject(req, req.params.id, 'view');
        return projectBilling(ctx, access.user.id, access.project, access.role);
      },
    );

    app.post<{ Params: { id: string } }>('/billing/projects/:id/transfer', async (req) => {
      const access = await requireProject(req, req.params.id, 'manage');
      const { credits } = parse(CreditTransferInput, req.body);
      return transferToTeam(ctx, {
        userId: access.user.id,
        projectId: access.project.id,
        credits,
        ref: `transfer:${newId('credit')}`,
      });
    });

    app.put<{ Params: { id: string; userId: string } }>(
      '/billing/projects/:id/members/:userId/cap',
      async (req) => {
        const access = await requireProject(req, req.params.id, 'manage');
        const { monthlyCap } = parse(MemberCapInput, req.body);
        const [member] = await ctx.db.db
          .select({ userId: projectMembers.userId })
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.projectId, access.project.id),
              eq(projectMembers.userId, req.params.userId),
            ),
          );
        if (!member) throw new ApiError('not_found', '这个人不是项目成员');
        if (monthlyCap === null) {
          await ctx.db.db
            .delete(projectCreditCaps)
            .where(
              and(
                eq(projectCreditCaps.projectId, access.project.id),
                eq(projectCreditCaps.userId, member.userId),
              ),
            );
        } else {
          await ctx.db.db
            .insert(projectCreditCaps)
            .values({ projectId: access.project.id, userId: member.userId, monthlyCap })
            .onConflictDoUpdate({
              target: [projectCreditCaps.projectId, projectCreditCaps.userId],
              set: { monthlyCap, updatedAt: new Date() },
            });
        }
        return { userId: member.userId, monthlyCap };
      },
    );

    app.get<{ Params: { id: string }; Querystring: { ids?: string } }>(
      '/billing/projects/:id/turns',
      async (req): Promise<TurnCredits[]> => {
        const access = await requireProject(req, req.params.id, 'view');
        const ids = (req.query.ids ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 100);
        if (!ids.length) return [];
        const rows = await ctx.db.db
          .select({
            turnId: creditLedger.turnRef,
            credits: sql<string>`coalesce(sum(-${creditLedger.delta}), 0)`,
            inputTokens: sql<string>`coalesce(sum(${creditLedger.inputTokens}), 0)`,
            outputTokens: sql<string>`coalesce(sum(${creditLedger.outputTokens}), 0)`,
          })
          .from(creditLedger)
          .where(
            and(
              eq(creditLedger.projectId, access.project.id),
              eq(creditLedger.kind, 'usage'),
              inArray(creditLedger.turnRef, ids),
            ),
          )
          .groupBy(creditLedger.turnRef);
        return rows.map((r) => ({
          turnId: r.turnId!,
          credits: Number(r.credits),
          inputTokens: Number(r.inputTokens),
          outputTokens: Number(r.outputTokens),
        }));
      },
    );

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
