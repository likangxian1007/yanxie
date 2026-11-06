import { describe, expect, it, vi } from 'vitest';
import type { RouteObject } from 'react-router';
import { PROJECT_LAZY, lazyRoutes, loadRoute } from './lazy-routes';

describe('lazyRoutes', () => {
  it('lazy 不返回已经静态定义的属性（否则 React Router 会警告并忽略）', async () => {
    const load = () =>
      Promise.resolve<RouteObject[]>([
        { path: 'x', element: 'X', handle: { title: '别的标题' } },
        { path: 'x/:id', element: 'Y' },
      ]);
    const routes = lazyRoutes(
      [
        { path: 'x', title: '甲' },
        { path: 'x/:id', title: '乙' },
      ],
      load,
    );
    for (const route of routes) {
      const lazy = route.lazy as () => Promise<Record<string, unknown>>;
      const resolved = await lazy();
      const staticKeys = Object.keys(route).filter((k) => k !== 'lazy' && k !== 'path');
      expect(staticKeys).toContain('handle');
      for (const key of Object.keys(resolved)) expect(staticKeys).not.toContain(key);
    }
    expect(routes.map((r) => (r.handle as { title: string }).title)).toEqual(['甲', '乙']);
  });
});

// 只读 routes.tsx 的源码（不执行），避免为了比对路径把编辑器、Yjs 等整包加载进测试
const SOURCES = import.meta.glob<string>('../features/*/routes.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function pathsIn(source: string): string[] {
  return [...source.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1] ?? '').sort();
}

describe('PROJECT_LAZY', () => {
  it.each(PROJECT_LAZY.map((g) => [g.name, g] as const))(
    '%s 的路径和功能自己的 routes.tsx 一致',
    (name, group) => {
      const source = SOURCES[`../features/${name}/routes.tsx`];
      expect(source, `features/${name}/routes.tsx`).toBeDefined();
      expect(group.specs.flatMap((s) => (s.path ? [s.path] : [])).sort()).toEqual(
        pathsIn(source ?? ''),
      );
    },
  );
});

describe('loadRoute', () => {
  it('路由导航和预加载共享模块与页面请求，列表不加载详情', async () => {
    const list = vi.fn(async () => ({ Component: () => null }));
    const detail = vi.fn(async () => ({ Component: () => null }));
    const load = vi.fn(async (): Promise<RouteObject[]> => [
      { path: 'docs', lazy: list },
      { path: 'docs/:docId', lazy: detail },
    ]);
    const specs = [
      { path: 'docs', title: '文档' },
      { path: 'docs/:docId', title: '文档' },
    ];
    const group = { name: 'docs', specs, load };
    const routes = lazyRoutes(specs, load);
    const navigation = routes[0]?.lazy as () => Promise<unknown>;
    const [preloaded, navigated] = await Promise.all([loadRoute(group, specs[0]!), navigation()]);
    expect(preloaded).toBe(navigated);
    expect(load).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(detail).not.toHaveBeenCalled();
    await loadRoute(group, specs[1]!);
    expect(detail).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('页面加载失败清理缓存，下一次请求可以重试', async () => {
    const page = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ Component: () => null });
    const spec = { index: true as const, title: '协作台' };
    const group = {
      name: 'coordinator',
      specs: [spec],
      load: async (): Promise<RouteObject[]> => [{ index: true, lazy: page }],
    };
    await expect(loadRoute(group, spec)).rejects.toThrow('offline');
    await expect(loadRoute(group, spec)).resolves.toHaveProperty('Component');
    expect(page).toHaveBeenCalledTimes(2);
    expect(lazyRoutes([spec], group.load)[0]).toMatchObject({
      index: true,
      handle: { title: '协作台' },
    });
  });
});
