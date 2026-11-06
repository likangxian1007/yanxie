import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { useRealtimeStore } from '@/lib/realtime-store';
import { qk } from '@/lib/query-keys';
import { api } from '@/lib/api';
import type { PresenceState } from '@srh/shared';
import { PresenceSummary } from './PresenceSummary';
vi.mock('@/lib/session', () => ({
  useMeUser: () => ({ id: 'self' }),
  useMe: () => ({ data: { projects: [{ id: 'p', role: 'owner' }] } }),
}));
const member = (id: string): PresenceState => ({
  userId: id,
  name: id,
  avatarColor: 0,
  view: 'document',
  objectId: 'doc',
  activity: 'viewing',
  lastSeenAt: '2026-11-01T00:00:00Z',
});
const roster = ['self', 'a', 'b'].map((id) => ({
  projectId: 'p',
  user: { id, name: id, email: `${id}@example.test`, avatarColor: 0 },
  role: id === 'self' ? 'owner' : 'member',
  joinedAt: '2026-11-01T00:00:00Z',
}));
function mount(cache = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cache) qc.setQueryData(qk.members('p'), roster);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PresenceSummary projectId="p" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}
beforeEach(() => {
  useRealtimeStore.setState({ status: 'open', presence: { p: [member('self')] } });
});
it('仅自己在线也可查看全部成员，支持搜索和管理入口', async () => {
  mount();
  const trigger = screen.getByRole('button', { name: '成员 · 3' });
  fireEvent.click(trigger);
  expect(screen.getAllByRole('listitem')).toHaveLength(3);
  expect(screen.getByText('你')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '邀请成员' })).toHaveAttribute(
    'href',
    '/p/p/settings?tab=invites',
  );
  fireEvent.change(screen.getByLabelText('搜索成员'), { target: { value: 'a@example' } });
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(trigger).toHaveFocus();
});
it('在线状态按人去重，断线保持完整名单并标记未知，实时成员变化更新总数', async () => {
  const qc = mount();
  act(() =>
    useRealtimeStore.getState().setPresence('p', [member('a'), member('a'), member('self')]),
  );
  fireEvent.click(screen.getByRole('button', { name: '成员 · 3' }));
  expect(screen.getAllByRole('listitem')).toHaveLength(3);
  expect(screen.getAllByText(/ · 在线$/)).toHaveLength(2);
  act(() => useRealtimeStore.getState().setStatus('reconnecting'));
  expect(screen.getAllByText(/在线状态未知/)).toHaveLength(3);
  act(() => qc.setQueryData(qk.members('p'), roster.slice(0, 2)));
  expect(await screen.findByRole('button', { name: '成员 · 2' })).toBeInTheDocument();
});
it('加载失败提供重试', async () => {
  vi.spyOn(api, 'get').mockRejectedValueOnce(new Error('断线'));
  mount(false);
  fireEvent.click(screen.getByRole('button', { name: '成员' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('成员加载失败');
  expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
});
