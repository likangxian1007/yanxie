import type * as ExcelJSNS from 'exceljs';
import { isFormula, jsDateToSerial, parseLiteral } from '../engine/values';
import { colIndex, rangeLabel, type CellRange } from '../lib/a1';
import type {
  CondFormatData,
  ExportSheet,
  SheetCellData,
  SheetData,
  WorkbookData,
} from '../model/io';
import type { BorderSide, BorderStyle, CachedValue, CellStyle } from '../model/schema';
import {
  packageWarnings,
  prepareXlsxPackage,
  sniffMessage,
  sniffSpreadsheet,
  XlsxPackageError,
  type XlsxPackageResult,
} from './xlsxPackage';
import { tr } from '@/lib/i18n';

/**
 * .xlsx 读写（ExcelJS，MIT）。只负责 Excel ⇄ WorkbookData（model/io.ts），不碰 Yjs。
 * 保留：全部工作表（含隐藏）、值、公式（公式 + Excel 的缓存值）、字体 / 填充 / 边框 / 对齐 / 换行、
 * 数字格式、合并单元格、列宽行高、隐藏行列、冻结窗格、自动筛选范围。
 */

type ExcelJS = typeof ExcelJSNS;

let lib: Promise<ExcelJS> | null = null;
/** 按需加载（约 1 MB，只在导入导出时下载） */
export function loadExcelJS(): Promise<ExcelJS> {
  lib ??= import('exceljs').then((m) => {
    const mod = m as unknown as ExcelJS & { default?: ExcelJS };
    return mod.default && 'Workbook' in mod.default ? mod.default : mod;
  });
  return lib;
}

// ------------------------------------------------------------------ 尺寸换算

/** Excel 列宽（字符数，Calibri 11 的数字宽 7px）→ px */
export const excelWidthToPx = (w: number) => Math.round(w * 7 + 5);
export const pxToExcelWidth = (px: number) => Math.max(0.5, Math.round(((px - 5) / 7) * 100) / 100);
/** 行高 pt → px */
export const ptToPx = (pt: number) => Math.round((pt * 4) / 3);
export const pxToPt = (px: number) => Math.round(px * 0.75 * 100) / 100;

const DEFAULT_FONT_PT = 11;

// ------------------------------------------------------------------ 颜色

/** Office 默认主题色（lt1 dk1 lt2 dk2 accent1-6 hlink folHlink） */
const THEME = [
  'FFFFFF',
  '000000',
  'E7E6E6',
  '44546A',
  '4472C4',
  'ED7D31',
  'A5A5A5',
  'FFC000',
  '5B9BD5',
  '70AD47',
  '0563C1',
  '954F72',
];
const INDEXED: Record<number, string> = {
  0: '000000',
  1: 'FFFFFF',
  2: 'FF0000',
  3: '00FF00',
  4: '0000FF',
  5: 'FFFF00',
  6: 'FF00FF',
  7: '00FFFF',
  8: '000000',
  9: 'FFFFFF',
  10: 'FF0000',
  11: '00FF00',
  12: '0000FF',
  13: 'FFFF00',
  14: 'FF00FF',
  15: '00FFFF',
  16: '800000',
  17: '008000',
  18: '000080',
  19: '808000',
  20: '800080',
  21: '008080',
  22: 'C0C0C0',
  23: '808080',
};

function applyTint(hex: string, tint: number): string {
  if (!tint) return hex;
  const ch = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const out = ch.map((v) => (tint < 0 ? v * (1 + tint) : v + (255 - v) * tint));
  return out
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
}

function colorOf(
  c: (Partial<ExcelJSNS.Color> & { indexed?: number; tint?: number }) | undefined,
): string | undefined {
  if (!c) return undefined;
  let hex: string | undefined;
  if (typeof c.argb === 'string' && /^[0-9a-f]{6,8}$/iu.test(c.argb)) hex = c.argb.slice(-6);
  else if (typeof c.theme === 'number') hex = THEME[c.theme];
  else if (typeof c.indexed === 'number') hex = INDEXED[c.indexed];
  if (!hex) return undefined;
  if (typeof c.tint === 'number') hex = applyTint(hex, c.tint);
  return `#${hex.toLowerCase()}`;
}

