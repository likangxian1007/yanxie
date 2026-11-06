import { act, renderHook } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  idlePreloadQueue,
  preloadRoute,
  prefetchRouteData,
  useIdlePreload,
  useRoutePreload,
} from './route-preload';

const { loadRoute, group, board, desktop } = vi.hoisted(() => ({
  loadRoute: vi.fn(async (..._args: unknown[]) => ({})),
  group: {
    name: 'docs',
    specs: [
      { path: 'docs', title: '文档' },
      { path: 'docs/:docId', title: '文档' },
    ],
  },
  board: {
    name: 'board',
    specs: [{ path: 'board', title: '看板' }],
    prefetch: vi.fn(async (..._args: unknown[]) => undefined),
  },
  desktop: {
    name: 'desktop',
    specs: [{ path: 'desktop', title: '云电脑' }],
    idle: false as const,
  },
}));

vi.mock('./lazy-routes', () => ({ PROJECT_LAZY: [group, board, desktop], loadRoute }));

beforeEach(() => {
  vi.useFakeTimers();
  loadRoute.mockClear();
  board.prefetch.mockClear();
  Object.defineProperty(navigator, 'connection', { configurable: true, value: undefined });
});
afterEach(() => vi.useRealTimers());

describe('preloadRoute', () => {
  it('只加载匹配页面的代码，忽略查询和锚点', async () => {
    const fetchSpy = vi.spyOn(window, 'fetch');
    await preloadRoute('/p/project/docs/document?mode=read#section');
    expect(loadRoute).toHaveBeenCalledExactlyOnceWith(group, group.specs[1]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('不预加载外部地址、未知路径或省流量/2g网络', async () => {
    await preloadRoute('https://example.com/p/project/docs');
    await preloadRoute('/p/project/unknown');
    for (const connection of [
      { saveData: true },
      { effectiveType: '2g' },
      { effectiveType: 'slow-2g' },
    ]) {
      Object.defineProperty(navigator, 'connection', { configurable: true, value: connection });
      await preloadRoute('/p/project/docs');
    }
    expect(loadRoute).not.toHaveBeenCalled();
  });
});

describe('prefetchRouteData', () => {
  it('列表页按目标项目预取首屏数据；没有预取的页面、外部地址和省流量都不请求', async () => {
    const qc = new QueryClient();
    await prefetchRouteData('/p/project-a/board?card=c1', qc);
    expect(board.prefetch).toHaveBeenCalledExactlyOnceWith(qc, 'project-a');
    await prefetchRouteData('/p/project-a/docs', qc);
    await prefetchRouteData('https://example.com/p/project-a/board', qc);
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { saveData: true },
    });
    await prefetchRouteData('/p/project-a/board', qc);
    expect(board.prefetch).toHaveBeenCalledTimes(1);
  });
});

describe('idlePreloadQueue', () => {
  it('有首屏数据的列表页排前面，只含列表路由，跳过 idle:false 的页面', () => {
    expect(idlePreloadQueue().map((item) => item.spec.path)).toEqual(['board', 'docs']);
  });
});

describe('useRoutePreload', () => {
  it('hover满150ms才触发，离开可取消，focus和按下立即触发', async () => {
    const { result } = renderHook(() => useRoutePreload('/p/project/docs'));
    act(() => result.current.onPointerEnter());
    await act(() => vi.advanceTimersByTimeAsync(149));
    expect(loadRoute).not.toHaveBeenCalled();
    act(() => result.current.onPointerLeave());
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(loadRoute).not.toHaveBeenCalled();
    act(() => result.current.onPointerEnter());
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(loadRoute).toHaveBeenCalledTimes(1);
    act(() => result.current.onFocus());
    expect(loadRoute).toHaveBeenCalledTimes(2);
    act(() => result.current.onPointerDown());
    expect(loadRoute).toHaveBeenCalledTimes(3);
  });

  it('悬停在列表页上时连同首屏数据一起预取', async () => {
    const { result } = renderHook(() => useRoutePreload('/p/project/board'));
    await act(async () => result.current.onFocus());
    expect(loadRoute).toHaveBeenCalledExactlyOnceWith(board, board.specs[0]);
    expect(board.prefetch).toHaveBeenCalledWith(expect.any(QueryClient), 'project');
  });

  it('卸载或目标改变取消悬停任务，预加载失败不阻断导航', async () => {
    const { result, rerender, unmount } = renderHook(({ to }) => useRoutePreload(to), {
      initialProps: { to: '/p/project/docs' },
    });
    act(() => result.current.onPointerEnter());
    rerender({ to: '/p/project/docs/document' });
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(loadRoute).not.toHaveBeenCalled();
    loadRoute.mockRejectedValueOnce(new Error('offline'));
    await act(async () => result.current.onFocus());
    act(() => result.current.onPointerEnter());
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(loadRoute).toHaveBeenCalledTimes(1);
  });
});

describe('useIdlePreload', () => {
  it('空闲后预加载列表页代码和数据，跳过 idle:false 的页面；单页失败不影响其他页', async () => {
    loadRoute.mockRejectedValueOnce(new Error('offline'));
    renderHook(() => useIdlePreload('project', true));
    expect(loadRoute).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    const paths = loadRoute.mock.calls.map(([, spec]) => (spec as { path: string }).path);
    expect(paths.sort()).toEqual(['board', 'docs']);
    expect(board.prefetch).toHaveBeenCalledWith(expect.any(QueryClient), 'project');
  });

  it('默认只在生产构建开启；省流量时不预加载；开始前卸载就不再开始', async () => {
    renderHook(() => useIdlePreload('project'));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(loadRoute).not.toHaveBeenCalled();
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { saveData: true },
    });
    renderHook(() => useIdlePreload('project', true));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    Object.defineProperty(navigator, 'connection', { configurable: true, value: undefined });
    const { unmount } = renderHook(() => useIdlePreload('project', true));
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(loadRoute).not.toHaveBeenCalled();
    expect(board.prefetch).not.toHaveBeenCalled();
  });
});
