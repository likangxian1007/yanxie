import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ResearchArtifactVersion, ResearchItem, ResearchItemSummary } from '@srh/shared';
import { ApiRequestError } from '@/lib/api';
import { contentApi } from '../content-data';
import { draftKey, itemDraft } from '../lib/workspace-draft';
import { workspaceApi } from '../workspace-data';
import { WorkspaceItemEditor } from './WorkspaceItemEditor';

const item = (version = 1, body = '原文'): ResearchItem => ({
  id: 'rwi_1',
  projectId: 'p1',
  recordId: 'r1',
  kind: 'note',
  title: '笔记',
  body,
  resource: null,
  evidenceRef: null,
  action: null,
  origin: null,
  parentId: null,
  position: { x: 0, y: 0 },
  version,
  positionVersion: 1,
  createdBy: { kind: 'user', id: 'u1', name: '甲' },
  updatedBy: { kind: 'user', id: 'u1', name: '甲' },
  createdAt: '',
  updatedAt: '',
  archivedAt: null,
});
function mount(path = '/', items: ResearchItemSummary[] = [], onClose = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <WorkspaceItemEditor
          pid="p1"
          recordId="r1"
          userId="u1"
          itemId="rwi_1"
          items={items}
          writable
          onOpen={() => {}}
          onClose={onClose}
          onCreated={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('自动保存遇到冲突时保留草稿、比较版本并允许明确覆盖', async () => {
  const base = item();
  const remote = item(2, '他人的修改');
  vi.spyOn(workspaceApi, 'item').mockResolvedValue(base);
  const update = vi
    .spyOn(workspaceApi, 'updateItem')
    .mockRejectedValueOnce(
      new ApiRequestError({
        status: 409,
        code: 'conflict',
        message: '冲突',
        details: { current: remote },
      }),
    )
    .mockResolvedValueOnce(item(3, '我的修改'));
  mount();
  const editor = await screen.findByLabelText('笔记正文');
  fireEvent.change(editor, { target: { value: '我的修改' } });
  expect(JSON.parse(localStorage.getItem(draftKey('u1', 'p1', 'r1', 'rwi_1'))!).draft.body).toBe(
    '我的修改',
  );
  await screen.findByText(
    '其他人已保存新版本，本机草稿仍保留。比较后选择如何继续。',
    {},
    { timeout: 3000 },
  );
  expect(screen.getByText(/他人的修改/)).toBeTruthy();
  expect((editor as HTMLTextAreaElement).value).toBe('我的修改');
  fireEvent.click(screen.getByRole('button', { name: '用本机草稿保存' }));
  await waitFor(() =>
    expect(update).toHaveBeenLastCalledWith(
      'p1',
      'r1',
      'rwi_1',
      expect.objectContaining({ baseVersion: 2, body: '我的修改' }),
    ),
  );
  await screen.findByText('已保存');
});

it('离线时恢复本机草稿，不能声称服务器已保存', async () => {
  const base = item();
  localStorage.setItem(
    draftKey('u1', 'p1', 'r1', 'rwi_1'),
    JSON.stringify({ base, draft: { ...itemDraft(base), body: '离线草稿' }, dirty: true }),
  );
  const network = new ApiRequestError({ status: 0, code: 'network_error', message: '网络不可用' });
  vi.spyOn(workspaceApi, 'item').mockRejectedValue(network);
  vi.spyOn(workspaceApi, 'updateItem').mockRejectedValue(network);
  mount();
  expect(((await screen.findByLabelText('笔记正文')) as HTMLTextAreaElement).value).toBe(
    '离线草稿',
  );
  await screen.findByText('离线，草稿保存在本机', {}, { timeout: 3000 });
  expect(screen.queryByText('已保存')).toBeNull();
});

it('请求进行中继续输入会再次保存新内容', async () => {
  vi.spyOn(workspaceApi, 'item').mockResolvedValue(item());
  let resolveFirst!: (value: ResearchItem) => void;
  const first = new Promise<ResearchItem>((resolve) => {
    resolveFirst = resolve;
  });
  const update = vi
    .spyOn(workspaceApi, 'updateItem')
    .mockReturnValueOnce(first)
    .mockResolvedValueOnce(item(3, '继续输入'));
  mount();
  const editor = await screen.findByLabelText('笔记正文');
  fireEvent.change(editor, { target: { value: '先输入' } });
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1), { timeout: 3000 });
  fireEvent.change(editor, { target: { value: '继续输入' } });
  resolveFirst(item(2, '先输入'));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2), { timeout: 3000 });
  expect(update).toHaveBeenLastCalledWith(
    'p1',
    'r1',
    'rwi_1',
    expect.objectContaining({ baseVersion: 2, body: '继续输入' }),
  );
  await screen.findByText('已保存');
});

