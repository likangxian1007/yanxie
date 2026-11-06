import type * as Y from 'yjs';
import { readXlsx } from '../editors/sheet/io/xlsx';
import { csvToSheetData } from '../editors/sheet/io/csv';
import { sniffMessage, sniffSpreadsheet } from '../editors/sheet/io/xlsxPackage';
import { writeWorkbookData } from '../editors/sheet/model/io';
import { ImportError, type ImportContext } from './types';
import { tr } from '@/lib/i18n';

/**
 * Excel / CSV 导入：把文件写进**空的**本地 Y.Doc 的表格 v2 结构（API.md §2.7.1，
 * editors/sheet/model/schema.ts）。.xlsx 用 ExcelJS 读取：全部工作表、值、公式（保留公式和 Excel 的
 * 缓存值）、样式、数字格式、合并、列宽行高、冻结窗格；.csv 写成一张表。
 * 旧版二进制 .xls 不支持（ExcelJS 只读 OOXML），提示用户另存为 .xlsx。
 */
export async function importXlsx(
  file: File,
  ydoc: Y.Doc,
  ctx?: {
    projectId: string;
    uploadFile: (blob: Blob, name: string) => Promise<{ id: string; url: string }>;
  },
): Promise<{ title: string; warnings?: string[] }> {
  void (ctx satisfies ImportContext | undefined);
  const name = file.name || 'Sheet1';
  const lower = name.toLowerCase();
  const title = name.replace(/\.(xlsx|xlsm|xls|csv|tsv|txt)$/iu, '').trim() || tr('导入的表格');
  const buffer = await readFileBuffer(file);
  if (lower.endsWith('.xls')) {
    // 扩展名是 .xls 但内容其实是 .xlsx（zip）的也照常导入；加了密码的单独说
    const kind = sniffSpreadsheet(new Uint8Array(buffer));
    if (kind === 'encrypted') throw new ImportError(sniffMessage(kind)!);
    if (kind !== 'zip')
      throw new ImportError(tr('暂不支持旧版 .xls 文件，请在 Excel 里另存为 .xlsx 再导入'));
  }
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
    const text = decodeText(buffer);
    const sheet = csvToSheetData(
      text,
      title.slice(0, 31),
      lower.endsWith('.tsv') ? '\t' : undefined,
    );
    if (sheet.cells.length === 0) throw new ImportError(tr('文件是空的'));
    writeWorkbookData(ydoc, { sheets: [sheet] }, { mode: 'replace' });
    return { title };
  }
  let result;
  try {
    result = await readXlsx(buffer);
  } catch (e) {
    throw new ImportError(e instanceof Error ? e.message : tr('没能读取这个 Excel 文件'));
  }
  writeWorkbookData(ydoc, result.data, { mode: 'replace' });
  return result.warnings.length ? { title, warnings: result.warnings } : { title };
}

async function readFileBuffer(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new ImportError(tr('没能读取这个文件')));
    reader.readAsArrayBuffer(file);
  });
}

/** UTF-8（带不带 BOM）；不是合法 UTF-8 时按 GBK 解（Excel 中文版另存的 CSV 常见） */
export function decodeText(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/u, '');
  } catch {
    try {
      return new TextDecoder('gbk').decode(buffer);
    } catch {
      return new TextDecoder('utf-8').decode(buffer);
    }
  }
}
