import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  ResearchArtifactVersion,
  ResearchItem,
  ResearchItemSummary,
  ResearchRun,
} from '@srh/shared';
import { api, ApiRequestError } from '@/lib/api';
import { contentApi } from '../content-data';
import { workspaceApi } from '../workspace-data';
import { clearTablePending, markTablePending, tableSyncKey } from '../lib/workspace-table-sync';
import WorkspaceExecution from './WorkspaceExecution';

const action: ResearchItem = {
  id: 'a1',
  projectId: 'p1',
  recordId: 'r1',
  kind: 'action',
  title: '人工检查',
  body: '',
  resource: null,
  evidenceRef: null,
  origin: null,
  parentId: null,
  position: { x: 0, y: 0 },
  version: 1,
  positionVersion: 1,
  action: {
    kind: 'human',
    instructions: '核对结果',
    inputItemIds: ['n1'],
    notebookId: null,
    cellIds: [],
    model: null,
    effort: null,
    profile: null,
  },
  createdBy: { kind: 'user', id: 'u1', name: '甲' },
  updatedBy: { kind: 'user', id: 'u1', name: '甲' },
  createdAt: '',
  updatedAt: '',
  archivedAt: null,
};
const items = [
  { ...action, actionKind: 'human', preview: '' },
  { ...action, id: 'n1', kind: 'note', title: '资料甲', actionKind: null, preview: '原文' },
  { ...action, id: 'n2', kind: 'note', title: '资料乙', actionKind: null, preview: '新原文' },
] as unknown as ResearchItemSummary[];
const waiting = {
  id: 'run1',
  projectId: 'p1',
  recordId: 'r1',
  status: 'waiting',
  cancelRequested: false,
  createdAt: '2026-01-01T00:00:00Z',
  inputSnapshots: [],
  steps: [
    {
      definition: { itemId: 'a1', title: '人工检查', action: action.action, dependsOn: [] },
      status: 'waiting',
      attempts: [],
    },
  ],
} as unknown as ResearchRun;
function mount(
  initialItemIds: string[] = [],
  mountedItems: ResearchItemSummary[] = items,
  onOpenItem: (id: string) => void = () => {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <WorkspaceExecution
          pid="p1"
          recordId="r1"
          userId="u1"
          items={mountedItems}
          initialItemIds={initialItemIds}
          writable
          onClose={() => {}}
          onOpenItem={onOpenItem}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const fixedArtifact: ResearchArtifactVersion = {
  id: 'artifact-fixed',
  itemId: 'table1',
  version: 3,
  kind: 'table',
  mime: 'application/json',
  hash: 'fixed-hash',
  size: 20,
  projectId: 'p1',
  recordId: 'r1',
  runId: 'previous-run',
  stepId: 'upstream',
  outputKey: 'result',
  summary: '固定的候选表格',
  createdBy: { kind: 'user', id: 'u1', name: '甲' },
  createdAt: '2026-01-01T00:00:00Z',
  origin: 'ai_draft',
  inputs: [],
};

const pinnedWaiting = {
  ...waiting,
  steps: [
    {
      ...waiting.steps[0],
      definition: {
        ...waiting.steps[0]!.definition,
        action: {
          ...action.action!,
          inputs: [
            {
              name: '候选',
              source: {
                kind: 'output',
                stepId: 'upstream',
                outputKey: 'result',
                artifactVersionId: 'artifact-fixed',
              },
            },
          ],
          outputs: [{ key: 'result', kind: 'table' }],
        },
        dependsOn: [],
      },
    },
  ],
} as unknown as ResearchRun;

function mockRun(run: ResearchRun) {
  vi.spyOn(api, 'get').mockImplementation(async (path) => {
    if (path.endsWith('/runs')) return { items: [run], nextCursor: null } as never;
    if (path.endsWith('/staleness')) return { stale: false, inputs: [] } as never;
    if (path.endsWith('/reviews')) return [] as never;
    return { items: [], nextCursor: null } as never;
  });
}
beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  clearTablePending(tableSyncKey('u1', 'p1', 'r1', 'table1'), 'confirm-test');
});

