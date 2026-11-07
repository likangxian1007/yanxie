import { locale } from '@/lib/i18n';

/** 积分显示：整数，千分位 */
export function formatCredits(n: number): string {
  return n.toLocaleString(locale());
}

/** 积分折合美元（1 积分 = 0.001 美元） */
export function creditsToUsd(n: number): string {
  return `$${(n / 1000).toFixed(2)}`;
}

/** 余额低于这个数时在聊天框里用警示色 */
export const LOW_CREDITS = 200;
