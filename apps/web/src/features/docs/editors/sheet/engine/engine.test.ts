import { describe, expect, it } from 'vitest';
import { FormulaEngine, evaluateOnce, type EngineSource } from './engine';
import { formatValue } from './format';
import {
  dropSheetInFormula,
  listRefs,
  offsetFormula,
  renameSheetInFormula,
  shiftFormula,
} from './refs';
import { parseLiteral } from './values';

/** 测试用数据源：{ 表名: { 'A1': 原始输入 } } */
function source(data: Record<string, Record<string, string>>) {
  const grids = new Map<string, Map<string, string>>();
  const toKey = (a1: string) => {
    const m = /^([A-Z]+)(\d+)$/u.exec(a1)!;
    let c = 0;
    for (const ch of m[1]!) c = c * 26 + ch.charCodeAt(0) - 64;
    return `${Number(m[2]) - 1}:${c - 1}`;
  };
  for (const [name, cells] of Object.entries(data)) {
    grids.set(name, new Map(Object.entries(cells).map(([k, v]) => [toKey(k), v])));
  }
  const src: EngineSource = {
    sheetIdByName: (n) => [...grids.keys()].find((x) => x.toLowerCase() === n.toLowerCase()),
    sheetName: (id) => id,
    size: () => ({ rows: 200, cols: 30 }),
    raw: (id, r, c) => grids.get(id)?.get(`${r}:${c}`),
  };
  const engine = new FormulaEngine(src);
  const set = (sheet: string, a1: string, raw: string) => {
    const k = toKey(a1);
    grids.get(sheet)!.set(k, raw);
    const [r, c] = k.split(':').map(Number) as [number, number];
    engine.cellsChanged([[sheet, r, c]]);
  };
  const get = (sheet: string, a1: string) => {
    const [r, c] = toKey(a1).split(':').map(Number) as [number, number];
    return engine.get(sheet, r, c);
  };
  return { engine, set, get };
}

const ev = (formula: string, cells: Record<string, string> = {}) => {
  const conv: Record<string, string> = {};
  for (const [a1, v] of Object.entries(cells)) {
    const m = /^([A-Z]+)(\d+)$/u.exec(a1)!;
    let c = 0;
    for (const ch of m[1]!) c = c * 26 + ch.charCodeAt(0) - 64;
    conv[`${Number(m[2]) - 1}:${c - 1}`] = v;
  }
  return evaluateOnce({ S: conv }, 'S', formula);
};

describe('公式引擎（fast-formula-parser + formulajs）', () => {
  it('四则运算、浮点修整、比较、文本连接', () => {
    expect(ev('=1+2*3')).toBe(7);
    expect(ev('=0.1+0.2')).toBe(0.3);
    expect(ev('=2^10')).toBe(1024);
    expect(ev('="a"&1')).toBe('a1');
    expect(ev('=A1>2', { A1: '3' })).toBe(true);
    expect(ev('=A1', {})).toBe(0);
  });

  it('常用函数：SUM / AVERAGE / IF / ROUND / COUNTIF / VLOOKUP / TEXT / DATE', () => {
    const cells = { A1: '1', A2: '2', A3: '3', B1: 'a', B2: 'b', B3: 'c' };
    expect(ev('=SUM(A1:A3)', cells)).toBe(6);
    expect(ev('=AVERAGE(A1:A3)', cells)).toBe(2);
    expect(ev('=IF(A1>0,"正","负")', cells)).toBe('正');
    expect(ev('=ROUND(2.345,2)')).toBe(2.35);
    expect(ev('=COUNTIF(B1:B3,"b")', cells)).toBe(1);
    expect(ev('=VLOOKUP("b",B1:B3,1,FALSE)', cells)).toBe('b');
    expect(ev('=TEXT(1234.5,"#,##0.00")')).toBe('1,234.50');
    expect(ev('=DATE(2024,1,5)')).toBe(45296);
    expect(ev('=LEN("中文")')).toBe(2);
  });

  it('formulajs 补齐的函数：MATCH / MEDIAN / STDEV / SUMIFS / TEXTJOIN', () => {
    const cells = { A1: '1', A2: '2', A3: '3', B1: 'a', B2: 'b', B3: 'c' };
    expect(ev('=MATCH("b",B1:B3,0)', cells)).toBe(2);
    expect(ev('=MEDIAN(A1:A3)', cells)).toBe(2);
    expect(ev('=ROUND(STDEV(A1:A3),4)', cells)).toBe(1);
    expect(ev('=SUMIFS(A1:A3,B1:B3,"<>a")', cells)).toBe(5);
    expect(ev('=TEXTJOIN(",",TRUE,B1:B3)', cells)).toBe('a,b,c');
  });

  it('XLOOKUP：精确匹配、未找到的默认值、#N/A', () => {
    const cells = { A1: '甲', A2: '乙', B1: '10', B2: '20' };
    expect(ev('=XLOOKUP("乙",A1:A2,B1:B2)', cells)).toBe(20);
    expect(ev('=XLOOKUP("丙",A1:A2,B1:B2,"无")', cells)).toBe('无');
    expect(ev('=XLOOKUP("丙",A1:A2,B1:B2)', cells)).toEqual({ error: '#N/A' });
  });

  it('错误值：#DIV/0!、#NAME?、#ERROR!（语法）、错误传播、IFERROR', () => {
    expect(ev('=1/0')).toEqual({ error: '#DIV/0!' });
    expect(ev('=FOO(1)')).toEqual({ error: '#NAME?' });
    expect(ev('=SUM(1')).toEqual({ error: '#ERROR!' });
    expect(ev('=A1+1', { A1: '=1/0' })).toEqual({ error: '#DIV/0!' });
    expect(ev('=IFERROR(1/0,"x")')).toBe('x');
  });

  it('跨表引用（含中文、带空格的表名），表不存在 → #REF!', () => {
    const { get } = source({
      汇总: { A1: '=销售!B2*2', A2: "='销售 明细'!A1+1", A3: '=SUM(销售!B1:B2)', A4: '=无此表!A1' },
      销售: { B1: '1', B2: '21' },
      '销售 明细': { A1: '5' },
    });
    expect(get('汇总', 'A1')).toBe(42);
    expect(get('汇总', 'A2')).toBe(6);
    expect(get('汇总', 'A3')).toBe(22);
    expect(get('汇总', 'A4')).toEqual({ error: '#REF!' });
  });

  it('依赖重算：改一格，直接和间接依赖它的公式都更新（含区域与跨表）', () => {
    const { get, set } = source({
      S: { A1: '1', A2: '=A1*10', A3: '=SUM(A1:A2)', B1: '=T!A1+A3' },
      T: { A1: '100' },
    });
    expect(get('S', 'B1')).toBe(111);
    set('S', 'A1', '2');
    expect(get('S', 'A2')).toBe(20);
    expect(get('S', 'A3')).toBe(22);
    expect(get('S', 'B1')).toBe(122);
    set('T', 'A1', '0');
    expect(get('S', 'B1')).toBe(22);
  });

  it('循环引用 → #CYCLE!；很深的引用链不会栈溢出', () => {
    const { get } = source({ S: { A1: '=A2', A2: '=A1' } });
    expect(get('S', 'A1')).toEqual({ error: '#CYCLE!' });
    const deep: Record<string, string> = { A1: '1' };
    for (let i = 2; i <= 150; i += 1) deep[`A${i}`] = `=A${i - 1}+1`;
    const s = source({ D: deep });
    expect(s.get('D', 'A150')).toBe(150);
  });
});

