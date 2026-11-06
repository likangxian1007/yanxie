import type { RouteObject } from 'react-router';
import { LegacyListRedirect } from '@/app/pages/LegacyListRedirect';
export const todosRoutes: RouteObject[] = [
  { path: 'todos', element: <LegacyListRedirect path="tasks" view="todos" /> },
];
