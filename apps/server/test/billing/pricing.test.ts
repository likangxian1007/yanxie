import { describe, expect, it } from 'vitest';
import {
  creditsFor,
  creditsPerMillion,
  estimateCostMicros,
  priceFor,
  TOPUP_PACKS,
  usdToMicros,
} from '../../src/modules/billing/pricing';
import { dollarsToCents } from '../../src/modules/billing/kyren';

/** 计价：整数运算、向上取整、最少 1 积分 */

describe('pricing', () => {
  it('按模型名匹配兜底价（忽略 vendor/ 前缀），未知模型按最贵一档', () => {
    expect(priceFor('qwen/qwen3.7-plus')).toEqual({ input: 320, output: 1280 });
    expect(priceFor('deepseek-v4-pro')).toEqual({ input: 1600, output: 3200 });
    expect(priceFor('someone/new-model')).toEqual({ input: 2000, output: 12000 });
  });

  it('估算成本：tokens × 美元/百万 → micro-USD，向上取整', () => {
    // 1000×0.32 + 1000×1.28 = 1600 micro-USD
    expect(estimateCostMicros('qwen/qwen3.7-plus', 1000, 1000)).toBe(1600);
    // 1 个输入 token × 0.07 美元/百万 = 0.07 micro → 1
    expect(estimateCostMicros('z-ai/glm-5.3', 1, 0)).toBe(1);
    expect(estimateCostMicros('z-ai/glm-5.3', 0, 0)).toBe(0);
  });

  it('零售积分 = ceil(成本 × 倍率 × 1000)，有用量最少 1 积分', () => {
    // 0.0016 美元 × 1.6 = 0.00256 美元 = 2.56 积分 → 3
    expect(creditsFor(1600, 1.6, 2000)).toBe(3);
    // 正好整除不多收
    expect(creditsFor(10_000, 1.6, 100)).toBe(16);
    expect(creditsFor(1, 1.6, 10)).toBe(1);
    expect(creditsFor(0, 1.6, 10)).toBe(1);
    expect(creditsFor(0, 1.6, 0)).toBe(0);
    // 倍率不会低于 1（绝不按成本以下收费）
    expect(creditsFor(10_000, 0.5, 100)).toBe(10);
  });

  it('上游美元成本转 micro-USD：避开浮点误差并向上取整', () => {
    expect(usdToMicros(0.001234)).toBe(1234);
    expect(usdToMicros(0.0000015)).toBe(2);
    expect(usdToMicros(0.1 + 0.2)).toBe(300_000);
    expect(usdToMicros(0)).toBe(0);
    expect(usdToMicros(-1)).toBe(0);
    expect(usdToMicros(Number.NaN)).toBe(0);
  });

  it('价目表：每百万 tokens 的零售积分', () => {
    // claude-sonnet-5.5 输出 10 美元/百万 × 1.6 = 16 美元 = 16000 积分
    expect(creditsPerMillion(priceFor('anthropic/claude-sonnet-5.5').output, 1.6)).toBe(16_000);
    expect(creditsPerMillion(priceFor('google/gemini-3.8-flash').input, 1.6)).toBe(1320);
  });

  it('充值包与金额换算', () => {
    expect(TOPUP_PACKS.map((p) => [p.price, p.credits])).toEqual([
      ['5.00', 5000],
      ['10.00', 10_500],
      ['30.00', 33_000],
    ]);
    expect(dollarsToCents('5')).toBe(500);
    expect(dollarsToCents('9.9')).toBe(990);
    expect(dollarsToCents('10.05')).toBe(1005);
    expect(() => dollarsToCents('1.234')).toThrow();
    expect(() => dollarsToCents('-5')).toThrow();
  });
});
