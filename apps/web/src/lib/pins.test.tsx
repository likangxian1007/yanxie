import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '@/components/ui/toast-store';
import { api, ApiRequestError } from './api';
import {
  fetchPins,
  LEGACY_PINS_KEY,
  MAX_PINS,
  mergePins,
  PINS_QUERY_KEY,
  sanitizePins,
  togglePinList,
  usePins,
  usePinStore,
} from './pins';

describe('置顶：纯函数', () => {
  it('sanitizePins 只留项目 id → 非空字符串数组（去重）', () => {
    expect(sanitizePins(null)).toEqual({});
    expect(sanitizePins(['x'])).toEqual({});
    expect(
      sanitizePins({ prj_1: ['thr_a', 'thr_a', 3, ''], prj_2: 'thr_b', prj_3: [], items: [] }),
    ).toEqual({ prj_1: ['thr_a'] });
  });

  it('mergePins：服务端的一个不丢、在前，本机多出的接在后面，到上限为止', () => {
    expect(mergePins(['a', 'b'], ['b', 'c', 'c'])).toEqual(['a', 'b', 'c']);
    const full = Array.from({ length: MAX_PINS }, (_, i) => `t${i}`);
    expect(mergePins(full, ['x'])).toEqual(full);
    const over = [...full, 'y'];
    expect(mergePins(over, ['x'])).toEqual(over);
  });

  it('togglePinList：新置顶放最前，再点取消', () => {
    expect(togglePinList(['a'], 'b')).toEqual(['b', 'a']);
    expect(togglePinList(['b', 'a'], 'b')).toEqual(['a']);
    const full = Array.from({ length: MAX_PINS }, (_, i) => `t${i}`);
    expect(togglePinList(full, 'x')).toHaveLength(MAX_PINS);
  });
});

describe('fetchPins：本机旧置顶迁移到服务端', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('合并本机的到服务端、PUT 后清掉本机；服务端已经有的不重复 PUT', async () => {
    window.localStorage.setItem(
      LEGACY_PINS_KEY,
      JSON.stringify({ prj_1: ['thr_local', 'thr_a'], prj_2: ['thr_a'] }),
    );
    vi.spyOn(api, 'get').mockResolvedValue({ prj_1: ['thr_a'], prj_2: ['thr_a'] });
    const put = vi
      .spyOn(api, 'put')
      .mockImplementation(
        async (url, body) => ({ projectId: url, ids: (body as { ids: string[] }).ids }) as never,
      );
    const pins = await fetchPins();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith('/auth/me/pins/prj_1', { ids: ['thr_a', 'thr_local'] });
    expect(pins).toEqual({ prj_1: ['thr_a', 'thr_local'], prj_2: ['thr_a'] });
    expect(window.localStorage.getItem(LEGACY_PINS_KEY)).toBeNull();
  });

  it('不再是成员（404）的项目丢掉；断网时保留本机这份下次再试', async () => {
    window.localStorage.setItem(LEGACY_PINS_KEY, JSON.stringify({ prj_gone: ['thr_x'] }));
    vi.spyOn(api, 'get').mockResolvedValue({});
    const put = vi
      .spyOn(api, 'put')
      .mockRejectedValue(new ApiRequestError({ status: 404, code: 'not_found', message: '没了' }));
    expect(await fetchPins()).toEqual({});
    expect(window.localStorage.getItem(LEGACY_PINS_KEY)).toBeNull();

    window.localStorage.setItem(LEGACY_PINS_KEY, JSON.stringify({ prj_1: ['thr_x'] }));
    put.mockRejectedValue(
      new ApiRequestError({ status: 0, code: 'network_error', message: '断网' }),
    );
    expect(await fetchPins()).toEqual({});
    expect(window.localStorage.getItem(LEGACY_PINS_KEY)).not.toBeNull();
  });
});

describe('usePins / usePinStore', () => {
  let qc: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    window.localStorage.clear();
    useToastStore.setState({ items: [] });
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => vi.restoreAllMocks());

  it('读服务端的置顶；toggle 先乐观更新再 PUT 整组', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ prj_1: ['thr_a'] });
    let release: () => void = () => {};
    const put = vi.spyOn(api, 'put').mockImplementation(
      (_url, body) =>
        new Promise((resolve) => {
          release = () => resolve({ projectId: 'prj_1', ...(body as object) } as never);
        }),
    );
    const { result } = renderHook(
      () => ({ pins: usePins('prj_1'), toggle: usePinStore((s) => s.toggle) }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.pins).toEqual(['thr_a']));

    act(() => result.current.toggle('prj_1', 'thr_b'));
    await waitFor(() => expect(result.current.pins).toEqual(['thr_b', 'thr_a']));
    expect(put).toHaveBeenCalledWith('/auth/me/pins/prj_1', { ids: ['thr_b', 'thr_a'] });
    await act(async () => release());

    act(() => result.current.toggle('prj_1', 'thr_a'));
    await waitFor(() => expect(result.current.pins).toEqual(['thr_b']));
  });

  it('保存失败：回滚并提示', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ prj_1: ['thr_a'] });
    vi.spyOn(api, 'put').mockRejectedValue(
      new ApiRequestError({ status: 500, code: 'internal', message: '服务器出了点问题。' }),
    );
    const { result } = renderHook(
      () => ({ pins: usePins('prj_1'), toggle: usePinStore((s) => s.toggle) }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.pins).toEqual(['thr_a']));
    act(() => result.current.toggle('prj_1', 'thr_a'));
    await waitFor(() => expect(useToastStore.getState().items.at(-1)?.title).toBe('置顶没保存'));
    expect(qc.getQueryData(PINS_QUERY_KEY)).toEqual({ prj_1: ['thr_a'] });
    await waitFor(() => expect(result.current.pins).toEqual(['thr_a']));
  });

  it('还没拉到时先显示本机旧的置顶', () => {
    window.localStorage.setItem(LEGACY_PINS_KEY, JSON.stringify({ prj_1: ['thr_old'] }));
    vi.spyOn(api, 'get').mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => usePins('prj_1'), { wrapper });
    expect(result.current).toEqual(['thr_old']);
  });
});
