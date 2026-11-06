/**
 * 计价（纯函数，单测覆盖）。全部整数运算，账本里不出现浮点。
 *
 * - 1 积分 = 0.001 美元零售价；零售价 = 成本 × 倍率
 * - 成本优先用上游返回的真实成本（OpenRouter usage.cost），否则按下表估算
 * - 表里没有的模型按最贵一档估（宁可多收一点，绝不亏钱）
 */

/** 每 100 万 token 的美元成本，按「千分之一美元」存整数（0.825 美元 → 825） */
interface PriceMilli {
  input: number;
  output: number;
}

/** key 为模型名（不含 provider 前缀，OpenRouter 的 vendor/ 前缀也去掉后匹配） */
export const FALLBACK_PRICES: Record<string, PriceMilli> = {
  'qwen3.7-plus': { input: 320, output: 1280 },
  'glm-5.3': { input: 70, output: 1400 },
  'kimi-k2.6': { input: 650, output: 3410 },
  'claude-sonnet-5.5': { input: 2000, output: 10000 },
  'gpt-5.6-terra': { input: 2000, output: 12000 },
  'gemini-3.8-flash': { input: 825, output: 4125 },
  'deepseek-flash': { input: 300, output: 1200 },
  'deepseek-v4-pro': { input: 1600, output: 3200 },
};

/** 未知模型的保守估价（取表里最贵的输入 / 输出） */
const UNKNOWN_PRICE: PriceMilli = { input: 2000, output: 12000 };

function ceilDiv(a: number, b: number): number {
  return Math.floor((a + b - 1) / b);
}

export function priceFor(model: string): PriceMilli {
  const bare = model.slice(model.lastIndexOf('/') + 1);
  return FALLBACK_PRICES[bare] ?? UNKNOWN_PRICE;
}

/** 估算成本（micro-USD，向上取整） */
export function estimateCostMicros(model: string, input: number, output: number): number {
  const p = priceFor(model);
  // tokens × (USD/1M) = micro-USD；价格是千分之一美元，所以再 /1000
  return ceilDiv(Math.max(0, input) * p.input + Math.max(0, output) * p.output, 1000);
}

/** 上游给的美元成本 → micro-USD（向上取整，防止浮点把 0.0000015 变 0） */
export function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.ceil(Math.round(usd * 1e9) / 1000);
}

/** 倍率按千分位整数参与运算（1.6 → 1600） */
export function markupMilli(markup: number): number {
  return Math.max(1000, Math.round(markup * 1000));
}

/**
 * 零售积分 = ceil(cost_usd × markup × 1000) = ceil(micros × markupMilli / 1e6)。
 * 有 token 用量时最少 1 积分。
 */
export function creditsFor(costMicros: number, markup: number, tokens: number): number {
  const credits = ceilDiv(Math.max(0, costMicros) * markupMilli(markup), 1_000_000);
  return tokens > 0 ? Math.max(1, credits) : credits;
}

/** 每 100 万 token 的零售积分（价目表展示用）：USD/1M × markup × 1000 */
export function creditsPerMillion(priceMilli: number, markup: number): number {
  return ceilDiv(priceMilli * markupMilli(markup), 1000);
}

/** 充值包：价格（美元字符串）与到账积分 */
export const TOPUP_PACKS = [
  { sku: 'credits-5', price: '5.00', currency: 'USD', credits: 5_000 },
  { sku: 'credits-10', price: '10.00', currency: 'USD', credits: 10_500 },
  { sku: 'credits-30', price: '30.00', currency: 'USD', credits: 33_000 },
] as const;
export type TopupPackDef = (typeof TOPUP_PACKS)[number];
