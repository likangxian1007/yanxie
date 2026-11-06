import { useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeferredPanel } from './right-panel-loader';

describe('辅助面板按需加载', () => {
  it('关闭时不加载，首次打开后保留 DOM 草稿，关闭释放查询订阅且失效不请求', async () => {
    const fetchPanel = vi.fn().mockResolvedValue('线程信息');
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    function Panel() {
      const query = useQuery({ queryKey: ['panel-only'], queryFn: fetchPanel });
      const [draft, setDraft] = useState('');
      return (
        <>
          <p>{query.data}</p>
          <input
            aria-label="草稿"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </>
      );
    }
    const load = vi.fn().mockResolvedValue({ default: Panel });
    const view = (active: boolean) => (
      <QueryClientProvider client={qc}>
        <DeferredPanel active={active} load={load} componentProps={{}} />
      </QueryClientProvider>
    );
    const { rerender } = render(view(false));
    expect(load).not.toHaveBeenCalled();
    expect(fetchPanel).not.toHaveBeenCalled();
    rerender(view(true));
    const input = await screen.findByRole('textbox', { name: '草稿' });
    await screen.findByText('线程信息');
    fireEvent.change(input, { target: { value: '尚未发送的研究问题' } });
    expect(fetchPanel).toHaveBeenCalledTimes(1);
    rerender(view(false));
    await waitFor(() =>
      expect(
        qc
          .getQueryCache()
          .find({ queryKey: ['panel-only'] })
          ?.isActive(),
      ).toBe(false),
    );
    await act(() => qc.invalidateQueries({ queryKey: ['panel-only'] }));
    expect(fetchPanel).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[aria-label="草稿"]')).toBe(input);
    expect(input).toHaveValue('尚未发送的研究问题');
    rerender(view(true));
    expect(await screen.findByRole('textbox', { name: '草稿' })).toBe(input);
    expect(input).toHaveValue('尚未发送的研究问题');
    await waitFor(() => expect(fetchPanel).toHaveBeenCalledTimes(2));
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('lazy 加载失败可原地重试并保留外部页面内容', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValue({ default: () => <p>已恢复的线程面板</p> });
    render(
      <>
        <textarea aria-label="主页面草稿" defaultValue="研究草稿" />
        <DeferredPanel active load={load} componentProps={{}} />
      </>,
    );
    const pageDraft = screen.getByRole('textbox', { name: '主页面草稿' });
    fireEvent.click(await screen.findByRole('button', { name: '重新加载' }));
    expect(await screen.findByText('已恢复的线程面板')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('textbox', { name: '主页面草稿' })).toBe(pageDraft);
    expect(pageDraft).toHaveValue('研究草稿');
    error.mockRestore();
  });
});
