import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useReaderFullscreen } from './lib/useReaderFullscreen';
afterEach(() => vi.restoreAllMocks());
it('原生全屏被拒时仍保留应用内全屏，Escape 退出并恢复焦点', async () => {
  Object.defineProperty(document.documentElement, 'requestFullscreen', {
    configurable: true,
    value: vi.fn().mockRejectedValue(new Error('denied')),
  });
  const button = document.createElement('button');
  document.body.append(button);
  button.focus();
  const h = renderHook(() => useReaderFullscreen());
  await act(() => h.result.current.toggle());
  expect(h.result.current.active).toBe(true);
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(h.result.current.active).toBe(false);
  expect(document.activeElement).toBe(button);
  h.unmount();
  button.remove();
});
it('浏览器退出原生全屏会同步状态；卸载后晚到的全屏请求被退出', async () => {
  let resolve!: () => void;
  Object.defineProperty(document.documentElement, 'requestFullscreen', {
    configurable: true,
    value: vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    ),
  });
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  const h = renderHook(() => useReaderFullscreen());
  let pending!: Promise<void>;
  act(() => {
    pending = h.result.current.toggle();
  });
  h.unmount();
  await act(async () => {
    resolve();
    await pending;
  });
  await waitFor(() => expect(document.exitFullscreen).toHaveBeenCalled());
});
