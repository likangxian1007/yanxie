import type { RouteObject } from 'react-router';
import { tr } from '@/lib/i18n';

const loadLibraryPage = () =>
  import('./pages/LibraryPage').then((m) => ({ Component: m.LibraryPage }));
const loadPaperReaderPage = () =>
  import('./pages/PaperReaderPage').then((m) => ({ Component: m.PaperReaderPage }));

/** 页面逐个按需加载，列表不会下载详情编辑器或阅读器。 */
export const libraryRoutes: RouteObject[] = [
  { path: 'library', lazy: loadLibraryPage, handle: { title: tr('文献库') } },
  { path: 'library/:paperId', lazy: loadPaperReaderPage, handle: { title: tr('论文阅读') } },
];
