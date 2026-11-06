import { useCallback, useContext, useEffect, useRef } from 'react';
import { matchPath } from 'react-router';
import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { queryClient as defaultClient } from '@/lib/query';
import {
  PROJECT_LAZY,
  loadRoute,
  type LazyRouteGroup,
  type LazyRouteSpec,
  type PagePrefetch,
} from './lazy-routes';

type Connection = { saveData?: boolean; effectiveType?: string };

function canPreload() {
  const connection = (navigator as Navigator & { connection?: Connection }).connection;
  return !connection?.saveData && !['slow-2g', '2g'].includes(connection?.effectiveType ?? '');
}

/** 列表页（不带 :参数 的那条路由）才有首屏数据预取；详情页的编辑器和数据都等进入时再拉。 */
function isListSpec(spec: LazyRouteSpec) {
  return spec.index === true || !spec.path?.includes(':');
}

function matchTarget(to: string) {
  if (!to.startsWith('/p/')) return null;
  const pathname = to.split(/[?#]/u)[0] ?? '';
  for (const group of PROJECT_LAZY) {
    for (const spec of group.specs) {
      const match = matchPath(
        { path: `/p/:projectId${spec.path ? `/${spec.path}` : ''}`, end: true },
        pathname,
      );
      if (match) return { group, spec, projectId: match.params.projectId ?? '' };
    }
  }
  return null;
}

/** 仅下载匹配页面的代码；不执行 loader，也不挂载组件或发起数据请求。 */
export async function preloadRoute(to: string): Promise<void> {
  if (!canPreload()) return;
  const target = matchTarget(to);
  if (target) await loadRoute(target.group, target.spec);
}

/** 把列表页的首屏数据放进查询缓存（新鲜的缓存不会重复请求）。 */
export async function prefetchRouteData(to: string, qc: QueryClient): Promise<void> {
  if (!canPreload()) return;
  const target = matchTarget(to);
  if (!target?.group.prefetch || !target.projectId || !isListSpec(target.spec)) return;
  await target.group.prefetch(qc, target.projectId);
}

function useClient(): QueryClient {
  return useContext(QueryClientContext) ?? defaultClient;
}

/**
 * 停留 150ms 表示鼠标意图；键盘聚焦、按下（触屏没有悬停）立即预加载。
 * 代码和列表数据一起提前拉，点下去时多半已经在缓存里。离开或卸载取消未执行任务。
 */
export function useRoutePreload(to: string) {
  const qc = useClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const start = useCallback(() => {
    cancel();
    // 预加载失败保持导航可用，真正进入时由路由错误页 / 页面自己的错误态提供重试。
    void preloadRoute(to).catch(() => {});
    void prefetchRouteData(to, qc).catch(() => {});
  }, [cancel, to, qc]);
  const onPointerEnter = useCallback(() => {
    cancel();
    if (canPreload()) timer.current = setTimeout(start, 150);
  }, [cancel, start]);
  useEffect(() => cancel, [cancel, to]);
  return { onPointerEnter, onPointerLeave: cancel, onFocus: start, onPointerDown: start };
}

/** 首屏请求结束后再开始，最多等这么久 */
const IDLE_START_DELAY = 300;
const IDLE_MAX_WAIT = 8000;
/**
 * 同时下载代码的页面数。每个页面是「路由表 → 页面分片」两跳，线上一跳就是几百毫秒，
 * 串行太慢；HTTP/1.1 每个域名 6 个连接，留两个给数据预取和用户的新操作。
 */
const IDLE_CONCURRENCY = 4;

type IdleHandle = { cancel: () => void };

function whenIdle(fn: () => void): IdleHandle {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(fn, { timeout: 2000 });
    return { cancel: () => window.cancelIdleCallback(id) };
  }
  const id = setTimeout(fn, 0);
  return { cancel: () => clearTimeout(id) };
}

/** 等当前页面自己的请求结束（或超时），避免抢它的连接。 */
async function waitForQuiet(qc: QueryClient, isCancelled: () => boolean) {
  const deadline = Date.now() + IDLE_MAX_WAIT;
  while (!isCancelled() && qc.isFetching() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * 空闲时要预加载代码的列表页：有首屏数据的轻量列表（看板、待办、线程……）排在前面，
 * 文档、文献库、设置、帮助随后；同一类里保持侧栏顺序。
 */
export function idlePreloadQueue(groups: LazyRouteGroup[] = PROJECT_LAZY) {
  const items = groups
    .filter((group) => group.idle !== false)
    .flatMap((group) => group.specs.filter(isListSpec).map((spec) => ({ group, spec }) as const));
  return [
    ...items.filter((item) => item.group.prefetch),
    ...items.filter((item) => !item.group.prefetch),
  ];
}

/**
 * 进入项目后，空闲时把各个列表页的代码和首屏数据提前拉好：
 * 之后点侧栏任何一项都直接从缓存渲染，不再先等分包再等接口（线上往返一次就要几百毫秒）。
 * 省流量 / 2g 不做；切项目或离开项目时停止。
 * 只在生产构建里默认开启：本地开发不缺这点时间，组件测试也不该被后台请求和整站模块加载打扰。
 */
export function useIdlePreload(projectId: string, enabled: boolean = import.meta.env.PROD) {
  const qc = useClient();
  useEffect(() => {
    if (!enabled || !projectId || !canPreload()) return;
    let cancelled = false;
    let idle: IdleHandle | null = null;
    const isCancelled = () => cancelled;
    const queue = idlePreloadQueue();
    const prefetches = [...new Set(queue.map((item) => item.group.prefetch))].filter(
      (prefetch): prefetch is PagePrefetch => prefetch !== undefined,
    );

    // 预加载只是加速；失败时进入页面会正常加载并显示错误态
    const worker = async () => {
      for (let next = queue.shift(); next && !cancelled; next = queue.shift()) {
        await loadRoute(next.group, next.spec).catch(() => {});
      }
    };

    const timer = setTimeout(() => {
      idle = whenIdle(() => {
        void waitForQuiet(qc, isCancelled).then(() => {
          if (cancelled) return;
          // 数据请求都很小（一两个列表接口），一起发出去由浏览器排队；代码按并发上限逐页下载
          for (const prefetch of prefetches) void prefetch(qc, projectId).catch(() => {});
          for (let i = 0; i < IDLE_CONCURRENCY; i++) void worker();
        });
      });
    }, IDLE_START_DELAY);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      idle?.cancel();
    };
  }, [enabled, projectId, qc]);
}