it('运行历史只加载首批，由用户明确加载后续记录', async () => {
  const get = vi.spyOn(api, 'get').mockImplementation(async (path, options) => {
    if (path.endsWith('/runs'))
      return {
        items: options?.query?.cursor ? [] : [{ ...waiting, status: 'succeeded' }],
        nextCursor: options?.query?.cursor ? null : 'older_cursor',
      } as never;
    if (path.endsWith('/reviews')) return [] as never;
    if (path.endsWith('/staleness')) return { stale: false, inputs: [] } as never;
    return { items: [], nextCursor: null } as never;
  });
  mount();
  const more = await screen.findByRole('button', { name: '加载更早运行' });
  expect(get.mock.calls.filter(([path]) => path.endsWith('/runs'))).toHaveLength(1);
  fireEvent.click(more);
  await waitFor(() =>
    expect(get.mock.calls.filter(([path]) => path.endsWith('/runs'))).toHaveLength(2),
  );
  expect(get.mock.calls.filter(([path]) => path.endsWith('/runs'))[1]![1]?.query).toMatchObject({
    cursor: 'older_cursor',
    limit: 10,
  });
});

it('提交真实运行并以服务端状态显示人工检查', async () => {
  let runs: ResearchRun[] = [];
  vi.spyOn(workspaceApi, 'item').mockResolvedValue(action);
  vi.spyOn(api, 'get').mockImplementation(async (path) => {
    if (path.endsWith('/runs')) return { items: runs, nextCursor: null } as never;
    if (path.endsWith('/recipes')) return { items: [], nextCursor: null } as never;
    if (path.endsWith('/staleness'))
      return {
        stale: true,
        inputs: [{ itemId: 'n1', state: 'changed', reason: '材料已更新' }],
      } as never;
    if (path.endsWith('/reviews')) return [] as never;
    if (path.endsWith('/findings')) return { items: [], nextCursor: null } as never;
    throw new Error(path);
  });
  const post = vi.spyOn(api, 'post').mockImplementation(async (path) => {
    if (path.endsWith('/runs')) runs = [waiting];
    return waiting as never;
  });
  mount();
  const config = await screen.findByRole('region', { name: '配置运行' });
  fireEvent.click(within(config).getByRole('checkbox'));
  await screen.findByText('人工检查：输入 资料甲');
  fireEvent.click(screen.getByRole('button', { name: '检查并启动' }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      '/projects/p1/research/records/r1/runs',
      expect.objectContaining({ steps: [{ itemId: 'a1', dependsOn: [] }] }),
    ),
  );
  await screen.findByText('人工检查 · 等待人工检查');
  expect(await screen.findByText(/输入已变化，结果待复核/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('人工检查检查记录'), {
    target: { value: '人工核对通过' },
  });
  fireEvent.click(screen.getByRole('button', { name: '确认检查' }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      '/projects/p1/research/records/r1/runs/run1/steps/a1/confirm',
      { note: '人工核对通过' },
    ),
  );
});

it('配置仍在加载时禁止启动，避免选择后立即点击的竞态', async () => {
  let loaded!: (value: ResearchItem) => void;
  vi.spyOn(workspaceApi, 'item').mockImplementation(
    () =>
      new Promise<ResearchItem>((resolve) => {
        loaded = resolve;
      }),
  );
  vi.spyOn(api, 'get').mockImplementation(
    async (path) => (path.endsWith('/reviews') ? [] : { items: [], nextCursor: null }) as never,
  );
  const post = vi.spyOn(api, 'post');
  mount();
  const config = await screen.findByRole('region', { name: '配置运行' });
  fireEvent.click(within(config).getByRole('checkbox'));
  const start = screen.getByRole('button', { name: '检查并启动' });
  expect(start).toBeDisabled();
  fireEvent.click(start);
  expect(post).not.toHaveBeenCalled();
  await waitFor(() => expect(loaded).toBeTypeOf('function'));
  loaded(action);
  await waitFor(() => expect(start).toBeEnabled());
});

it('人工检查先选择上游表格，再固定人工修改后的候选版本', async () => {
  const run = {
    ...waiting,
    steps: [
      {
        definition: { itemId: 'upstream', title: '提取表格', action: action.action, dependsOn: [] },
        status: 'succeeded',
        attempts: [
          {
            number: 1,
            status: 'succeeded',
            error: null,
            logs: [],
            outputs: [
              {
                itemId: 'table1',
                version: 1,
                title: '候选表格',
                content: '提取结果',
                origin: 'ai_draft',
                artifact: { id: 'artifact1', kind: 'table' },
                outputKey: 'result',
              },
            ],
          },
        ],
      },
      {
        definition: {
          itemId: 'a1',
          title: '人工检查',
          action: { ...action.action!, outputs: [{ key: 'result', kind: 'table' }] },
          dependsOn: ['upstream'],
        },
        status: 'waiting',
        attempts: [],
      },
    ],
  } as unknown as ResearchRun;
  vi.spyOn(api, 'get').mockImplementation(async (path) => {
    if (path.endsWith('/runs')) return { items: [run], nextCursor: null } as never;
    if (path.endsWith('/staleness')) return { stale: false, inputs: [] } as never;
    if (path.endsWith('/reviews')) return [] as never;
    return { items: [], nextCursor: null } as never;
  });
  const post = vi.spyOn(api, 'post').mockResolvedValue(run as never);
  mount();
  const select = await screen.findByLabelText('待确认的表格');
  fireEvent.change(select, { target: { value: 'table1' } });
  fireEvent.change(screen.getByLabelText('人工检查检查记录'), { target: { value: '修正后核对' } });
  const pending = tableSyncKey('u1', 'p1', 'r1', 'table1');
  markTablePending(pending, 'confirm-test', new Uint8Array([0]), false);
  fireEvent.click(screen.getByRole('button', { name: '确认检查' }));
  expect(screen.getByText(/候选表格存在未同步或旧会话的修改/)).toBeTruthy();
  expect(post).not.toHaveBeenCalled();
  clearTablePending(pending, 'confirm-test');
  fireEvent.click(screen.getByRole('button', { name: '确认检查' }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      '/projects/p1/research/records/r1/runs/run1/steps/a1/confirm',
      { note: '修正后核对', itemIds: ['table1'] },
    ),
  );
});

it('单独运行的人工步骤读取固定上游版本，加载完成后可选择并确认', async () => {
  mockRun(pinnedWaiting);
  let resolveArtifact!: (value: ResearchArtifactVersion) => void;
  const artifact = vi.spyOn(contentApi, 'artifact').mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveArtifact = resolve;
      }),
  );
  const post = vi.spyOn(api, 'post').mockResolvedValue(pinnedWaiting as never);
  const openItem = vi.fn();
  mount([], items, openItem);
  await screen.findByText('正在读取固定上游版本…');
  fireEvent.change(screen.getByLabelText('人工检查检查记录'), { target: { value: '检查通过' } });
  expect(screen.getByRole('button', { name: '确认检查' })).toBeDisabled();
  await waitFor(() => expect(resolveArtifact).toBeTypeOf('function'));
  resolveArtifact(fixedArtifact);
  await screen.findByRole('option', { name: '固定的候选表格 · 第 3 版' });
  expect(artifact).toHaveBeenCalledWith('p1', 'artifact-fixed', expect.anything());
  fireEvent.change(screen.getByLabelText('待确认的表格'), { target: { value: 'table1' } });
  fireEvent.click(screen.getByRole('button', { name: '打开候选内容修改' }));
  expect(openItem).toHaveBeenCalledWith('table1');
  fireEvent.click(screen.getByRole('button', { name: '确认检查' }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      '/projects/p1/research/records/r1/runs/run1/steps/a1/confirm',
      { note: '检查通过', itemIds: ['table1'] },
    ),
  );
});

