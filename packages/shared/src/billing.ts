import { z } from 'zod';

/**
 * 按量计费与充值（API.md §2.24）。归属：modules/billing。
 *
 * 单位：积分（整数），1 积分 = 0.001 美元零售价。
 */

export const CreditKind = z.enum(['signup', 'usage', 'topup', 'refund', 'adjust', 'transfer']);
export type CreditKind = z.infer<typeof CreditKind>;

/** personal = 个人积分；team = 项目团队积分 */
export const CreditWallet = z.enum(['personal', 'team']);
export type CreditWallet = z.infer<typeof CreditWallet>;

export interface CreditLedgerEntry {
  id: string;
  delta: number;
  kind: CreditKind;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  projectId: string | null;
  note: string | null;
  createdAt: string;
  /** 变动的钱包（旧数据都是 personal） */
  wallet?: CreditWallet;
}

export interface TopupPack {
  sku: string;
  /** 十进制美元字符串，如 "5.00" */
  price: string;
  currency: string;
  credits: number;
}

export interface ModelPrice {
  /** `<providerId>/<model>` */
  modelId: string;
  name: string;
  /** 每 100 万 token 的积分（含倍率） */
  inputPerMillion: number;
  outputPerMillion: number;
}

/** GET /billing/me */
export interface BillingOverview {
  enabled: boolean;
  /** 管理员免扣费 */
  exempt: boolean;
  balance: number;
  /** 是否可以充值（服务器配了 KyrenPay） */
  topupEnabled: boolean;
  packs: TopupPack[];
  prices: ModelPrice[];
  recent: CreditLedgerEntry[];
  /** 我所在项目的团队积分（只列有余额、有上限或我能管理的项目） */
  teams?: TeamWalletSummary[];
}

/** 一个项目的团队积分（从「我」的角度） */
export interface TeamWalletSummary {
  projectId: string;
  projectName: string;
  /** 我是项目 owner / admin，可以转入、充值、设上限 */
  canManage: boolean;
  balance: number;
  /** 我本月用掉的团队积分 */
  monthUsed: number;
  /** 我每月可用的团队积分上限；null = 不限 */
  monthlyCap: number | null;
}

/** 成员本月用量（GET /billing/projects/:id，仅 owner / admin 可见） */
export interface TeamMemberUsage {
  userId: string;
  name: string;
  role: string;
  monthUsed: number;
  monthlyCap: number | null;
}

/** GET /billing/projects/:id —— 聊天框的余额提示也用它 */
export interface ProjectBillingView extends TeamWalletSummary {
  enabled: boolean;
  /** 管理员免扣费 */
  exempt: boolean;
  personalBalance: number;
  /** 在这个项目里下一次调用平台模型会扣哪个钱包 */
  source: CreditWallet;
  /** 仅 canManage 时返回 */
  members: TeamMemberUsage[] | null;
}

/** POST /billing/projects/:id/transfer：个人积分转入团队 */
export const CreditTransferInput = z.object({
  credits: z.number().int().min(1).max(10_000_000),
});
export type CreditTransferInput = z.infer<typeof CreditTransferInput>;

/** PUT /billing/projects/:id/members/:userId/cap；null = 不限 */
export const MemberCapInput = z.object({
  monthlyCap: z.number().int().min(0).max(100_000_000).nullable(),
});
export type MemberCapInput = z.infer<typeof MemberCapInput>;

/** GET /billing/projects/:id/turns?ids=… 每轮 agent 的积分消耗 */
export interface TurnCredits {
  turnId: string;
  credits: number;
  inputTokens: number;
  outputTokens: number;
}

export const TopupInput = z.object({
  sku: z.string().min(1).max(40),
  /** 充到哪；默认 personal。team 需要 projectId，且是项目 owner / admin */
  wallet: CreditWallet.optional(),
  projectId: z.string().min(1).max(64).optional(),
});
export type TopupInput = z.infer<typeof TopupInput>;

export interface TopupCheckout {
  ref: string;
  url: string;
}

export const PayOrderStatus = z.enum(['created', 'paid', 'refunded', 'failed']);
export type PayOrderStatus = z.infer<typeof PayOrderStatus>;

export interface PayOrderView {
  ref: string;
  sku: string;
  credits: number;
  status: PayOrderStatus;
  createdAt: string;
  paidAt: string | null;
  wallet?: CreditWallet;
  projectId?: string | null;
}

export const CreditAdjustInput = z.object({
  userId: z.string().min(1),
  delta: z.number().int().min(-10_000_000).max(10_000_000),
  note: z.string().max(200).optional(),
});
export type CreditAdjustInput = z.infer<typeof CreditAdjustInput>;
