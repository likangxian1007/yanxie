import type { RouteObject } from 'react-router';
import { tr } from '@/lib/i18n';

const loadSettingsPage = () =>
  import('./pages/SettingsPage').then((m) => ({ Component: m.SettingsPage }));

/** 页面逐个按需加载，列表不会下载详情编辑器或阅读器。 */
export const settingsRoutes: RouteObject[] = [
  { path: 'settings', lazy: loadSettingsPage, handle: { title: tr('设置') } },
];
