import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { PaperDetail } from '@srh/shared';
import { Providers } from '@/app/providers';
import { routes } from '@/app/router';
import { useToastStore } from '@/components/ui/toast-store';
import { usePapers } from './api';
import { LibraryPage } from './pages/LibraryPage';
import { PaperReaderPage } from './pages/PaperReaderPage';

// jsdom 不渲染画布；实际 PDF 渲染由浏览器验收，接口和阅读页其余行为使用真实组件。
vi.mock('./pdf/usePdfDocument', () => ({
  usePdfDocument: () => ({ doc: null, sizes: [], error: null }),
}));
vi.mock('./pdf/PaperPdfViewer', () => ({ PaperPdfViewer: () => <div>PDF 原文区域</div> }));
vi.mock('@/features/docs/collab/useCollabDoc', () => ({ useCollabDoc: () => null }));

const user = {
  id: 'usr_alice',
  name: '小王',
  email: 'alice@example.test',
  avatarColor: 0,
  avatarUrl: null,
  createdAt: '2026-10-30T00:00:00Z',
};
const privatePaper: PaperDetail = {
  id: 'ppr_private',
  projectId: null,
  ownerUserId: user.id,
  title: '私人论文',
  authors: [],
  year: 2026,
  venue: null,
  abstract: null,
  doi: null,
  arxivId: null,
  url: null,
  citekey: 'private2026',
  tags: [],
  note: '',
  source: 'upload',
  status: 'ready',
  progress: 100,
  stage: null,
  error: null,
  parser: 'pdf-text',
  fileId: 'fil_private',
  pageCount: 1,
  chunkCount: 1,
  hasLatexSource: false,
  createdBy: { kind: 'user', id: user.id, name: user.name },
  createdAt: '2026-10-30T00:00:00Z',
  updatedAt: '2026-10-30T00:00:00Z',
  archivedAt: null,
  structure: {
    pages: [{ width: 612, height: 792 }],
    sections: [],
    chunks: [],
    formulas: [],
    figures: [],
    references: [],
    macros: {},
  },
};
const projectPaper = {
  ...privatePaper,
  id: 'ppr_team',
  title: '团队论文',
  projectId: 'prj_team',
  ownerUserId: null,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let personal: PaperDetail[];
let projects: { id: string; name: string; role: string; archivedAt: null }[];
let authenticated: boolean;
let fetchMock: ReturnType<typeof vi.fn>;
const clients: QueryClient[] = [];

beforeEach(() => {
  useToastStore.setState({ items: [] });
  personal = [{ ...privatePaper }];
  projects = [];
  authenticated = true;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    if (path === '/api/v1/auth/me')
      return authenticated
        ? json({ user, projects })
        : json({ error: { code: 'unauthorized', message: '请先登录' } }, 401);
    if (path.endsWith('/library/status'))
      return json({
        parser: 'grobid',
        reachable: true,
        version: null,
        url: '',
        queue: { running: 0, pending: 0 },
        llm: false,
      });
    if (path === '/api/v1/library/papers' && method === 'POST')
      return json({ paper: privatePaper, duplicate: true });
    if (path === '/api/v1/library/papers') return json(personal);
    if (path === '/api/v1/projects/prj_team/library/papers') return json([projectPaper]);
    if (path.endsWith('/pdf')) return new Response('%PDF-1.4 test');
    if (path.endsWith('/bibtex')) return new Response('@article{private2026}');
    if (path.endsWith('/search')) return json([]);
    if (path.endsWith('/annotations')) return json([]);
    if (path.endsWith('/notes')) {
      if (method === 'POST')
        return json(
          {
            id: 'lnt_new',
            paperId: privatePaper.id,
            ...JSON.parse(String(init?.body)),
            version: 1,
          },
          201,
        );
      return json([]);
    }
    if (path === '/api/v1/library/papers/ppr_private') {
      if (method === 'PATCH') return json({ ...privatePaper, ...JSON.parse(String(init?.body)) });
      return json(privatePaper);
    }
    if (path === '/api/v1/projects/prj_team/library/papers/ppr_team') return json(projectPaper);
    throw new Error(`未预期的请求 ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  for (const qc of clients.splice(0)) qc.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function client() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(qc);
  return qc;
}

function open(path: string) {
  const qc = client();
  const router = createMemoryRouter(
    [
      ...routes.filter((r) => r.path !== '/p/:projectId' && r.path !== '/login'),
      { path: '/login', element: <div>登录入口</div> },
      { path: '/p/:projectId/library', element: <LibraryPage /> },
      { path: '/p/:projectId/library/:paperId', element: <PaperReaderPage /> },
    ],
    { initialEntries: [path] },
  );
  render(
    <Providers queryClient={qc}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, qc };
}

const requests = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    path: String(url),
    method: init?.method ?? 'GET',
    body: init?.body,
  }));

describe('L02：个人库入口与个人优先导入', () => {
  it('未加入项目的用户从首页进入个人库，能看到自己的论文且不请求项目资料', async () => {
    const { router } = open('/');
    expect(await screen.findByRole('heading', { name: '个人文献库' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: '私人论文' })).toHaveAttribute(
      'href',
      expect.stringContaining('/library/ppr_private?'),
    );
    expect(router.state.location.pathname).toBe('/library');
    expect(screen.getByText('仅自己可见')).toBeInTheDocument();
    expect(requests().some((r) => r.path.includes('/projects/'))).toBe(false);
    expect(screen.queryByRole('link', { name: '预览《私人论文》' })).toBeNull();
  });

  it('未登录访问个人论文回登录，并保留返回地址', async () => {
    const { router } = (() => {
      authenticated = false;
      return open('/library/ppr_private');
    })();
    expect(await screen.findByText('登录入口')).toBeInTheDocument();
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe(
      '/library/ppr_private',
    );
    expect(requests().some((r) => r.path.includes('/library/papers'))).toBe(false);
  });

  it.each([
    ['10.1145/3065386', 'doi'],
    ['1706.03762', 'arxiv'],
    ['https://example.test/paper.pdf', 'url'],
  ])('项目页导入 %s 也写入个人库，重复导入打开既有私人论文', async (value, kind) => {
    projects = [{ id: 'prj_team', name: '课题', role: 'guest', archivedAt: null }];
    const { router } = open('/p/prj_team/library');
    expect(await screen.findByRole('link', { name: '团队论文' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '导入到个人库' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('本次导入不会发布到项目');
    fireEvent.change(within(dialog).getByLabelText('arXiv 编号、DOI 或 PDF 链接'), {
      target: { value },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '导入论文' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/library/ppr_private'));
    const posts = requests().filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ path: '/api/v1/library/papers' });
    expect(JSON.parse(posts[0]!.body)).toEqual({ [kind]: value });
    expect(await screen.findByRole('heading', { name: '私人论文' })).toBeInTheDocument();
  });

  it('PDF 文件上传使用个人接口并提示重复文件', async () => {
    open('/library');
    await screen.findByRole('heading', { name: '个人文献库' });
    fireEvent.click(screen.getByRole('button', { name: '导入论文' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('tab', { name: '上传 PDF' }));
    const input = dialog.querySelector('input[type=file]')!;
    fireEvent.change(input, {
      target: { files: [new File(['%PDF-test'], 'test.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '导入论文' }));
    await screen.findByRole('heading', { name: '私人论文' });
    const upload = requests().find((r) => r.method === 'POST');
    expect(upload?.path).toBe('/api/v1/library/papers');
    expect(upload?.body).toBeInstanceOf(FormData);
    expect((upload?.body as FormData).get('file')).toBeInstanceOf(File);
    expect(screen.getByText('个人库里已经有这篇')).toBeInTheDocument();
  });

  it('个人阅读接入私人 PDF 和笔记，不能直接插入项目引用', async () => {
    open('/library/ppr_private');
    await screen.findByRole('heading', { name: '私人论文' });
    await waitFor(() =>
      expect(requests().some((r) => r.path === '/api/v1/library/papers/ppr_private/pdf')).toBe(
        true,
      ),
    );
    fireEvent.click(screen.getByRole('tab', { name: '笔记' }));
    fireEvent.click(await screen.findByRole('button', { name: '新建笔记' }));
    fireEvent.change(screen.getByLabelText('笔记标题'), { target: { value: '私人笔记' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() =>
      expect(requests().find((r) => r.method === 'POST')).toMatchObject({
        path: '/api/v1/library/papers/ppr_private/notes',
        body: JSON.stringify({ title: '私人笔记', kind: 'note', body: '' }),
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('tab', { name: 'BibTeX' }));
    await screen.findByText('@article{private2026}');
    expect(screen.queryByRole('button', { name: '插入引用' })).toBeNull();
    expect(screen.getByRole('button', { name: '发布到项目' })).toBeEnabled();
  });

  it('切换库后列表和全文搜索均请求对应范围，返回链接保留筛选', async () => {
    const { router } = open('/library?q=quartz');
    await screen.findByText('正文里没有找到。论文是英文的话试试英文术语。');
    expect(requests().some((r) => r.path.startsWith('/api/v1/library/search?'))).toBe(true);
    await act(async () => {
      await router.navigate('/p/prj_team/library?q=quartz');
    });
    await waitFor(() =>
      expect(
        requests().some((r) => r.path.startsWith('/api/v1/projects/prj_team/library/search?')),
      ).toBe(true),
    );
    expect(screen.queryByRole('link', { name: '私人论文' })).toBeNull();
    await act(async () => {
      await router.navigate('/library/ppr_private?returnTo=%2Flibrary%3Fq%3Dquartz');
    });
    await screen.findByRole('heading', { name: '私人论文' });
    fireEvent.click(screen.getByRole('button', { name: '回文献库' }));
    await waitFor(() =>
      expect(router.state.location.pathname + router.state.location.search).toBe(
        '/library?q=quartz',
      ),
    );
  });

  it('个人解析进度自动刷新到完成，此后停止定时请求', async () => {
    vi.useFakeTimers();
    personal = [{ ...privatePaper, status: 'parsing', progress: 40 }];
    const qc = client();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => usePapers({ kind: 'personal', userId: user.id }), {
      wrapper,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(result.current.data?.[0]?.progress).toBe(40);
    personal = [{ ...privatePaper }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(result.current.data?.[0]?.status).toBe('ready');
    const count = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(fetchMock.mock.calls.length).toBe(count);
  });

  it('同一浏览器切换账号时不复用前一账号的个人列表', async () => {
    const qc = client();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ userId }) => usePapers({ kind: 'personal', userId }),
      { wrapper, initialProps: { userId: user.id } },
    );
    await waitFor(() => expect(result.current.data?.[0]?.id).toBe('ppr_private'));
    personal = [{ ...privatePaper, id: 'ppr_bob', title: '小李的论文', ownerUserId: 'usr_bob' }];
    rerender({ userId: 'usr_bob' });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data?.[0]?.id).toBe('ppr_bob'));
  });

  it('项目论文参考文献中的导入也进入个人库，访客可以收藏自己的副本', async () => {
    projects = [{ id: 'prj_team', name: '课题', role: 'guest', archivedAt: null }];
    const original = projectPaper.structure;
    projectPaper.structure = {
      ...privatePaper.structure!,
      references: [
        {
          id: 'ref1',
          index: 1,
          title: '参考论文',
          authors: [],
          year: null,
          venue: null,
          doi: '10.1145/3065386',
          arxivId: null,
          raw: null,
          page: null,
          boxes: [],
        },
      ],
    };
    try {
      open('/p/prj_team/library/ppr_team');
      await screen.findByRole('heading', { name: '团队论文' });
      fireEvent.click(screen.getByRole('tab', { name: '结构' }));
      fireEvent.click(
        within(screen.getByRole('tablist', { name: '结构视图' })).getByRole('tab', {
          name: /文献/,
        }),
      );
      fireEvent.click(screen.getByRole('button', { name: '存入个人库' }));
      expect(await screen.findByRole('link', { name: '打开个人论文' })).toHaveAttribute(
        'href',
        '/library/ppr_private',
      );
      expect(requests().filter((r) => r.method === 'POST')).toEqual([
        {
          path: '/api/v1/library/papers',
          method: 'POST',
          body: JSON.stringify({ doi: '10.1145/3065386' }),
        },
      ]);
    } finally {
      projectPaper.structure = original;
    }
  });
});
