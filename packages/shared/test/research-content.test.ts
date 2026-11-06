import { describe, expect, it } from 'vitest';
import {
  ResearchAction,
  ResearchItemCreateInput,
  ResearchLayoutUpdateInput,
  ResearchRunConfirmInput,
  ResearchTableSeed,
} from '../src';

describe('可组合研究内容契约', () => {
  it('旧行动和纯笔记输入继续有效，新内容不要求模板或Notebook', () => {
    expect(ResearchAction.parse({ kind: 'ai' })).toMatchObject({ kind: 'ai', inputItemIds: [] });
    expect(
      ResearchItemCreateInput.parse({ kind: 'note', title: '原笔记' }).payload,
    ).toBeUndefined();
    expect(
      ResearchItemCreateInput.parse({
        kind: 'draft',
        title: '零散材料',
        payload: {
          kind: 'draft',
          blocks: [
            { id: 'b1', kind: 'text', text: '原始文本' },
            { id: 'b2', kind: 'resource', resource: { kind: 'file', id: 'f1' } },
          ],
        },
      }).payload?.kind,
    ).toBe('draft');
    expect(ResearchItemCreateInput.parse({ kind: 'table', title: '对照表' }).kind).toBe('table');
  });
  it('具名输入明确区分材料和上游产物，输出形态不等于人工确认', () => {
    const action = ResearchAction.parse({
      kind: 'ai',
      operation: 'extract_table',
      inputs: [
        { name: '材料', source: { kind: 'item', itemId: 'd1', blockIds: ['b1'] } },
        { name: '前一步', source: { kind: 'output', stepId: 'a1', outputKey: 'result' } },
      ],
      outputs: [{ key: 'table', kind: 'table' }],
    });
    expect(action.inputs?.[0]?.source.kind).toBe('item');
    expect(action.outputs?.[0]?.kind).toBe('table');
    expect(ResearchRunConfirmInput.parse({ note: '已核对', itemIds: ['t1'] }).itemIds).toEqual([
      't1',
    ]);
  });
  it('数据类型、缺失值和单位不会在契约解析时转换', () => {
    const table = ResearchTableSeed.parse({
      columns: [{ id: 'c1', name: '长度', type: 'number', unit: 'mm', missingValues: ['NA'] }],
      rows: [[0], [null], ['NA'], ['=原始文字']],
    });
    expect(table.rows).toEqual([[0], [null], ['NA'], ['=原始文字']]);
    expect(table.columns[0]?.unit).toBe('mm');
    expect(ResearchTableSeed.safeParse({ columns: [], rows: [] }).success).toBe(false);
  });
  it('批量位置更新拒绝空移动、重复条目与非有限坐标', () => {
    const move = { itemId: 'a', basePositionVersion: 1, position: { x: 2, y: 3 } };
    expect(
      ResearchLayoutUpdateInput.safeParse({ moves: [], idempotencyKey: 'request_123' }).success,
    ).toBe(false);
    expect(
      ResearchLayoutUpdateInput.safeParse({ moves: [move, move], idempotencyKey: 'request_123' })
        .success,
    ).toBe(false);
    expect(
      ResearchLayoutUpdateInput.safeParse({
        moves: [{ ...move, position: { x: Infinity, y: 0 } }],
        idempotencyKey: 'request_123',
      }).success,
    ).toBe(false);
    expect(
      ResearchLayoutUpdateInput.parse({ moves: [move], idempotencyKey: 'request_123' }).moves,
    ).toEqual([move]);
  });
});
