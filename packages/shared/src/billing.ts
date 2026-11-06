import { z } from 'zod';

/**
 * 按量计费与充值（API.md §2.24）。归属：modules/billing。
 *
 * 单位：积分（整数），1 积分 = 0.001 美元零售价。
 */

export const CreditKind = z.enum(['signup', 'usage', 'topup', 'refund', 'adjust']);
export type CreditKind = z.infer<typeof CreditKind>;

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
}

export const TopupInput = z.object({ sku: z.string().min(1).max(40) });
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
}

export const CreditAdjustInput = z.object({
  userId: z.string().min(1),
  delta: z.number().int().min(-10_000_000).max(10_000_000),
  note: z.string().max(200).optional(),
});
export type CreditAdjustInput = z.infer<typeof CreditAdjustInput>;
