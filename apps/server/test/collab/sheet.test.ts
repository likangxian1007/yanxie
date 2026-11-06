import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { eq } from 'drizzle-orm';
import { SHEET_YDOC, YDOC_FIELD, sheetTypeName, type DocumentMeta } from '@srh/shared';
import { documents } from '../../src/db/schema';
import { documentExcerpt } from '../../src/modules/documents/markdown';
import {
  ensureWorkbook,
  listSheets,
  migrateLegacySheet,
  replaceWorkbook,
  sheetToMarkdown,
} from '../../src/modules/documents/sheet-model';
import { applyEdit, toMarkdown } from '../../src/modules/documents/ydoc';
import { setupCollabApp, type CollabTestApp } from './helpers';

/** 与前端 import/xlsx.ts + model/io.ts 写出的结构一致（两张表、样式、合并、缓存值） */
function importerShapedDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const order = doc.getArray<string>(SHEET_YDOC.order);
    const info = doc.getMap<unknown>(SHEET_YDOC.info);
    doc.getMap<unknown>(SHEET_YDOC.styles).set('stabc', { b: true, bg: '#ddebf7' });
    const put = (id: string, name: string, cells: Record<string, string>) => {
      doc.getArray<string>(sheetTypeName(id, 'rows')).push(['r0', 'r1', 'r2']);
      doc.getArray<string>(sheetTypeName(id, 'cols')).push(['c0', 'c1']);
      const m = doc.getMap<string>(sheetTypeName(id, 'cells'));
      for (const [k, v] of Object.entries(cells)) m.set(k, v);
      info.set(id, { name });
      order.push([id]);
    };
    put('s1', '销售明细', { 'r0:c0': '产品', 'r0:c1': '金额', 'r1:c0': '笔记本', 'r1:c1': '=1+2' });
    put('sxabc', '汇总', { 'r0:c0': '总计', 'r0:c1': '=SUM(销售明细!B2:B3)' });
    doc.getMap<string>(sheetTypeName('s1', 'fmt')).set('r0:c0', 'stabc');
    doc
      .getMap<unknown>(sheetTypeName('s1', 'merges'))
      .set('m1', { r0: 'r2', c0: 'c0', r1: 'r2', c1: 'c1' });
    doc.getMap<unknown>(sheetTypeName('s1', 'cache')).set('r1:c1', 3);
    doc.getMap<unknown>(sheetTypeName('s1', 'view')).set('frozenRows', 1);
  });
  return doc;
}

function legacyDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const cells = doc.getMap<string>(YDOC_FIELD.sheetCells);
    cells.set('0:0', 'model');
    cells.set('0:1', 'acc');
    cells.set('1:0', 'ViT');
    cells.set('1:1', '0.81');
    const meta = doc.getMap<unknown>(YDOC_FIELD.sheetMeta);
    meta.set('rows', 50);
    meta.set('cols', 12);
  });
  return doc;
}

