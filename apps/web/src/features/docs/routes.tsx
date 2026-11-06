import type { RouteObject } from 'react-router';
import { tr } from '@/lib/i18n';

const loadDocsPage = () => import('./pages/DocsPage').then((m) => ({ Component: m.DocsPage }));
const loadDocDetailPage = () =>
  import('./pages/DocDetailPage').then((m) => ({ Component: m.DocDetailPage }));

/** 页面逐个按需加载，列表不会下载详情编辑器或阅读器。 */
export const docsRoutes: RouteObject[] = [
  { path: 'docs', lazy: loadDocsPage, handle: { title: tr('文档') } },
  { path: 'docs/:docId', lazy: loadDocDetailPage, handle: { title: tr('文档') } },
];