const argb = (hex: string) => `FF${hex.replace('#', '').toUpperCase()}`;

// ------------------------------------------------------------------ 样式

const BORDER_IN: Record<string, BorderStyle> = {
  thin: 'thin',
  hair: 'thin',
  medium: 'medium',
  thick: 'thick',
  dashed: 'dashed',
  mediumDashed: 'dashed',
  dashDot: 'dashed',
  dashDotDot: 'dashed',
  mediumDashDot: 'dashed',
  mediumDashDotDot: 'dashed',
  slantDashDot: 'dashed',
  dotted: 'dotted',
  double: 'double',
};

function borderIn(b: Partial<ExcelJSNS.Border> | undefined): BorderSide | undefined {
  if (!b?.style) return undefined;
  const s = BORDER_IN[b.style];
  if (!s) return undefined;
  return { s, c: colorOf(b.color) ?? '#000000' };
}

export function styleFromExcel(cell: ExcelJSNS.Cell): CellStyle | undefined {
  const st: CellStyle = {};
  const f = cell.font;
  if (f) {
    if (f.bold) st.b = true;
    if (f.italic) st.i = true;
    if (f.underline && f.underline !== 'none') st.u = true;
    if (f.strike) st.s = true;
    if (typeof f.size === 'number' && f.size !== DEFAULT_FONT_PT) st.fs = f.size;
    const fc = colorOf(f.color);
    if (fc && fc !== '#000000') st.fc = fc;
    if (f.name && !/^(Calibri|等线|宋体|DengXian|SimSun|Arial)$/iu.test(f.name)) st.ff = f.name;
  }
  const fill = cell.fill;
  if (fill?.type === 'pattern' && fill.pattern === 'solid') {
    const bg = colorOf(fill.fgColor) ?? colorOf(fill.bgColor);
    if (bg) st.bg = bg;
  } else if (fill?.type === 'gradient') {
    const bg = colorOf(fill.stops?.[0]?.color);
    if (bg) st.bg = bg;
  }
  const a = cell.alignment;
  if (a) {
    if (a.horizontal === 'left' || a.horizontal === 'center' || a.horizontal === 'right')
      st.ha = a.horizontal;
    else if (a.horizontal === 'centerContinuous') st.ha = 'center';
    if (a.vertical === 'top' || a.vertical === 'middle' || a.vertical === 'bottom')
      st.va = a.vertical;
    if (a.wrapText) st.wrap = true;
  }
  const b = cell.border;
  if (b) {
    const t = borderIn(b.top);
    const r = borderIn(b.right);
    const bb = borderIn(b.bottom);
    const l = borderIn(b.left);
    if (t) st.bt = t;
    if (r) st.br = r;
    if (bb) st.bb = bb;
    if (l) st.bl = l;
  }
  if (cell.numFmt && cell.numFmt !== 'General') st.nf = cell.numFmt;
  return Object.keys(st).length ? st : undefined;
}

const BORDER_OUT: Record<BorderStyle, ExcelJSNS.BorderStyle> = {
  thin: 'thin',
  medium: 'medium',
  thick: 'thick',
  dashed: 'dashed',
  dotted: 'dotted',
  double: 'double',
};

