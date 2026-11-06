import type { RouteObject } from 'react-router';
import { tr } from '@/lib/i18n';

const loadReportsPage = () =>
  import('./pages/ReportsPage').then((m) => ({ Component: m.ReportsPage }));
const loadReportDetailPage = () =>
  import('./pages/ReportDetailPage').then((m) => ({ Component: m.ReportDetailPage }));

/** 页面逐个按需加载，列表不会下载详情编辑器或阅读器。 */
export const reportsRoutes: RouteObject[] = [
  { path: 'reports', lazy: loadReportsPage, handle: { title: tr('组会汇报') } },
  { path: 'reports/:reportId', lazy: loadReportDetailPage, handle: { title: tr('组会汇报') } },
];
