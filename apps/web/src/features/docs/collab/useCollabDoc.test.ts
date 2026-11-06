import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paletteHex, useCollabDoc } from './useCollabDoc';

type Handler = (payload: unknown) => void;

/** 假的 HocuspocusProvider：记录事件监听，测试里手动触发 */
const fake = vi.hoisted(() => {
  class FakeSocket {
    status = 'connecting';
    emitted: { name: string; payload: unknown }[] = [];
    connect = vi.fn();
    disconnect = vi.fn();
    emit(name: string, payload: unknown) {
      this.emitted.push({ name, payload });
    }
  }
  class FakeProvider {
    static last: FakeProvider | null = null;
    static all: FakeProvider[] = [];
    handlers = new Map<string, Set<Handler>>();
    awareness = null;
    configuration = { websocketProvider: new FakeSocket() };
    options: Record<string, unknown>;
    connect = vi.fn();
    disconnect = vi.fn();
    destroy = vi.fn();
    setAwarenessField = vi.fn();
    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeProvider.last = this;
      FakeProvider.all.push(this);
    }
    on(name: string, fn: Handler) {
      const set = this.handlers.get(name) ?? new Set<Handler>();
      set.add(fn);
      this.handlers.set(name, set);
    }
    off(name: string, fn: Handler) {
      this.handlers.get(name)?.delete(fn);
    }
    emit(name: string, payload: unknown) {
      for (const fn of this.handlers.get(name) ?? []) fn(payload);
    }
  }
  const cache = {
    opened: [] as string[],
    clear: vi.fn(async () => undefined),
    destroy: vi.fn(),
    hadContent: false,
  };
  return { FakeProvider, cache };
});

vi.mock('@hocuspocus/provider', () => ({ HocuspocusProvider: fake.FakeProvider }));
vi.mock('@/lib/session', () => ({
  useMeUser: () => ({ id: 'usr_me', name: '我', avatarColor: 0 }),
}));
vi.mock('./localCache', () => ({
  localCacheName: (u: string, d: string) => `srh-doc:${u}:${d}`,
  openLocalCache: (name: string) => {
    fake.cache.opened.push(name);
    return {
      whenLoaded: Promise.resolve({ hadContent: fake.cache.hadContent }),
      destroy: fake.cache.destroy,
      clear: fake.cache.clear,
    };
  },
}));

function lastProvider() {
  const p = fake.FakeProvider.last;
  if (!p) throw new Error('provider 没有创建');
  return p;
}

