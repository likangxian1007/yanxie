import { createBrowserRouter, type RouteObject } from 'react-router';
import { AppShell } from '@/components/layout/AppShell';
import { BASE } from '@/lib/base-path';
import { PROJECT_LAZY, lazyRoutes } from './lazy-routes';
import { FullPageLoading } from './pages/FullPageState';
import { NotFoundPage } from './pages/NotFoundPage';
import { RouteErrorPage } from './pages/RouteErrorPage';
import { tr } from '@/lib/i18n';

/** 静态登记 URL 与标题，项目外壳和每个功能页独立加载。 */
export const projectChildRoutes: RouteObject[] = [
  ...PROJECT_LAZY.flatMap((g) => lazyRoutes(g.specs, g.load)),
  {
    path: 'go/:refId',
    handle: { title: tr('正在打开') },
    lazy: () => import('./pages/GoToRefPage').then((m) => ({ Component: m.GoToRefPage })),
  },
];

export const routes: RouteObject[] = [
  {
    path: '/',
    errorElement: <RouteErrorPage />,
    hydrateFallbackElement: <FullPageLoading />,
    lazy: () => import('./pages/HomeRedirect').then((m) => ({ Component: m.HomeRedirect })),
  },
  {
    path: '/new',
    handle: { title: tr('新建课题') },
    errorElement: <RouteErrorPage />,
    hydrateFallbackElement: <FullPageLoading />,
    lazy: () => import('./pages/NewProjectPage').then((m) => ({ Component: m.NewProjectPage })),
  },
  {
    path: '/invite/:token',
    handle: { title: tr('加入课题') },
    errorElement: <RouteErrorPage />,
    hydrateFallbackElement: <FullPageLoading />,
    lazy: () => import('./pages/InviteAcceptPage').then((m) => ({ Component: m.InviteAcceptPage })),
  },
  {
    path: '/s/:token',
    handle: { title: tr('打开分享链接') },
    errorElement: <RouteErrorPage />,
    hydrateFallbackElement: <FullPageLoading />,
    lazy: () =>
      import('@/features/sharing/ShareLinkPage').then((m) => ({ Component: m.ShareLinkPage })),
  },
  {
    path: '/login',
    handle: { title: tr('登录') },
    errorElement: <RouteErrorPage />,
    hydrateFallbackElement: <FullPageLoading />,
    lazy: () => import('./pages/LoginPage').then((m) => ({ Component: m.LoginPage })),
  },
  {
    path: '/register',
    handle: { title: tr('注册') },
    errorElement: <RouteErrorPage />,
    hydrateFallbackElement: <FullPageLoading />,
    lazy: () => import('./pages/RegisterPage').then((m) => ({ Component: m.RegisterPage })),
  },
  {
    path: '/forgot-password',
    handle: { title: tr('找回密码') },
    errorElement: <RouteErrorPage />,
    hydrateFallbackElement: <FullPageLoading />,
    lazy: () =>
      import('./pages/ForgotPasswordPage').then((m) => ({ Component: m.ForgotPasswordPage })),
  },
  {
    path: '/reset-password',
    handle: { title: tr('重置密码') },
    errorElement: <RouteErrorPage />,
    hydrateFallbackElement: <FullPageLoading />,
    lazy: () =>
      import('./pages/ResetPasswordPage').then((m) => ({ Component: m.ResetPasswordPage })),
  },
  {
    // 项目外壳随首屏一起打包：线上是 HTTP/1.1，懒加载时外壳要再拉 60 多个小分片、
    // 每个都排队往返一次，首次打开项目要十几秒。登录页因此多下载一些，但只在登录时出现一次。
    path: '/p/:projectId',
    Component: AppShell,
    errorElement: <RouteErrorPage />,
    hydrateFallbackElement: <FullPageLoading />,
    children: [
      ...projectChildRoutes,
      { path: '*', element: <NotFoundPage inShell />, handle: { title: tr('页面不存在') } },
    ],
  },
  { path: '*', element: <NotFoundPage />, handle: { title: tr('页面不存在') } },
  {
    path: '/library',
    handle: { title: tr('个人文献库') },
    errorElement: <RouteErrorPage />,
    hydrateFallbackElement: <FullPageLoading />,
    lazy: () =>
      import('@/features/library/pages/PersonalLibraryShell').then((m) => ({
        Component: m.PersonalLibraryShell,
      })),
    children: [
      {
        index: true,
        lazy: () =>
          import('@/features/library/pages/LibraryPage').then((m) => ({
            Component: m.LibraryPage,
          })),
      },
      {
        path: ':paperId',
        lazy: () =>
          import('@/features/library/pages/PaperReaderPage').then((m) => ({
            Component: m.PaperReaderPage,
          })),
      },
    ],
  },
  {
    path: '/feedback',
    handle: { title: tr('反馈中心') },
    errorElement: <RouteErrorPage />,
    hydrateFallbackElement: <FullPageLoading />,
    lazy: () =>
      import('@/features/library/pages/PersonalLibraryShell').then((m) => ({
        Component: m.PersonalLibraryShell,
      })),
    children: [
      {
        index: true,
        lazy: () =>
          import('@/features/feedback/pages/FeedbackCenterPage').then((m) => ({
            Component: m.FeedbackCenterPage,
          })),
      },
      {
        path: ':no',
        handle: { title: tr('工单') },
        lazy: () =>
          import('@/features/feedback/pages/TicketDetailPage').then((m) => ({
            Component: m.TicketDetailPage,
          })),
      },
    ],
  },
  {
    path: '/billing',
    handle: { title: tr('余额与充值') },
    errorElement: <RouteErrorPage />,
    hydrateFallbackElement: <FullPageLoading />,
    lazy: () =>
      import('@/features/library/pages/PersonalLibraryShell').then((m) => ({
        Component: m.PersonalLibraryShell,
      })),
    children: [
      {
        index: true,
        lazy: () =>
          import('@/features/billing/pages/BillingPage').then((m) => ({
            Component: m.BillingPage,
          })),
      },
    ],
  },
  {
    path: '/admin',
    handle: { title: tr('运维后台') },
    errorElement: <RouteErrorPage />,
    hydrateFallbackElement: <FullPageLoading />,
    lazy: () =>
      import('@/features/library/pages/PersonalLibraryShell').then((m) => ({
        Component: m.PersonalLibraryShell,
      })),
    children: [
      {
        index: true,
        lazy: () =>
          import('@/features/admin/pages/AdminPage').then((m) => ({ Component: m.AdminPage })),
      },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes, BASE ? { basename: BASE } : undefined);
}
