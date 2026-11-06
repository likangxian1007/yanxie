import { expect, it } from 'vitest';
import type { ResearchItemSummary } from '@srh/shared';
import { dataConnections, latestWorkspaceItems, inputBinding } from './workspace-dataflow';
it('数据连接来自输入绑定，固定历史产物不变成待运行依赖', () => {
  const action = {
    id: 'a',
    actionInputs: [
      { name: '材料', source: { kind: 'item', itemId: 'd' } },
      { name: '当前输出', source: { kind: 'output', stepId: 'b', outputKey: 'table' } },
      {
        name: '固定输出',
        source: { kind: 'output', stepId: 'c', outputKey: 'table', artifactVersionId: 'v1' },
      },
    ],
  } as ResearchItemSummary;
  expect(dataConnections([action]).map((e) => e.fromItemId)).toEqual(['d', 'b']);
});
it('重跑只展示每个输出槽最新产物，原材料和不同输出均保留', () => {
  const rows = [
    { id: 'm' },
    { id: 'old', producerStepId: 'a', producerOutputKey: 'table', createdAt: '1' },
    { id: 'new', producerStepId: 'a', producerOutputKey: 'table', createdAt: '2' },
    { id: 'other', producerStepId: 'a', producerOutputKey: 'note', createdAt: '1' },
  ] as ResearchItemSummary[];
  expect(latestWorkspaceItems(rows).map((i) => i.id)).toEqual(['m', 'new', 'other']);
});
it('处理连接保留输出key，输入名称唯一', () => {
  expect(
    inputBinding(
      {
        id: 'a',
        title: '提取',
        kind: 'action',
        actionOutputs: [{ key: 'table', kind: 'table' }],
      } as ResearchItemSummary,
      { kind: 'action' } as ResearchItemSummary,
      [{ name: '提取', source: { kind: 'item', itemId: 'd' } }],
      'table',
    ),
  ).toEqual({ name: '提取 2', source: { kind: 'output', stepId: 'a', outputKey: 'table' } });
});

it('旧步骤没有声明输出时仍能连接默认产物', () => {
  expect(
    inputBinding(
      {
        id: 'legacy',
        title: '整理',
        kind: 'action',
        actionOutputs: [],
      } as unknown as ResearchItemSummary,
      { kind: 'action' } as ResearchItemSummary,
      [],
    ).source,
  ).toEqual({ kind: 'output', stepId: 'legacy', outputKey: 'result' });
});
