import { parseDelimited, toCsv } from '../lib/csv';
import type { SheetData } from '../model/io';
import type { SheetModel } from '../model/workbook';
import { displayOf } from '../model/workbook';

/** CSV / TSV 文本 → 一张表的数据（自动识别逗号 / 制表符 / 分号分隔） */
export function csvToSheetData(text: string, name: string, delimiter?: string): SheetData {
  const firstLine = text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : text.length);
  const delim =
    delimiter ??
    (firstLine.includes('\t') && !firstLine.includes(',')
      ? '\t'
      : firstLine.includes(';') && !firstLine.includes(',')
        ? ';'
        : ',');
  const grid = parseDelimited(text.replace(/^\uFEFF/u, ''), delim).filter((row) =>
    row.some((v) => v.trim() !== ''),
  );
  const cells: SheetData['cells'] = [];
  grid.forEach((row, r) =>
    row.forEach((raw, c) => {
      if (raw !== '') cells.push({ r, c, raw });
    }),
  );
  return { name, cells };
}

/** 当前表 → CSV（显示值，与 Excel“另存为 CSV”一致）；带 BOM，Excel 打开中文不乱码 */
export function sheetToCsv(s: SheetModel): string {
  const bounds = s.usedBounds();
  if (!bounds) return '';
  const rows: string[][] = [];
  for (let r = 0; r < bounds.rows; r += 1) {
    const line: string[] = [];
    for (let c = 0; c < bounds.cols; c += 1) line.push(displayOf(s, r, c).text);
    rows.push(line);
  }
  return `\uFEFF${toCsv(rows)}`;
}
