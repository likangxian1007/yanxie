import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { Report } from '@srh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { ReportsPage } from './ReportsPage';

function report(id: string, over: Partial<Report> = {}): Report {
  return {
    id,
    projectId: 'p1',
    title: `汇报 ${id}`,
    periodStart: '2026-10-19T16:00:00.000Z',
    periodEnd: '2026-10-26T15:59:59.999Z',
    status: 'draft',
    content: '',
    documentId: null,
    stats: null,
    error: null,
    version: 1,
    createdBy: { kind: 'user', id: 'u1', name: '张三' },
    createdAt: '2026-10-26T08:00:00.000Z',
    updatedAt: '2026-10-26T08:00:00.000Z',
    ...over,
  };
}

const ME = {
  user: {
    id: 'u1',
    email: 'z@example.com',
    name: '张三',
    avatarColor: 2,
    avatarUrl: null,
    createdAt: '',
  },
  projects: [{ id: 'p1', name: '课题', role: 'member' }],
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

let reports: Report[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

function renderPage(path = '/p/p1/reports') {
  const router = createMemoryRouter(
    [
      { path: '/p/:projectId/reports', element: <ReportsPage /> },
      { path: '/p/:projectId/reports/:reportId', element: <h1>汇报详情</h1> },
    ],
    { initialEntries: [path] },
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <Providers queryClient={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('ReportsPage', () => {
  beforeEach(() => {
    reports = [];
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.startsWith('/api/v1/auth/me')) return json(ME);
      if (url.startsWith('/api/v1/projects/p1/members')) return json([]);
      if (url === '/api/v1/projects/p1/reports' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { title: string };
        return json(report('new', { title: body.title, status: 'generating' }), 201);
      }
      if (url === '/api/v1/projects/p1/reports') return json(reports);
      return json({ error: { code: 'not_found', message: '没有' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('渲染汇报卡片：状态、期间、上下文规模、生成中', async () => {
    reports = [
      report('a', {
        title: '第 8 周组会',
        status: 'final',
        stats: { threads: 12, messages: 90, experiments: 5, reviews: 3, todos: 0, documents: 0 },
        createdAt: '2026-10-25T00:00:00.000Z',
      }),
      report('b', { title: '第 9 周组会', status: 'generating' }),
      report('c', {
        title: '失败的一期',
        error: '模型服务暂时不可用',
        createdAt: '2026-10-01T00:00:00.000Z',
      }),
    ];
    renderPage();

    const list = await screen.findByRole('list', { name: '汇报列表' });
    const items = within(list).getAllByRole('listitem');
    // 按创建时间新到旧
    expect(items.map((li) => within(li).getByRole('heading').textContent)).toEqual([
      '第 9 周组会',
      '第 8 周组会',
      '失败的一期',
    ]);
    expect(within(items[1] as HTMLElement).getByText('定稿')).toBeInTheDocument();
    expect(
      within(items[1] as HTMLElement).getByText('整理了 12 个线程 · 5 个实验 · 3 个审阅'),
    ).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).getByText('生成中')).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).getByText('正在整理这一期的上下文')).toBeInTheDocument();
    expect(
      within(items[2] as HTMLElement).getByText(/生成失败：模型服务暂时不可用/u),
    ).toBeInTheDocument();
    expect(
      within(items[0] as HTMLElement).getByRole('link', { name: '第 9 周组会' }),
    ).toHaveAttribute('href', '/p/p1/reports?preview=report%3Ab');
    expect(within(items[0] as HTMLElement).getByRole('link', { name: '完整页面' })).toHaveAttribute(
      'href',
      '/p/p1/reports/b?returnTo=%2Fp%2Fp1%2Freports',
    );
  });

  it('从 URL 恢复搜索状态，预览保留其他参数，完整页入口仍可达', async () => {
    reports = [
      report('a', { title: '消融结果', status: 'final' }),
      report('b', { title: '基线周报' }),
    ];
    renderPage('/p/p1/reports?q=消融&status=final&other=keep');
    expect(await screen.findByRole('link', { name: '消融结果' })).toHaveAttribute(
      'href',
      '/p/p1/reports?q=%E6%B6%88%E8%9E%8D&status=final&other=keep&preview=report%3Aa',
    );
    expect(screen.getByRole('searchbox', { name: '搜索汇报' })).toHaveValue('消融');
    expect(screen.queryByRole('link', { name: '基线周报' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: '完整页面' }));
    expect(await screen.findByRole('heading', { name: '汇报详情' })).toBeInTheDocument();
  });

  it('空状态 → 生成汇报对话框 → 提交后跳到详情', async () => {
    renderPage();
    expect(await screen.findByText('还没有组会汇报')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '生成汇报' }));

    const dialog = await screen.findByRole('dialog', { name: '生成汇报' });
    const title = within(dialog).getByLabelText('标题') as HTMLInputElement;
    expect(title.value).toMatch(/^组会汇报 · \d+月\d+日–\d+月\d+日$/u);

    fireEvent.click(within(dialog).getByRole('button', { name: '上周' }));
    fireEvent.change(within(dialog).getByLabelText(/额外要求/u), {
      target: { value: '重点讲消融实验' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '开始生成' }));

    expect(await screen.findByRole('heading', { name: '汇报详情' })).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    const body = JSON.parse(String(post?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ generate: true, instructions: '重点讲消融实验' });
    expect(body.periodStart).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(body.periodEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(body.title).toBe(title.value);
  });

  it('自定义期间校验', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '生成汇报' }));
    const dialog = await screen.findByRole('dialog', { name: '生成汇报' });
    fireEvent.click(within(dialog).getByRole('button', { name: '自定义' }));
    fireEvent.change(within(dialog).getByLabelText('开始日期'), {
      target: { value: '2026-10-27' },
    });
    fireEvent.change(within(dialog).getByLabelText('结束日期'), {
      target: { value: '2026-10-20' },
    });
    await waitFor(() =>
      expect(within(dialog).getByText('结束日期不能早于开始日期')).toBeInTheDocument(),
    );
    expect(within(dialog).getByRole('button', { name: '开始生成' })).toBeDisabled();
  });
});
