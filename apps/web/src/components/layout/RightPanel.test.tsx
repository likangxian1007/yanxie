import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, ApiRequestError } from '@/lib/api';
import { ResourcePreviewLink } from '@/features/resource-preview/ResourcePreviewLink';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RightPanel } from './RightPanel';
import { usePanelThreads } from '@/features/coordinator/use-panel-threads';
import { isProfessionalWorkspace, useLayoutStore } from './layout-store';

vi.mock('@/features/coordinator/use-panel-threads', () => ({
  usePanelThreads: vi.fn(() => ({
    rows: [],
    waitingOnMe: 0,
    isPending: false,
    error: null,
    refetch: vi.fn(),
    nameOf: vi.fn(),
    colorOf: vi.fn(),
  })),
}));
vi.mock('@/features/coordinator/components/ThreadPanel', () => ({
  ThreadPanel: ({
    selectedId,
    onSelect,
  }: {
    selectedId: string | null;
    onSelect: (id: string | null) => void;
  }) => {
    const [draft, setDraft] = useState('');
    return (
      <div>
        <p>{selectedId ? `选中 ${selectedId}` : '线程列表'}</p>
        <button onClick={() => onSelect('thr_a')}>打开测试线程</button>
        <input
          aria-label="面板草稿"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </div>
    );
  },
}));
vi.mock('@/lib/project', () => ({
  useAgents: () => ({ data: [] }),
  useClaims: () => ({ data: [] }),
  useThreads: () => ({ data: [] }),
  useMemberMap: () => new Map(),
  isAgentBusy: () => false,
}));
vi.mock('@/lib/realtime', () => ({ useProjectEvent: vi.fn() }));
vi.mock('./presence', () => ({ usePresenceMembers: () => [] }));
vi.mock('./use-panel-lookup', () => ({ usePanelLookup: () => ({}) }));

