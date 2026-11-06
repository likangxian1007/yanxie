import { useMatches } from 'react-router';

/** 路由 handle 约定：各功能的 routes.tsx 在每条路由上写 `handle: { title: '文档' }` */
export interface RouteHandle {
  title?: string;
}

function titleOf(handle: unknown): string | undefined {
  if (handle && typeof handle === 'object' && 'title' in handle) {
    const { title } = handle as RouteHandle;
    if (typeof title === 'string' && title) return title;
  }
  return undefined;
}

/** 当前路由链上最深的一条标题（面包屑 / document.title 用）。 */
export function useRouteTitle(): string | undefined {
  const matches = useMatches();
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const title = titleOf(matches[i]?.handle);
    if (title) return title;
  }
  return undefined;
}