describe('表格 v2 结构的服务端读写', () => {
  it('导入器写出的多表结构能被 toMarkdown 读（POST P/docs/import 的校验路径）', () => {
    const md = toMarkdown(importerShapedDoc(), 'sheet');
    expect(md).toContain('## 工作表：销售明细');
    expect(md).toContain('| 2 | 笔记本 | =1+2 |');
    expect(md).toContain('## 工作表：汇总');
    expect(md).toContain('| 1 | 总计 | =SUM(销售明细!B2:B3) |');
    expect(documentExcerpt('sheet', md)).toBe(
      '产品 · 金额 ／ 笔记本 · =1+2 ／ 总计 · =SUM(销售明细!B2:B3)',
    );
  });

  it('单表时 markdown 与旧格式一致；旧结构不迁移也能读', () => {
    const legacy = legacyDoc();
    const before = toMarkdown(legacy, 'sheet');
    expect(before).toBe(
      '|   | A | B |\n|---| --- | --- |\n| 1 | model | acc |\n| 2 | ViT | 0.81 |',
    );
    legacy.transact(() => migrateLegacySheet(legacy));
    expect(listSheets(legacy).map((s) => s.name)).toEqual(['Sheet1']);
    expect(legacy.getMap(YDOC_FIELD.sheetCells).size).toBe(0);
    expect(toMarkdown(legacy, 'sheet')).toBe(before);
    // 再迁移一次不会产生第二张表
    expect(migrateLegacySheet(legacy)).toBe(false);
  });

  it('set_cells 默认写第一张表；指定 sheet 写对应表，不存在就新建；超出上限整次拒绝', () => {
    const doc = legacyDoc();
    doc.transact(() => {
      applyEdit(doc, 'sheet', { op: 'set_cells', cells: [{ ref: 'C1', value: 'f1' }] });
      applyEdit(doc, 'sheet', {
        op: 'set_cells',
        sheet: '汇总',
        cells: [{ ref: 'A1', value: '=Sheet1!B2*100' }],
      });
    });
    const sheets = listSheets(doc);
    expect(sheets.map((s) => s.name)).toEqual(['Sheet1', '汇总']);
    const md = sheetToMarkdown(doc);
    expect(md).toContain('| 1 | model | acc | f1 |');
    expect(md).toContain('| 1 | =Sheet1!B2*100 |');
    expect(() =>
      applyEdit(doc, 'sheet', {
        op: 'set_cells',
        cells: [
          { ref: 'A1', value: 'changed' },
          { ref: 'A200000', value: 'x' },
        ],
      }),
    ).toThrow(/最多/u);
    expect(sheetToMarkdown(doc)).toContain('| 1 | model |');
  });

  it('replace_all / append 支持按「## 工作表：名字」分段写多张表；读出的 markdown 原样写回不变', () => {
    const doc = new Y.Doc();
    doc.transact(() => ensureWorkbook(doc));
    doc.transact(() =>
      applyEdit(doc, 'sheet', {
        op: 'replace_all',
        markdown: '## 工作表：数据\n\na,b\n1,2\n\n## 工作表：Sheet1\n\nx,y',
      }),
    );
    expect(listSheets(doc).map((s) => s.name)).toEqual(['Sheet1', '数据']);
    doc.transact(() =>
      applyEdit(doc, 'sheet', { op: 'append', markdown: '## 工作表：数据\n\n3,4' }),
    );
    const md = sheetToMarkdown(doc);
    expect(md).toContain('| 3 | 3 | 4 |');
    const copy = new Y.Doc();
    copy.transact(() => applyEdit(copy, 'sheet', { op: 'replace_all', markdown: md }));
    expect(sheetToMarkdown(copy)).toBe(md);
  });

  it('版本恢复：整体替换工作簿（表的增删、单元格、样式），旧结构的版本也能恢复', () => {
    const target = importerShapedDoc();
    const v1 = new Y.Doc();
    Y.applyUpdate(v1, Y.encodeStateAsUpdate(target));
    target.transact(() => {
      applyEdit(target, 'sheet', { op: 'set_cells', cells: [{ ref: 'A1', value: '改过' }] });
      applyEdit(target, 'sheet', {
        op: 'set_cells',
        sheet: '新表',
        cells: [{ ref: 'A1', value: 'x' }],
      });
    });
    target.transact(() => replaceWorkbook(target, v1));
    expect(toMarkdown(target, 'sheet')).toBe(toMarkdown(v1, 'sheet'));
    expect(target.getMap(sheetTypeName('s1', 'fmt')).get('r0:c0')).toBe('stabc');

    const old = legacyDoc();
    target.transact(() => replaceWorkbook(target, old));
    expect(listSheets(target).map((s) => s.name)).toEqual(['Sheet1']);
    expect(toMarkdown(target, 'sheet')).toContain('| 2 | ViT | 0.81 |');
  });
});

