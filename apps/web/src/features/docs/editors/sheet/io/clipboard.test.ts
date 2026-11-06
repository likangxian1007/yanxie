import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { copyPayload, parseHtmlTable } from './clipboard';
import { planFill } from '../model/fill';
import { prepareWorkbook } from '../model/migrate';
import { Workbook } from '../model/workbook';

describe('fill handle and clipboard', () => {
  it('extends numeric series, text with numbers and shifts formulas', () => {
    const doc = new Y.Doc();
    prepareWorkbook(doc);
    const wb = new Workbook(doc);
    wb.setCells(
      's1',
      [
        { row: 0, col: 0, raw: '1' },
        { row: 1, col: 0, raw: '3' },
        { row: 0, col: 1, raw: '第1组' },
        { row: 0, col: 2, raw: '=A1*2' },
      ],
      null,
    );
    const s = wb.sheet('s1');
    const writes = planFill(s, { r0: 0, c0: 0, r1: 1, c1: 0 }, { r0: 0, c0: 0, r1: 3, c1: 0 });
    expect(writes.map((w) => w.raw)).toEqual(['5', '7']);
    const t = planFill(s, { r0: 0, c0: 1, r1: 0, c1: 2 }, { r0: 0, c0: 1, r1: 2, c1: 2 });
    expect(t.filter((w) => w.col === 1).map((w) => w.raw)).toEqual(['第2组', '第3组']);
    expect(t.filter((w) => w.col === 2).map((w) => w.raw)).toEqual(['=A2*2', '=A3*2']);
  });

  it('copies styled HTML that parses back with styles and merges', () => {
    const doc = new Y.Doc();
    prepareWorkbook(doc);
    const wb = new Workbook(doc);
    wb.setCells(
      's1',
      [
        { row: 0, col: 0, raw: '标题' },
        { row: 1, col: 0, raw: '0.25' },
        { row: 1, col: 1, raw: 'x' },
      ],
      null,
    );
    wb.applyStyle(
      's1',
      { r0: 0, c0: 0, r1: 0, c1: 1 },
      { b: true, bg: '#ddebf7', ha: 'center' },
      null,
    );
    wb.applyStyle('s1', { r0: 1, c0: 0, r1: 1, c1: 0 }, { nf: '0.00%' }, null);
    wb.merge('s1', { r0: 0, c0: 0, r1: 0, c1: 1 }, null);
    const { text, html } = copyPayload(wb.sheet('s1'), { r0: 0, c0: 0, r1: 1, c1: 1 });
    expect(text.split(/\r?\n/u)[1]).toBe('25.00%\tx');
    const grid = parseHtmlTable(html)!;
    expect(grid.merges).toEqual([{ r0: 0, c0: 0, r1: 0, c1: 1 }]);
    expect(grid.cells[0]![0]).toMatchObject({
      raw: '标题',
      style: { b: true, bg: '#ddebf7', ha: 'center' },
    });
    expect(grid.cells[1]![0]!.style?.nf).toBe('0.00%');
  });

  it('parses Excel clipboard HTML with class styles', () => {
    const html = `<html><head><style><!--
.xl65 {font-weight:700; background:#FFFF00; mso-number-format:"0\\.00";}
--></style></head><body><table><tr><td class=xl65>1.5</td><td>文本</td></tr></table></body></html>`;
    const grid = parseHtmlTable(html)!;
    expect(grid.cells[0]![0]).toMatchObject({
      raw: '1.5',
      style: { b: true, bg: '#ffff00', nf: '0.00' },
    });
    expect(grid.cells[0]![1]!.raw).toBe('文本');
  });
});