export function styleToExcel(st: CellStyle): Partial<ExcelJSNS.Style> {
  const out: Partial<ExcelJSNS.Style> = {};
  const font: Partial<ExcelJSNS.Font> = {};
  if (st.b) font.bold = true;
  if (st.i) font.italic = true;
  if (st.u) font.underline = true;
  if (st.s) font.strike = true;
  if (st.fs) font.size = st.fs;
  if (st.ff) font.name = st.ff;
  if (st.fc) font.color = { argb: argb(st.fc) };
  if (Object.keys(font).length) out.font = font;
  if (st.bg) out.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(st.bg) } };
  const al: Partial<ExcelJSNS.Alignment> = {};
  if (st.ha) al.horizontal = st.ha;
  if (st.va) al.vertical = st.va;
  if (st.wrap) al.wrapText = true;
  if (Object.keys(al).length) out.alignment = al;
  const border: Partial<ExcelJSNS.Borders> = {};
  const side = (b: BorderSide | undefined) =>
    b ? { style: BORDER_OUT[b.s] ?? 'thin', color: { argb: argb(b.c) } } : undefined;
  if (st.bt) border.top = side(st.bt);
  if (st.br) border.right = side(st.br);
  if (st.bb) border.bottom = side(st.bb);
  if (st.bl) border.left = side(st.bl);
  if (Object.keys(border).length) out.border = border;
  if (st.nf) out.numFmt = st.nf;
  return out;
}

// ------------------------------------------------------------------ 读

/** 文本里看起来像数字 / 公式 / 日期的，加 ' 前缀保持为文本 */
export function textRaw(s: string): string {
  if (s === '') return '';
  if (s.startsWith('=') || s.startsWith("'")) return `'${s}`;
  const lit = parseLiteral(s);
  return lit.value === s ? s : `'${s}`;
}

function cachedOf(v: unknown): CachedValue | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (v instanceof Date) return jsDateToSerial(v);
  if (typeof v === 'object' && 'error' in v) return { e: String((v as { error: unknown }).error) };
  return undefined;
}

function cellRaw(cell: ExcelJSNS.Cell): { raw: string; cached?: CachedValue } {
  const v = cell.value as unknown;
  if (v === null || v === undefined) return { raw: '' };
  if (typeof v === 'object' && v !== null && ('formula' in v || 'sharedFormula' in v)) {
    const formula = cell.formula;
    const result = (v as { result?: unknown }).result;
    if (formula) return { raw: `=${formula.replace(/^=/u, '')}`, cached: cachedOf(result) };
    const c = cachedOf(result);
    return { raw: c === undefined ? '' : typeof c === 'object' ? c.e : String(c) };
  }
  if (typeof v === 'number') return { raw: String(v) };
  if (typeof v === 'boolean') return { raw: v ? 'TRUE' : 'FALSE' };
  if (typeof v === 'string') return { raw: textRaw(v) };
  if (v instanceof Date) return { raw: String(jsDateToSerial(v)) };
  if (typeof v === 'object') {
    if ('richText' in v) {
      const text = ((v as ExcelJSNS.CellRichTextValue).richText ?? []).map((t) => t.text).join('');
      return { raw: textRaw(text) };
    }
    if ('hyperlink' in v)
      return { raw: textRaw(String((v as ExcelJSNS.CellHyperlinkValue).text ?? '')) };
    if ('error' in v) return { raw: String((v as ExcelJSNS.CellErrorValue).error) };
  }
  return { raw: textRaw(String(v)) };
}

function parseRangeRef(ref: string): { r0: number; c0: number; r1: number; c1: number } | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/iu.exec(ref.trim());
  if (!m) return null;
  const col = (s: string) => {
    let n = 0;
    for (const ch of s.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
    return n - 1;
  };
  const r0 = Number(m[2]) - 1;
  const c0 = col(m[1]!);
  const r1 = m[4] ? Number(m[4]) - 1 : r0;
  const c1 = m[3] ? col(m[3]) : c0;
  return { r0: Math.min(r0, r1), c0: Math.min(c0, c1), r1: Math.max(r0, r1), c1: Math.max(c0, c1) };
}

