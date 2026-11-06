import { describe, expect, it } from 'vitest';
import {
  cellKey,
  colIndex,
  colName,
  normRange,
  parseA1,
  parseKey,
  rangeLabel,
  toA1,
  usedBounds,
} from './a1';
import { parseCsv, parseTsv, stripFences, toCsv, toTsv } from './csv';

describe('a1', () => {
  it('converts column names', () => {
    expect(colName(0)).toBe('A');
    expect(colName(25)).toBe('Z');
    expect(colName(26)).toBe('AA');
    expect(colName(701)).toBe('ZZ');
    expect(colName(702)).toBe('AAA');
    for (const n of [0, 5, 25, 26, 51, 700, 702, 1000]) expect(colIndex(colName(n))).toBe(n);
    expect(colIndex('1')).toBe(-1);
  });
  it('converts A1 refs and keys', () => {
    expect(toA1(0, 0)).toBe('A1');
    expect(toA1(9, 27)).toBe('AB10');
    expect(parseA1('$B$3')).toEqual({ row: 2, col: 1 });
    expect(parseA1('b3')).toEqual({ row: 2, col: 1 });
    expect(parseA1('A0')).toBeNull();
    expect(parseKey(cellKey(3, 4))).toEqual({ row: 3, col: 4 });
    expect(parseKey('x')).toBeNull();
  });
  it('normalises and labels ranges', () => {
    const r = normRange({ row: 3, col: 2 }, { row: 1, col: 0 });
    expect(r).toEqual({ r0: 1, c0: 0, r1: 3, c1: 2 });
    expect(rangeLabel(r)).toBe('A2:C4');
    expect(rangeLabel({ r0: 0, c0: 0, r1: 0, c1: 0 })).toBe('A1');
  });
  it('computes used bounds', () => {
    expect(usedBounds([])).toBeNull();
    expect(usedBounds(['0:0', '4:2', '1:7'])).toEqual({ rows: 5, cols: 8 });
  });
});

describe('csv', () => {
  it('parses quoted fields, escaped quotes and newlines', () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\n"multi\nline",3')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
      ['multi\nline', '3'],
    ]);
  });
  it('handles CRLF, BOM, trailing newline and empty fields', () => {
    expect(parseCsv('\uFEFFa,,c\r\n1,2,\r\n')).toEqual([
      ['a', '', 'c'],
      ['1', '2', ''],
    ]);
  });
  it('tolerates an unterminated quote while streaming', () => {
    expect(parseCsv('a,b\n1,"partial')).toEqual([
      ['a', 'b'],
      ['1', 'partial'],
    ]);
  });
  it('strips code fences', () => {
    expect(stripFences('```csv\na,b\n1,2\n```')).toBe('a,b\n1,2');
    expect(parseCsv('```\nx,y\n```')).toEqual([['x', 'y']]);
  });
  it('round-trips through toCsv', () => {
    const rows = [
      ['模型', 'Top-1', '备注'],
      ['ResNet-50', '76.1', 'has, comma'],
      ['ViT-B/16', '81.8', 'quote "q"'],
      ['ConvNeXt', '82.1', 'line\nbreak'],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
  it('round-trips TSV like Excel clipboard', () => {
    const rows = [
      ['a', 'b c'],
      ['1\t2', 'x'],
    ];
    expect(toTsv(rows)).toBe('a\tb c\n"1\t2"\tx');
    expect(parseTsv(toTsv(rows))).toEqual(rows);
    expect(parseTsv('1\t2\n3\t4\n')).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });
});