it('固定上游版本读取失败时不能确认，可以重试', async () => {
  mockRun(pinnedWaiting);
  const artifact = vi
    .spyOn(contentApi, 'artifact')
    .mockRejectedValueOnce(new Error('无法读取'))
    .mockResolvedValueOnce(fixedArtifact);
  mount();
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('固定上游版本没有加载出来');
  fireEvent.change(screen.getByLabelText('人工检查检查记录'), { target: { value: '检查通过' } });
  expect(screen.getByRole('button', { name: '确认检查' })).toBeDisabled();
  fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
  await screen.findByRole('option', { name: '固定的候选表格 · 第 3 版' });
  expect(artifact).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByLabelText('待确认的表格'), { target: { value: 'table1' } });
  expect(screen.getByRole('button', { name: '确认检查' })).toBeEnabled();
});

it('固定版本的元数据与声明不符时不提供候选', async () => {
  mockRun(pinnedWaiting);
  vi.spyOn(contentApi, 'artifact').mockResolvedValue({
    ...fixedArtifact,
    recordId: 'other-record',
  });
  mount();
  await screen.findByText('固定上游版本与本步骤的输入声明不匹配，请检查步骤配置。');
  expect(screen.queryByRole('option', { name: /固定的候选表格/ })).toBeNull();
  fireEvent.change(screen.getByLabelText('人工检查检查记录'), { target: { value: '检查通过' } });
  expect(screen.getByRole('button', { name: '确认检查' })).toBeDisabled();
});

