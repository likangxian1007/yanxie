import type { RouteObject } from 'react-router';
export const notebookRoutes: RouteObject[] = [
  {
    path: 'notebooks/:notebookId',
    lazy: () => import('./NotebookPage').then((m) => ({ Component: m.NotebookPage })),
  },
];
