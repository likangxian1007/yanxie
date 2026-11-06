import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnyProjectEvent, Paper, PaperNote } from '@srh/shared';
import { useLibraryEvents, usePaper, usePapers } from './api';
import { PublishPaperDialog } from './components/PublishPaperDialog';
import { PaperMetadataDialog } from './components/PaperMetadataDialog';
import { useToastStore } from '@/components/ui/toast-store';

const live = vi.hoisted(() => ({ event: (_event: AnyProjectEvent) => {} }));
vi.mock('@/lib/realtime', () => ({
  realtime: { on: () => () => {} },
  useProjectEvent: (_pid: string, handler: (event: AnyProjectEvent) => void) => {
    live.event = handler;
  },
}));

const me = vi.hoisted(() => ({
  data: {
    projects: [
      { id: 'prj_team', name: '团队项目', role: 'member', archivedAt: null },
      { id: 'prj_guest', name: '只读项目', role: 'guest', archivedAt: null },
    ],
  },
  isPending: false,
  isError: false,
  isSuccess: true,
  refetch: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ useMe: () => me }));
const scope = { kind: 'personal', userId: 'usr_me' } as const;
const paper: Paper = {
  id: 'ppr_personal',
  projectId: null,
  ownerUserId: 'usr_me',
  title: '原始标题',
  authors: [],
  year: 2026,
  venue: null,
  abstract: null,
  doi: null,
  arxivId: null,
  url: null,
  citekey: 'paper2026',
  tags: ['原标签'],
  note: 'PRIVATE_NOTE_MUST_STAY_PRIVATE',
  noteVersion: 1,
  titleVersion: 1,
  tagsVersion: 1,
  source: 'doi',
  status: 'needs_pdf',
  progress: 0,
  stage: null,
  error: null,
  parser: null,
  fileId: null,
  pageCount: null,
  chunkCount: 0,
  hasLatexSource: false,
  createdBy: { kind: 'user', id: 'usr_me', name: '本人' },
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
  archivedAt: null,
};
const teamCopy = { ...paper, id: 'ppr_team', projectId: 'prj_team', ownerUserId: null, note: '' };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let fetchMock: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;
let client: QueryClient;
let sent: Record<string, unknown>[];
let candidates: unknown[] = [];
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  sent = [];
  candidates = [];
  useToastStore.setState({ items: [] });
  me.data.projects = [
    { id: 'prj_team', name: '团队项目', role: 'member', archivedAt: null },
    { id: 'prj_guest', name: '只读项目', role: 'guest', archivedAt: null },
  ];
  fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return json({ paper: teamCopy, replayed: false }, 201);
  });
  vi.stubGlobal('fetch', (url: string, init: RequestInit) =>
    url.includes('/publish-targets') ? Promise.resolve(json(candidates)) : fetchMock(url, init),
  );
});
afterEach(() => {
  client.clear();
  vi.unstubAllGlobals();
});
const close = vi.fn();
const wrap = (child: React.ReactNode) => (
  <QueryClientProvider client={client}>
    <MemoryRouter>{child}</MemoryRouter>
  </QueryClientProvider>
);
function showPublish(p = paper) {
  return render(wrap(<PublishPaperDialog scope={scope} paper={p} onClose={close} />));
}
async function selectProject() {
  fireEvent.change(screen.getByLabelText('目标项目'), { target: { value: 'prj_team' } });
  await waitFor(() => expect(screen.queryByText('正在核对项目已有论文…')).not.toBeInTheDocument());
}

describe('L08 笔记选择与全文预览', () => {
  const note: PaperNote = {
    id: 'lnt_selected',
    paperId: paper.id,
    title: '团队说明稿',
    kind: 'brief',
    body: '团队可以看到的完整正文',
    version: 3,
    createdBy: paper.createdBy,
    updatedBy: paper.createdBy,
    createdAt: paper.createdAt,
    updatedAt: paper.updatedAt,
    publishedFrom: null,
  };
  function notesServer() {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/notes'))
        return json([
          note,
          { ...note, id: 'lnt_private', title: '私人思路', body: 'SECRET_NOT_SELECTED' },
        ]);
      if (url.endsWith('/flush')) return json(note);
      sent.push(JSON.parse(String(init?.body)));
      return json({ paper: teamCopy, replayed: false }, 201);
    });
  }
  it('默认不选、选后必须先预览，只发送所选 ID 与预览版本，不发送遗漏正文', async () => {
    notesServer();
    showPublish();
    await selectProject();
    fireEvent.click(screen.getByRole('button', { name: '选择要发布的笔记' }));
    const chosen = await screen.findByRole('checkbox', { name: '说明稿 · 团队说明稿' });
    expect(chosen).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '说明稿 · 私人思路' })).not.toBeChecked();
    fireEvent.click(chosen);
    expect(screen.getByRole('button', { name: '确认发布' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '预览所选正文' }));
    expect(await screen.findByText(note.body)).toBeInTheDocument();
    expect(screen.queryByText('SECRET_NOT_SELECTED')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
    await screen.findByRole('link', { name: '打开项目副本' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ notes: [{ id: note.id, version: note.version }] });
    expect(JSON.stringify(sent)).not.toContain('lnt_private');
  });
  it('改变勾选后作废旧预览，不能误发之前选中的笔记', async () => {
    notesServer();
    showPublish();
    await selectProject();
    fireEvent.click(screen.getByRole('button', { name: '选择要发布的笔记' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: '说明稿 · 团队说明稿' }));
    fireEvent.click(screen.getByRole('button', { name: '预览所选正文' }));
    await screen.findByText(note.body);
    fireEvent.click(screen.getByRole('checkbox', { name: '说明稿 · 私人思路' }));
    expect(screen.queryByText(note.body)).toBeNull();
    expect(screen.getByRole('button', { name: '确认发布' })).toBeDisabled();
  });
});

