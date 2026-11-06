import type { RouteObject } from 'react-router';
import { tr } from '@/lib/i18n';

const loadCoordinatorPage = () =>
  import('./pages/CoordinatorPage').then((m) => ({ Component: m.CoordinatorPage }));

/** 页面逐个按需加载，列表不会下载详情编辑器或阅读器。 */
export const coordinatorRoutes: RouteObject[] = [
  { index: true, lazy: loadCoordinatorPage, handle: { title: tr('协作台') } },
];
