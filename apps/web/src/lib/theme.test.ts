import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import initialHtml from '../../index.html?raw';

let dark = false;
let reduced = false;
let listeners: Set<() => void>;
let cleanup: (() => void) | undefined;
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  dark = false;
  reduced = false;
  listeners = new Set();
  Object.defineProperty(document, 'startViewTransition', { configurable: true, value: undefined });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  document.documentElement.classList.remove('theme-transition', 'theme-view-transition');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-palette');
  document.documentElement.removeAttribute('data-material');
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      get matches() {
        return query.includes('reduced-motion') ? reduced : dark;
      },
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    })),
  );
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  Reflect.deleteProperty(document, 'startViewTransition');
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function firstFrame() {
  const html = initialHtml;
  const source = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  expect(source).toBeTruthy();
  Function(source!)();
  return { ...document.documentElement.dataset };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
function viewTransitions() {
  const transitions: Array<{
    update: () => void;
    ready: ReturnType<typeof deferred>;
    finished: ReturnType<typeof deferred>;
    updateDone: ReturnType<typeof deferred>;
    skip: ReturnType<typeof vi.fn>;
  }> = [];
  const start = vi.fn((update: () => void) => {
    const pending = {
      update,
      ready: deferred(),
      finished: deferred(),
      updateDone: deferred(),
      skip: vi.fn(),
    };
    transitions.push(pending);
    return {
      ready: pending.ready.promise,
      finished: pending.finished.promise,
      updateCallbackDone: pending.updateDone.promise,
      skipTransition: pending.skip,
    };
  });
  Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
  return { transitions, start };
}

describe('三维外观', () => {
  it('首次默认复旦蓝和玻璃，明暗跟随系统，首帧与 store 一致', async () => {
    dark = true;
    const frame = firstFrame();
    const { initTheme, useThemeStore } = await import('./theme');
    cleanup = initTheme();
    expect(useThemeStore.getState()).toMatchObject({
      preference: 'system',
      resolved: 'dark',
      palette: 'fudan',
      material: 'glass',
    });
    expect({ ...document.documentElement.dataset }).toEqual(frame);
  });
  it('保留旧 srh-theme，并读取独立配色和材质', async () => {
    localStorage.setItem('srh-theme', 'dark');
    localStorage.setItem('srh-palette', 'paper');
    localStorage.setItem('srh-material', 'solid');
    const frame = firstFrame();
    const { initTheme, useThemeStore } = await import('./theme');
    cleanup = initTheme();
    expect(useThemeStore.getState()).toMatchObject({
      preference: 'dark',
      palette: 'paper',
      material: 'solid',
    });
    expect({ ...document.documentElement.dataset }).toEqual(frame);
  });
  it('非法偏好恢复默认，与首帧一致', async () => {
    for (const key of ['srh-theme', 'srh-palette', 'srh-material'])
      localStorage.setItem(key, 'invalid');
    const frame = firstFrame();
    const { initTheme, useThemeStore } = await import('./theme');
    cleanup = initTheme();
    expect(useThemeStore.getState()).toMatchObject({
      preference: 'system',
      palette: 'fudan',
      material: 'glass',
    });
    expect({ ...document.documentElement.dataset }).toEqual(frame);
  });
  it('存储不可用时仍能跟随系统和内存切换', async () => {
    dark = true;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(firstFrame().theme).toBe('dark');
    const { initTheme, useThemeStore } = await import('./theme');
    cleanup = initTheme();
    useThemeStore.getState().setPalette('graphite');
    useThemeStore.getState().setMaterial('solid');
    useThemeStore.getState().setPreference('light');
    expect(document.documentElement.dataset).toMatchObject({
      theme: 'light',
      palette: 'graphite',
      material: 'solid',
    });
  });
  it('系统变化仅影响 system，清理后停止监听', async () => {
    const { initTheme, useThemeStore } = await import('./theme');
    cleanup = initTheme();
    dark = true;
    listeners.forEach((cb) => cb());
    expect(useThemeStore.getState().resolved).toBe('dark');
    useThemeStore.getState().setPreference('light');
    listeners.forEach((cb) => cb());
    expect(useThemeStore.getState().resolved).toBe('light');
    cleanup();
    cleanup = undefined;
    expect(listeners.size).toBe(0);
  });
  it('跨标签同步含 remove/clear，并且不重新写入存储', async () => {
    const { initTheme, useThemeStore } = await import('./theme');
    cleanup = initTheme();
    const spy = vi.spyOn(Storage.prototype, 'setItem');
    window.dispatchEvent(new StorageEvent('storage', { key: 'srh-palette', newValue: 'paper' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'srh-material', newValue: 'solid' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'srh-theme', newValue: 'dark' }));
    expect(useThemeStore.getState()).toMatchObject({
      preference: 'dark',
      palette: 'paper',
      material: 'solid',
    });
    window.dispatchEvent(new StorageEvent('storage', { key: 'srh-palette', newValue: null }));
    expect(useThemeStore.getState().palette).toBe('fudan');
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated', newValue: 'x' }));
    expect(useThemeStore.getState().material).toBe('solid');
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(useThemeStore.getState()).toMatchObject({
      preference: 'system',
      palette: 'fudan',
      material: 'glass',
    });
    expect(spy).not.toHaveBeenCalled();
    cleanup();
    cleanup = undefined;
    window.dispatchEvent(new StorageEvent('storage', { key: 'srh-theme', newValue: 'dark' }));
    expect(useThemeStore.getState().preference).toBe('system');
  });
  it('重置三个维度，减少动态效果时不添加过渡', async () => {
    reduced = true;
    const { initTheme, useThemeStore } = await import('./theme');
    cleanup = initTheme();
    useThemeStore.getState().setPreference('dark');
    useThemeStore.getState().setPalette('paper');
    useThemeStore.getState().setMaterial('solid');
    expect(document.documentElement.classList.contains('theme-transition')).toBe(false);
    useThemeStore.getState().reset();
    expect(useThemeStore.getState()).toMatchObject({
      preference: 'system',
      palette: 'fudan',
      material: 'glass',
    });
  });
});

describe('外观过渡', () => {
  it('原生过渡延迟提交外观，首次初始化与相同外观不启动动画', async () => {
    const { transitions, start } = viewTransitions();
    const { initTheme, useThemeStore } = await import('./theme');
    cleanup = initTheme();
    expect(start).not.toHaveBeenCalled();
    useThemeStore.getState().setPreference('light');
    expect(start).not.toHaveBeenCalled();
    const input = document.createElement('textarea');
    input.value = '尚未发送的草稿';
    document.body.append(input);
    input.focus();
    try {
      useThemeStore.getState().setPreference('dark');
      expect(document.documentElement.dataset.theme).toBe('light');
      expect(useThemeStore.getState().resolved).toBe('dark');
      expect(document.documentElement.classList.contains('theme-view-transition')).toBe(true);
      expect(document.documentElement.classList.contains('theme-transition')).toBe(false);
      transitions[0]!.update();
      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe('尚未发送的草稿');
      transitions[0]!.finished.resolve();
      await Promise.resolve();
      expect(document.documentElement.classList.contains('theme-view-transition')).toBe(false);
    } finally {
      input.remove();
    }
  });

  it('快速连续切换与跨标签事件保持最后选择，旧回调和结束事件不能覆盖', async () => {
    const { transitions } = viewTransitions();
    const { initTheme, useThemeStore } = await import('./theme');
    cleanup = initTheme();
    useThemeStore.getState().setPreference('dark');
    useThemeStore.getState().setPalette('paper');
    window.dispatchEvent(new StorageEvent('storage', { key: 'srh-material', newValue: 'solid' }));
    expect(transitions).toHaveLength(3);
    expect(transitions[0]!.skip).toHaveBeenCalledOnce();
    expect(transitions[1]!.skip).toHaveBeenCalledOnce();
    transitions[2]!.update();
    transitions[0]!.update();
    transitions[1]!.update();
    transitions[0]!.finished.resolve();
    transitions[1]!.finished.reject(new Error('superseded'));
    transitions[0]!.ready.reject(new Error('skipped'));
    await Promise.resolve();
    expect(document.documentElement.dataset).toMatchObject({
      theme: 'dark',
      palette: 'paper',
      material: 'solid',
    });
    expect(document.documentElement.classList.contains('theme-view-transition')).toBe(true);
    transitions[2]!.finished.resolve();
    await Promise.resolve();
    expect(document.documentElement.classList.contains('theme-view-transition')).toBe(false);
  });

  it('切回当前DOM外观仍取消尚未提交的旧回调', async () => {
    const { transitions, start } = viewTransitions();
    const { initTheme, useThemeStore } = await import('./theme');
    cleanup = initTheme();
    useThemeStore.getState().setPreference('dark');
    useThemeStore.getState().setPreference('light');
    expect(start).toHaveBeenCalledOnce();
    transitions[0]!.update();
    transitions[0]!.finished.resolve();
    await Promise.resolve();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(useThemeStore.getState().resolved).toBe('light');
    expect(document.documentElement.classList.contains('theme-view-transition')).toBe(false);
  });

  it('原生启动失败退回180ms受限过渡，连续调用重新计时', async () => {
    vi.useFakeTimers();
    const { start } = viewTransitions();
    start.mockImplementation(() => {
      throw new Error('snapshot unavailable');
    });
    const { initTheme, useThemeStore } = await import('./theme');
    cleanup = initTheme();
    useThemeStore.getState().setPreference('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.classList.contains('theme-view-transition')).toBe(false);
    expect(document.documentElement.classList.contains('theme-transition')).toBe(true);
    vi.advanceTimersByTime(100);
    useThemeStore.getState().setPalette('paper');
    vi.advanceTimersByTime(179);
    expect(document.documentElement.classList.contains('theme-transition')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(document.documentElement.classList.contains('theme-transition')).toBe(false);
  });

  it('没有原生API时立即应用并短暂标记过渡，后台同步移除标记', async () => {
    vi.useFakeTimers();
    const { initTheme, useThemeStore } = await import('./theme');
    cleanup = initTheme();
    useThemeStore.getState().setPreference('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.classList.contains('theme-transition')).toBe(true);
    vi.advanceTimersByTime(180);
    expect(document.documentElement.classList.contains('theme-transition')).toBe(false);
    useThemeStore.getState().setPalette('paper');
    expect(document.documentElement.classList.contains('theme-transition')).toBe(true);
    vi.mocked(Object.getOwnPropertyDescriptor(document, 'visibilityState')!.get!).mockReturnValue(
      'hidden',
    );
    window.dispatchEvent(new StorageEvent('storage', { key: 'srh-material', newValue: 'solid' }));
    expect(document.documentElement.dataset.material).toBe('solid');
    expect(document.documentElement.classList.contains('theme-transition')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('快照或更新失败仍应用最后外观并清理标记，不留下拒绝的Promise', async () => {
    const { transitions } = viewTransitions();
    const { initTheme, useThemeStore } = await import('./theme');
    cleanup = initTheme();
    useThemeStore.getState().setPalette('graphite');
    transitions[0]!.ready.reject(new Error('snapshot failed'));
    transitions[0]!.updateDone.reject(new Error('update failed'));
    transitions[0]!.finished.reject(new Error('aborted'));
    await Promise.resolve();
    expect(document.documentElement.dataset.palette).toBe('graphite');
    expect(document.documentElement.classList.contains('theme-view-transition')).toBe(false);
  });

  it('后台直接应用外观，进入后台时取消活动快照且返回前台不补播', async () => {
    const { transitions, start } = viewTransitions();
    const { initTheme, useThemeStore } = await import('./theme');
    cleanup = initTheme();
    useThemeStore.getState().setPreference('dark');
    vi.mocked(Object.getOwnPropertyDescriptor(document, 'visibilityState')!.get!).mockReturnValue(
      'hidden',
    );
    document.dispatchEvent(new Event('visibilitychange'));
    expect(transitions[0]!.skip).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.theme).toBe('dark');
    useThemeStore.getState().setPalette('paper');
    expect(document.documentElement.dataset.palette).toBe('paper');
    expect(start).toHaveBeenCalledOnce();
    transitions[0]!.update();
    transitions[0]!.finished.resolve();
    await Promise.resolve();
    expect(document.documentElement.dataset.palette).toBe('paper');
    vi.mocked(Object.getOwnPropertyDescriptor(document, 'visibilityState')!.get!).mockReturnValue(
      'visible',
    );
    document.dispatchEvent(new Event('visibilitychange'));
    expect(start).toHaveBeenCalledOnce();
    expect(document.documentElement.classList.contains('theme-view-transition')).toBe(false);
  });

  it('减少动态效果直接应用并中止已有过渡，清理后旧回调也不回写', async () => {
    const { transitions, start } = viewTransitions();
    const { initTheme, useThemeStore } = await import('./theme');
    cleanup = initTheme();
    useThemeStore.getState().setPreference('dark');
    reduced = true;
    listeners.forEach((cb) => cb());
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(transitions[0]!.skip).toHaveBeenCalledOnce();
    useThemeStore.getState().setPalette('paper');
    expect(document.documentElement.dataset.palette).toBe('paper');
    expect(start).toHaveBeenCalledOnce();
    cleanup();
    cleanup = undefined;
    transitions[0]!.update();
    expect(document.documentElement.dataset.palette).toBe('paper');
    expect(document.documentElement.classList.contains('theme-transition')).toBe(false);
    expect(document.documentElement.classList.contains('theme-view-transition')).toBe(false);
  });

  it('重置三项偏好只有一次store通知和原生更新，存储部分失败仍完整落地', async () => {
    localStorage.setItem('srh-theme', 'dark');
    localStorage.setItem('srh-palette', 'paper');
    localStorage.setItem('srh-material', 'solid');
    const { transitions, start } = viewTransitions();
    const { initTheme, useThemeStore } = await import('./theme');
    cleanup = initTheme();
    const changed = vi.fn();
    const unsubscribe = useThemeStore.subscribe(changed);
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key) => {
      if (key === 'srh-palette') throw new Error('quota exceeded');
    });
    useThemeStore.getState().reset();
    expect(changed).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(storageWrite.mock.calls.map(([key]) => key)).toEqual([
      'srh-theme',
      'srh-palette',
      'srh-material',
    ]);
    expect(useThemeStore.getState()).toMatchObject({
      preference: 'system',
      resolved: 'light',
      palette: 'fudan',
      material: 'glass',
    });
    transitions[0]!.update();
    expect(document.documentElement.dataset).toMatchObject({
      theme: 'light',
      palette: 'fudan',
      material: 'glass',
    });
    unsubscribe();
  });
});
