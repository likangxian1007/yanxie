import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { importXlsx } from '../../../import/xlsx';
import { readWorkbookData } from '../model/io';
import { Workbook, displayOf } from '../model/workbook';
import { sheetToCsv } from './csv';
import { buildPrintHtml, textWidthPx } from './print';
import { writeXlsx } from './xlsx';
import { prepareXlsxPackage } from './xlsxPackage';

/** 和真实使用一样：用 ExcelJS 生成一个 .xlsx（两张表、中文表头、样式、合并标题行、数字格式、跨表公式） */
async function sampleWorkbook(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const s1 = wb.addWorksheet('销售明细', { views: [{ state: 'frozen', ySplit: 2, xSplit: 1 }] });
  s1.mergeCells('A1:D1');
  s1.getCell('A1').value = '2024 年第一季度销售';
  s1.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF1F4E79' } };
  s1.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
  s1.getRow(1).height = 30;
  s1.addRow(['产品', '单价', '数量', '金额']);
  s1.getRow(2).eachCell((c) => {
    c.font = { bold: true };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
    c.border = { bottom: { style: 'thin', color: { argb: 'FF000000' } } };
  });
  const items: Array<[string, number, number]> = [
    ['笔记本', 5999.5, 3],
    ['显示器', 1299, 5],
    ['键盘', 199.9, 12],
  ];
  items.forEach(([name, price, qty], i) => {
    const r = i + 3;
    s1.getCell(`A${r}`).value = name;
    s1.getCell(`B${r}`).value = price;
    s1.getCell(`B${r}`).numFmt = '"¥"#,##0.00';
    s1.getCell(`C${r}`).value = qty;
    s1.getCell(`D${r}`).value = { formula: `B${r}*C${r}`, result: price * qty };
    s1.getCell(`D${r}`).numFmt = '#,##0.00';
  });
  s1.getCell('A6').value = '日期';
  s1.getCell('B6').value = new Date(Date.UTC(2024, 0, 5));
  s1.getCell('B6').numFmt = 'yyyy-mm-dd';
  s1.getColumn(1).width = 20;
  const s2 = wb.addWorksheet('汇总');
  s2.getCell('A1').value = '总金额';
  s2.getCell('B1').value = { formula: 'SUM(销售明细!D3:D5)', result: 26892.3 };
  s2.getCell('A2').value = '占比';
  s2.getCell('B2').value = { formula: '销售明细!D3/B1', result: 0.669 };
  s2.getCell('B2').numFmt = '0.0%';
  s2.getCell('A3').value = '未知函数';
  s2.getCell('B3').value = { formula: 'FOOBAR(1)', result: 42 };
  const buf = await wb.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}