/** 条件格式的 sqref 里还会出现整列 C:C / 整行 2:2：先给一个足够大的范围，写进 Y.Doc 时按表的大小截断 */
function parseSqrefPart(ref: string): CellRange | null {
  const full = parseRangeRef(ref);
  if (full) return full;
  const col = /^\$?([A-Z]{1,3}):\$?([A-Z]{1,3})$/iu.exec(ref.trim());
  if (col) {
    const a = colIndex(col[1]!.toUpperCase());
    const b = colIndex(col[2]!.toUpperCase());
    return { r0: 0, c0: Math.min(a, b), r1: 1_048_575, c1: Math.max(a, b) };
  }
  const row = /^\$?(\d+):\$?(\d+)$/u.exec(ref.trim());
  if (row) {
    const a = Number(row[1]) - 1;
    const b = Number(row[2]) - 1;
    return { r0: Math.min(a, b), c0: 0, r1: Math.max(a, b), c1: 16_383 };
  }
  return null;
}

/** 去掉 ExcelJS 模型里的 null / undefined，保证能放进 Y.Doc（纯 JSON） */
function plainJson(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) return v.map((x) => plainJson(x) ?? null);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const y = plainJson(x);
      if (y !== undefined) out[k] = y;
    }
    return out;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return undefined;
  return v;
}

/** ExcelJS 的 { ref, rules } → CondFormatData；区域解析不了或没有规则时返回 null */
function condFormatFromExcel(cf: unknown): CondFormatData | null {
  if (!cf || typeof cf !== 'object') return null;
  const { ref, rules } = cf as { ref?: unknown; rules?: unknown };
  if (typeof ref !== 'string' || !Array.isArray(rules) || rules.length === 0) return null;
  const ranges: CellRange[] = [];
  for (const part of ref.trim().split(/\s+/u)) {
    const r = parseSqrefPart(part);
    if (!r) return null;
    ranges.push(r);
  }
  const clean = rules.map((r) => plainJson(r)).filter((r) => r && typeof r === 'object');
  return ranges.length && clean.length ? { ranges, rules: clean } : null;
}

export interface XlsxReadResult {
  data: WorkbookData;
  warnings: string[];
}

/** 只有真的解不开 zip 时才说「损坏」 */
const CORRUPT_MESSAGE = tr(
  '这个文件已损坏，没能解压。请用 Excel 打开确认能正常显示，另存一份 .xlsx 后再导入',
);
/** zip 正常、ExcelJS 仍然读不了：不猜原因，给可操作的建议 */
const UNSUPPORTED_MESSAGE = tr(
  '这个 Excel 文件里有暂不支持的内容，没能读取。可以在 Excel 里「另存为」一份新的 .xlsx 再导入；如果还不行，把数据复制到新建的表格里',
);

