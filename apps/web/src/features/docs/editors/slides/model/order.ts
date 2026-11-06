import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

/**
 * 分数排序键（fractional-indexing）：页的 `order`、元素的 `z`。
 * 移动 = 只改这一项的键，所以拖动换页不会删除重建，别人同时在这页里的编辑不受影响。
 * 两人同时在同一位置插入可能得到相同的键：排序时再按 id 比较，结果在各端一致。
 */

export function cmpKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isKey(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * 在已排序的键列表里，取位置 index 之前插入用的新键（index = keys.length 表示末尾）。
 * 相邻键相等（并发插入造成）时向后找第一个更大的键作为上界。
 */
export function keyAt(keys: readonly string[], index: number): string {
  const lower = index > 0 ? (keys[index - 1] ?? null) : null;
  let upper: string | null = null;
  for (let i = index; i < keys.length; i += 1) {
    const k = keys[i]!;
    if (lower === null || k > lower) {
      upper = k;
      break;
    }
  }
  try {
    return generateKeyBetween(lower, upper);
  } catch {
    return generateKeyBetween(lower, null);
  }
}

/** 在 index 处连续插入 n 个键 */
export function keysAt(keys: readonly string[], index: number, n: number): string[] {
  if (n <= 0) return [];
  const lower = index > 0 ? (keys[index - 1] ?? null) : null;
  let upper: string | null = null;
  for (let i = index; i < keys.length; i += 1) {
    const k = keys[i]!;
    if (lower === null || k > lower) {
      upper = k;
      break;
    }
  }
  try {
    return generateNKeysBetween(lower, upper, n);
  } catch {
    return generateNKeysBetween(lower, null, n);
  }
}

/** 给 n 项生成一组从头开始的均匀键（迁移旧数据时用；同样的 n 得到同样的键，并发迁移结果一致） */
export function initialKeys(n: number): string[] {
  return n > 0 ? generateNKeysBetween(null, null, n) : [];
}
