import type { ResearchCellSource, ResearchStructuredTable } from '@srh/shared';

type Row = ResearchStructuredTable['rows'][number];
/** 摘录是否匹配来源，与表格当前值是否仍是生成时值是两个独立判断。 */
export function lineageCurrentState(
  source: ResearchCellSource,
  row?: Row,
): 'unchanged' | 'modified' | 'unavailable' {
  if (
    !row ||
    !source.locator ||
    typeof source.locator !== 'object' ||
    !Object.hasOwn(source.locator, 'cellValue')
  )
    return 'unavailable';
  const original = (source.locator as { cellValue?: unknown }).cellValue ?? null;
  return Object.is(row.cells[source.columnId] ?? null, original) ? 'unchanged' : 'modified';
}
