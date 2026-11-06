import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { Board, Card, ProjectRole } from '@srh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { qk } from '@/lib/query-keys';
import { ck } from '@/features/collab-kit/keys';
import { ACTIVE_PROJECT_THREADS } from '@/features/collab-kit/assignees';
import type { BoardDetail } from '../lib/board-state';
import { BoardPage } from './BoardPage';

const PID = 'prj_1';
const BOARD: Board = {
  id: 'brd_1',
  projectId: PID,
  name: '默认看板',
  createdAt: '2026-10-01T00:00:00.000Z',
  columns: [
    { id: 'col_a', boardId: 'brd_1', name: '想法', position: 'a1', color: 0 },
    { id: 'col_b', boardId: 'brd_1', name: '进行中', position: 'a2', color: 3 },
  ],
};

function card(id: string, columnId: string, position: string, extra: Partial<Card> = {}): Card {
  return {
    id,
    boardId: 'brd_1',
    columnId,
    title: `卡片 ${id}`,
    description: '',
    position,
    assigneeIds: [],
    labels: [],
    dueAt: null,
    threadId: null,
    experimentId: null,
    version: 1,
    createdBy: { kind: 'user', id: 'usr_a', name: '张三' },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  };
}

const DETAIL: BoardDetail = {
  ...BOARD,
  cards: [
    card('c1', 'col_a', 'a1', { title: '读 MedSegDiff', labels: ['调研'] }),
    card('c2', 'col_b', 'a1', { title: '复现 baseline', assigneeIds: ['agent:coordinator'] }),
  ],
};

function renderBoard(role: ProjectRole, path = `/p/${PID}/board`) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(qk.me, {
    user: { id: 'usr_a', name: '张三', email: 'a@lab.edu', avatarColor: 1, avatarUrl: null },
    projects: [{ id: PID, role }],
  });
  qc.setQueryData(qk.members(PID), []);
  qc.setQueryData(qk.threads(PID, ACTIVE_PROJECT_THREADS), []);
  qc.setQueryData(qk.threads(PID, { kind: 'project' }), []);
  qc.setQueryData(ck.boards(PID), [BOARD]);
  qc.setQueryData(ck.board(PID, BOARD.id), DETAIL);
  const router = createMemoryRouter([{ path: '/p/:projectId/board', element: <BoardPage /> }], {
    initialEntries: [path],
  });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { qc, router };
}

describe('BoardPage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('[]', { status: 200 })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('渲染列、计数与卡片，可写时显示添加入口', async () => {
    renderBoard('member');
    const idea = await screen.findByRole('region', { name: '想法，1 张卡片' });
    expect(within(idea).getByText('读 MedSegDiff')).toBeInTheDocument();
    expect(within(idea).getByText('调研')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '进行中，1 张卡片' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '添加卡片' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: '添加列' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建看板' })).toBeInTheDocument();
  });

  it('访客只读：没有添加入口', async () => {
    renderBoard('guest');
    await screen.findByText('读 MedSegDiff');
    expect(screen.queryByRole('button', { name: '添加卡片' })).toBeNull();
    expect(screen.queryByRole('button', { name: '添加列' })).toBeNull();
    expect(screen.queryByRole('button', { name: '新建看板' })).toBeNull();
  });

  it('按标题筛选', async () => {
    const { router } = renderBoard('member', `/p/${PID}/board?board=brd_1&other=keep`);
    await screen.findByText('读 MedSegDiff');
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索卡片标题' }), {
      target: { value: 'baseline' },
    });
    // 被筛掉的卡片有退场动画
    await waitFor(() => expect(screen.queryByText('读 MedSegDiff')).toBeNull());
    expect(screen.getByText('复现 baseline')).toBeInTheDocument();
    expect(screen.getByText('没有符合筛选的卡片')).toBeInTheDocument();
    const params = new URLSearchParams(router.state.location.search);
    expect(params.get('q')).toBe('baseline');
    expect(params.get('board')).toBe('brd_1');
    expect(params.get('other')).toBe('keep');
  });

  it('URL 恢复组合筛选，清除时保留看板和其他参数', async () => {
    const { router } = renderBoard(
      'member',
      `/p/${PID}/board?board=brd_1&q=MedSeg&assignee=none&label=调研&other=keep`,
    );
    expect(await screen.findByText('读 MedSegDiff')).toBeInTheDocument();
    expect(screen.queryByText('复现 baseline')).toBeNull();
    expect(screen.getByRole('searchbox', { name: '搜索卡片标题' })).toHaveValue('MedSeg');
    expect(screen.getByRole('combobox', { name: '按指派筛选' })).toHaveValue('none');
    expect(screen.getByRole('combobox', { name: '按标签筛选' })).toHaveValue('调研');
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(await screen.findByText('复现 baseline')).toBeInTheDocument();
    expect(screen.getByText('读 MedSegDiff')).toBeInTheDocument();
    await waitFor(() => {
      const params = new URLSearchParams(router.state.location.search);
      expect(params.get('q')).toBeNull();
      expect(params.get('assignee')).toBeNull();
      expect(params.get('label')).toBeNull();
      expect(params.get('board')).toBe('brd_1');
      expect(params.get('other')).toBe('keep');
    });
  });

  it('?card= 打开卡片详情', async () => {
    renderBoard('member', `/p/${PID}/board?card=c2`);
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('复现 baseline')).toBeInTheDocument();
    expect(within(sheet).getByText('已指派给 agent，它会被唤醒来推进这张卡')).toBeInTheDocument();
  });
});
