import type { RouteObject } from 'react-router';
import { tr } from '@/lib/i18n';

const loadHelpPage = () => import('./pages/HelpPage').then((m) => ({ Component: m.HelpPage }));

/** 页面逐个按需加载，列表不会下载详情编辑器或阅读器。 */
export const helpRoutes: RouteObject[] = [
  { path: 'help', lazy: loadHelpPage, handle: { title: tr('帮助中心') } },
];
