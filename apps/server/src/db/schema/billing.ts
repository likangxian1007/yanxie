/**
 * 计费与充值表（feat/models-billing）。归属：`modules/billing`。
 *
 * - `credit_balances`：每人一行余额（积分，1 积分 = 0.001 美元零售价）
 * - `credit_ledger`：积分流水，余额变动与流水在同一事务里写；`ref` 唯一，保证幂等
 *   （signup:<userId> / topup:<orderRef> / refund:<refundId> / usage 行 ref 为空）
 * - `kyren_products`：KyrenPay 商品（每个充值包一个，懒创建，绝不按次创建）
 * - `pay_orders`：充值订单；只有验签通过、金额币种商品全对上的 order.paid 才入账
 * - `kyren_events`：已处理的 webhook 事件 id（去重）
 *
 * 金额一律整数：积分 bigint、美元成本按 micro-USD（百万分之一美元）、订单金额按分。
 */
import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './_helpers';
import { projects, users } from './core';

export type CreditKind = 'signup' | 'usage' | 'topup' | 'refund' | 'adjust' | 'transfer';
export type PayOrderStatus = 'created' | 'paid' | 'refunded' | 'failed';
/** personal = 用户个人余额；team = 项目团队余额（project_credit_balances） */
export type CreditWallet = 'personal' | 'team';

export const creditBalances = pgTable('credit_balances', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  balance: bigint('balance', { mode: 'number' }).notNull().default(0),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 正数入账，负数扣费 */
    delta: bigint('delta', { mode: 'number' }).notNull(),
    kind: text('kind').$type<CreditKind>().notNull(),
    /** 幂等键；同一个 ref 只能记一次 */
    ref: text('ref'),
    /** 用量行：`<providerId>/<model>` */
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** 上游成本，micro-USD */
    costUsdMicros: bigint('cost_usd_micros', { mode: 'number' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    /** 来源说明（agent / library / docs …），仅展示 */
    note: text('note'),
    /**
     * 变动的是哪个钱包：personal = user_id 的个人余额；team = project_id 的团队余额
     * （team 行的 user_id 是付款成员 / 充值人，用来算成员本月用量）
     */
    wallet: text('wallet').$type<CreditWallet>().notNull().default('personal'),
    /** agent 一轮的 turnId（用量行），用于「这一轮消耗 N 积分」 */
    turnRef: text('turn_ref'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('credit_ledger_ref_uq').on(t.ref),
    index('credit_ledger_user_idx').on(t.userId, t.createdAt),
    index('credit_ledger_project_idx').on(t.projectId, t.wallet, t.createdAt),
    index('credit_ledger_turn_idx').on(t.turnRef),
  ],
);

/** 项目团队余额：成员在项目里用平台模型时优先扣这里 */
export const projectCreditBalances = pgTable('project_credit_balances', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  balance: bigint('balance', { mode: 'number' }).notNull().default(0),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** 成员每月可用的团队积分上限（没有行 = 不限） */
export const projectCreditCaps = pgTable(
  'project_credit_caps',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    monthlyCap: bigint('monthly_cap', { mode: 'number' }).notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);

export const kyrenProducts = pgTable('kyren_products', {
  sku: text('sku').primaryKey(),
  productId: text('product_id').notNull(),
  /** 十进制美元字符串，如 "5.00" */
  price: text('price').notNull(),
  currency: text('currency').notNull(),
  createdAt: createdAt(),
});

export const payOrders = pgTable(
  'pay_orders',
  {
    id: id(),
    ref: text('ref').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    credits: bigint('credits', { mode: 'number' }).notNull(),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull(),
    productId: text('product_id').notNull(),
    status: text('status').$type<PayOrderStatus>().notNull().default('created'),
    kyrenCheckoutId: text('kyren_checkout_id'),
    kyrenOrderId: text('kyren_order_id'),
    /** 对不上账等需要人工复核的原因 */
    reviewNote: text('review_note'),
    /** 充到哪：personal = 下单人；team = project_id 的团队余额 */
    wallet: text('wallet').$type<CreditWallet>().notNull().default('personal'),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    paidAt: ts('paid_at'),
  },
  (t) => [
    uniqueIndex('pay_orders_ref_uq').on(t.ref),
    index('pay_orders_user_idx').on(t.userId, t.createdAt),
  ],
);

export const kyrenEvents = pgTable('kyren_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: createdAt(),
});
