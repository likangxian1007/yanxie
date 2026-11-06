import { formatValue } from '../engine/format';
import { isError, type CellValue } from '../engine/values';
import { colName, type CellRange } from './a1';

/**
 * 把选区变成图表数据：
 * - 首行有非数字文本、且下面有数字 → 首行是表头（系列名）
 * - 首列（表头以下）有非数字文本 → 首列是类别标签
 * - 其余列里至少有一个数字的列各成一个系列（最多 8 个，对应 8 色色板）
 */
export interface ChartSeries {
  name: string;
  values: Array<number | null>;
}

export interface ChartData {
  categories: string[];
  series: ChartSeries[];
}

const MAX_SERIES = 8;
const MAX_POINTS = 60;

export function buildChartData(
  range: CellRange,
  get: (row: number, col: number) => CellValue,
): ChartData | null {
  const isText = (v: CellValue) => typeof v === 'string' && v.trim() !== '';
  const isNum = (v: CellValue) => typeof v === 'number';

  let headerRow = false;
  if (range.r1 > range.r0) {
    let textInFirst = false;
    for (let c = range.c0; c <= range.c1; c += 1) if (isText(get(range.r0, c))) textInFirst = true;
    let numBelow = false;
    for (let r = range.r0 + 1; r <= range.r1 && !numBelow; r += 1) {
      for (let c = range.c0; c <= range.c1; c += 1) if (isNum(get(r, c))) numBelow = true;
    }
    headerRow = textInFirst && numBelow;
  }
  const dataR0 = headerRow ? range.r0 + 1 : range.r0;
  const dataR1 = Math.min(range.r1, dataR0 + MAX_POINTS - 1);

  let labelCol = false;
  if (range.c1 > range.c0) {
    for (let r = dataR0; r <= dataR1; r += 1) if (isText(get(r, range.c0))) labelCol = true;
  }

  const categories: string[] = [];
  for (let r = dataR0; r <= dataR1; r += 1) {
    categories.push(labelCol ? formatValue(get(r, range.c0)).text : String(r + 1));
  }

  const series: ChartSeries[] = [];
  for (let c = labelCol ? range.c0 + 1 : range.c0; c <= range.c1; c += 1) {
    const vals: Array<number | null> = [];
    let any = false;
    for (let r = dataR0; r <= dataR1; r += 1) {
      const v = get(r, c);
      if (typeof v === 'number' && !isError(v)) {
        vals.push(v);
        any = true;
      } else vals.push(null);
    }
    if (!any) continue;
    const name = headerRow ? formatValue(get(range.r0, c)).text || colName(c) : colName(c);
    series.push({ name, values: vals });
    if (series.length >= MAX_SERIES) break;
  }
  if (series.length === 0 || categories.length === 0) return null;
  return { categories, series };
}

/** 坐标轴刻度：0（或负最小值）到不小于最大值的“整”刻度 */
export function niceScale(
  min: number,
  max: number,
  ticks = 4,
): { lo: number; hi: number; step: number } {
  const lo0 = Math.min(0, min);
  const hi0 = Math.max(0, max);
  const span = hi0 - lo0 || 1;
  const raw = span / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { lo: Math.floor(lo0 / step) * step, hi: Math.ceil(hi0 / step) * step, step };
}
