import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { DocumentMeta } from '@srh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { DocsPage } from '../pages/DocsPage';

function doc(id: string, over: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    id,
    projectId: 'p1',
    parentId: null,
    kind: 'doc',
    title: id,
    icon: null,
    excerpt: '',
    createdBy: { kind: 'user', id: 'u1', name: '张三' },
    updatedBy: { kind: 'agent', id: 'ses_1', name: '协调者' },
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    archivedAt: null,
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

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

let docs: DocumentMeta[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

// 整页渲染（路由 + Query + 动效 + 懒加载）：完整 `pnpm check` 并行跑、机器负载高时，
// 默认的 5s 用例超时和 findBy* 的 1s 等待都会偶发超时，这里放宽
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

function renderPage(path = '/p/p1/docs') {
  const router = createMemoryRouter(
    [
      { path: '/p/:projectId/docs', element: <DocsPage /> },
      { path: '/p/:projectId/docs/:docId', element: <h1>文档详情</h1> },
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

describe('DocsPage', () => {
  beforeEach(() => {
    docs = [
      doc('d1', {
        title: '实验周报 第 8 周',
        excerpt: '本周完成了消融实验',
        updatedAt: '2026-10-25T00:00:00.000Z',
      }),
      doc('s1', { kind: 'sheet', title: '实验数据记录表', excerpt: '实验编号\t模型\tacc' }),
      doc('l1', { kind: 'latex', title: 'ICLR 投稿', excerpt: '\\documentclass{article}' }),
      doc('d1c', { parentId: 'd1', title: '附录：超参数' }),
    ];
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.startsWith('/api/v1/auth/me')) return json(ME);
      if (url.startsWith('/api/v1/projects/p1/members')) return json([]);
      if (url.startsWith('/api/v1/projects/p1/docs') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as Partial<DocumentMeta>;
        return json(doc('new1', { title: body.title ?? '', kind: body.kind ?? 'doc' }), 201);
      }
      if (url.startsWith('/api/v1/projects/p1/docs')) return json(docs);
      return json({ error: { code: 'not_found', message: '没有' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('列表视图：树形展示，按类型筛选，搜索', async () => {
    renderPage();
    expect(await screen.findByText('实验周报 第 8 周')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: '文档列表' });
    expect(within(list).getByText('实验数据记录表')).toBeInTheDocument();
    expect(within(list).getByText('本周完成了消融实验')).toBeInTheDocument();

    // 子文档默认收起，展开后出现
    expect(screen.queryByText('附录：超参数')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开「实验周报 第 8 周」的子文档' }));
    expect(await screen.findByText('附录：超参数')).toBeInTheDocument();

    // 类型 Tabs（带计数）
    fireEvent.click(screen.getByRole('tab', { name: /表格/u }));
    await waitFor(() => expect(screen.queryByText('实验周报 第 8 周')).not.toBeInTheDocument());
    expect(screen.getByText('实验数据记录表')).toBeInTheDocument();

    // 搜索无结果 → 空状态
    fireEvent.click(screen.getByRole('tab', { name: /全部/u }));
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索文档' }), {
      target: { value: '不存在的关键词' },
    });
    expect(await screen.findByText('没有找到匹配的文档')).toBeInTheDocument();

    // 搜索命中摘要
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索文档' }), {
      target: { value: 'documentclass' },
    });
    expect(await screen.findByText('ICLR 投稿')).toBeInTheDocument();
    expect(screen.queryByText('实验数据记录表')).not.toBeInTheDocument();
  });

  it('URL 恢复类型、搜索和视图，文档标题和摘要预览分别可达', async () => {
    renderPage('/p/p1/docs?kind=sheet&q=实验&sort=title&view=list&other=keep');
    const title = await screen.findByRole('link', { name: /^实验数据记录表/u });
    expect(new URL(title.getAttribute('href')!, 'https://test.local').pathname).toBe(
      '/p/p1/docs/s1',
    );
    expect(
      new URL(title.getAttribute('href')!, 'https://test.local').searchParams.get('returnTo'),
    ).toBe('/p/p1/docs?kind=sheet&q=%E5%AE%9E%E9%AA%8C&sort=title&view=list&other=keep');
    expect(screen.getByRole('searchbox', { name: '搜索文档' })).toHaveValue('实验');
    expect(screen.queryByText('实验周报 第 8 周')).not.toBeInTheDocument();
    const preview = screen.getByRole('link', { name: '预览「实验数据记录表」' });
    expect(preview).toHaveAttribute(
      'href',
      '/p/p1/docs?kind=sheet&q=%E5%AE%9E%E9%AA%8C&sort=title&view=list&other=keep&preview=doc%3As1',
    );
    fireEvent.click(title);
    expect(await screen.findByRole('heading', { name: '文档详情' })).toBeInTheDocument();
  });

  it('网格视图显示类型预览', async () => {
    renderPage();
    await screen.findByText('实验周报 第 8 周');
    fireEvent.click(screen.getByRole('tab', { name: /网格/u }));
    expect(await screen.findByRole('img', { name: 'LaTeX 论文' })).toBeInTheDocument();
    expect(screen.getByText('附录：超参数')).toBeInTheDocument();
  });

  it('新建表格：POST 后跳到详情页', async () => {
    renderPage();
    await screen.findByText('实验周报 第 8 周');
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^表格/u }));
    expect(await screen.findByRole('heading', { name: '文档详情' })).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ title: '未命名表格', kind: 'sheet' });
  });

  it('空项目：介绍四类文档与模板入口', async () => {
    docs = [];
    renderPage();
    expect(await screen.findByText('还没有文档')).toBeInTheDocument();
    for (const label of ['新建文档', '新建表格', '新建幻灯片', '新建 LaTeX 论文']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: '从模板新建' }));
    const gallery = await screen.findByRole('dialog', { name: '从模板新建' });
    for (const name of ['实验周报', '实验数据记录表', '组会汇报', '学术论文（article）']) {
      expect(
        within(gallery).getByRole('button', { name: new RegExp(name, 'u') }),
      ).toBeInTheDocument();
    }
  });
});
