import type { RouteObject } from 'react-router';
import { RetiredFeaturePage } from '@/app/pages/RetiredFeaturePage';
export const retiredRoutes: RouteObject[] = [
  { path: 'experiments', Component: RetiredFeaturePage },
  { path: 'experiments/:experimentId', Component: RetiredFeaturePage },
  { path: 'desktop', Component: RetiredFeaturePage },
];