describe('L07 发布交互', () => {
  it('发布后立即重开窗口会重新取候选，不沿用应用全局的长缓存', async () => {
    client.setDefaultOptions({ queries: { retry: false, staleTime: 60000 } });
    const first = showPublish();
    await selectProject();
    fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
    await screen.findByRole('link', { name: '打开项目副本' });
    first.unmount();
    candidates = [
      {
        paper: teamCopy,
        reasons: ['此前发布到此论文'],
        samePdf: true,
        published: { notes: [], annotations: [], qa: [] },
      },
    ];
    showPublish();
    await selectProject();
    expect(await screen.findByLabelText('追加到项目论文')).toBeInTheDocument();
  });
  it('发现候选后须明确选择目标，预览新增与跳过数量，追加不发送团队正文', async () => {
    const n = {
      id: 'lnt_new',
      paperId: paper.id,
      title: '追加笔记',
      body: 'NEW_NOTE',
      kind: 'note',
      version: 1,
    };
    candidates = [
      {
        paper: teamCopy,
        reasons: ['此前发布到此论文'],
        samePdf: true,
        published: { notes: [], annotations: [], qa: [] },
      },
    ];
    fetchMock.mockImplementation(async (url, init) => {
      if (url.endsWith('/notes')) return json([n]);
      if (url.endsWith('/flush')) return json(n);
      sent.push(JSON.parse(String(init.body)));
      return json({ paper: teamCopy, replayed: false });
    });
    showPublish();
    await selectProject();
    expect(screen.getByRole('button', { name: '确认发布' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('追加到项目论文'), { target: { value: teamCopy.id } });
    expect(screen.getByRole('button', { name: '确认追加' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '选择要发布的笔记' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: '追加笔记' }));
    fireEvent.click(screen.getByRole('button', { name: '预览所选正文' }));
    await screen.findByText('NEW_NOTE');
    expect(screen.getByText(/笔记新增 1、跳过 0/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认追加' }));
    await screen.findByRole('link', { name: '打开项目副本' });
    expect(sent[0]).toMatchObject({
      targetPaperId: teamCopy.id,
      targetUpdatedAt: teamCopy.updatedAt,
      notes: [{ id: n.id, version: 1 }],
    });
    expect(sent[0]).not.toHaveProperty('body');
  });
  it('显示发布范围和无 PDF 提示，确认只发送项目与预览身份，不发送私人笔记', async () => {
    showPublish();
    expect(screen.getByText(/当前没有 PDF/)).toBeInTheDocument();
    expect(screen.queryByText(paper.note)).toBeNull();
    expect(screen.queryByRole('option', { name: '只读项目' })).toBeNull();
    expect(screen.getByRole('button', { name: '确认发布' })).toBeDisabled();
    await selectProject();
    fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
    expect(await screen.findByRole('link', { name: '打开项目副本' })).toHaveAttribute(
      'href',
      '/p/prj_team/library/ppr_team',
    );
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!).sort()).toEqual(['projectId', 'requestId', 'sourceUpdatedAt']);
    expect(sent[0]).toMatchObject({ projectId: 'prj_team', sourceUpdatedAt: paper.updatedAt });
  });

  it('网络失败后重试保留同一请求编号，避免重复发布', async () => {
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      throw new TypeError('network failure');
    });
    showPublish();
    await selectProject();
    fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
    fireEvent.click(await screen.findByRole('button', { name: '重试发布' }));
    await screen.findByRole('link', { name: '打开项目副本' });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });

  it('目标项目已有论文时明确提示并提供已有副本入口', async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            code: 'conflict',
            message: '项目中已有论文，本次未覆盖',
            details: { existingPaperId: 'ppr_existing' },
          },
        },
        409,
      ),
    );
    showPublish();
    await selectProject();
    fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('本次未覆盖');
    expect(screen.getByRole('link', { name: '查看项目已有论文' })).toHaveAttribute(
      'href',
      '/p/prj_team/library/ppr_existing',
    );
  });

  it('没有可发布项目或论文仍在处理时不能提交', () => {
    me.data.projects = [];
    showPublish({ ...paper, status: 'parsing' });
    expect(screen.getByText(/暂无可发布的项目/)).toBeInTheDocument();
    expect(screen.getByText(/论文正在处理/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认发布' })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('L11 元数据草稿与字段版本', () => {
  it('仅修改标题时不把旧标签发回去', async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return json({ ...teamCopy, title: '新标题', titleVersion: 2 });
    });
    render(wrap(<PaperMetadataDialog scope="prj_team" paper={teamCopy} onClose={close} />));
    fireEvent.change(screen.getByLabelText('论文标题'), { target: { value: '新标题' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(sent).toEqual([{ title: '新标题', baseTitleVersion: 1 }]));
  });

  it('仅修改标签时只发送标签版本，并去重', async () => {
    render(wrap(<PaperMetadataDialog scope="prj_team" paper={teamCopy} onClose={close} />));
    fireEvent.change(screen.getByLabelText('论文标签'), {
      target: { value: '新标签, 新标签, 另一个' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(sent).toEqual([{ tags: ['新标签', '另一个'], baseTagsVersion: 1 }]));
  });

  it('实时更新不覆盖草稿；冲突保留输入，明确载入新版后才能再保存', async () => {
    const newer = { ...teamCopy, title: '同事的新标题', titleVersion: 2 };
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            code: 'version_conflict',
            message: '字段已被其他成员更新',
            details: { current: newer },
          },
        },
        409,
      ),
    );
    const page = render(
      wrap(<PaperMetadataDialog scope="prj_team" paper={teamCopy} onClose={close} />),
    );
    fireEvent.change(screen.getByLabelText('论文标题'), { target: { value: '我的草稿' } });
    page.rerender(wrap(<PaperMetadataDialog scope="prj_team" paper={newer} onClose={close} />));
    expect(screen.getByLabelText('论文标题')).toHaveValue('我的草稿');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('字段已被其他成员更新');
    expect(screen.getByLabelText('论文标题')).toHaveValue('我的草稿');
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '载入最新版本' }));
    expect(screen.getByLabelText('论文标题')).toHaveValue('同事的新标题');
    fireEvent.change(screen.getByLabelText('论文标题'), { target: { value: '重新整理的标题' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(sent.at(-1)).toMatchObject({ title: '重新整理的标题', baseTitleVersion: 2 }),
    );
  });
});

