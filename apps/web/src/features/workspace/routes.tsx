import type { RouteObject } from 'react-router';
import { tr } from '@/lib/i18n';

const loadWorkspacePage = () =>
  import('./pages/WorkspacePage').then((m) => ({ Component: m.WorkspacePage }));

/** 页面逐个按需加载，列表不会下载详情编辑器或阅读器。 */
export const workspaceRoutes: RouteObject[] = [
  { path: 'workspace', lazy: loadWorkspacePage, handle: { title: tr('我的工作区') } },
  { path: 'workspace/:threadId', lazy: loadWorkspacePage, handle: { title: tr('我的工作区') } },
];
