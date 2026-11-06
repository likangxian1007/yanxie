import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * 分数位置（fractional-indexing）键必须按字节序比较；数据库的默认排序规则（如 en_US）
 * 会忽略大小写，排出来的顺序不对。排序与比较一律走 COLLATE "C"。boards 与 todos 共用。
 */
export function posKey(col: AnyPgColumn): SQL {
  return sql`${col} collate "C"`;
}

/** col > value（字节序） */
export function posAfter(col: AnyPgColumn, value: string): SQL {
  return sql`${col} collate "C" > ${value}`;
}

/** 与 COLLATE "C" 一致的 JS 比较 */
export function comparePos(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