export async function readXlsx(buffer: ArrayBuffer): Promise<XlsxReadResult> {
  const bytes = new Uint8Array(buffer);
  const notZip = sniffMessage(sniffSpreadsheet(bytes));
  if (notZip) throw new Error(notZip);
  let pkg: XlsxPackageResult | null = null;
  try {
    // 剥掉 ExcelJS 读不了的图表 / 绘图层，同时数出来写进提示
    pkg = prepareXlsxPackage(bytes);
  } catch (e) {
    if (!(e instanceof XlsxPackageError)) throw e;
    // fflate 解不开时退回把原文件交给 ExcelJS（JSZip）再试一次，它也不行才算损坏
    if (e.message !== 'corrupt') throw new Error(e.message, { cause: e });
  }
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load((pkg?.bytes ?? bytes) as unknown as Parameters<typeof wb.xlsx.load>[0]);
  } catch (e) {
    console.warn('[xlsx] ExcelJS 读取失败', e);
    // JSZip 解压层面的错误（目录损坏、CRC 不对、deflate 数据坏）才算损坏
    const zipBroken =
      /corrupt|crc32|end of data|invalid (?:stored|code|distance|block)|deflate/iu.test(
        e instanceof Error ? e.message : String(e),
      );
    throw new Error(!pkg || zipBroken ? CORRUPT_MESSAGE : UNSUPPORTED_MESSAGE, { cause: e });
  }
  const warnings: string[] = pkg ? packageWarnings(pkg) : [];
  const sheets: SheetData[] = [];
  let images = 0;
  let validations = 0;
  let cfKept = 0;
  let cfDropped = 0;
  wb.eachSheet((ws) => {
    const cells: SheetCellData[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        if (cell.type === 1 /* Merge：合并区域里的从属格 */) return;
        const { raw, cached } = cellRaw(cell);
        const style = styleFromExcel(cell);
        if (!raw && !style) return;
        const out: SheetCellData = { r: rowNumber - 1, c: colNumber - 1, raw };
        if (style) out.style = style;
        if (cached !== undefined && isFormula(raw)) out.cached = cached;
        cells.push(out);
      });
    });
    const rowHeights: Record<number, number> = {};
    const hiddenRows: number[] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      if (row.height && Math.abs(row.height - 15) > 0.5) rowHeights[n - 1] = ptToPx(row.height);
      if (row.hidden) hiddenRows.push(n - 1);
    });
    const colWidths: Record<number, number> = {};
    const hiddenCols: number[] = [];
    const defaultW = ws.properties?.defaultColWidth ?? 8.43;
    const colCount = Math.max(ws.columnCount, ws.actualColumnCount);
    for (let c = 1; c <= colCount; c += 1) {
      const col = ws.getColumn(c);
      colWidths[c - 1] = excelWidthToPx(col.width ?? defaultW);
      if (col.hidden) hiddenCols.push(c - 1);
    }
    const merges: SheetData['merges'] = [];
    const model = ws.model as unknown as { merges?: string[] };
    for (const ref of model.merges ?? []) {
      const r = parseRangeRef(ref);
      if (r) merges.push(r);
    }
    const view = ws.views?.[0] as Partial<ExcelJSNS.WorksheetViewFrozen> | undefined;
    const frozen = view?.state === 'frozen' ? view : undefined;
    let filter: SheetData['filter'];
    const af = ws.autoFilter as unknown;
    if (typeof af === 'string') filter = parseRangeRef(af) ?? undefined;
    else if (af && typeof af === 'object' && 'from' in af) {
      const a = af as {
        from: string | { row: number; column: number };
        to: string | { row: number; column: number };
      };
      const ref = (x: typeof a.from) =>
        typeof x === 'string' ? x : `${String.fromCharCode(64 + x.column)}${x.row}`;
      filter = parseRangeRef(`${ref(a.from)}:${ref(a.to)}`) ?? undefined;
    }
    const condFormats: CondFormatData[] = [];
    const rawCf = (ws as unknown as { conditionalFormattings?: unknown[] }).conditionalFormattings;
    for (const cf of rawCf ?? []) {
      const kept = condFormatFromExcel(cf);
      if (kept) condFormats.push(kept);
      else cfDropped += 1;
    }
    images += ws.getImages?.().length ?? 0;
    const dv = (ws as unknown as { dataValidations?: { model?: Record<string, unknown> } })
      .dataValidations;
    validations += Object.keys(dv?.model ?? {}).length;
    sheets.push({
      name: ws.name,
      hidden: ws.state === 'hidden' || ws.state === 'veryHidden',
      rows: ws.rowCount,
      cols: colCount,
      cells,
      rowHeights,
      colWidths,
      hiddenRows,
      hiddenCols,
      merges,
      frozenRows: frozen?.ySplit || 0,
      frozenCols: frozen?.xSplit || 0,
      filter,
      ...(condFormats.length ? { condFormats } : {}),
    });
    cfKept += condFormats.length;
  });
  if (sheets.length === 0) throw new Error(tr('这个 Excel 文件里没有工作表'));
  // drawing 已在预处理时剥掉并计数；这里一般是 0，留着兜底
  if (images) warnings.push(tr('图片未导入（{images} 张，表格暂不支持图片）', { images }));
  if (validations) warnings.push(tr('数据验证（下拉列表等）没有导入'));
  if (cfKept) warnings.push(tr('条件格式已保留（编辑器里暂不显示效果，导出 .xlsx 时会原样写回）'));
  if (cfDropped) warnings.push(tr('有 {cfDropped} 组条件格式没能保留', { cfDropped }));
  return { data: { sheets }, warnings };
}