describe('表格 REST（v2）', () => {
  const PID = 'prj_sheet';
  const base = `/api/v1/projects/${PID}`;
  let t: CollabTestApp;
  beforeAll(async () => {
    t = await setupCollabApp();
    await t.seedUser('usr_a', '张三', 1);
    await t.seedProject(PID, 'usr_a');
  }, 60_000);
  afterAll(async () => {
    await t?.close();
  });

  const create = async (body: Record<string, unknown>): Promise<DocumentMeta> => {
    const res = await t.app.inject({
      method: 'POST',
      url: `${base}/docs`,
      headers: t.as('usr_a'),
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  };

  it('新建表格是 v2 结构；摘要、多表编辑、版本恢复都走新结构', async () => {
    const sheet = await create({ kind: 'sheet', title: '实验', markdown: 'model,acc\nViT,0.81' });
    expect(sheet.excerpt).toBe('model · acc ／ ViT · 0.81');
    const [row] = await t.db.db.select().from(documents).where(eq(documents.id, sheet.id));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, row!.ydocState!);
    expect(listSheets(doc).map((s) => s.name)).toEqual(['Sheet1']);
    expect(doc.getMap(YDOC_FIELD.sheetCells).size).toBe(0);

    let res = await t.app.inject({
      method: 'POST',
      url: `${base}/docs/${sheet.id}/versions`,
      headers: t.as('usr_a'),
      payload: { label: 'v1' },
    });
    const v1 = res.json();
    res = await t.app.inject({
      method: 'POST',
      url: `${base}/docs/${sheet.id}/edit`,
      headers: t.as('usr_a'),
      payload: { op: 'set_cells', sheet: '汇总', cells: [{ ref: 'A1', value: '=Sheet1!B2' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().markdown).toContain('## 工作表：汇总');
    res = await t.app.inject({
      method: 'GET',
      url: `${base}/docs/${sheet.id}/markdown`,
      headers: t.as('usr_a'),
    });
    expect(res.json().outline.map((o: { heading: string }) => o.heading)).toEqual([
      'Sheet1',
      '汇总',
    ]);
    res = await t.app.inject({
      method: 'POST',
      url: `${base}/docs/${sheet.id}/versions/${v1.id}/restore`,
      headers: t.as('usr_a'),
    });
    expect(res.statusCode).toBe(200);
    res = await t.app.inject({
      method: 'GET',
      url: `${base}/docs/${sheet.id}/markdown`,
      headers: t.as('usr_a'),
    });
    expect(res.json().markdown).not.toContain('汇总');
    expect(res.json().markdown).toContain('| 2 | ViT | 0.81 |');
  });

  it('库里的旧结构文档：读不迁移，第一次编辑时迁移成 v2', async () => {
    const sheet = await create({ kind: 'sheet', title: '旧表' });
    await t.db.db
      .update(documents)
      .set({ ydocState: Y.encodeStateAsUpdate(legacyDoc()) })
      .where(eq(documents.id, sheet.id));
    let res = await t.app.inject({
      method: 'GET',
      url: `${base}/docs/${sheet.id}/markdown`,
      headers: t.as('usr_a'),
    });
    expect(res.json().markdown).toContain('| 2 | ViT | 0.81 |');
    res = await t.app.inject({
      method: 'POST',
      url: `${base}/docs/${sheet.id}/edit`,
      headers: t.as('usr_a'),
      payload: { op: 'set_cells', cells: [{ ref: 'C2', value: '新' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().markdown).toContain('| 2 | ViT | 0.81 | 新 |');
    const [row] = await t.db.db.select().from(documents).where(eq(documents.id, sheet.id));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, row!.ydocState!);
    expect(listSheets(doc)).toHaveLength(1);
    expect(doc.getMap(YDOC_FIELD.sheetCells).size).toBe(0);
  });
});
