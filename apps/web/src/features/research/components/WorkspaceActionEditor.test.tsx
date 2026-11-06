import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ResearchAction, ResearchItem, ResearchItemSummary } from '@srh/shared';
import { workspaceApi } from '../workspace-data';
import { WorkspaceActionEditor } from './WorkspaceActionEditor';

const draft = {
  id: 'draft1',
  kind: 'draft',
  title: '混合草稿',
  payload: {
    kind: 'draft',
    blocks: [
      { id: 'b1', kind: 'text', text: '第一段' },
      { id: 'b2', kind: 'text', text: '第二段' },
    ],
  },
} as ResearchItem;
const initial: ResearchAction = {
  kind: 'ai',
  instructions: '',
  inputItemIds: [],
  notebookId: null,
  cellIds: [],
  model: null,
  effort: null,
  profile: null,
};
function Harness({
  initialAction = initial,
  extraItems = [],
}: { initialAction?: ResearchAction; extraItems?: ResearchItemSummary[] } = {}) {
  const [action, setAction] = useState(initialAction);
  return (
    <>
      <WorkspaceActionEditor
        pid="p"
        recordId="r"
        itemId="step"
        items={[draft as unknown as ResearchItemSummary, ...extraItems]}
        action={action}
        disabled={false}
        onChange={(patch) => setAction((old) => ({ ...old, ...patch }))}
      />
      <output data-testid="action">{JSON.stringify(action)}</output>
    </>
  );
}
afterEach(() => vi.restoreAllMocks());
it('将草稿绑定为具名输入并选择部分内容块', async () => {
  vi.spyOn(workspaceApi, 'item').mockResolvedValue(draft);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText('添加输入'), { target: { value: 'item:draft1' } });
  fireEvent.click(await screen.findByLabelText('全部内容块'));
  fireEvent.click(screen.getByLabelText('第 2 块 · 第二段'));
  const saved = JSON.parse(screen.getByTestId('action').textContent!);
  expect(saved.inputs).toEqual([
    { name: '输入1', source: { kind: 'item', itemId: 'draft1', blockIds: ['b1'] } },
  ]);
  expect(saved.inputItemIds).toEqual(['draft1']);
});

it('旧固定方案须显式切换，自动模式可声明多个稳定产物', () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>,
  );
  expect(screen.getByText('已有固定方案：自由指令')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '切换为自动规划' }));
  fireEvent.click(screen.getByLabelText('笔记'));
  fireEvent.click(screen.getByLabelText('数据表'));
  let saved = JSON.parse(screen.getByTestId('action').textContent!);
  expect(saved.processing).toEqual({ mode: 'auto', expectedOutputs: ['note', 'table'] });
  expect(saved.outputs).toEqual([
    { key: 'note', kind: 'note' },
    { key: 'table', kind: 'table' },
  ]);
  fireEvent.click(screen.getByLabelText('数据表'));
  saved = JSON.parse(screen.getByTestId('action').textContent!);
  expect(saved.outputs).toEqual([{ key: 'note', kind: 'note' }]);
});

it('取消期望产物时保留已被下游连接引用的具名输出', () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const auto: ResearchAction = {
    ...initial,
    processing: { mode: 'auto', expectedOutputs: ['table'] },
    outputs: [{ key: 'table', kind: 'table' }],
  };
  const downstream = {
    id: 'next',
    kind: 'action',
    actionInputs: [
      { name: '输入', source: { kind: 'output', stepId: 'step', outputKey: 'table' } },
    ],
  } as ResearchItemSummary;
  render(
    <QueryClientProvider client={qc}>
      <Harness initialAction={auto} extraItems={[downstream]} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByLabelText('数据表'));
  const saved = JSON.parse(screen.getByTestId('action').textContent!);
  expect(saved.processing.expectedOutputs).toEqual([]);
  expect(saved.outputs).toEqual([{ key: 'table', kind: 'table' }]);
});

it('有下游连接时拒绝切换处理动作并提示先移除连接', () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const auto: ResearchAction = {
    ...initial,
    processing: { mode: 'auto', expectedOutputs: ['table'] },
    outputs: [{ key: 'table', kind: 'table' }],
  };
  const downstream = {
    id: 'next',
    kind: 'action',
    actionInputs: [
      { name: '输入', source: { kind: 'output', stepId: 'step', outputKey: 'table' } },
    ],
  } as ResearchItemSummary;
  render(
    <QueryClientProvider client={qc}>
      <Harness initialAction={auto} extraItems={[downstream]} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText('处理动作'), { target: { value: 'human' } });
  expect(screen.getByRole('alert').textContent).toContain('请先移除连接');
  expect(JSON.parse(screen.getByTestId('action').textContent!).kind).toBe('ai');
});
