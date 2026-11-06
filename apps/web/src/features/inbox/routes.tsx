import type { RouteObject } from 'react-router';
import { tr } from '@/lib/i18n';

const loadInboxPage = () => import('./pages/InboxPage').then((m) => ({ Component: m.InboxPage }));

/** 页面逐个按需加载，列表不会下载详情编辑器或阅读器。 */
export const inboxRoutes: RouteObject[] = [
  { path: 'inbox', lazy: loadInboxPage, handle: { title: tr('待我处理') } },
];
