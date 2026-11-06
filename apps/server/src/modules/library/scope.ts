import { and, eq, isNull, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { ApiError } from '@srh/shared';

/** 个人归属只能来自已认证会话；字符串保留现有项目服务调用的兼容性。 */
export type LibraryScope =
  { kind: 'project'; projectId: string } | { kind: 'personal'; ownerUserId: string };
export type LibraryScopeInput = LibraryScope | string;

export function libraryScope(value: LibraryScopeInput): LibraryScope {
  return typeof value === 'string' ? { kind: 'project', projectId: value } : value;
}

export function scopeKey(value: LibraryScopeInput): string {
  const scope = libraryScope(value);
  return scope.kind === 'project' ? `project:${scope.projectId}` : `personal:${scope.ownerUserId}`;
}

export function scopeValues(value: LibraryScopeInput) {
  const scope = libraryScope(value);
  return scope.kind === 'project'
    ? { projectId: scope.projectId, ownerUserId: null }
    : { projectId: null, ownerUserId: scope.ownerUserId };
}

export function scopeOf(row: {
  projectId: string | null;
  ownerUserId: string | null;
}): LibraryScope {
  if (row.projectId) return { kind: 'project', projectId: row.projectId };
  if (row.ownerUserId && !row.projectId) return { kind: 'personal', ownerUserId: row.ownerUserId };
  throw new ApiError('not_found', '文献归属无效');
}

export function scopeWhere(
  table: { projectId: AnyPgColumn; ownerUserId: AnyPgColumn },
  value: LibraryScopeInput,
): SQL {
  const scope = libraryScope(value);
  return (
    scope.kind === 'project'
      ? eq(table.projectId, scope.projectId)
      : and(eq(table.ownerUserId, scope.ownerUserId), isNull(table.projectId))
  )!;
}
