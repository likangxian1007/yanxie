import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { Todo } from '@srh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { qk } from '@/lib/query-keys';
import { ck } from '@/features/collab-kit/keys';
import { ACTIVE_PROJECT_THREADS } from '@/features/collab-kit/assignees';
import { TodosPage } from './TodosPage';

const PID = 'prj_1';

function todo(id: string, position: string, extra: Partial<Todo> = {}): Todo {
  return {
    id,
    projectId: PID,
    ownerUserId: null,
    assigneeId: null,
    title: `待办 ${id}`,
    notes: '',
    done: false,
    priority: 'normal',
    dueAt: null,
    position,
    source: null,
    createdBy: { kind: 'user', id: 'usr_a', name: '张三' },
    createdAt: '2026-10-01T00:00:00.000Z',
    completedAt: null,
    ...extra,
  };
}

const TODOS = [
  todo('t1', 'a1', { title: '整理数据', priority: 'urgent', assigneeId: 'usr_a' }),
  todo('t2', 'a2', {
    title: '改引言',
    ownerUserId: 'usr_a',
    source: { kind: 'report', id: 'rpt_1' },
  }),
  todo('t3', 'a3', { title: '别人的事', assigneeId: 'usr_b' }),
  todo('t4', 'a0', { title: '已经做完', done: true, completedAt: '2026-10-20T00:00:00.000Z' }),
];

function renderTodos(path = `/p/${PID}/todos`) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(qk.me, {
    user: { id: 'usr_a', name: '张三', email: 'a@lab.edu', avatarColor: 1, avatarUrl: null },
    projects: [{ id: PID, role: 'member' }],
  });
  qc.setQueryData(qk.members(PID), []);
  qc.setQueryData(qk.threads(PID, ACTIVE_PROJECT_THREADS), []);
  qc.setQueryData(ck.todos(PID), TODOS);
  const router = createMemoryRouter([{ path: '/p/:projectId/todos', element: <TodosPage /> }], {
    initialEntries: [path],
  });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return qc;
}

describe('TodosPage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { title: string; priority: Todo['priority'] };
        return new Response(
          JSON.stringify(todo('t9', 'b0', { title: body.title, priority: body.priority })),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('全部：进行中的待办、来源与个人标记，已完成在底部', async () => {
    renderTodos();
    const list = await screen.findByRole('list', { name: '进行中的待办' });
    expect(within(list).getAllByRole('checkbox')).toHaveLength(3);
    expect(within(list).getByText('紧急')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: /来自组会汇报/u })).toHaveAttribute(
      'href',
      `/p/${PID}/reports/rpt_1`,
    );
    expect(within(list).getByRole('img', { name: '个人待办，只有你能看到' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: '最近完成的待办' })).toHaveTextContent('已经做完');
  });

  it('我的：只剩指派给我和我的个人待办', async () => {
    renderTodos();
    fireEvent.click(await screen.findByRole('tab', { name: /我的/u }));
    const list = screen.getByRole('list', { name: '进行中的待办' });
    expect(list).toHaveTextContent('整理数据');
    expect(list).toHaveTextContent('改引言');
    // 被筛掉的行有退场动画
    await waitFor(() => expect(list).not.toHaveTextContent('别人的事'));
  });

  it('快速添加：解析优先级并提交', async () => {
    const qc = renderTodos();
    const input = await screen.findByRole('textbox', { name: '添加待办' });
    fireEvent.change(input, { target: { value: '写摘要 !高' } });
    expect(screen.getByText('标记为高')).toBeInTheDocument();
    fireEvent.submit(input.closest('form')!);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/projects/${PID}/todos`),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      title: '写摘要',
      priority: 'high',
    });
    await waitFor(() => expect(qc.getQueryData<Todo[]>(ck.todos(PID))).toHaveLength(5));
  });

  it('?todo= 指向已完成项时切到已完成并高亮', async () => {
    renderTodos(`/p/${PID}/todos?todo=t4`);
    const list = await screen.findByRole('list', { name: '已完成的待办' });
    expect(list.querySelector('[data-todo-id="t4"]')).not.toBeNull();
  });
});
