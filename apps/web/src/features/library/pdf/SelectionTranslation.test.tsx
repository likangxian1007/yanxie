import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelectionTranslation } from './SelectionTranslation';
import type { PdfTextSelection } from './selection';
import type { LibraryScope } from '../lib/scope';

const selected: PdfTextSelection = {
  text: 'The result depends on the dataset.',
  page: 2,
  boxes: [{ page: 2, x: 72, y: 60, w: 150, h: 14 }],
  warning: null,
};
const scope = { kind: 'personal' as const, userId: 'usr_alice' };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const models = {
  defaultModel: 'local/model',
  models: [{ id: 'local/model', name: '本机翻译模型', providerName: '科研服务' }],
};
const success = {
  translation: '结果取决于数据集。',
  modelId: 'local/model',
  modelName: '本机翻译模型',
  targetLanguage: 'zh-CN',
};
let client: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
let complete: (init: RequestInit) => Promise<Response>;
let catalog: typeof models;
const copy = vi.fn();

function element(
  selection = selected,
  currentScope: LibraryScope = scope,
  writable = true,
  fileId = 'fil_current',
) {
  return (
    <QueryClientProvider client={client}>
      <SelectionTranslation
        key={`${JSON.stringify(currentScope)}:${fileId}`}
        scope={currentScope}
        paperId="ppr_one"
        fileId={fileId}
        selection={selection}
        writable={writable}
        onClear={() => {}}
      />
    </QueryClientProvider>
  );
}
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  catalog = models;
  complete = async () => json(success);
  copy.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: copy }, configurable: true });
  fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (String(input).endsWith('/translation-models')) return json(catalog);
    if (String(input).endsWith('/translate')) return complete(init);
    throw new Error(`unexpected request ${String(input)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  client.clear();
  vi.unstubAllGlobals();
});
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');

describe('R02 翻译交互', () => {
  it('目录刷新移除已用模型后要求重选，不能自动把同一原文发给新提供方', async () => {
    render(element());
    await screen.findByLabelText('译文');
    expect(posts()).toHaveLength(1);
    catalog = {
      defaultModel: 'another/model',
      models: [{ id: 'another/model', name: '其他服务', providerName: '其他项目' }],
    };
    fireEvent.click(screen.getByRole('button', { name: '刷新模型列表' }));
    await screen.findByRole('option', { name: '原模型已不可用，请重新选择' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 650));
    });
    expect(posts()).toHaveLength(1);
    expect(screen.getByRole('button', { name: '重新翻译' })).toBeDisabled();
  });
  it('关闭自动后只在主动点击时翻译，带 PDF 版本和页码，不发送坐标、笔记或项目上下文', async () => {
    render(element());
    fireEvent.click(screen.getByRole('switch', { name: '自动翻译' }));
    const button = await screen.findByRole('button', { name: '开始翻译' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(posts()).toHaveLength(0);
    fireEvent.click(button);
    expect(await screen.findByLabelText('译文')).toHaveTextContent(success.translation);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]![0]).toBe('/api/v1/library/papers/ppr_one/translate');
    expect(JSON.parse(posts()[0]![1].body)).toEqual({
      text: selected.text,
      page: 2,
      fileId: 'fil_current',
      targetLanguage: 'zh-CN',
      modelId: 'local/model',
    });
    fireEvent.click(screen.getByRole('button', { name: '复制译文' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(success.translation));
  });
  it('项目阅读器使用项目接口', async () => {
    render(element(selected, 'prj_team'));
    fireEvent.click(screen.getByRole('switch', { name: '自动翻译' }));
    const button = screen.getByRole('button', { name: '开始翻译' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await screen.findByLabelText('译文');
    expect(posts()[0]![0]).toBe('/api/v1/projects/prj_team/library/papers/ppr_one/translate');
  });
  it('取消后中止信号；迟到的旧译文不能覆盖重试结果', async () => {
    let finish!: (r: Response) => void;
    complete = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    render(element());
    fireEvent.click(screen.getByRole('switch', { name: '自动翻译' }));
    const button = screen.getByRole('button', { name: '开始翻译' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await screen.findByText('正在翻译，可随时取消…');
    const signal = posts()[0]![1].signal as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: '取消翻译' }));
    expect(signal.aborted).toBe(true);
    complete = async () => json({ ...success, translation: '新的译文' });
    fireEvent.click(screen.getByRole('button', { name: '开始翻译' }));
    expect(await screen.findByLabelText('译文')).toHaveTextContent('新的译文');
    await act(async () => {
      finish(json({ ...success, translation: '旧的译文' }));
    });
    expect(screen.getByLabelText('译文')).not.toHaveTextContent('旧的译文');
  });
  it('切换选区或 PDF 文件销毁旧请求和结果', async () => {
    complete = () => new Promise(() => {});
    const view = render(element());
    fireEvent.click(screen.getByRole('switch', { name: '自动翻译' }));
    const button = screen.getByRole('button', { name: '开始翻译' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await screen.findByText('正在翻译，可随时取消…');
    const signal = posts()[0]![1].signal as AbortSignal;
    view.rerender(element({ ...selected, text: 'A new sentence.' }, scope, true, 'fil_new'));
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByLabelText('译文')).toBeNull();
  });
  it('模型错误支持重试；修改目标语言不自动产生额外调用', async () => {
    complete = async () =>
      json({ error: { code: 'rate_limited', message: '模型繁忙，请重试' } }, 429);
    render(element());
    fireEvent.click(screen.getByRole('switch', { name: '自动翻译' }));
    const button = screen.getByRole('button', { name: '开始翻译' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('模型繁忙');
    fireEvent.change(screen.getByRole('combobox', { name: '目标语言' }), {
      target: { value: 'en' },
    });
    expect(posts()).toHaveLength(1);
    complete = async () => json({ ...success, targetLanguage: 'en', translation: selected.text });
    fireEvent.click(screen.getByRole('button', { name: '开始翻译' }));
    await screen.findByLabelText('译文');
    expect(JSON.parse(posts()[1]![1].body).targetLanguage).toBe('en');
  });
  it('模型未配置时说明配置位置，不发起翻译请求', async () => {
    catalog = { defaultModel: '', models: [] };
    render(element());
    fireEvent.click(screen.getByRole('switch', { name: '自动翻译' }));
    expect(await screen.findByText(/尚未配置可用模型。/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始翻译' })).toBeDisabled();
    expect(posts()).toHaveLength(0);
  });
  it('访客不能发起付费调用，仍可复制原文', async () => {
    render(element(selected, 'prj_team', false));
    expect(screen.getByRole('button', { name: '开始翻译' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '复制原文' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(selected.text));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('过长选区清楚提示限制，不调用翻译', () => {
    render(element({ ...selected, text: 'x'.repeat(4001) }));
    expect(screen.getByRole('button', { name: '开始翻译' })).toBeDisabled();
    expect(screen.getByText(/一次最多翻译 4000/u)).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it('默认自动翻译，稳定重复选区不重复请求；不弹出对话框', async () => {
    const view = render(element());
    expect(await screen.findByLabelText('译文')).toHaveTextContent(success.translation);
    expect(posts()).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    view.rerender(element({ ...selected, boxes: [...selected.boxes] }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 650));
    });
    expect(posts()).toHaveLength(1);
  });
  it('自动模式快速换选区只翻译最后一次，换页相同文字也更新页码', async () => {
    const view = render(element());
    await screen.findByText('科研服务 / 本机翻译模型', { selector: 'option' });
    view.rerender(element({ ...selected, text: 'Second sentence.' }));
    view.rerender(element({ ...selected, text: 'Final sentence.' }));
    await screen.findByLabelText('译文');
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0]![1].body).text).toBe('Final sentence.');
    view.rerender(element({ ...selected, text: 'Final sentence.', page: 3 }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(JSON.parse(posts()[1]![1].body).page).toBe(3);
  });
  it('关闭自动翻译会取消正在进行的请求；仍能手动选择其他模型', async () => {
    catalog = {
      ...models,
      models: [...models.models, { id: 'team/second', name: '团队模型', providerName: '项目' }],
    };
    complete = () => new Promise(() => {});
    render(element());
    await screen.findByText('正在翻译，可随时取消…');
    const signal = posts()[0]![1].signal as AbortSignal;
    fireEvent.click(screen.getByRole('switch', { name: '自动翻译' }));
    expect(signal.aborted).toBe(true);
    fireEvent.change(screen.getByRole('combobox', { name: '翻译模型' }), {
      target: { value: 'team/second' },
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 650));
    });
    expect(posts()).toHaveLength(1);
    complete = async () => json({ ...success, modelId: 'team/second' });
    fireEvent.click(screen.getByRole('button', { name: '开始翻译' }));
    await screen.findByLabelText('译文');
    expect(JSON.parse(posts()[1]![1].body).modelId).toBe('team/second');
  });
  it('选区改变会中止旧请求，迟到结果不能覆盖新的自动翻译', async () => {
    let finish!: (r: Response) => void;
    complete = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const view = render(element());
    await screen.findByText('正在翻译，可随时取消…');
    const signal = posts()[0]![1].signal as AbortSignal;
    complete = async () => json({ ...success, translation: '新选区译文' });
    view.rerender(element({ ...selected, text: 'New selection.' }));
    expect(signal.aborted).toBe(true);
    expect(await screen.findByLabelText('译文')).toHaveTextContent('新选区译文');
    await act(async () => finish(json({ ...success, translation: '旧选区译文' })));
    expect(screen.getByLabelText('译文')).not.toHaveTextContent('旧选区译文');
  });
});
