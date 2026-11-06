import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { PaperQaTurn, PaperQaSession, PaperQaPublishPreview } from '@srh/shared';
import { QaPanel } from './components/QaPanel';
import { QaPublicationPicker } from './components/QaPublicationPicker';
import { qaApi } from './qa-api';
const state = vi.hoisted(() => ({ models: true, writable: true, jump: vi.fn() }));
vi.mock('./lib/reader', () => ({
  useReader: () => ({
    paper: { id: 'ppr_1', fileId: 'fil_1', status: 'ready', archivedAt: null },
    writable: state.writable,
    editable: true,
    jump: state.jump,
  }),
}));
vi.mock('./api', () => ({
  useTranslationModels: () => ({
    data: { models: state.models ? [{ id: 'provider/chat', name: '测试模型' }] : [] },
    isError: false,
  }),
}));
vi.mock('@/lib/realtime', () => ({ useProjectEvent: () => {}, realtime: { on: () => () => {} } }));
vi.mock('@/features/docs/collab/useCollabDoc', () => ({ useCollabDoc: () => null }));
const scope = { kind: 'personal', userId: 'usr_1' } as const;
const actor = { kind: 'user', id: 'usr_1', name: '本人' } as const;
const session: PaperQaSession = {
  id: 'lqs_1',
  paperId: 'ppr_1',
  title: '已保存会话',
  version: 1,
  createdBy: actor,
  updatedBy: actor,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  deletedAt: null,
};
const turn: PaperQaTurn = {
  id: 'lqt_1',
  sessionId: session.id,
  paperId: 'ppr_1',
  generationId: 'lqj_1',
  question: '已保存的问题',
  answer: '已保存的回答 [p.1 ¶1]',
  originalQuestion: '原问题',
  originalAnswer: '模型最初的回答',
  origin: 'model',
  status: 'done',
  error: null,
  modelId: 'provider/chat',
  modelName: '测试模型',
  searchScope: 'paper',
  sources: [
    {
      id: 'ref_1',
      paperId: null,
      fileId: null,
      pdfSha256: null,
      chunkId: null,
      paperTitle: '未共享论文',
      citekey: 'source',
      seq: 0,
      page: 1,
      para: 1,
      boxes: [],
      quote: '',
      status: 'unshared',
    },
  ],
  context: [],
  contextOmitted: false,
  keywords: [],
  version: 2,
  createdBy: actor,
  updatedBy: actor,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  completedAt: session.updatedAt,
  publishedFrom: null,
};
let client: QueryClient, fetchMock: ReturnType<typeof vi.fn>;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  state.models = true;
  state.writable = true;
  state.jump.mockClear();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  fetchMock = vi.fn(async (url: string) =>
    url.endsWith('/sessions')
      ? json([session])
      : url.endsWith('/turns')
        ? json([turn])
        : url.endsWith('/revisions')
          ? json([])
          : json(turn),
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const wrap = (child: React.ReactNode) => (
  <QueryClientProvider client={client}>
    <MemoryRouter>{child}</MemoryRouter>
  </QueryClientProvider>
);
describe('L05/L14 问答网页', () => {
  it('选句先展示供核对，发送才附带；移除与发送成功分别回调，不自动付费提问', async () => {
    const selection = { fileId: 'fil_1', page: 1, text: 'selected original' },
      clear = vi.fn();
    const ask = vi.spyOn(qaApi, 'ask').mockResolvedValue(turn);
    render(wrap(<QaPanel pid={scope} llm selection={selection} onClearSelection={clear} />));
    await screen.findByText('selected original');
    expect(ask).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('问题'), { target: { value: '解释这句话' } });
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect(ask.mock.calls[0]![3]).toMatchObject({ question: '解释这句话', selection });
    await waitFor(() => expect(clear).toHaveBeenCalledWith(selection));
    fireEvent.click(screen.getByRole('button', { name: '移除引用' }));
    expect(clear).toHaveBeenCalledTimes(2);
  });
  it('无可用模型仍可查看历史和原始版本，未共享引用不能跳转', async () => {
    state.models = false;
    render(wrap(<QaPanel pid={scope} llm={false} />));
    expect(await screen.findByText('已保存的问题')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送问题' })).toBeDisabled();
    expect(screen.getByTitle('来源未共享').tagName).toBe('SPAN');
    fireEvent.click(screen.getByTitle('来源未共享'));
    expect(state.jump).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '原始版本与历史' }));
    expect(await screen.findByText(/模型最初的回答/)).toBeInTheDocument();
  });
  it('访客保留阅读和共同维护入口，付费调用入口关闭', async () => {
    state.writable = false;
    render(wrap(<QaPanel pid="prj_1" llm />));
    await screen.findByText('已保存的问题');
    expect(screen.queryByRole('button', { name: '发送问题' })).toBeNull();
    expect(screen.getByRole('button', { name: '编辑问答' })).toBeEnabled();
    expect(screen.getByText(/当前角色不能调用模型/)).toBeInTheDocument();
  });
  it('生成时只读并允许发送独立的新问题，模型与上下文随请求保存', async () => {
    const ask = vi.spyOn(qaApi, 'ask').mockResolvedValue(turn);
    vi.spyOn(qaApi, 'turns').mockResolvedValue([
      { ...turn, id: 'running', status: 'generating' },
      turn,
    ]);
    render(wrap(<QaPanel pid={scope} llm />));
    await screen.findByRole('button', { name: '停止生成' });
    expect(screen.getAllByRole('button', { name: '编辑问答' })).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('问答模型'), { target: { value: 'provider/chat' } });
    fireEvent.change(screen.getByLabelText('问题', { exact: true }), {
      target: { value: '另一个问题' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
    await waitFor(() =>
      expect(ask).toHaveBeenCalledWith(
        scope,
        'ppr_1',
        session.id,
        expect.objectContaining({
          modelId: 'provider/chat',
          question: '另一个问题',
          contextTurnIds: [turn.id],
        }),
      ),
    );
    expect(screen.getByLabelText('问题', { exact: true })).toHaveValue('');
  });
  it('发送失败保留输入，同一内容重试沿用请求编号', async () => {
    const ask = vi
      .spyOn(qaApi, 'ask')
      .mockRejectedValueOnce(new Error('连接中断'))
      .mockResolvedValue(turn);
    render(wrap(<QaPanel pid={scope} llm />));
    await screen.findByText('已保存的问题');
    fireEvent.change(screen.getByLabelText('问题', { exact: true }), {
      target: { value: '不可丢失的提问' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
    await screen.findByText('连接中断');
    expect(screen.getByLabelText('问题', { exact: true })).toHaveValue('不可丢失的提问');
    const first = ask.mock.calls[0]![3].requestId;
    fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    expect(ask.mock.calls[1]![3].requestId).toBe(first);
  });
});
describe('L09 选择发布网页', () => {
  it('默认不选，预览不带未选正文；缺上下文需明确确认，改选或策略变化作废预览', async () => {
    vi.spyOn(qaApi, 'sessions').mockResolvedValue([session]);
    vi.spyOn(qaApi, 'turns').mockResolvedValue([
      turn,
      { ...turn, id: 'private', question: '私人问题', answer: 'SECRET_ANSWER' },
    ]);
    vi.spyOn(qaApi, 'flush').mockResolvedValue(turn);
    const preview: PaperQaPublishPreview = {
      turns: [
        {
          id: turn.id,
          version: 2,
          sessionTitle: session.title,
          question: turn.question,
          answer: '公开预览',
          author: actor,
          sources: turn.sources,
          missingContext: [{ id: 'previous', version: 1, question: '此前假设' }],
          unsharedSources: [{ id: 'ref_1', title: '未共享论文' }],
          privateLinksRemoved: true,
          previewHash: 'a'.repeat(64),
        },
      ],
    };
    const pre = vi.spyOn(qaApi, 'preview').mockResolvedValue(preview),
      change = vi.fn();
    render(
      wrap(
        <QaPublicationPicker
          scope={scope}
          paperId="ppr_1"
          projectId="prj_1"
          disabled={false}
          onChange={change}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '选择要发布的问答' }));
    const choice = await screen.findByRole('checkbox', { name: /已保存的问题/ });
    expect(choice).not.toBeChecked();
    expect(screen.queryByText('SECRET_ANSWER')).toBeNull();
    fireEvent.click(choice);
    expect(change).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole('button', { name: '预览所选问答' }));
    await screen.findByText(/公开预览/);
    expect(pre.mock.calls[0]![3]).toHaveLength(1);
    expect(change).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole('checkbox', { name: /我已核对正文/ }));
    expect(change).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: turn.id,
        allowMissingContext: true,
        previewHash: 'a'.repeat(64),
      }),
    ]);
    fireEvent.change(screen.getByLabelText('未共享来源的处理'), { target: { value: 'remove' } });
    expect(change).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText(/公开预览/)).toBeNull();
  });
});
