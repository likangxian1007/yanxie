import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParsingHelpDialog } from './ParsingHelpDialog';
import type { LibraryScope } from '../lib/scope';

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  client.clear();
  vi.unstubAllGlobals();
});

function show(scope: LibraryScope, status: 'ready' | 'failed' = 'ready') {
  render(
    <QueryClientProvider client={client}>
      <ParsingHelpDialog
        scope={scope}
        paper={{ status, parser: 'pdf-text', error: 'GROBID 不可达：原始原因' }}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe('解析帮助', () => {
  it.each([
    [{ kind: 'personal', userId: 'usr_me' }, '/api/v1/library/status'],
    ['prj_team', '/api/v1/projects/prj_team/library/status'],
  ] as const)('在正确的库检查服务，恢复后保留原始失败原因且不自动重解析', async (scope, url) => {
    let reachable = false;
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            parser: 'grobid',
            reachable,
            url: 'http://localhost:8070',
            version: null,
            queue: { running: 0, pending: 0 },
            llm: false,
          }),
        ),
    );
    vi.stubGlobal('fetch', fetch);
    show(scope);
    await screen.findByText('结构解析服务未连接');
    expect(screen.getByText(/这篇论文已提取出正文/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('查看本次解析的原始原因'));
    await waitFor(() => expect(screen.getByText('GROBID 不可达：原始原因')).toBeVisible());
    reachable = true;
    fireEvent.click(screen.getByRole('button', { name: '检查服务连接' }));
    await screen.findByText('结构解析服务已连接');
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [input] of vi.mocked(globalThis.fetch).mock.calls) expect(input).toBe(url);
    await waitFor(() => expect(screen.getByText('GROBID 不可达：原始原因')).toBeVisible());
  });
  it('状态请求失败时展示错误，解析失败不显示已提取正文', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'unavailable', message: '后端暂不可用' },
            }),
            { status: 503 },
          ),
      ),
    );
    show('prj_team', 'failed');
    await waitFor(() => expect(screen.getByText('暂时无法获取服务状态')).toBeInTheDocument());
    expect(screen.getByText('后端暂不可用')).toBeInTheDocument();
    expect(screen.queryByText(/这篇论文已提取出正文/)).not.toBeInTheDocument();
    expect(screen.getByText(/本次解析没有正常完成/)).toBeInTheDocument();
  });
});
