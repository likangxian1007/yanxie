/** 项目调用继续使用项目 ID；个人范围显式携带账号 ID，仅用于隔离浏览器缓存。 */
export type PersonalLibrary = { kind: 'personal'; userId: string };
export type LibraryScope = string | PersonalLibrary;

export const isPersonalLibrary = (scope: LibraryScope): scope is PersonalLibrary =>
  typeof scope !== 'string';

export const libraryEnabled = (scope: LibraryScope) =>
  Boolean(isPersonalLibrary(scope) ? scope.userId : scope);

/** 个人接口由服务器从登录会话识别所有者，URL 不接受用户 ID。 */
export const libraryBase = (scope: LibraryScope) =>
  isPersonalLibrary(scope) ? '/library' : `/projects/${scope}/library`;

export const libraryKey = (scope: LibraryScope) =>
  isPersonalLibrary(scope)
    ? (['u', scope.userId, 'library'] as const)
    : (['p', scope, 'library'] as const);

export function libraryPath(scope: LibraryScope, paperId?: string) {
  const root = isPersonalLibrary(scope) ? '/library' : `/p/${scope}/library`;
  return paperId ? `${root}/${encodeURIComponent(paperId)}` : root;
}

export function paperHref(scope: LibraryScope, paperId: string, returnTo: string, seq?: number) {
  const params = new URLSearchParams({ returnTo });
  if (seq !== undefined) params.set('seq', String(seq));
  return `${libraryPath(scope, paperId)}?${params}`;
}