describe('xlsx 导入 / 导出往返', () => {
  it('导入：全部工作表、值、公式（重新计算）、样式、数字格式、合并、冻结、列宽行高', async () => {
    const buffer = await sampleWorkbook();
    const file = new File([buffer], '季度销售.xlsx');
    const doc = new Y.Doc();
    const res = await importXlsx(file, doc);
    expect(res.title).toBe('季度销售');
    const wb = new Workbook(doc);
    expect(wb.sheetIds().map((id) => wb.sheetInfo(id).name)).toEqual(['销售明细', '汇总']);
    const s1 = wb.sheet(wb.sheetIds()[0]!);
    const s2 = wb.sheet(wb.sheetIds()[1]!);
    expect(s1.raw(0, 0)).toBe('2024 年第一季度销售');
    expect(s1.merges()).toEqual([expect.objectContaining({ r0: 0, c0: 0, r1: 0, c1: 3 })]);
    expect(s1.style(0, 0)).toMatchObject({
      b: true,
      fs: 16,
      fc: '#1f4e79',
      ha: 'center',
      va: 'middle',
    });
    expect(s1.style(1, 0)).toMatchObject({
      b: true,
      bg: '#ddebf7',
      bb: { s: 'thin', c: '#000000' },
    });
    expect(s1.raw(2, 3)).toBe('=B3*C3');
    expect(s1.value(2, 3)).toBe(17998.5);
    expect(displayOf(s1, 2, 1).text).toBe('¥5,999.50');
    expect(displayOf(s1, 5, 1).text).toBe('2024-01-05');
    expect(s1.frozen()).toEqual({ rows: 2, cols: 1 });
    expect(s1.colWidth(0)).toBe(145);
    expect(s1.rowHeight(0)).toBe(40);
    expect(s2.value(0, 1)).toBeCloseTo(26892.3);
    expect(displayOf(s2, 1, 1).text).toBe('66.9%');
    // 不支持的函数：退回 Excel 存的缓存值
    expect(s2.value(2, 1)).toBe(42);
  });

  it('导出 .xlsx 后用 ExcelJS 读回：公式、缓存值、样式、合并、冻结都在', async () => {
    const doc = new Y.Doc();
    await importXlsx(new File([await sampleWorkbook()], 'a.xlsx'), doc);
    const wb = new Workbook(doc);
    wb.setCells(wb.sheetIds()[0]!, [{ row: 3, col: 2, raw: '10' }], 'test');
    const blob = await writeXlsx(readWorkbookData(wb));
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(await blob.arrayBuffer());
    const s1 = back.getWorksheet('销售明细')!;
    const s2 = back.getWorksheet('汇总')!;
    expect(s1.getCell('D4').formula).toBe('B4*C4');
    expect((s1.getCell('D4').value as { result: number }).result).toBe(12990);
    expect(s2.getCell('B1').formula).toBe('SUM(销售明细!D3:D5)');
    expect((s2.getCell('B1').value as { result: number }).result).toBeCloseTo(33387.3);
    expect(s1.getCell('A1').font).toMatchObject({ bold: true, size: 16 });
    expect(s1.getCell('A2').fill).toMatchObject({ type: 'pattern', pattern: 'solid' });
    expect(s1.getCell('B3').numFmt).toBe('"¥"#,##0.00');
    expect(s1.getCell('B6').numFmt).toBe('yyyy-mm-dd');
    expect((s1.model as unknown as { merges: string[] }).merges).toContain('A1:D1');
    expect(s1.views[0]).toMatchObject({ state: 'frozen', xSplit: 1, ySplit: 2 });
    expect(Math.round(s1.getColumn(1).width ?? 0)).toBe(20);
  });

  it('CSV 导入导出与打印视图', async () => {
    const doc = new Y.Doc();
    await importXlsx(new File(['名称,数量\n甲,1\n"乙,丙",2\n'], '清单.csv'), doc);
    const wb = new Workbook(doc);
    const s = wb.sheet(wb.sheetIds()[0]!);
    expect(s.raw(2, 0)).toBe('乙,丙');
    expect(s.value(2, 1)).toBe(2);
    expect(sheetToCsv(s)).toBe('\uFEFF名称,数量\r\n甲,1\r\n"乙,丙",2');
    wb.merge(s.id, { r0: 0, c0: 0, r1: 0, c1: 1 }, 'test');
    const html = buildPrintHtml(wb, '清单');
    expect(html).toContain('colspan="2"');
    expect(html).toContain('<td');
    await expect(importXlsx(new File(['x'], 'old.xls'), new Y.Doc())).rejects.toThrow('.xlsx');
  });
});

// ------------------------------------------------------------------ 带图表 / 图片的 .xlsx（二轮终验 #8）

/** 样本来自二轮终验 collab-verify/r2-office/samples（vitest 的 cwd 是 apps/web） */
const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(resolve(process.cwd(), 'src/features/docs/editors/sheet/io/__fixtures__', name)),
  );

async function importBytes(bytes: Uint8Array, name: string) {
  const doc = new Y.Doc();
  const res = await importXlsx(new File([bytes as Uint8Array<ArrayBuffer>], name), doc);
  return { res, wb: new Workbook(doc) };
}

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * 现场拼一个最小的 Excel 风格（带 xdr: 前缀、相对路径）的 .xlsx：
 * 一张表、一个柱状图（标题「季度销量」，引用 Sheet1!B2:B4 和 A2:A4）、一张图片、一个文本框。
 */
