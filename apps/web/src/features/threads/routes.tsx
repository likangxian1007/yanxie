import type { RouteObject } from 'react-router';
import { tr } from '@/lib/i18n';

const loadThreadsPage = () =>
  import('./pages/ThreadsPage').then((m) => ({ Component: m.ThreadsPage }));
const loadThreadDetailPage = () =>
  import('./pages/ThreadDetailPage').then((m) => ({ Component: m.ThreadDetailPage }));

/** 页面逐个按需加载，列表不会下载详情编辑器或阅读器。 */
export const threadsRoutes: RouteObject[] = [
  { path: 'threads', lazy: loadThreadsPage, handle: { title: tr('线程') } },
  { path: 'threads/:threadId', lazy: loadThreadDetailPage, handle: { title: tr('线程详情') } },
];