it('人工检查只选择已声明的直接快照和成功上游输出，并按内容去重', async () => {
  const snapshot = (id: string, kind: 'note' | 'table', title: string) => ({
    item: { ...action, id, kind, title, action: null },
    artifact: { id: `snapshot-${id}`, itemId: id, kind, version: 1 },
    content: '固定输入',
    contentVersion: 1,
    hash: 'hash',
  });
  const output = (id: string, key: string, title: string) => ({
    itemId: id,
    outputKey: key,
    title,
    version: 2,
    content: '',
    origin: 'ai_draft',
    artifact: { id: `artifact-${id}`, kind: 'table' },
  });
  const run = {
    ...waiting,
    inputSnapshots: [
      snapshot('n1', 'note', '已绑定笔记'),
      snapshot('table1', 'table', '已绑定表格'),
      snapshot('n2', 'note', '其他步骤的输入'),
    ],
    steps: [
      {
        definition: { itemId: 'upstream', title: '上游', action: action.action, dependsOn: [] },
        status: 'succeeded',
        attempts: [
          {
            number: 1,
            status: 'succeeded',
            logs: [],
            error: null,
            outputs: [
              output('table1', 'result', '同一表格的上游版本'),
              output('rogue', 'other', '未绑定输出'),
            ],
          },
        ],
      },
      {
        definition: { itemId: 'other', title: '其他步骤', action: action.action, dependsOn: [] },
        status: 'succeeded',
        attempts: [
          {
            number: 1,
            status: 'succeeded',
            logs: [],
            error: null,
            outputs: [output('other-table', 'result', '其他步骤的产物')],
          },
        ],
      },
      {
        definition: {
          itemId: 'a1',
          title: '人工检查',
          action: {
            ...action.action!,
            inputs: [
              { name: '笔记', source: { kind: 'item', itemId: 'n1' } },
              { name: '表格', source: { kind: 'item', itemId: 'table1' } },
              { name: '上游', source: { kind: 'output', stepId: 'upstream', outputKey: 'result' } },
            ],
            outputs: [
              { key: 'note', kind: 'note' },
              { key: 'table', kind: 'table' },
            ],
          },
          dependsOn: ['upstream', 'other'],
        },
        status: 'waiting',
        attempts: [],
      },
    ],
  } as unknown as ResearchRun;
  mockRun(run);
  const post = vi.spyOn(api, 'post').mockResolvedValue(run as never);
  mount();
  const noteSelect = await screen.findByLabelText('待确认的笔记');
  const tableSelect = screen.getByLabelText('待确认的表格');
  expect(within(noteSelect).getByRole('option', { name: /已绑定笔记/ })).toBeTruthy();
  expect(within(noteSelect).queryByRole('option', { name: /其他步骤的输入/ })).toBeNull();
  expect(within(tableSelect).queryByRole('option', { name: /未绑定输出/ })).toBeNull();
  expect(within(tableSelect).queryByRole('option', { name: /其他步骤的产物/ })).toBeNull();
  expect(
    within(tableSelect)
      .getAllByRole('option')
      .filter((entry) => (entry as HTMLOptionElement).value === 'table1'),
  ).toHaveLength(1);
  fireEvent.change(noteSelect, { target: { value: 'n1' } });
  fireEvent.change(tableSelect, { target: { value: 'table1' } });
  fireEvent.change(screen.getByLabelText('人工检查检查记录'), {
    target: { value: '核对直接输入' },
  });
  fireEvent.click(screen.getByRole('button', { name: '确认检查' }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      '/projects/p1/research/records/r1/runs/run1/steps/a1/confirm',
      { note: '核对直接输入', itemIds: ['n1', 'table1'] },
    ),
  );
});