function chartPackage(): Uint8Array {
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>季度</t></is></c><c r="B1" t="inlineStr"><is><t>销量</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>Q1</t></is></c><c r="B2"><v>10</v></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>Q2</t></is></c><c r="B3"><v>20</v></c></row>
<row r="4"><c r="A4" t="inlineStr"><is><t>Q3</t></is></c><c r="B4"><v>30</v></c></row>
<row r="5"><c r="B5"><f>SUM(B2:B4)</f><v>60</v></c></row>
</sheetData><drawing r:id="rId1"/></worksheet>`;
  const drawing = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<xdr:twoCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>9</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>14</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="图表 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${NS_R}" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>
<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>7</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="952500" cy="952500"/>
<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="图片 2"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="${NS_R}" r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"/></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>
<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="952500" cy="300000"/>
<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="4" name="文本框 3"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr><xdr:spPr/><xdr:txBody><a:bodyPr/><a:p><a:r><a:t>备注</a:t></a:r></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:oneCellAnchor>
</xdr:wsDr>`;
  const chart = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart>
<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>季度销量</a:t></a:r></a:p></c:rich></c:tx></c:title>
<c:plotArea><c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f></c:strRef></c:tx>
<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$4</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$4</c:f></c:numRef></c:val></c:ser></c:barChart>
<c:valAx><c:title><c:tx><c:rich><a:p><a:r><a:t>坐标轴标题</a:t></a:r></a:p></c:rich></c:tx></c:title></c:valAx></c:plotArea></c:chart></c:chartSpace>`;
  const rels = (items: Array<[string, string, string]>) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
      .map(
        ([id, type, target]) =>
          `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`,
      )
      .join('')}</Relationships>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`;
  return zipSync({
    '[Content_Types].xml': strToU8(ct),
    '_rels/.rels': strToU8(rels([['rId1', 'officeDocument', 'xl/workbook.xml']])),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(rels([['rId1', 'worksheet', 'worksheets/sheet1.xml']])),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
    'xl/worksheets/_rels/sheet1.xml.rels': strToU8(
      rels([['rId1', 'drawing', '../drawings/drawing1.xml']]),
    ),
    'xl/drawings/drawing1.xml': strToU8(drawing),
    'xl/drawings/_rels/drawing1.xml.rels': strToU8(
      rels([
        ['rId1', 'chart', '../charts/chart1.xml'],
        ['rId2', 'image', '../media/image1.png'],
      ]),
    ),
    'xl/charts/chart1.xml': strToU8(chart),
    'xl/media/image1.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  });
}

describe('打印 / PDF 视图不裁字（终验：「2026-10-0」「引用实验数」）', () => {
  const colWidths = (html: string, section: number) => {
    const sec = html.split('<section>')[section + 1] ?? '';
    return [...sec.matchAll(/<col style="width:(\d+)px">/gu)].map((m) => Number(m[1]));
  };

  it('日期、表格最右列的文本按内容加宽列', async () => {
    const { wb } = await importBytes(fixture('chart-experiment.xlsx'), 'office-实验数据.xlsx');
    const html = buildPrintHtml(wb, '实验数据');
    expect(html).toContain('2026-10-01');
    const font = 14.67;
    // 实验数据：E 列是 yyyy-mm-dd 日期（原列宽 64px，放不下）
    expect(colWidths(html, 0)[4]).toBeGreaterThanOrEqual(
      Math.ceil(textWidthPx('2026-10-01', font)),
    );
    // 参数：D 列「引用实验数据」在最右列，右边没有格子可溢出
    expect(colWidths(html, 1)[3]).toBeGreaterThanOrEqual(
      Math.ceil(textWidthPx('引用实验数据', font)),
    );
    // 放得下的列不动
    expect(colWidths(html, 1)[1]).toBe(wb.sheet(wb.sheetIds()[1]!).colWidth(1));
  });

  it('右边有内容的超长文本：加宽到上限后在格内换行；右边是空格子的照旧溢出', () => {
    const doc = new Y.Doc();
    const wb = new Workbook(doc);
    const id = wb.addSheet('test', { name: '备注' });
    const long = '这是一段很长的实验备注，'.repeat(12);
    wb.setCells(
      id,
      [
        { row: 0, col: 0, raw: long },
        { row: 0, col: 1, raw: '右边有字' },
        { row: 1, col: 0, raw: '溢出到右边的空格子里也没关系' },
      ],
      'test',
    );
    const html = buildPrintHtml(wb, '备注', [id]);
    expect(html).toMatch(new RegExp(`<td class="wrap"[^>]*>${long}</td>`, 'u'));
    expect(html).toMatch(/<td class="spill"[^>]*>溢出到右边的空格子里也没关系<\/td>/u);
    expect(colWidths(html, 0)[0]).toBe(360);
  });
});

describe('条件格式原样保留并在导出时写回', () => {
  it('CellIsRule 和 ColorScale：导入保存在工作簿里，插入行后区域跟着走，导出 .xlsx 写回', async () => {
    const { res, wb } = await importBytes(fixture('chart-experiment.xlsx'), 'office-实验数据.xlsx');
    expect(res.warnings).toContain(
      '条件格式已保留（编辑器里暂不显示效果，导出 .xlsx 时会原样写回）',
    );
    const id = wb.sheetIds()[0]!;
    // 在第 1 行下面插一行：C2:C5 → C3:C6
    wb.insertRows(id, 1, 1, 'test');
    const blob = await writeXlsx(readWorkbookData(wb));
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(await blob.arrayBuffer());
    const cfs = (
      back.getWorksheet('实验数据') as unknown as {
        conditionalFormattings: Array<{ ref: string; rules: Array<Record<string, unknown>> }>;
      }
    ).conditionalFormattings;
    expect(cfs).toHaveLength(2);
    expect(cfs[0]).toMatchObject({
      ref: 'C3:C6',
      rules: [
        {
          type: 'cellIs',
          operator: 'greaterThan',
          formulae: ['0.7'],
          style: { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: '00C6EFCE' } } },
        },
      ],
    });
    expect(cfs[1]).toMatchObject({
      ref: 'D3:D6',
      rules: [
        {
          type: 'colorScale',
          cfvo: [{ type: 'min' }, { type: 'max' }],
          color: [{ argb: '00FFFFFF' }, { argb: '00F8696B' }],
        },
      ],
    });
    // 其他表没有条件格式
    expect(
      (back.getWorksheet('参数') as unknown as { conditionalFormattings: unknown[] })
        .conditionalFormattings,
    ).toHaveLength(0);
  });

  it('整列区域按表的大小截断；区域所在的行全被删掉时这一组丢弃', async () => {
    const src = new ExcelJS.Workbook();
    const ws = src.addWorksheet('S');
    ws.getCell('A1').value = 1;
    ws.getCell('A2').value = 2;
    ws.addConditionalFormatting({
      ref: 'A:A',
      rules: [
        { type: 'expression', priority: 1, formulae: ['A1>1'], style: { font: { bold: true } } },
      ],
    });
    ws.addConditionalFormatting({
      ref: 'B2',
      rules: [{ type: 'containsText', operator: 'containsText', text: 'x', priority: 2 }],
    });
    const { wb } = await importBytes(new Uint8Array(await src.xlsx.writeBuffer()), 's.xlsx');
    const id = wb.sheetIds()[0]!;
    const rows = wb.sheet(id).rowCount;
    wb.deleteRows(id, 1, 1, 'test');
    const out = readWorkbookData(wb)[0]!.condFormats!;
    expect(out).toHaveLength(1);
    expect(out[0]!.ranges).toEqual([{ r0: 0, c0: 0, r1: rows - 2, c1: 0 }]);
    expect(out[0]!.rules[0]).toMatchObject({ type: 'expression', formulae: ['A1>1'] });
  });
});

