import type { QueryClient } from '@tanstack/react-query';
import type { RouteObject } from 'react-router';
// 列表页的数据模块静态引入：预取时不必先多等一跳去下载它们（线上一跳几百毫秒）。
// 这些模块只有查询定义和小工具，编辑器等大依赖仍跟着各自页面懒加载。
import { boardQueryOptions, boardsQueryOptions } from '@/features/board/data';
import { inboxQueryOptions } from '@/features/inbox/inbox-api';
import { plansOverviewQueryOptions } from '@/features/plans/api';
import { reportsQueryOptions } from '@/features/reports/api';
import { reviewsQueryOptions } from '@/features/reviews/api';
import { todosQueryOptions } from '@/features/todos/data';
import { ACTIVE_PROJECT_THREADS, agentsQueryOptions, threadsQueryOptions } from '@/lib/project';
import { tr } from '@/lib/i18n';

type RoutesModule = () => Promise<RouteObject[]>;
type LazyResult = { element?: RouteObject['element']; Component?: RouteObject['Component'] };

/** 列表页首屏数据：与页面里 useQuery 同一个查询键，提前放进缓存后进入页面不再显示骨架屏。 */
export type PagePrefetch = (qc: QueryClient, projectId: string) => Promise<unknown>;

export interface LazyRouteSpec {
  path?: string;
  index?: true;
  title: string;
}

export interface LazyRouteGroup {
  name: string;
  specs: LazyRouteSpec[];
  load: RoutesModule;
  /** 列表页（不带参数的那条路由）的首屏数据 */
  prefetch?: PagePrefetch;
  /** false：空闲时不提前下载这组代码（只在进入或悬停时下载，例如云电脑的 noVNC） */
  idle?: false;
}

const modules = new WeakMap<RoutesModule, Promise<RouteObject[]>>();
const pages = new WeakMap<() => Promise<LazyResult>, Promise<LazyResult>>();

/** 代码加载去重；失败不缓存，刷新/重试可以重新请求。不会执行页面中的数据请求。 */
function loadOnce<T>(cache: WeakMap<() => Promise<T>, Promise<T>>, load: () => Promise<T>) {
  let pending = cache.get(load);
  if (!pending) {
    pending = Promise.resolve().then(load);
    cache.set(load, pending);
    void pending.catch(() => cache.delete(load));
  }
  return pending;
}

export async function loadRoute(group: LazyRouteGroup, spec: LazyRouteSpec): Promise<LazyResult> {
  const routes = await loadOnce(modules, group.load);
  const route = routes.find((r) => (spec.index ? r.index : r.path === spec.path));
  if (!route) throw new Error(tr('路由 {value} 不存在', { value: spec.path ?? '(index)' }));
  if (typeof route.lazy === 'function') {
    return loadOnce(pages, route.lazy as () => Promise<LazyResult>);
  }
  return { element: route.element, ...(route.Component ? { Component: route.Component } : {}) };
}

/** 标题与路径同步注册，页面与详情编辑器各自延迟加载。 */
export function lazyRoutes(specs: LazyRouteSpec[], load: RoutesModule): RouteObject[] {
  const group = { name: '', specs, load };
  return specs.map((spec) => ({
    ...(spec.index ? { index: true as const } : { path: spec.path }),
    handle: { title: spec.title },
    lazy: () => loadRoute(group, spec),
  }));
}

/** 看板、待办、实验的指派选择器都会读进行中的项目线程。 */
const prefetchActiveThreads = (qc: QueryClient, pid: string) =>
  qc.prefetchQuery(threadsQueryOptions(pid, ACTIVE_PROJECT_THREADS));