it('显式空输入不会回退旧的 inputItemIds 或依赖候选', async () => {
  const run = {
    ...waiting,
    inputSnapshots: [
      {
        item: { ...action, id: 'n1', kind: 'note', title: '旧输入', action: null },
        artifact: { id: 'snapshot-n1', itemId: 'n1', kind: 'note', version: 1 },
        content: '固定输入',
        contentVersion: 1,
        hash: 'hash',
      },
    ],
    steps: [
      {
        definition: { itemId: 'upstream', title: '上游', action: action.action, dependsOn: [] },
        status: 'succeeded',
        attempts: [
          {
            number: 1,
            status: 'succeeded',
            logs: [],
            error: null,
            outputs: [
              {
                itemId: 'n2',
                outputKey: 'result',
                title: '旧依赖',
                version: 1,
                content: '',
                origin: 'ai_draft',
                artifact: { id: 'artifact-n2', kind: 'note' },
              },
            ],
          },
        ],
      },
      {
        ...waiting.steps[0],
        definition: {
          ...waiting.steps[0]!.definition,
          action: { ...action.action!, inputs: [], outputs: [{ key: 'result', kind: 'note' }] },
          dependsOn: ['upstream'],
        },
      },
    ],
  } as unknown as ResearchRun;
  mockRun(run);
  mount();
  await screen.findByLabelText('待确认的笔记');
  expect(screen.queryByRole('option', { name: /旧输入/ })).toBeNull();
  expect(screen.queryByRole('option', { name: /旧依赖/ })).toBeNull();
  fireEvent.change(screen.getByLabelText('人工检查检查记录'), { target: { value: '检查通过' } });
  expect(screen.getByRole('button', { name: '确认检查' })).toBeDisabled();
});

it('从画布运行选中步骤时预先选中范围', async () => {
  vi.spyOn(workspaceApi, 'item').mockResolvedValue(action);
  vi.spyOn(api, 'get').mockImplementation(
    async (path) => (path.endsWith('/reviews') ? [] : { items: [], nextCursor: null }) as never,
  );
  mount(['a1']);
  const config = await screen.findByRole('region', { name: '配置运行' });
  expect(within(config).getByRole('checkbox')).toBeChecked();
  expect(await screen.findByText('人工检查：输入 资料甲')).toBeTruthy();
});

it('内核不可用时把启动错误显示在对应步骤旁且不伪造运行', async () => {
  const notebook = {
    ...action,
    action: { ...action.action!, kind: 'notebook', notebookId: 'nb1' },
  } as ResearchItem;
  vi.spyOn(workspaceApi, 'item').mockResolvedValue(notebook);
  vi.spyOn(api, 'get').mockImplementation(
    async (path) => (path.endsWith('/reviews') ? [] : { items: [], nextCursor: null }) as never,
  );
  vi.spyOn(api, 'post').mockRejectedValue(
    new ApiRequestError({
      status: 501,
      code: 'not_implemented',
      message: '服务器未配置 Notebook 内核，无法执行计算',
    }),
  );
  mount(['a1']);
  await screen.findByText('已选 Notebook');
  fireEvent.click(screen.getByRole('button', { name: '检查并启动' }));
  const config = screen.getByRole('region', { name: '配置运行' });
  expect(await within(config).findByText('服务器未配置 Notebook 内核，无法执行计算')).toBeTruthy();
  expect(screen.getByText('还没有运行记录')).toBeTruthy();
});