it('来源定位打开笔记时选中当前正文对应位置', async () => {
  vi.spyOn(workspaceApi, 'item').mockResolvedValue(item(1, '甲乙丙丁戊'));
  mount('/?start=1&end=3');
  const editor = (await screen.findByLabelText('笔记正文')) as HTMLTextAreaElement;
  await waitFor(() => expect([editor.selectionStart, editor.selectionEnd]).toEqual([1, 3]));
  expect(screen.getByText(/若正文已变化/)).toBeTruthy();
});

it('查看同输出的历史笔记不会覆盖当前正在编辑的正文', async () => {
  const current = item();
  const old: ResearchArtifactVersion = {
    id: 'artifact-old',
    itemId: 'old-item',
    version: 1,
    kind: 'note',
    mime: 'text/markdown',
    hash: 'hash',
    size: 10,
    projectId: 'p1',
    recordId: 'r1',
    runId: 'old-run',
    stepId: 'organize',
    outputKey: 'result',
    summary: '旧笔记',
    createdBy: { kind: 'user', id: 'u1', name: '甲' },
    createdAt: '2026-01-01T00:00:00Z',
    origin: 'ai_draft',
    inputs: [],
  };
  vi.spyOn(workspaceApi, 'item').mockResolvedValue(current);
  const save = vi.spyOn(workspaceApi, 'updateItem').mockResolvedValue(item(2, '我的新草稿'));
  const versions = vi
    .spyOn(contentApi, 'artifacts')
    .mockResolvedValue({ items: [old], nextCursor: null });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '旧版本内容' }));
  const summary = {
    ...current,
    actionKind: null,
    preview: '',
    originItemId: null,
    producerStepId: 'organize',
    producerOutputKey: 'result',
  } as ResearchItemSummary;
  mount('/', [summary]);
  const editor = await screen.findByLabelText('笔记正文');
  fireEvent.change(editor, { target: { value: '我的新草稿' } });
  fireEvent.click(screen.getByText('该步骤同输出历史'));
  await screen.findByText(/旧笔记/);
  expect(versions).toHaveBeenCalledWith('p1', 'r1', 'organize', undefined, expect.anything());
  fireEvent.click(screen.getByRole('button', { name: '查看固定版本' }));
  expect(await screen.findByText('旧版本内容')).toBeTruthy();
  expect(editor).toHaveValue('我的新草稿');
  expect(save.mock.calls.every(([, , id]) => id === 'rwi_1')).toBe(true);
});

it('快速编辑混合草稿后返回会等待保存成功', async () => {
  const base: ResearchItem = {
    ...item(),
    kind: 'draft',
    payload: { kind: 'draft', blocks: [{ id: 'b1', kind: 'text', text: '原内容' }] },
  };
  vi.spyOn(workspaceApi, 'item').mockResolvedValue(base);
  let resolveSave!: (value: ResearchItem) => void;
  const update = vi.spyOn(workspaceApi, 'updateItem').mockReturnValue(
    new Promise((resolve) => {
      resolveSave = resolve;
    }),
  );
  const close = vi.fn();
  mount('/', [], close);
  fireEvent.change(await screen.findByLabelText('第 1 块文字'), { target: { value: '新内容' } });
  fireEvent.click(screen.getByRole('button', { name: '← 返回总览' }));
  expect(update).toHaveBeenCalledWith(
    'p1',
    'r1',
    'rwi_1',
    expect.objectContaining({
      payload: { kind: 'draft', blocks: [{ id: 'b1', kind: 'text', text: '新内容' }] },
    }),
  );
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '← 返回总览' })).toBeDisabled();
  resolveSave({
    ...base,
    version: 2,
    payload: { kind: 'draft', blocks: [{ id: 'b1', kind: 'text', text: '新内容' }] },
  });
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});
