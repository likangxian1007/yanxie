import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { researchKey, useResearchEvents } from './data';

const events = vi.hoisted(() => ({
  listener: null as null | ((event: { type: string; payload: unknown }) => void),
}));
vi.mock('@/lib/realtime', () => ({
  useProjectEvent: (_pid: string, listener: typeof events.listener) => {
    events.listener = listener;
  },
}));

it('正文旧事件仍独立合并新位置，旧布局不倒退且不重载画布', () => {
  const client = new QueryClient();
  const key = researchKey('p', 'workspace', 'r');
  client.setQueryData(key, {
    items: [
      {
        id: 'item',
        recordId: 'r',
        version: 5,
        positionVersion: 3,
        position: { x: 30, y: 0 },
        title: '最新正文',
      },
    ],
  });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const { unmount } = renderHook(() => useResearchEvents('p'), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  act(() =>
    events.listener!({
      type: 'research.item.updated',
      payload: {
        id: 'item',
        recordId: 'r',
        version: 4,
        positionVersion: 4,
        position: { x: 40, y: 0 },
        title: '旧正文',
      },
    }),
  );
  expect(client.getQueryData(key)).toMatchObject({
    items: [{ title: '最新正文', version: 5, positionVersion: 4, position: { x: 40, y: 0 } }],
  });
  act(() =>
    events.listener!({
      type: 'research.item.updated',
      payload: {
        id: 'item',
        recordId: 'r',
        version: 4,
        positionVersion: 2,
        position: { x: 20, y: 0 },
      },
    }),
  );
  expect(client.getQueryData(key)).toMatchObject({
    items: [{ positionVersion: 4, position: { x: 40, y: 0 } }],
  });
  expect(invalidate).not.toHaveBeenCalled();
  unmount();
  client.clear();
});