/** 协作功能路由表（相对 /p/:projectId）。 */
export const COLLAB_LAZY: LazyRouteGroup[] = [
  {
    name: 'notebooks',
    specs: [{ path: 'notebooks/:notebookId', title: 'Notebook' }],
    load: () => import('@/features/notebooks/routes').then((m) => m.notebookRoutes),
  },
  {
    name: 'tasks',
    specs: [{ path: 'tasks', title: tr('任务') }],
    load: () => import('@/features/tasks/routes').then((m) => m.tasksRoutes),
  },
  {
    name: 'retired',
    specs: [
      { path: 'experiments', title: tr('内容已移除') },
      { path: 'experiments/:experimentId', title: tr('内容已移除') },
      { path: 'desktop', title: tr('内容已移除') },
    ],
    load: () => import('@/features/retired/routes').then((m) => m.retiredRoutes),
  },
  {
    name: 'docs',
    specs: [
      { path: 'docs', title: tr('文档') },
      { path: 'docs/:docId', title: tr('文档') },
    ],
    load: () => import('@/features/docs/routes').then((m) => m.docsRoutes),
  },
  {
    name: 'board',
    specs: [{ path: 'board', title: tr('看板') }],
    load: () => import('@/features/board/routes').then((m) => m.boardRoutes),
    // 看板列表 → 默认看板详情是两跳请求，提前走完
    prefetch: async (qc, pid) => {
      const [boards] = await Promise.all([
        qc.ensureQueryData(boardsQueryOptions(pid)),
        prefetchActiveThreads(qc, pid),
      ]);
      const first = boards[0];
      if (first) await qc.prefetchQuery(boardQueryOptions(pid, first.id));
    },
  },
  {
    name: 'todos',
    specs: [{ path: 'todos', title: tr('待办') }],
    load: () => import('@/features/todos/routes').then((m) => m.todosRoutes),
    prefetch: (qc, pid) =>
      Promise.all([qc.prefetchQuery(todosQueryOptions(pid)), prefetchActiveThreads(qc, pid)]),
  },
  {
    name: 'research',
    specs: [
      { path: 'research', title: tr('研究空间') },
      { path: 'research/:recordId', title: tr('研究空间') },
      { path: 'research-items/:itemId', title: tr('研究内容') },
      { path: 'research-findings/:findingId', title: tr('研究结论') },
      { path: 'research-templates', title: tr('研究空间') },
      { path: 'research-sources', title: tr('研究资料') },
      { path: 'research-sources/:sourceId', title: tr('研究资料') },
    ],
    load: () => import('@/features/research/routes').then((m) => m.researchRoutes),
  },
  {
    name: 'reviews',
    specs: [
      { path: 'reviews', title: tr('审阅') },
      { path: 'reviews/:reviewId', title: tr('审阅详情') },
      { path: 'proposals/:proposalId', title: tr('改动提案') },
    ],
    load: () => import('@/features/reviews/routes').then((m) => m.reviewsRoutes),
    prefetch: (qc, pid) => qc.prefetchQuery(reviewsQueryOptions(pid)),
  },
  {
    name: 'reports',
    specs: [
      { path: 'reports', title: tr('组会汇报') },
      { path: 'reports/:reportId', title: tr('组会汇报') },
    ],
    load: () => import('@/features/reports/routes').then((m) => m.reportsRoutes),
    prefetch: (qc, pid) => qc.prefetchQuery(reportsQueryOptions(pid)),
  },
  {
    name: 'plans',
    specs: [{ path: 'plans', title: tr('方案与依据') }],
    load: () => import('@/features/plans/routes').then((m) => m.plansRoutes),
    prefetch: (qc, pid) => qc.prefetchQuery(plansOverviewQueryOptions(pid)),
  },
  {
    name: 'library',
    specs: [
      { path: 'library', title: tr('文献库') },
      { path: 'library/:paperId', title: tr('论文阅读') },
    ],
    load: () => import('@/features/library/routes').then((m) => m.libraryRoutes),
  },
];

/** 所有项目页共用一份代码加载入口，路由导航与意图预加载共享缓存。 */
export const PROJECT_LAZY: LazyRouteGroup[] = [
  {
    name: 'coordinator',
    specs: [{ index: true, title: tr('协作台') }],
    load: () => import('@/features/coordinator/routes').then((m) => m.coordinatorRoutes),
  },
  {
    name: 'workspace',
    specs: [
      { path: 'workspace', title: tr('我的工作区') },
      { path: 'workspace/:threadId', title: tr('我的工作区') },
    ],
    load: () => import('@/features/workspace/routes').then((m) => m.workspaceRoutes),
    prefetch: (qc, pid) =>
      Promise.all([
        qc.prefetchQuery(threadsQueryOptions(pid, { kind: 'personal' })),
        qc.prefetchQuery(agentsQueryOptions(pid)),
      ]),
  },
  {
    name: 'threads',
    specs: [
      { path: 'threads', title: tr('线程') },
      { path: 'threads/:threadId', title: tr('线程详情') },
    ],
    load: () => import('@/features/threads/routes').then((m) => m.threadsRoutes),
    prefetch: (qc, pid) =>
      Promise.all([
        qc.prefetchQuery(threadsQueryOptions(pid, { kind: 'project' })),
        qc.prefetchQuery(agentsQueryOptions(pid)),
      ]),
  },
  ...COLLAB_LAZY,
  {
    name: 'inbox',
    specs: [{ path: 'inbox', title: tr('待我处理') }],
    load: () => import('@/features/inbox/routes').then((m) => m.inboxRoutes),
    prefetch: (qc, pid) => qc.prefetchQuery(inboxQueryOptions(pid, false)),
  },
  {
    name: 'settings',
    specs: [{ path: 'settings', title: tr('设置') }],
    load: () => import('@/features/settings/routes').then((m) => m.settingsRoutes),
  },
  {
    name: 'help',
    specs: [{ path: 'help', title: tr('帮助中心') }],
    load: () => import('@/features/help/routes').then((m) => m.helpRoutes),
  },
];
