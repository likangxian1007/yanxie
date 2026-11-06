import { webcrypto } from 'node:crypto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Message, User } from '@srh/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { useSendMessage } from './messages';
import { qk } from './query-keys';
import type { MessagePages } from './apply-event';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('sends team and agent messages on HTTP where randomUUID is absent', async () => {
  vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const me = { id: 'u', name: '测试' } as User;
  for (const channel of ['agent', 'team'] as const) {
    qc.setQueryData(qk.timeline('p', channel), {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [null],
    });
  }
  const post = vi.spyOn(api, 'post').mockImplementation(
    async (_path, input) =>
      ({
        id: `msg_${(input as { agentVisible: boolean }).agentVisible}`,
        projectId: 'p',
        threadId: null,
        author: { id: 'u', name: '测试', kind: 'user' },
        kind: 'text',
        body: 'HTTP 回归',
        agentVisible: (input as { agentVisible: boolean }).agentVisible,
        meta: {},
        reactions: [],
        outputs: [],
        rootOfThreadId: null,
        createdAt: '2026-10-27T00:00:00Z',
        editedAt: null,
      }) as Message,
  );
  const { result } = renderHook(() => useSendMessage('p', null, me), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  });
  for (const agentVisible of [true, false]) {
    await act(async () => {
      await result.current.mutateAsync({ body: 'HTTP 回归', agentVisible });
    });
    const data = qc.getQueryData<MessagePages>(qk.timeline('p', agentVisible ? 'agent' : 'team'));
    expect(data?.pages[0]?.items.map((m) => m.id)).toEqual([`msg_${agentVisible}`]);
  }
  expect(post).toHaveBeenCalledTimes(2);
});