function Fixture() {
  const location = useLocation();
  const [editor, setEditor] = useState('原始编辑内容');
  return (
    <>
      <button data-panel-trigger onClick={() => useLayoutStore.getState().setRightPanelOpen(true)}>
        打开辅助面板
      </button>
      <p data-testid="current-url">{location.pathname + location.search}</p>
      <textarea
        aria-label="专业编辑器"
        value={editor}
        onChange={(event) => setEditor(event.target.value)}
      />
      <ResourcePreviewLink type="doc" id="doc_a">
        预览测试文档
      </ResourcePreviewLink>
      <RightPanel />
    </>
  );
}
function renderPanel(path = '/p/prj_a') {
  const router = createMemoryRouter([{ path: '/p/:projectId/*', element: <Fixture /> }], {
    initialEntries: [path],
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}
let inline = false;
beforeEach(() => {
  inline = false;
  vi.clearAllMocks();
  useLayoutStore.setState({ rightPanelOpen: false, panelTab: 'threads' });
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('1280') && inline,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('统一辅助面板', () => {
  it('初始关闭不挂载线程数据层，首次打开才查询', async () => {
    renderPanel();
    expect(usePanelThreads).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('textbox', { name: '面板草稿', hidden: true }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '打开辅助面板' }));
    expect(await screen.findByRole('textbox', { name: '面板草稿' })).toBeInTheDocument();
    expect(usePanelThreads).toHaveBeenCalled();
  });

  it.each([false, true])('所有宽度默认关闭（inline=%s），打开后只有一个面板', async (wide) => {
    inline = wide;
    renderPanel();
    expect(
      screen.queryByRole(wide ? 'complementary' : 'dialog', { name: '辅助面板' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '打开辅助面板' }));
    expect(
      await screen.findByRole(wide ? 'complementary' : 'dialog', { name: '辅助面板' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('tablist', { name: '辅助面板内容' })).toHaveLength(1);
  });
  it('深链接自动打开线程，关闭移除参数，前进后退恢复对应状态', async () => {
    const router = renderPanel('/p/prj_a?thread=thr_a');
    expect(await screen.findByRole('dialog', { name: '辅助面板' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '线程' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('选中 thr_a')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭辅助面板' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(screen.queryByRole('dialog', { name: '辅助面板' })).not.toBeInTheDocument();
    await act(() => router.navigate(-1));
    expect(router.state.location.search).toBe('?thread=thr_a');
    expect(await screen.findByRole('dialog', { name: '辅助面板' })).toBeInTheDocument();
    await act(() => router.navigate(1));
    expect(router.state.location.search).toBe('');
    expect(screen.queryByText('选中 thr_a')).not.toBeInTheDocument();
  });
  it('快速切到动态再后退，恢复 URL 对应的线程页签', async () => {
    const router = renderPanel('/p/prj_a?thread=thr_a');
    await screen.findByRole('dialog', { name: '辅助面板' });
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: '动态' }));
      await router.navigate(-1);
    });
    expect(router.state.location.search).toBe('?thread=thr_a');
    expect(screen.getByRole('tab', { name: '线程' })).toHaveAttribute('aria-selected', 'true');
  });
  it('切到动态移除线程参数，标签支持方向键且保留线程输入', async () => {
    const router = renderPanel('/p/prj_a?thread=thr_a');
    await screen.findByRole('dialog', { name: '辅助面板' });
    fireEvent.change(await screen.findByRole('textbox', { name: '面板草稿' }), {
      target: { value: '继续分析实验' },
    });
    const threads = screen.getByRole('tab', { name: '线程' });
    fireEvent.keyDown(threads, { key: 'ArrowRight' });
    const activity = screen.getByRole('tab', { name: '动态' });
    expect(activity).toHaveAttribute('aria-selected', 'true');
    expect(activity).toHaveAttribute('tabindex', '0');
    expect(threads).toHaveAttribute('tabindex', '-1');
    expect(activity).toHaveFocus();
    await waitFor(() => expect(router.state.location.search).toBe(''));
    fireEvent.keyDown(activity, { key: 'Home' });
    expect(await screen.findByRole('textbox', { name: '面板草稿' })).toHaveValue('继续分析实验');
    fireEvent.keyDown(threads, { key: 'End' });
    expect(activity).toHaveAttribute('aria-selected', 'true');
  });
  it('手机 Esc 关闭并恢复触发器焦点，重新打开保留输入', async () => {
    renderPanel();
    const trigger = screen.getByRole('button', { name: '打开辅助面板' });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole('dialog', { name: '辅助面板' });
    fireEvent.change(await screen.findByRole('textbox', { name: '面板草稿' }), {
      target: { value: '未发送的回复' },
    });
    fireEvent.keyDown(screen.getByRole('tab', { name: '线程' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '辅助面板' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    expect(await screen.findByRole('textbox', { name: '面板草稿' })).toHaveValue('未发送的回复');
  });
  it.each([
    'docs/doc_a',
    'library/ppr_a',
    'notebooks/nb_a',
    'reviews/rev_a',
    'reports/rpt_a',
    'research/rrc_a',
  ])('专业工作区 %s 持续互斥，编辑器不被重建', async (route) => {
    renderPanel(`/p/prj_a/${route}`);
    const editor = screen.getByRole('textbox', { name: '专业编辑器' });
    fireEvent.change(editor, { target: { value: '尚未同步的研究草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '打开辅助面板' }));
    expect(screen.queryByRole('dialog', { name: '辅助面板' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '专业编辑器' })).toBe(editor);
    expect(editor).toHaveValue('尚未同步的研究草稿');
  });
  it('列表路由允许全局面板，详情路由互斥', () => {
    for (const route of ['docs', 'library', 'experiments', 'threads', 'workspace', 'research'])
      expect(isProfessionalWorkspace(`/p/prj_a/${route}`)).toBe(false);
    expect(isProfessionalWorkspace('/p/prj_a/notebooks/nb_a')).toBe(true);
    expect(isProfessionalWorkspace('/p/prj_a/experiments/exp_a')).toBe(false);
    expect(isProfessionalWorkspace('/p/prj_a/desktop')).toBe(false);
  });
});

describe('资源辅助面板', () => {
  const metadata = {
    title: '研究计划',
    excerpt: '验证注意力机制',
    updatedAt: '2026-10-27T01:00:00.000Z',
    kind: 'doc',
    archivedAt: null,
  };
  it('列表预览保留筛选，完整页带返回上下文，关闭恢复焦点且不重建线程草稿', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue(metadata);
    const router = renderPanel('/p/prj_a/docs?tab=mine&q=abc');
    fireEvent.click(screen.getByRole('button', { name: '打开辅助面板' }));
    fireEvent.change(await screen.findByRole('textbox', { name: '面板草稿' }), {
      target: { value: '未发送的回复' },
    });
    const trigger = screen.getByRole('link', { name: '预览测试文档' });
    fireEvent.click(trigger);
    expect(await screen.findByText('研究计划')).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
    expect(router.state.location.search).toContain('tab=mine');
    const href = screen.getByRole('link', { name: '打开完整页面' }).getAttribute('href')!;
    expect(new URL(href, 'https://test.local').searchParams.get('returnTo')).toBe(
      '/p/prj_a/docs?tab=mine&q=abc',
    );
    fireEvent.click(screen.getByRole('button', { name: '关闭辅助面板' }));
    expect(router.state.location.search).toBe('?tab=mine&q=abc');
    expect(trigger).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: '打开辅助面板' }));
    expect(await screen.findByRole('textbox', { name: '面板草稿' })).toHaveValue('未发送的回复');
  });
  it('深链接和 history 恢复预览，URL 双参数归一为资源面板', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(metadata);
    const router = renderPanel('/p/prj_a/docs?preview=doc:doc_a&thread=thr_a&tab=mine');
    expect(await screen.findByText('研究计划')).toBeInTheDocument();
    expect(router.state.location.search).not.toContain('thread');
    fireEvent.click(screen.getByRole('button', { name: '关闭辅助面板' }));
    expect(screen.queryByText('研究计划')).not.toBeInTheDocument();
    await act(() => router.navigate(-1));
    expect(await screen.findByText('研究计划')).toBeInTheDocument();
    await act(() => router.navigate(1));
    expect(screen.queryByRole('dialog', { name: '辅助面板' })).not.toBeInTheDocument();
  });
  it.each([
    [401, '请重新登录后查看'],
    [403, '没有查看权限'],
    [404, '资源已删除或不可见'],
    [500, '预览加载失败'],
  ] as const)('状态 %s 可见且不提供失效完整页入口', async (status, title) => {
    vi.spyOn(api, 'get').mockRejectedValue(
      new ApiRequestError({ status, code: 'test', message: title }),
    );
    renderPanel('/p/prj_a/docs?preview=doc:doc_a');
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '打开完整页面' })).not.toBeInTheDocument();
  });
  it.each([
    [
      'paper',
      'ppr_a',
      '/library/papers/ppr_a',
      {
        title: '论文摘要',
        abstract: '注意力机制',
        year: 2026,
        venue: '研讨会',
        citekey: 'attention2026',
        status: 'ready',
        archivedAt: null,
      },
      '论文摘要',
    ],
    [
      'review',
      'rev_a',
      '/reviews/rev_a',
      {
        title: '方法审阅',
        summary: '核对假设',
        reviewers: [],
        commentCount: 2,
        status: 'changes_requested',
      },
      '方法审阅',
    ],
    [
      'report',
      'rpt_a',
      '/reports/rpt_a',
      {
        title: '本周进展',
        content: '已完成实验',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-07',
        status: 'draft',
        error: '生成中断，请到完整页重新生成',
      },
      '本周进展',
    ],
  ] as const)('%s 仅加载元信息且支持完整页', async (type, id, endpoint, record, title) => {
    const get = vi
      .spyOn(api, 'get')
      .mockResolvedValue({ ...record, updatedAt: '2026-10-27T01:00:00.000Z' });
    renderPanel(`/p/prj_a/docs?preview=${type}:${id}`);
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(get).toHaveBeenCalledExactlyOnceWith(
      `/projects/prj_a${endpoint}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByRole('link', { name: '打开完整页面' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭辅助面板' }));
    fireEvent.click(screen.getByRole('button', { name: '打开辅助面板' }));
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('旧实验引用显示移除说明，不请求旧 API', async () => {
    const get = vi.spyOn(api, 'get');
    renderPanel('/p/prj_a/docs?preview=experiment:exp_a');
    expect(await screen.findByText('内容已移除')).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: '打开研究空间' })).toHaveAttribute(
      'href',
      '/p/prj_a/research',
    );
  });
  it('请求失败可重试，成功后显示当前资源', async () => {
    const get = vi
      .spyOn(api, 'get')
      .mockRejectedValueOnce(
        new ApiRequestError({ status: 500, code: 'internal', message: '失败' }),
      )
      .mockResolvedValue(metadata);
    renderPanel('/p/prj_a/docs?preview=doc:doc_a');
    fireEvent.click(await screen.findByRole('button', { name: '重试' }));
    expect(await screen.findByText('研究计划')).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
  });
  it('隐藏或专业页面不请求资源', () => {
    const get = vi.spyOn(api, 'get');
    renderPanel('/p/prj_a/docs/doc_b?preview=doc:doc_a');
    expect(get).not.toHaveBeenCalled();
  });
});
