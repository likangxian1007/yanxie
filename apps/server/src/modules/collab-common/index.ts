/**
 * 协作模块（documents、boards、todos、experiments、reviews、reports）共用的小工具。
 * 归属：协作功能线程。不是业务模块，不在 modules/index.ts 登记。
 */
import { generateKeyBetween } from 'fractional-indexing';
import { ApiError, type ActorRef } from '@srh/shared';

export * from './guard';
export * from './links';

export type Params<K extends string> = { [P in K]: string };

/** 在 a、b 之间生成排序键（a/b 为 null 表示开头/末尾）。 */
export function positionBetween(
  a: string | null | undefined,
  b: string | null | undefined,
): string {
  return generateKeyBetween(a ?? null, b ?? null);
}

/** 乐观并发：baseVersion 与当前版本不一致时抛 409 version_conflict，details.current 为最新对象。 */
export function assertVersion(current: { version: number }, baseVersion: number, dto: unknown) {
  if (current.version !== baseVersion) {
    throw new ApiError('version_conflict', '内容已被他人修改，已为你载入最新版本', {
      current: dto,
    });
  }
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
export const isoReq = (d: Date): string => d.toISOString();

/** 解析 ISO 时间字符串；非法时抛 422。 */
export function parseDate(value: string | null | undefined, field = '时间'): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ApiError('validation_failed', `${field}格式不对`, {
      issues: [{ path: field, message: '应为 ISO 8601 时间' }],
    });
  }
  return d;
}

export const SYSTEM_ACTOR: ActorRef = { kind: 'system', id: null, name: '研协' };

export function notFound(what: string): never {
  throw new ApiError('not_found', `${what}不存在，可能已被删除`);
}