describe('带图表的 .xlsx 导入（终验 #8）', () => {
  it('真实样本 office-实验数据.xlsx（openpyxl 生成，带柱状图）：导入成功，数据、公式都在，提示图表引用范围', async () => {
    const { res, wb } = await importBytes(fixture('chart-experiment.xlsx'), 'office-实验数据.xlsx');
    expect(wb.sheetIds().map((id) => wb.sheetInfo(id).name)).toEqual(['实验数据', '参数', '汇总']);
    const s1 = wb.sheet(wb.sheetIds()[0]!);
    const s3 = wb.sheet(wb.sheetIds()[2]!);
    expect(s1.raw(0, 0)).toBe('实验组');
    expect(s1.value(1, 2)).toBe(0.697);
    expect(s1.raw(1, 7)).toBe('=MAX(C2:C5)');
    expect(s1.value(1, 7)).toBe(0.781);
    expect(s1.raw(6, 2)).toBe('=AVERAGE(C2:C5)');
    expect(s1.value(6, 2)).toBeCloseTo(0.7045);
    expect(s1.merges()).toEqual([expect.objectContaining({ r0: 6, c0: 0, r1: 6, c1: 1 })]);
    expect(s1.frozen()).toEqual({ rows: 1, cols: 0 });
    expect(s3.raw(0, 1)).toBe('=实验数据!D7+参数!B3');
    expect(s3.value(1, 1)).toBe(2);
    const warnings = res.warnings ?? [];
    expect(warnings).toContain('图表未导入（1 个，表格暂不支持图表），数据和公式已正常导入');
    expect(warnings).toContain('图表「各组准确率」引用 实验数据!A2:A5、C2:C5，已跳过');
    expect(warnings.join('；')).not.toMatch(/损坏|密码/u);
  });

  it('变体样本 v3-chart（无标题图表）和 v8-relfix（rels 用相对路径）都能导入', async () => {
    const v3 = await importBytes(fixture('chart-v3.xlsx'), 'v3-chart.xlsx');
    const s = v3.wb.sheet(v3.wb.sheetIds()[0]!);
    expect(s.value(1, 1)).toBe(0.6);
    expect(s.raw(6, 1)).toBe('=AVERAGE(B2:B5)');
    expect(s.value(6, 1)).toBeCloseTo(0.675);
    expect(v3.res.warnings).toContain('图表「Chart 1」引用 实验数据!B2:B5，已跳过');

    const v8 = await importBytes(fixture('chart-v8-relfix.xlsx'), 'v8-relfix.xlsx');
    expect(v8.wb.sheetIds()).toHaveLength(3);
    expect(v8.wb.sheet(v8.wb.sheetIds()[0]!).raw(1, 7)).toBe('=MAX(C2:C5)');
    expect(v8.res.warnings).toContain('图表「各组准确率」引用 实验数据!A2:A5、C2:C5，已跳过');
  });

  it('对照：不带图表的同一份数据，结果一致且没有图表提示', async () => {
    const { res, wb } = await importBytes(
      fixture('nochart-experiment.xlsx'),
      'office-实验数据-无图表.xlsx',
    );
    const s1 = wb.sheet(wb.sheetIds()[0]!);
    expect(s1.value(1, 7)).toBe(0.781);
    expect(s1.value(6, 2)).toBeCloseTo(0.7045);
    expect((res.warnings ?? []).join()).not.toContain('图表');
  });

  it('现场构造的 Excel 风格包：图表、图片、文本框分别提示，坐标轴标题不当成图表标题', async () => {
    const { res, wb } = await importBytes(chartPackage(), '最小图表.xlsx');
    const s = wb.sheet(wb.sheetIds()[0]!);
    expect(s.raw(0, 1)).toBe('销量');
    expect(s.raw(4, 1)).toBe('=SUM(B2:B4)');
    expect(s.value(4, 1)).toBe(60);
    expect(res.warnings).toEqual([
      '图表未导入（1 个，表格暂不支持图表），数据和公式已正常导入',
      '图表「季度销量」引用 Sheet1!A2:A4、B2:B4，已跳过',
      '图片未导入（1 张，表格暂不支持图片）',
      '形状和文本框未导入（1 个）',
    ]);
  });

  it('预处理后的包里没有 drawing / chart 部件和引用，其余部件原样保留', () => {
    const pkg = prepareXlsxPackage(chartPackage());
    expect(pkg.changed).toBe(true);
    const out = unzipSync(pkg.bytes);
    const names = Object.keys(out);
    expect(names.some((n) => n.startsWith('xl/drawings/') || n.startsWith('xl/charts/'))).toBe(
      false,
    );
    expect(names).toContain('xl/media/image1.png');
    expect(strFromU8(out['xl/worksheets/sheet1.xml']!)).not.toContain('<drawing');
    expect(strFromU8(out['xl/worksheets/_rels/sheet1.xml.rels']!)).not.toContain('drawing');
    const ct = strFromU8(out['[Content_Types].xml']!);
    expect(ct).not.toMatch(/drawing1|chart1/u);
    expect(ct).toContain('/xl/worksheets/sheet1.xml');
    // 没有图表的文件不重新打包
    const plain = new Uint8Array([...fixture('nochart-experiment.xlsx')]);
    expect(prepareXlsxPackage(plain)).toMatchObject({ changed: false, bytes: plain });
  });

  it('只有真打不开时才说损坏；密码保护、旧版 .xls、其他文件分别提示', async () => {
    const cfb = (stream: string) => {
      const bytes = new Uint8Array(1024);
      bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
      [...stream].forEach((ch, i) => (bytes[512 + i * 2] = ch.charCodeAt(0)));
      return bytes;
    };
    const run = (bytes: Uint8Array, name = 'a.xlsx') =>
      importXlsx(new File([bytes as Uint8Array<ArrayBuffer>], name), new Y.Doc());
    await expect(run(cfb('EncryptionInfo'))).rejects.toThrow('设置了打开密码');
    await expect(run(cfb('EncryptionInfo'), 'a.xls')).rejects.toThrow('设置了打开密码');
    await expect(run(cfb('Workbook'))).rejects.toThrow('旧版 Excel 97-2003');
    await expect(run(strToU8('名称,数量\n甲,1'))).rejects.toThrow('不是 .xlsx 格式');
    await expect(run(new Uint8Array())).rejects.toThrow('文件是空的');
    const docx = zipSync({ 'word/document.xml': strToU8('<w:document/>') });
    await expect(run(docx)).rejects.toThrow('Word 文档');
    // zip 头后面是垃圾：真正的损坏
    const broken = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(200).fill(7)]);
    await expect(run(broken)).rejects.toThrow('已损坏');
    await expect(run(broken)).rejects.not.toThrow('密码');
    // 内容其实是 .xlsx、扩展名写成 .xls：照常导入
    const { wb } = await importBytes(chartPackage(), '改了扩展名.xls');
    expect(wb.sheet(wb.sheetIds()[0]!).value(4, 1)).toBe(60);
  });
});
