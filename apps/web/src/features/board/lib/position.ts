import { generateKeyBetween } from 'fractional-indexing';

/**
 * 分数位置（fractional index）字符串的本地工具。
 * 与服务端用同一个算法（`fractional-indexing` 的 generateKeyBetween，见
 * apps/server/src/modules/collab-common positionBetween / boards checkPosition），
 * 所以前端算出的位置可以直接发给服务端（例如新建列的 position），不会被 422。
 */

/** 按位置字符串（码元顺序，与服务端 COLLATE "C" 一致）比较，位置相同再按 id 稳定排序。 */
export function comparePosition(
  a: { position: string; id: string },
  b: { position: string; id: string },
): number {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export function sortByPosition<T extends { position: string; id: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort(comparePosition);
}

/** 这个字符串是不是服务端认可的位置（服务端校验 = generateKeyBetween(position, null) 不抛错）。 */
export function isValidPosition(position: string): boolean {
  try {
    generateKeyBetween(position, null);
    return true;
  } catch {
    return false;
  }
}

/**
 * 生成一个排在 a 与 b 之间的位置（a = null 表示最前，b = null 表示最后），结果严格满足 a < 结果 < b。
 * 输入不合法（比如历史数据或 a ≥ b）时尽量退化：先忽略 b 放到 a 之后，再不行从头生成。
 */
export function positionBetween(a: string | null, b: string | null): string {
  // generateKeyBetween 在 a ≥ b 时不一定抛错，先自己挡掉
  if (a === null || b === null || a < b) {
    try {
      return generateKeyBetween(a, b);
    } catch {
      // a、b 之一不合法
    }
  }
  if (a !== null && isValidPosition(a)) return generateKeyBetween(a, null);
  if (b !== null && isValidPosition(b)) return generateKeyBetween(null, b);
  return generateKeyBetween(null, null);
}
