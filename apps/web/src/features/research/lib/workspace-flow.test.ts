import { describe, expect, it } from 'vitest';
import type { ResearchAction, ResearchItem, ResearchRunOutput } from '@srh/shared';
import {
  connectedFlow,
  filterValue,
  flowDefinitions,
  itemInputIds,
  outputDependencies,
  outputSummary,
} from './workspace-flow';

const action = (inputs?: ResearchAction['inputs']): ResearchAction => ({
  kind: 'ai',
  instructions: '',
  inputItemIds: ['legacy'],
  notebookId: null,
  cellIds: [],
  model: null,
  effort: null,
  profile: null,
  ...(inputs === undefined ? {} : { inputs }),
});
const step = (id: string, inputs?: ResearchAction['inputs']) =>
  ({ id, action: action(inputs) }) as ResearchItem;
const output = (stepId: string, artifactVersionId?: string) => ({
  name: '输入',
  source: {
    kind: 'output' as const,
    stepId,
    outputKey: 'result',
    ...(artifactVersionId ? { artifactVersionId } : {}),
  },
});

describe('处理流程绑定', () => {
  it('显式空 inputs 不回退旧字段', () => {
    expect(itemInputIds(action())).toEqual(['legacy']);
    expect(itemInputIds(action([]))).toEqual([]);
  });
  it('只把本次流程产物作为依赖，固定版本不构成依赖', () => {
    const items = [step('a'), step('b', [output('a')]), step('c', [output('b', 'v1')])];
    expect(outputDependencies(items[2]!.action!)).toEqual([]);
    expect(flowDefinitions(['a', 'b'], items, {})).toEqual([
      { itemId: 'a', dependsOn: [] },
      { itemId: 'b', dependsOn: ['a'] },
    ]);
    expect(connectedFlow(['b'], items)).toEqual(['a', 'b']);
  });
  it('筛选值按列类型解析但不把缺失值变成零', () => {
    expect(filterValue('', 'number')).toBe('');
    expect(filterValue('12.5', 'number')).toBe(12.5);
    expect(filterValue('false', 'boolean')).toBe(false);
    expect(filterValue('N/A', 'number')).toBe('N/A');
  });
});

it('人工确认的结构化表格显示概要，不把原始JSON铺入运行界面', () => {
  const output = {
    artifact: { kind: 'table' },
    content: JSON.stringify({
      totalRows: 3,
      columns: [{ id: 'a' }, { id: 'b' }],
      rows: [{ cells: { a: '甲', b: 4 } }],
    }),
  } as ResearchRunOutput;
  expect(outputSummary(output)).toContain('3 行、2 列');
  expect(outputSummary({ ...output, content: '{截断快照' })).toBe(
    '已固定表格版本。打开结果查看数据与依据。',
  );
  expect(outputSummary({ ...output, content: '实际处理3行，未补零。' })).toBe(
    '实际处理3行，未补零。',
  );
});
