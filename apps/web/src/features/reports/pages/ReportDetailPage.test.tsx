import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { Report } from '@srh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { ReportDetailPage } from './ReportDetailPage';

const CONTENT = `## 本周进展

- 完成基线复现

## 下周计划

- 完成消融实验
- 写方法部分
`;

function report(over: Partial<Report> = {}): Report {
  return {
    id: 'r1',
    projectId: 'p1',
    title: '第 8 周组会',
    periodStart: '2026-10-19T16:00:00.000Z',
    periodEnd: '2026-10-26T15:59:59.999Z',
    status: 'draft',
    content: CONTENT,
    documentId: null,
    stats: { threads: 12, messages: 90, experiments: 5, reviews: 3, todos: 2, documents: 1 },
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
  projects: [{ id: 'p1', name: '课题', role: 'owner' }],
};
const MEMBERS = [
  {
    projectId: 'p1',
    user: { id: 'u1', name: '张三', email: 'z@example.com', avatarColor: 2, avatarUrl: null },
    role: 'owner',
    joinedAt: '',
  },
  {
    projectId: 'p1',
    user: { id: 'u2', name: '李四', email: 'l@example.com', avatarColor: 4, avatarUrl: null },
    role: 'member',
    joinedAt: '',
  },
];

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

let current: Report;
let fetchMock: ReturnType<typeof vi.fn>;

function renderPage() {
  const router = createMemoryRouter(
    [{ path: '/p/:projectId/reports/:reportId', element: <ReportDetailPage /> }],
    { initialEntries: ['/p/p1/reports/r1'] },
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <Providers queryClient={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('ReportDetailPage', () => {
  beforeEach(() => {
    current = report();
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.startsWith('/api/v1/auth/me')) return json(ME);
      if (url.startsWith('/api/v1/projects/p1/members')) return json(MEMBERS);
      if (url === '/api/v1/projects/p1/reports/r1' && method === 'PATCH') {
        current = { ...current, ...(JSON.parse(String(init?.body)) as Partial<Report>) };
        return json(current);
      }
      if (url === '/api/v1/projects/p1/reports/r1/todos') {
        const { items } = JSON.parse(String(init?.body)) as { items: unknown[] };
        return json(
          items.map((_, i) => ({ id: `t${i}` })),
          201,
        );
      }
      if (url === '/api/v1/projects/p1/reports/r1') return json(current);
      return json({ error: { code: 'not_found', message: '没有' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('草稿：编辑后 1s 自动保存，定稿后只读', async () => {
    renderPage();
    const editor = (await screen.findByLabelText('汇报正文（Markdown）')) as HTMLTextAreaElement;
    expect(editor.value).toBe(CONTENT);
    expect(screen.getAllByRole('heading', { name: '下周计划' }).length).toBeGreaterThan(0);

    fireEvent.change(editor, { target: { value: `${CONTENT}\n- 新加一条` } });
    await waitFor(
      () => {
        const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
        // 带上草稿基线版本，别人先改了会 409 而不是被覆盖
        expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
          content: `${CONTENT}\n- 新加一条`,
          baseVersion: 1,
        });
      },
      { timeout: 2500 },
    );
    expect(await screen.findAllByText('已保存')).not.toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: '定稿' }));
    expect(await screen.findByRole('button', { name: '改回草稿' })).toBeInTheDocument();
    expect(screen.queryByLabelText('汇报正文（Markdown）')).not.toBeInTheDocument();
    expect(screen.getByText('新加一条')).toBeInTheDocument();
  });

  it('标题只占一层上下文标题，重命名仍按原接口保存', async () => {
    renderPage();
    const rename = await screen.findByRole('button', { name: '标题：第 8 周组会（点击修改）' });
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(document.querySelector('h1 h1')).toBeNull();
    fireEvent.click(rename);
    const title = screen.getByRole('textbox', { name: '汇报标题' });
    fireEvent.change(title, { target: { value: '消融结果汇报' } });
    fireEvent.blur(title);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/projects/p1/reports/r1',
        expect.objectContaining({ method: 'PATCH', body: expect.stringContaining('消融结果汇报') }),
      ),
    );
  });

  it('拆成待办：抽取计划条目并提交', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '拆成待办' }));
    const dialog = await screen.findByRole('dialog', { name: '拆成待办' });
    const titles = within(dialog).getAllByRole('textbox') as HTMLInputElement[];
    expect(titles.map((t) => t.value)).toEqual(['完成消融实验', '写方法部分']);

    fireEvent.change(within(dialog).getByLabelText('第 2 条指派给'), { target: { value: 'u2' } });
    fireEvent.click(within(dialog).getByLabelText('创建第 1 条'));
    fireEvent.click(within(dialog).getByRole('button', { name: '创建 1 条待办' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/todos'));
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        items: [{ title: '写方法部分', assigneeId: 'u2' }],
      });
    });
  });

  it('生成中：显示 agent 光带骨架；失败时显示原因与重试', async () => {
    current = report({ status: 'generating', content: '', stats: null });
    const { unmount } = renderPage();
    expect(await screen.findByText('正在整理这一期的上下文')).toBeInTheDocument();
    expect(screen.queryByLabelText('汇报正文（Markdown）')).not.toBeInTheDocument();
    unmount();

    current = report({ error: '模型服务暂时不可用', content: '' });
    renderPage();
    expect(await screen.findByText('生成失败：模型服务暂时不可用')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('来源说明折叠区', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '这份汇报参考了什么' }));
    expect(await screen.findByText('讨论消息')).toBeInTheDocument();
    expect(screen.getByText('90')).toBeInTheDocument();
  });

  it('生成后论文又改了：标出内容可能已过期，一键按最新内容重新生成', async () => {
    current = report({
      outdatedBy: [
        {
          kind: 'document',
          id: 'doc_paper',
          title: '论文 v2',
          updatedAt: '2026-10-26T09:00:00.000Z',
        },
        {
          kind: 'experiment',
          id: 'exp_02',
          title: 'exp-02 留出类别',
          updatedAt: '2026-10-26T09:01:00.000Z',
        },
      ],
    });
    renderPage();
    const banner = await screen.findByText(/内容可能已过期/u);
    const box = banner.closest('[role="status"]') as HTMLElement;
    expect(within(box).getByRole('link', { name: '「论文 v2」' })).toHaveAttribute(
      'href',
      '/p/p1/docs/doc_paper',
    );
    expect(within(box).getByRole('link', { name: '「exp-02 留出类别」' })).toHaveAttribute(
      'href',
      '/p/p1/experiments/exp_02',
    );
    fireEvent.click(within(box).getByRole('button', { name: '按最新内容重新生成' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).endsWith('/reports/r1/regenerate')),
      ).toBe(true),
    );
  });
});