describe('数字格式（SSF）与显示四舍五入', () => {
  it('常规格式：最多 10 位有效数字', () => {
    expect(formatValue(1 / 3).text).toBe('0.3333333333');
    expect(formatValue(0.1 + 0.2).text).toBe('0.3');
    expect(formatValue(12).text).toBe('12');
  });
  it('数字、百分比、货币、日期、科学计数', () => {
    expect(formatValue(2.345, '0.00').text).toBe('2.35');
    expect(formatValue(1234.5, '#,##0.00').text).toBe('1,234.50');
    expect(formatValue(0.256, '0.0%').text).toBe('25.6%');
    expect(formatValue(1234.5, '¥#,##0.00').text).toBe('¥1,234.50');
    expect(formatValue(45296, 'yyyy-mm-dd').text).toBe('2024-01-05');
    expect(formatValue(12345, '0.00E+00').text).toBe('1.23E+04');
    expect(formatValue(-2, '0.00;[Red]-0.00')).toEqual({ text: '-2.00', color: '#e5484d' });
  });
  it('输入解析：百分比、千分位、日期、货币、强制文本', () => {
    expect(parseLiteral('12%')).toEqual({ value: 0.12, format: '0%' });
    expect(parseLiteral('1,234.5').value).toBe(1234.5);
    expect(parseLiteral('2024-01-05')).toEqual({ value: 45296, format: 'yyyy-mm-dd' });
    expect(parseLiteral('¥12.5')).toEqual({ value: 12.5, format: '"¥"#,##0.00' });
    expect(parseLiteral("'001").value).toBe('001');
  });
});

describe('引用改写', () => {
  it('插入行：之后的引用下移，区域跨过插入点时扩大', () => {
    expect(shiftFormula('=A1+A5', 'S', 'S', 'row', 2, 1)).toBe('=A1+A6');
    expect(shiftFormula('=SUM(A1:A5)', 'S', 'S', 'row', 2, 3)).toBe('=SUM(A1:A8)');
    expect(shiftFormula('=T!A5', 'S', 'S', 'row', 0, 1)).toBe('=T!A5');
    expect(shiftFormula('=S!A5', 'T', 'S', 'row', 0, 1)).toBe('=S!A6');
  });
  it('删除行：被删的单格引用 → #REF!，区域收缩', () => {
    expect(shiftFormula('=A3+A1', 'S', 'S', 'row', 2, -1)).toBe('=#REF!+A1');
    expect(shiftFormula('=SUM(A1:A5)', 'S', 'S', 'row', 1, -2)).toBe('=SUM(A1:A3)');
    expect(shiftFormula('=SUM(B2:B3)', 'S', 'S', 'row', 1, -2)).toBe('=SUM(#REF!)');
  });
  it('插入列、字符串里的 A1 不动、绝对引用照样随结构移动', () => {
    expect(shiftFormula('=$B$1&"B1"', 'S', 'S', 'col', 0, 1)).toBe('=$C$1&"B1"');
  });
  it('复制粘贴平移相对引用', () => {
    expect(offsetFormula('=A1+$B$1+B$2', 2, 1)).toBe('=B3+$B$1+C$2');
    expect(offsetFormula('=A1', -1, 0)).toBe('=#REF!');
  });
  it('表改名 / 删除表', () => {
    expect(renameSheetInFormula("=Sheet1!A1+'Sheet1'!B2", 'Sheet1', '销售 明细')).toBe(
      "='销售 明细'!A1+'销售 明细'!B2",
    );
    expect(dropSheetInFormula('=T!A1+A1', 'T')).toBe('=#REF!+A1');
    expect(listRefs("=SUM('a b'!A1:B2)")[0]).toMatchObject({ kind: 'range', sheet: 'a b' });
  });
});