// ------------------------------------------------------------------ 写

function exportValue(c: ExportSheet['cells'][number]): ExcelJSNS.CellValue {
  if (c.raw === '') return null;
  if (isFormula(c.raw)) {
    const v = c.value;
    const result =
      v === null
        ? undefined
        : typeof v === 'object'
          ? ({ error: v.error } as ExcelJSNS.CellErrorValue)
          : v;
    return { formula: c.raw.slice(1), result } as ExcelJSNS.CellFormulaValue;
  }
  const v = c.value;
  if (v === null) return null;
  if (typeof v === 'object') return { error: v.error } as ExcelJSNS.CellErrorValue;
  return v;
}

/** 导出 .xlsx（Blob）。sheets 为 readWorkbookData 的结果。 */
export async function writeXlsx(
  sheets: ExportSheet[],
  meta: { creator?: string } = {},
): Promise<Blob> {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.creator ?? tr('研协');
  wb.created = new Date();
  for (const s of sheets) {
    const views: Array<Partial<ExcelJSNS.WorksheetView>> =
      s.frozenRows || s.frozenCols
        ? [{ state: 'frozen', xSplit: s.frozenCols || 0, ySplit: s.frozenRows || 0 }]
        : [];
    const ws = wb.addWorksheet(s.name, {
      views,
      state: s.hidden ? 'hidden' : 'visible',
    });
    for (const [c, w] of Object.entries(s.colWidths ?? {}))
      ws.getColumn(Number(c) + 1).width = pxToExcelWidth(w);
    for (const c of s.hiddenCols ?? []) ws.getColumn(c + 1).hidden = true;
    for (const [r, h] of Object.entries(s.rowHeights ?? {}))
      ws.getRow(Number(r) + 1).height = pxToPt(h);
    for (const r of s.hiddenRows ?? []) ws.getRow(r + 1).hidden = true;
    for (const c of s.cells) {
      const cell = ws.getCell(c.r + 1, c.c + 1);
      const v = exportValue(c);
      if (v !== null) cell.value = v;
      const st = c.style ? styleToExcel(c.style) : {};
      if (!st.numFmt && c.numFmt) st.numFmt = c.numFmt;
      if (st.font) cell.font = st.font as ExcelJSNS.Font;
      if (st.fill) cell.fill = st.fill;
      if (st.alignment) cell.alignment = st.alignment as ExcelJSNS.Alignment;
      if (st.border) cell.border = st.border as ExcelJSNS.Borders;
      if (st.numFmt) cell.numFmt = st.numFmt;
    }
    for (const m of s.merges ?? []) ws.mergeCells(m.r0 + 1, m.c0 + 1, m.r1 + 1, m.c1 + 1);
    for (const cf of s.condFormats ?? []) {
      try {
        ws.addConditionalFormatting({
          ref: cf.ranges.map(rangeLabel).join(' '),
          rules: cf.rules as ExcelJSNS.ConditionalFormattingRule[],
        });
      } catch (e) {
        // 某条规则 ExcelJS 写不了：跳过这一组，不影响整个导出
        console.warn('[xlsx] 条件格式没有写出', e);
      }
    }
    if (s.filter) {
      ws.autoFilter = {
        from: { row: s.filter.r0 + 1, column: s.filter.c0 + 1 },
        to: { row: s.filter.r1 + 1, column: s.filter.c1 + 1 },
      };
    }
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
