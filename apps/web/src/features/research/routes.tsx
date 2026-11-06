import { LegacyListRedirect } from '@/app/pages/LegacyListRedirect';
import type { RouteObject } from 'react-router';

export const researchRoutes: RouteObject[] = [
  {
    path: 'research-items/:itemId',
    lazy: () =>
      import('./pages/ResearchItemRedirectPage').then((m) => ({
        Component: m.ResearchItemRedirectPage,
      })),
  },
  {
    path: 'research',
    lazy: () => import('./pages/ResearchHomePage').then((m) => ({ Component: m.ResearchHomePage })),
  },
  {
    path: 'research/:recordId',
    lazy: () =>
      import('./pages/ResearchRecordPage').then((m) => ({ Component: m.ResearchRecordPage })),
  },
  {
    path: 'research-findings/:findingId',
    lazy: () =>
      import('./pages/ResearchFindingRedirectPage').then((m) => ({
        Component: m.ResearchFindingRedirectPage,
      })),
  },
  {
    path: 'research-templates',
    lazy: () =>
      import('./pages/ResearchRetiredRedirectPage').then((m) => ({
        Component: m.ResearchRetiredRedirectPage,
      })),
  },
  {
    path: 'research-sources',
    element: <LegacyListRedirect path="research" view="sources" />,
  },
  {
    path: 'research-sources/:sourceId',
    lazy: () =>
      import('./pages/ResearchSourcePage').then((m) => ({ Component: m.ResearchSourcePage })),
  },
];