it('L11 首次加载中的旧 REST 响应不能覆盖实时发布及更新，列表与阅读详情均重取', async () => {
  const pending: ((response: Response) => void)[] = [];
  const latest = { ...teamCopy, title: '刚发布的标题', structure: null };
  fetchMock.mockImplementation((url: string) => {
    if (pending.length < 2) return new Promise<Response>((resolve) => pending.push(resolve));
    return Promise.resolve(json(url.endsWith('/papers') ? [latest] : latest));
  });
  const hook = renderHook(
    () => {
      useLibraryEvents('prj_team');
      return { list: usePapers('prj_team'), detail: usePaper('prj_team', 'ppr_team') };
    },
    { wrapper: ({ children }) => wrap(children) },
  );
  await waitFor(() => expect(pending).toHaveLength(2));
  act(() =>
    live.event({
      type: 'paper.created',
      payload: latest,
      seq: 1,
      projectId: 'prj_team',
      threadId: null,
      actor: latest.createdBy,
      createdAt: latest.createdAt,
    }),
  );
  await waitFor(() => {
    expect(hook.result.current.list.data?.[0]?.title).toBe(latest.title);
    expect(hook.result.current.detail.data?.title).toBe(latest.title);
  });
  await act(async () => {
    pending[0]!(json([]));
    pending[1]!(json({ ...teamCopy, structure: null }));
  });
  expect(hook.result.current.list.data?.[0]?.title).toBe(latest.title);
  expect(hook.result.current.detail.data?.title).toBe(latest.title);
});

it('L11 团队论文被删除后，正在阅读的详情撤下旧内容并重新检查服务器', async () => {
  fetchMock.mockResolvedValue(json({ ...teamCopy, structure: null }));
  const hook = renderHook(
    () => {
      useLibraryEvents('prj_team');
      return usePaper('prj_team', 'ppr_team');
    },
    { wrapper: ({ children }) => wrap(children) },
  );
  await waitFor(() => expect(hook.result.current.data?.id).toBe('ppr_team'));
  fetchMock.mockResolvedValue(
    json({ error: { code: 'not_found', message: '论文不存在或已被删除' } }, 404),
  );
  act(() =>
    live.event({
      type: 'paper.deleted',
      payload: { id: 'ppr_team' },
      seq: 2,
      projectId: 'prj_team',
      threadId: null,
      actor: teamCopy.createdBy,
      createdAt: teamCopy.createdAt,
    }),
  );
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
  expect(hook.result.current.data).toBeUndefined();
});
