import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useNavigate } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createListStateStore,
  listStateKey,
  listStateStore,
  updateListSearch,
  useListQueryState,
  useListStateScope,
} from './list-state';

let accountId = 'usr_a';
vi.mock('./session', () => ({ useMeUser: () => ({ id: accountId }) }));
beforeEach(() => {
  accountId = 'usr_a';
  listStateStore.clear();
});

function List() {
  useListStateScope('docs');
  const navigate = useNavigate();
  const [q, setQ] = useListQueryState('q', '');
  const [status, setStatus] = useListQueryState('status', 'all');
  return (
    <>
      <p>
        {q}:{status}
      </p>
      <button
        onClick={() => {
          setQ(null);
          setStatus(null);
        }}
      >
        清除筛选
      </button>
      <button data-list-item="doc:a" onClick={() => navigate('/p/p_a/docs/a')}>
        条目
      </button>
    </>
  );
}
function fixture(initialEntries = ['/p/p_a/docs']) {
  const router = createMemoryRouter(
    [
      { path: '/p/:projectId/docs', element: <List /> },
      { path: '/p/:projectId/docs/:id', element: <p>详情</p> },
    ],
    { initialEntries },
  );
  return {
    router,
    view: render(
      <div id="app-scroll">
        <RouterProvider router={router} />
      </div>,
    ),
  };
}

describe('列表返回状态', () => {
  it('工作区独立滚动容器使用固定列表路径跨会话恢复', async () => {
    function WorkspaceList() {
      useListStateScope('sessions', {
        scrollElementId: 'workspace-list-scroll',
        path: '/p/p_a/workspace',
      });
      const navigate = useNavigate();
      return (
        <button data-list-item="session:a" onClick={() => navigate('/p/p_a/away')}>
          工作区会话
        </button>
      );
    }
    const router = createMemoryRouter(
      [
        { path: '/p/:projectId/workspace/:sessionId', element: <WorkspaceList /> },
        { path: '/p/:projectId/away', element: <p>其他页面</p> },
      ],
      { initialEntries: ['/p/p_a/workspace/session_a'] },
    );
    render(
      <div id="app-scroll">
        <div id="workspace-list-scroll">
          <RouterProvider router={router} />
        </div>
      </div>,
    );
    const root = document.getElementById('workspace-list-scroll')!;
    root.scrollTop = 320;
    fireEvent.scroll(root);
    const item = screen.getByRole('button', { name: '工作区会话' });
    item.focus();
    fireEvent.click(item);
    root.scrollTop = 0;
    await act(() => router.navigate('/p/p_a/workspace/session_b'));
    expect(root.scrollTop).toBe(320);
    expect(document.getElementById('app-scroll')!.scrollTop).toBe(0);
    expect(screen.getByRole('button', { name: '工作区会话' })).toHaveFocus();
  });

  it('按账号、课题、路径、scope 隔离，并限制 50 条 LRU', () => {
    const store = createListStateStore();
    const key = listStateKey('a', 'p', '/docs', 'docs');
    expect(key).not.toBe(listStateKey('b', 'p', '/docs', 'docs'));
    expect(key).not.toBe(listStateKey('a', 'other', '/docs', 'docs'));
    expect(key).not.toBe(listStateKey('a', 'p', '/reviews', 'docs'));
    for (let i = 0; i < 50; i++) store.set(String(i), { scrollTop: i, focus: null });
    store.get('0');
    store.set('50', { scrollTop: 50, focus: 'doc:a' });
    expect(store.size).toBe(50);
    expect(store.get('1')).toBeUndefined();
    expect(store.get('0')?.scrollTop).toBe(0);
  });
  it('修改查询只影响指定项，多个 setter 同事件不丢参数', () => {
    expect(
      updateListSearch('?q=abc&preview=doc:a&tab=mine', { q: null, sort: 'title' }).toString(),
    ).toBe('preview=doc%3Aa&tab=mine&sort=title');
    const { router } = fixture(['/p/p_a/docs?q=abc&status=draft&view=grid&tab=mine']);
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(router.state.location.search).toBe('?view=grid&tab=mine');
  });
  it('从完整页后退恢复 app-scroll 与条目焦点', async () => {
    const { router } = fixture();
    const root = document.getElementById('app-scroll')!;
    root.scrollTop = 480;
    fireEvent.scroll(root);
    const item = screen.getByRole('button', { name: '条目' });
    item.focus();
    fireEvent.click(item);
    expect(await screen.findByText('详情')).toBeInTheDocument();
    root.scrollTop = 0;
    await act(() => router.navigate(-1));
    expect(root.scrollTop).toBe(480);
    expect(screen.getByRole('button', { name: '条目' })).toHaveFocus();
  });
  it('其他账号不读取前一个账号的滚动与焦点', async () => {
    const { router } = fixture();
    const root = document.getElementById('app-scroll')!;
    root.scrollTop = 600;
    fireEvent.scroll(root);
    fireEvent.click(screen.getByRole('button', { name: '条目' }));
    root.scrollTop = 0;
    accountId = 'usr_b';
    await act(() => router.navigate(-1));
    expect(root.scrollTop).toBe(0);
    expect(screen.getByRole('button', { name: '条目' })).not.toHaveFocus();
  });
});