/** 让推迟到下一轮的 connect / 本机缓存打开跑完 */
async function flushStart() {
  await act(async () => {
    vi.advanceTimersByTime(1);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fake.FakeProvider.all = [];
  fake.cache.opened = [];
  fake.cache.clear.mockClear();
  fake.cache.destroy.mockClear();
  fake.cache.hadContent = false;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useCollabDoc：握手被拒', () => {
  it.each([4401, 4403, 4404])(
    '关闭码 %i：断开 provider，停在 denied，之后的 status 不再覆盖',
    async (code) => {
      const { result } = renderHook(() => useCollabDoc('doc_x'));
      await flushStart();
      const provider = lastProvider();
      act(() => provider.emit('status', { status: 'connected' }));
      expect(result.current?.status).toBe('connected');

      act(() => provider.emit('close', { event: { code } }));
      expect(provider.disconnect).toHaveBeenCalled();
      expect(result.current?.status).toBe('denied');
      expect(result.current?.sync).toBe('denied');

      // provider 断开 / 自动重连时还会发 status，不能把 denied 盖掉
      act(() => provider.emit('status', { status: 'disconnected' }));
      act(() => provider.emit('status', { status: 'connecting' }));
      expect(result.current?.status).toBe('denied');
    },
  );

  it.each([
    [4403, true],
    [4404, true],
    [4401, false],
  ])('关闭码 %i：是否删除本机缓存 = %s', async (code, cleared) => {
    renderHook(() => useCollabDoc('doc_c'));
    await flushStart();
    expect(fake.cache.opened).toEqual(['srh-doc:usr_me:doc_c']);
    act(() => lastProvider().emit('close', { event: { code } }));
    expect(fake.cache.clear).toHaveBeenCalledTimes(cleared ? 1 : 0);
  });

  it('其他关闭码（例如服务端重置连接）不算被拒，继续跟随 status', async () => {
    const { result } = renderHook(() => useCollabDoc('doc_y'));
    await flushStart();
    const provider = lastProvider();
    act(() => provider.emit('close', { event: { code: 4205 } }));
    expect(provider.disconnect).not.toHaveBeenCalled();
    act(() => provider.emit('status', { status: 'connecting' }));
    expect(result.current?.status).toBe('connecting');
  });
});

describe('useCollabDoc：连接时机', () => {
  it('构造时不自动连接，推迟到下一轮再连；挂载后立即卸载（StrictMode）不会建连接', async () => {
    const first = renderHook(() => useCollabDoc('doc_s'));
    const p1 = lastProvider();
    expect(p1.options.autoConnect).toBe(false);
    first.unmount();
    await flushStart();
    expect(p1.connect).not.toHaveBeenCalled();
    expect(p1.destroy).toHaveBeenCalled();
    expect(fake.cache.opened).toEqual([]);

    renderHook(() => useCollabDoc('doc_s'));
    const p2 = lastProvider();
    expect(p2.connect).not.toHaveBeenCalled();
    await flushStart();
    expect(p2.connect).toHaveBeenCalledTimes(1);
  });
});

describe('useCollabDoc：离线与未同步', () => {
  async function connected() {
    const hook = renderHook(() => useCollabDoc('doc_o'));
    await flushStart();
    const provider = lastProvider();
    act(() => {
      provider.emit('status', { status: 'connected' });
      provider.emit('synced', { state: true });
    });
    provider.configuration.websocketProvider.status = 'connected';
    return { ...hook, provider };
  }

  it('浏览器 offline 事件：立即显示离线并断开当前 socket；online：立即重连', async () => {
    const { result, provider } = await connected();
    expect(result.current?.sync).toBe('synced');

    act(() => {
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current?.sync).toBe('offline');
    expect(result.current?.online).toBe(false);
    const socket = provider.configuration.websocketProvider;
    expect(socket.emitted.at(-1)).toMatchObject({
      name: 'close',
      payload: { event: { code: 4408 } },
    });
    // 离线期间暂停自动重连
    expect(socket.disconnect).toHaveBeenCalled();

    socket.status = 'disconnected';
    act(() => provider.emit('status', { status: 'disconnected' }));
    act(() => {
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(socket.connect).toHaveBeenCalled();
    expect(result.current?.sync).toBe('reconnecting');
    vi.restoreAllMocks();
  });

  it('离线时打开：先不连接，联网后再连', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const { result } = renderHook(() => useCollabDoc('doc_off'));
    await flushStart();
    const provider = lastProvider();
    expect(provider.connect).not.toHaveBeenCalled();
    expect(result.current?.sync).toBe('offline');
    act(() => {
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(provider.configuration.websocketProvider.connect).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('修改迟迟没被确认：1.5s 后显示「有未同步的修改」，6s 后主动重连；确认后回到已同步', async () => {
    const { result, provider } = await connected();
    act(() => provider.emit('unsyncedChanges', { number: 1 }));
    expect(result.current?.unsynced).toBe(1);
    expect(result.current?.sync).toBe('synced'); // 正常往返很快，不闪

    act(() => vi.advanceTimersByTime(2000));
    expect(result.current?.sync).toBe('unsynced');

    act(() => vi.advanceTimersByTime(4500));
    const socket = provider.configuration.websocketProvider;
    expect(socket.emitted.some((e) => e.name === 'close')).toBe(true);

    act(() => provider.emit('unsyncedChanges', { number: 0 }));
    expect(result.current?.sync).toBe('synced');
  });

  it('有未确认的修改时，离开页面前提醒；确认后不再提醒', async () => {
    const { provider } = await connected();
    const fire = () => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(fire()).toBe(false);
    act(() => provider.emit('unsyncedChanges', { number: 2 }));
    expect(fire()).toBe(true);
    act(() => provider.emit('unsyncedChanges', { number: 0 }));
    expect(fire()).toBe(false);
  });

  it('连不上服务端但本机缓存有内容：可以直接显示编辑器（离线编辑）', async () => {
    fake.cache.hadContent = true;
    const { result } = renderHook(() => useCollabDoc('doc_l'));
    await flushStart();
    expect(result.current?.localLoaded).toBe(true);
    expect(result.current?.ready).toBe(false); // 还在连接，先等服务端
    act(() => lastProvider().emit('status', { status: 'disconnected' }));
    expect(result.current?.ready).toBe(true);
  });

  it('本机缓存是空的：断开时也不显示编辑器，避免空文档', async () => {
    const { result } = renderHook(() => useCollabDoc('doc_e'));
    await flushStart();
    act(() => lastProvider().emit('status', { status: 'disconnected' }));
    expect(result.current?.ready).toBe(false);
  });
});

describe('paletteHex', () => {
  it('优先读 CSS 变量 --palette-n，读不到用内置值', () => {
    document.documentElement.style.setProperty('--palette-2', '#123456');
    expect(paletteHex(2)).toBe('#123456');
    document.documentElement.style.setProperty('--palette-3', 'rgb(1, 2, 3)');
    expect(paletteHex(3)).toBe('#010203');
    document.documentElement.style.removeProperty('--palette-2');
    document.documentElement.style.removeProperty('--palette-3');
    expect(paletteHex(2)).toBe('#0090ff');
    expect(paletteHex(10)).toBe('#0090ff');
  });
});
