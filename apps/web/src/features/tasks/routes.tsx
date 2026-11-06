import type { RouteObject } from 'react-router';
export const tasksRoutes: RouteObject[] = [
  { path: 'tasks', lazy: () => import('./TasksPage').then((m) => ({ Component: m.TasksPage })) },
];
