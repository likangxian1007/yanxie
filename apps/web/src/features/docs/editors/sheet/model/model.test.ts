import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { YDOC_FIELD } from '@srh/shared';
import { ensureDefaultSheet, migrateLegacySheet, prepareWorkbook } from './migrate';
import { Workbook } from './workbook';

const O = { test: true };

function fresh() {
  const doc = new Y.Doc();
  prepareWorkbook(doc);
  const wb = new Workbook(doc);
  return { doc, wb, sid: wb.sheetIds()[0]! };
}

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

describe('表格模型 v2', () => {
  it('空文档建默认表（100 × 26）；两个客户端并发建表合并成一张', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    ensureDefaultSheet(a);
    ensureDefaultSheet(b);
    new Workbook(a).setCells('s1', [{ row: 0, col: 0, raw: 'A 写的' }], O);
    new Workbook(b).setCells('s1', [{ row: 1, col: 0, raw: 'B 写的' }], O);
    sync(a, b);
    const wb = new Workbook(a);
    expect(wb.sheetIds()).toEqual(['s1']);
    const s = wb.sheet('s1');
    expect(s.rowCount).toBe(100);
    expect(s.colCount).toBe(26);
    expect(s.raw(0, 0)).toBe('A 写的');
    expect(s.raw(1, 0)).toBe('B 写的');
  });

  it('旧单表结构惰性迁移：内容、格式、列宽都保留，旧字段清空；重复迁移不产生两份', () => {
    const legacy = new Y.Doc();
    legacy.transact(() => {
      const cells = legacy.getMap<string>(YDOC_FIELD.sheetCells);
      cells.set('0:0', '名称');
      cells.set('1:1', '=SUM(B1:B1)+1');
      cells.set('2:3', '0.5');
      legacy.getMap<string>('formats').set('2:3', 'percent');
      const meta = legacy.getMap<unknown>(YDOC_FIELD.sheetMeta);
      meta.set('rows', 50);
      meta.set('cols', 12);
      const w = new Y.Map<number>();
      meta.set('colWidths', w);
      w.set('0', 180);
    });
    const state = Y.encodeStateAsUpdate(legacy);
    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(a, state);
    Y.applyUpdate(b, state);
    expect(migrateLegacySheet(a)).toBe(true);
    expect(migrateLegacySheet(b)).toBe(true);
    sync(a, b);
    expect(migrateLegacySheet(a)).toBe(false);
    const wb = new Workbook(a);
    expect(wb.sheetIds()).toEqual(['s1']);
    const s = wb.sheet('s1');
    expect(s.rowCount).toBe(100);
    expect(s.raw(0, 0)).toBe('名称');
    expect(s.value(1, 1)).toBe(1);
    expect(wb.displayText(s, 2, 3)).toBe('50.00%');
    expect(s.colWidth(0)).toBe(180);
    expect(a.getMap(YDOC_FIELD.sheetCells).size).toBe(0);
  });

  it('插入 / 删除行：公式引用跟着改写（含跨表），合并区域跟着走', () => {
    const { wb, sid } = fresh();
    const s2 = wb.addSheet(O, { name: '汇总' });
    wb.setCells(
      sid,
      [
        { row: 0, col: 0, raw: '1' },
        { row: 1, col: 0, raw: '2' },
        { row: 2, col: 0, raw: '=SUM(A1:A2)' },
      ],
      O,
    );
    wb.setCells(s2, [{ row: 0, col: 0, raw: '=Sheet1!A3*10' }], O);
    wb.merge(sid, { r0: 4, c0: 0, r1: 5, c1: 2 }, O);
    expect(wb.sheet(s2).value(0, 0)).toBe(30);
    wb.insertRows(sid, 1, 2, O);
    const s = wb.sheet(sid);
    expect(s.raw(4, 0)).toBe('=SUM(A1:A4)');
    expect(wb.sheet(s2).raw(0, 0)).toBe('=Sheet1!A5*10');
    expect(wb.sheet(s2).value(0, 0)).toBe(30);
    expect(s.merges()[0]).toMatchObject({ r0: 6, c0: 0, r1: 7, c1: 2 });
    wb.deleteRows(sid, 0, 1, O);
    expect(s.raw(3, 0)).toBe('=SUM(A1:A3)');
    expect(wb.sheet(s2).value(0, 0)).toBe(20);
  });

  it('表改名 / 删除：其他表里的引用改名或变 #REF!', () => {
    const { wb, sid } = fresh();
    const s2 = wb.addSheet(O, { name: '数据' });
    wb.setCells(s2, [{ row: 0, col: 0, raw: '7' }], O);
    wb.setCells(sid, [{ row: 0, col: 0, raw: '=数据!A1+1' }], O);
    expect(wb.sheet(sid).value(0, 0)).toBe(8);
    wb.renameSheet(s2, '原始 数据', O);
    expect(wb.sheet(sid).raw(0, 0)).toBe("='原始 数据'!A1+1");
    expect(wb.sheet(sid).value(0, 0)).toBe(8);
    wb.deleteSheet(s2, O);
    expect(wb.sheet(sid).raw(0, 0)).toBe('=#REF!+1');
    expect(wb.deleteSheet(sid, O)).toBe(false);
  });

  it('样式按内容去重；并发插入行与改单元格不会错位', () => {
    const { doc, wb, sid } = fresh();
    wb.applyStyle(sid, { r0: 0, c0: 0, r1: 1, c1: 1 }, { b: true, fc: '#ff0000' }, O);
    expect(wb.sheet(sid).styleId(0, 0)).toBe(wb.sheet(sid).styleId(1, 1));
    expect(wb.t.styles.size).toBe(1);
    const other = new Y.Doc();
    sync(doc, other);
    const wb2 = new Workbook(other);
    wb.insertRows(sid, 0, 1, O); // A 在最上面插一行
    wb2.setCells(sid, [{ row: 5, col: 0, raw: 'B 改第 6 行' }], O); // B 同时改第 6 行
    sync(doc, other);
    expect(wb.sheet(sid).raw(6, 0)).toBe('B 改第 6 行');
    expect(wb2.sheet(sid).raw(6, 0)).toBe('B 改第 6 行');
  });

  it('排序（数字 < 文本，空值在后）与筛选隐藏行', async () => {
    const { wb, sid } = fresh();
    const { compareValues } = await import('../engine/values');
    const { offsetFormula } = await import('../engine/refs');
    wb.setCells(
      sid,
      ['名称', '丙', '甲', '乙']
        .map((raw, row) => ({ row, col: 0, raw }))
        .concat(['数量', '3', '1', '2'].map((raw, row) => ({ row, col: 1, raw }))),
      O,
    );
    wb.sortRange(sid, { r0: 1, c0: 0, r1: 3, c1: 1 }, 1, true, O, compareValues, (raw, d) =>
      offsetFormula(raw, d, 0),
    );
    const s = wb.sheet(sid);
    expect([1, 2, 3].map((r) => s.raw(r, 0))).toEqual(['甲', '乙', '丙']);
    wb.setFilter(sid, { r0: 0, c0: 0, r1: 3, c1: 1 }, O);
    wb.setFilterCriteria(sid, 1, ['1', '3'], O);
    expect([...s.filterHidden()]).toEqual([2]);
    expect(s.rowHeight(2)).toBe(0);
  });
});