it('表格存在本机未同步修改时阻止运行，保留待同步标记', async () => {
  const marker = tableSyncKey('u1', 'p1', 'r1', 'n1');
  markTablePending(marker, 'pending-test', new Uint8Array([0]), false);
  try {
    vi.spyOn(workspaceApi, 'item').mockResolvedValue(action);
    vi.spyOn(api, 'get').mockImplementation(async (path) => {
      if (path.endsWith('/table'))
        return {
          documentId: 'doc',
          sheetId: 'sheet',
          sourceVersion: 'hash1',
          hash: 'hash1',
          columns: [],
          rows: [],
          totalRows: 0,
          nextCursor: null,
        } as never;
      if (path.endsWith('/reviews')) return [] as never;
      return { items: [], nextCursor: null } as never;
    });
    const post = vi.spyOn(api, 'post');
    mount(
      ['a1'],
      items.map((entry) => (entry.id === 'n1' ? { ...entry, kind: 'table' } : entry)),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: '检查并启动' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '检查并启动' }));
    const config = screen.getByRole('region', { name: '配置运行' });
    expect(within(config).getByText(/表格存在未同步或旧会话的修改/)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  } finally {
    clearTablePending(marker, 'pending-test');
  }
});

it('自动处理展示计划并按问题版本提交补充回答', async () => {
  const auto = {
    ...waiting,
    steps: [
      {
        ...waiting.steps[0],
        definition: {
          ...waiting.steps[0]!.definition,
          action: {
            ...action.action!,
            kind: 'ai',
            processing: { mode: 'auto', expectedOutputs: [] },
          },
        },
        waitingFor: {
          kind: 'clarification',
          questionId: 'q1',
          question: '使用哪一列？',
          reason: 'ambiguous',
        },
        attempts: [
          {
            number: 1,
            status: 'running',
            logs: [],
            outputs: [],
            processing: {
              version: 2,
              phase: 'waiting',
              plan: {
                summary: '先整理数据',
                steps: [
                  {
                    id: 'chart1',
                    title: '画图',
                    operation: 'chart',
                    inputKeys: ['input:1'],
                    instructions: '',
                    chart: { kind: 'bar', xColumn: 'group', yColumns: ['value'], missing: 'omit' },
                  },
                ],
                outputs: [],
              },
              steps: [],
              answers: [{ questionId: 'q0', question: '哪种图？', answer: '柱状图' }],
              intermediates: [],
            },
          },
        ],
      },
    ],
  } as unknown as ResearchRun;
  mockRun(auto);
  const post = vi.spyOn(api, 'post').mockResolvedValue(auto as never);
  mount();
  expect(await screen.findByText('先整理数据')).toBeTruthy();
  expect(screen.queryByText(/等待人工确认/)).toBeNull();
  fireEvent.click(screen.getByText('处理详情'));
  expect(screen.getByText('图表类型：柱状图')).toBeTruthy();
  expect(screen.getByText('缺失值：跳过')).toBeTruthy();
  expect(screen.getByText('问题：哪种图？')).toBeTruthy();
  expect(screen.getByText('回答：柱状图')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('使用哪一列？'), { target: { value: '质量' } });
  fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      '/projects/p1/research/records/r1/runs/run1/steps/a1/answer',
      expect.objectContaining({
        questionId: 'q1',
        answer: '质量',
        baseVersion: 2,
        idempotencyKey: expect.any(String),
      }),
    ),
  );
  expect(screen.queryByRole('button', { name: '确认检查' })).toBeNull();
});

it('重新规划将标记传给新运行', async () => {
  mockRun(waiting);
  vi.spyOn(workspaceApi, 'item').mockResolvedValue(action);
  const post = vi.spyOn(api, 'post').mockResolvedValue(waiting as never);
  mount(['a1']);
  const button = await screen.findByRole('button', { name: '重新规划' });
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      '/projects/p1/research/records/r1/runs',
      expect.objectContaining({ replan: true }),
    ),
  );
});
