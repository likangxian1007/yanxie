import type { RouteObject } from 'react-router';
import { LegacyListRedirect } from '@/app/pages/LegacyListRedirect';
export const boardRoutes: RouteObject[] = [
  { path: 'board', element: <LegacyListRedirect path="tasks" view="board" /> },
];
