import { tr } from '@/lib/i18n';
/**
 * 8 色色板（STYLE §1.2）：头像、项目、标签、看板列。序号 0–7 存在数据里。
 * 头像 = 实心色 + 白色首字；标签/列头 = 14% 色底 + 原色文字（paletteSoft）。
 */

export const PALETTE_SIZE = 8;

/** 0 紫 · 1 靛 · 2 蓝 · 3 青 · 4 绿 · 5 橙 · 6 玫红 · 7 石板灰 */
export const PALETTE_NAMES = [
  tr('紫'),
  tr('靛'),
  tr('蓝'),
  tr('青'),
  tr('绿'),
  tr('橙'),
  tr('玫红'),
  tr('石板灰'),
] as const;

/** 把任意数字规整到 0–7。 */
export function paletteIndex(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const i = Math.trunc(n) % PALETTE_SIZE;
  return i < 0 ? i + PALETTE_SIZE : i;
}

/** 实心色：`var(--palette-n)` */
export function paletteVar(n: number): string {
  return `var(--palette-${paletteIndex(n)})`;
}

/** 柔和底色：14% 色板色叠在透明上 */
export function paletteSoft(n: number): string {
  return `color-mix(in oklab, ${paletteVar(n)} 14%, transparent)`;
}

/** 没有存色号时，按字符串（id / 名字）稳定地取一个色。 */
export function paletteFromString(seed: string): number {
  // FNV-1a + 末尾混洗：短中文标签（「实验」「数据」「汇报」）也能分到不同颜色；
  // 简单的 *31 累加对两个汉字的组合几乎总落在同一格。
  let hash = 0x811c9dc5;
  for (const ch of seed) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x45d9f3b);
  hash ^= hash >>> 16;
  return paletteIndex(hash >>> 0);
}

const HAN = /\p{Script=Han}/u;

/**
 * 头像首字：中文名取最后一个汉字（“张三” → “三”），其他取首字母大写（“alice” → “A”）。
 */
export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const chars = Array.from(trimmed);
  if (HAN.test(trimmed)) {
    for (let i = chars.length - 1; i >= 0; i -= 1) {
      const ch = chars[i];
      if (ch && HAN.test(ch)) return ch;
    }
  }
  const first = chars.find((ch) => /[\p{L}\p{N}]/u.test(ch)) ?? chars[0] ?? '?';
  return first.toUpperCase();
}
