import { describe, expect, it } from 'vitest';
import type { ResearchCellSource, ResearchStructuredTable } from '@srh/shared';
import { lineageCurrentState } from './workspace-lineage';

const source: ResearchCellSource = {
  rowId: 'r',
  columnId: 'c',
  verification: 'matched',
  locator: { cellValue: 12, start: 0, end: 2 },
};
const row = (value: number | null) =>
  ({ id: 'r', cells: { c: value } }) as ResearchStructuredTable['rows'][number];

describe('表格来源核对', () => {
  it('生成时摘录匹配不代表用户修改后的单元格仍匹配', () => {
    expect(lineageCurrentState(source, row(12))).toBe('unchanged');
    expect(lineageCurrentState(source, row(13))).toBe('modified');
  });
  it('未读取行或旧产物缺少生成时值时不作推断', () => {
    expect(lineageCurrentState(source)).toBe('unavailable');
    expect(lineageCurrentState({ ...source, locator: { start: 0 } }, row(12))).toBe('unavailable');
  });
});
