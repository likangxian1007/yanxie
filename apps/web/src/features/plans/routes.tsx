import type { RouteObject } from 'react-router';
import { tr } from '@/lib/i18n';

const loadPlans = () => import('./pages/PlansPage').then((m) => ({ Component: m.PlansPage }));

export const plansRoutes: RouteObject[] = [
  { path: 'plans', lazy: loadPlans, handle: { title: tr('方案与依据') } },
];
