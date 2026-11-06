import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap';
import {
  SHEET_YDOC,
  sheetTypeName,
  type DocumentContent,
  type DocumentMeta,
  type DocumentVersion,
} from '@srh/shared';
import { documents } from '../../src/db/schema';
import { docSchema } from '../../src/modules/documents/pm-schema';
import { DOC_PAGE_FIELD } from '../../src/modules/documents/pm-word';
import { eq } from 'drizzle-orm';
import { setupCollabApp, type CollabTestApp } from './helpers';

/**
 * POST P/docs/import 接收的是前端真实导入器写出的 Y.Doc（docx → Word 式富文本、xlsx → 表格 v2 工作簿、
 * pptx → 幻灯片 v2 自由版式）。这里按各导入器实际写入的结构构造状态，确认服务端的 toMarkdown 校验接受它们，
 * 导入后 markdown 读取、agent 编辑、版本快照 / 恢复都能用（API.md §2.7.1、§2.7.6）。
 */

const PID = 'prj_import_kinds';
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

async function postImport(kind: string, title: string, doc: Y.Doc) {
  return t.app.inject({
    method: 'POST',
    url: `${base}/docs/import?${new URLSearchParams({ kind, title }).toString()}`,
    headers: { ...t.as('usr_a'), 'content-type': 'application/octet-stream' },
    payload: Buffer.from(Y.encodeStateAsUpdate(doc)),
  });
}

async function readMarkdown(id: string): Promise<DocumentContent> {
  const res = await t.app.inject({
    method: 'GET',
    url: `${base}/docs/${id}/markdown`,
    headers: t.as('usr_a'),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function edit(id: string, body: unknown) {
  return t.app.inject({
    method: 'POST',
    url: `${base}/docs/${id}/edit`,
    headers: t.as('usr_a'),
    payload: body as Record<string, unknown>,
  });
}

async function storedDoc(id: string): Promise<Y.Doc> {
  const [row] = await t.db.db.select().from(documents).where(eq(documents.id, id));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, row!.ydocState!);
  return doc;
}

/** docx 导入器的输出：Word 式段落属性、字体颜色字号、脚注、上标、分页符、目录、带底色的表格、页面设置 */
function wordDoc(): Y.Doc {
  const doc = new Y.Doc();
  const json = {
    type: 'doc',
    content: [
      { type: 'tableOfContents', attrs: { maxLevel: 3 } },
      {
        type: 'heading',
        attrs: { level: 1, indent: 0, textAlign: 'center', spaceAfter: 12 },
        content: [{ type: 'text', text: '课题组季度研究报告' }],
      },
      {
        type: 'paragraph',
        attrs: { textIndent: 2, lineHeight: '1.5', indent: 0 },
        content: [
          {
            type: 'text',
            text: '本季度完成了图神经网络基线',
            marks: [
              {
                type: 'textStyle',
                attrs: { color: '#c00000', fontSize: '12pt', fontFamily: '宋体' },
              },
            ],
          },
          { type: 'text', text: '2', marks: [{ type: 'superscript' }] },
          { type: 'footnote', attrs: { id: 'fn1', content: '数据来自公开基准。' } },
          { type: 'text', text: '，准确率提升。', marks: [{ type: 'bold' }] },
        ],
      },
      { type: 'pageBreak' },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableHeader',
                attrs: { backgroundColor: '#d9e2f3' },
                content: [{ type: 'paragraph', content: [{ type: 'text', text: '模型' }] }],
              },
              {
                type: 'tableHeader',
                attrs: { backgroundColor: '#d9e2f3' },
                content: [{ type: 'paragraph', content: [{ type: 'text', text: '准确率' }] }],
              },
            ],
          },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'GCN' }] }],
              },
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: '0.91' }] }],
              },
            ],
          },
        ],
      },
      {
        type: 'image',
        attrs: {
          src: `/api/v1/projects/${PID}/files/fil_img`,
          alt: '架构图',
          fileId: 'fil_img',
          width: 60,
          align: 'center',
        },
      },
    ],
  };
  doc.transact(() => {
    prosemirrorJSONToYXmlFragment(docSchema(), json, doc.getXmlFragment('default'));
    const page = doc.getMap<unknown>(DOC_PAGE_FIELD);
    page.set('size', 'A4');
    page.set('orientation', 'portrait');
    page.set('marginTop', 25.4);
  });
  return doc;
}

/** xlsx 导入器的输出：两张表、样式、合并、冻结、列宽、公式与 Excel 缓存值（表格 v2） */
function workbookDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const order = doc.getArray<string>(SHEET_YDOC.order);
    const info = doc.getMap<unknown>(SHEET_YDOC.info);
    const styles = doc.getMap<unknown>(SHEET_YDOC.styles);
    styles.set('stbold', { b: true, bg: '#FFFF00' });
    styles.set('stpct', { nf: '0.00%' });
    const sheet = (id: string, name: string, rows: number, cols: number) => {
      info.set(id, { name });
      order.push([id]);
      doc
        .getArray<string>(sheetTypeName(id, 'rows'))
        .push(Array.from({ length: rows }, (_, i) => `r${i}`));
      doc
        .getArray<string>(sheetTypeName(id, 'cols'))
        .push(Array.from({ length: cols }, (_, i) => `c${i}`));
    };
    sheet('s1', '成绩', 100, 26);
    sheet('s2', '汇总', 100, 26);
    const c1 = doc.getMap<unknown>(sheetTypeName('s1', 'cells'));
    c1.set('r0:c0', '模型');
    c1.set('r0:c1', '准确率');
    c1.set('r1:c0', 'GCN');
    c1.set('r1:c1', '0.91');
    c1.set('r2:c0', 'GAT');
    c1.set('r2:c1', '0.93');
    c1.set('r3:c1', '=AVERAGE(B2:B3)');
    doc.getMap<unknown>(sheetTypeName('s1', 'cache')).set('r3:c1', 0.92);
    const f1 = doc.getMap<unknown>(sheetTypeName('s1', 'fmt'));
    f1.set('r0:c0', 'stbold');
    f1.set('r0:c1', 'stbold');
    f1.set('r1:c1', 'stpct');
    doc
      .getMap<unknown>(sheetTypeName('s1', 'merges'))
      .set('m1', { r0: 'r5', c0: 'c0', r1: 'r5', c1: 'c1' });
    doc.getMap<unknown>(sheetTypeName('s1', 'view')).set('frozenRows', 1);
    doc.getMap<unknown>(sheetTypeName('s1', 'colp')).set('c0', { w: 120 });
    const c2 = doc.getMap<unknown>(sheetTypeName('s2', 'cells'));
    c2.set('r0:c0', '平均');
    c2.set('r0:c1', '=成绩!B4');
  });
  return doc;
}

function para(text: string, bold = false): Y.XmlElement {
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, text, bold ? { bold: true } : {});
  p.insert(0, [t]);
  return p;
}

function element(fields: Record<string, unknown>, frag?: Y.XmlFragment): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(fields)) m.set(k, v);
  if (frag) m.set('text', frag);
  return m;
}

/** pptx 导入器的输出：没有占位符的文本框、形状、图片、表格、备注、页面尺寸（幻灯片 v2） */
function deckDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const meta = doc.getMap<unknown>('slidesMeta');
    meta.set('w', 960);
    meta.set('h', 540);
    meta.set('theme', 'default');
    const mk = (id: string, order: string, els: Y.Map<unknown>[], notes: string) => {
      const m = new Y.Map<unknown>();
      m.set('id', id);
      m.set('order', order);
      m.set('v', 2);
      m.set('layout', 'blank');
      const map = new Y.Map<Y.Map<unknown>>();
      els.forEach((e, i) => map.set(`${id}-e${i}`, e));
      m.set('elements', map);
      m.set('notes', new Y.Text(notes));
      return m;
    };
    const title = new Y.XmlFragment();
    title.insert(0, [para('组会汇报：图神经网络进展', true)]);
    const body = new Y.XmlFragment();
    body.insert(0, [para('本周完成基线实验'), para('下周补充消融实验')]);
    const box = new Y.XmlFragment();
    box.insert(0, [para('结论')]);
    const cellText = (s: string) => {
      const c = new Y.Map<unknown>();
      c.set('text', new Y.Text(s));
      return c;
    };
    const row = (a: string, b: string) => {
      const r = new Y.Array<Y.Map<unknown>>();
      r.push([cellText(a), cellText(b)]);
      return r;
    };
    const cells = new Y.Array<Y.Array<Y.Map<unknown>>>();
    cells.push([row('模型', '准确率'), row('GAT', '0.93')]);
    doc.getArray<Y.Map<unknown>>('slides').push([
      mk(
        'sl_1',
        'a0',
        [
          element(
            {
              id: 'sl_1-e0',
              type: 'text',
              x: 60,
              y: 40,
              w: 840,
              h: 80,
              rot: 0,
              z: 'a0',
              style: { fontSize: 36 },
            },
            title,
          ),
          element(
            { id: 'sl_1-e1', type: 'text', x: 60, y: 160, w: 840, h: 300, rot: 0, z: 'a1' },
            body,
          ),
        ],
        '先讲背景',
      ),
      mk(
        'sl_2',
        'a1',
        [
          element(
            {
              id: 'sl_2-e0',
              type: 'shape',
              shape: 'roundRect',
              x: 40,
              y: 40,
              w: 300,
              h: 100,
              rot: 0,
              z: 'a0',
              fill: { type: 'color', color: '#4472C4' },
            },
            box,
          ),
          element({
            id: 'sl_2-e1',
            type: 'image',
            src: `/api/v1/projects/${PID}/files/fil_pic`,
            fileId: 'fil_pic',
            name: '实验曲线',
            x: 400,
            y: 40,
            w: 400,
            h: 300,
            rot: 0,
            z: 'a1',
          }),
          element({
            id: 'sl_2-e2',
            type: 'table',
            cells,
            colW: [200, 200],
            rowH: [40, 40],
            x: 40,
            y: 360,
            w: 400,
            h: 80,
            rot: 0,
            z: 'a2',
          }),
          element({
            id: 'sl_2-e3',
            type: 'line',
            x: 40,
            y: 340,
            w: 300,
            h: 0,
            rot: 0,
            z: 'a3',
            stroke: { color: '#000000', width: 2 },
            end: 'arrow',
          }),
        ],
        '',
      ),
    ]);
  });
  return doc;
}

describe('POST P/docs/import：真实导入器写出的结构', () => {
  it('Word（docx）：Word 式排版与页面设置原样入库，markdown 含脚注、分页符、目录与表格', async () => {
    const res = await postImport('doc', '课题组季度研究报告', wordDoc());
    expect(res.statusCode, res.body).toBe(201);
    const meta = res.json<DocumentMeta>();
    const content = await readMarkdown(meta.id);
    expect(content.markdown).toContain('# 课题组季度研究报告');
    expect(content.markdown).toContain('<!-- toc -->');
    expect(content.markdown).toContain('<!-- pagebreak -->');
    expect(content.markdown).toContain('<sup>2</sup>');
    expect(content.markdown).toMatch(/\[\^1\][\s\S]*\[\^1\]: 数据来自公开基准。/u);
    expect(content.markdown).toContain('| 模型 | 准确率 |');
    expect(content.markdown).toContain('fil_img');
    expect(content.outline).toEqual([{ heading: '课题组季度研究报告', level: 1 }]);
    const stored = await storedDoc(meta.id);
    expect(stored.getMap(DOC_PAGE_FIELD).get('marginTop')).toBe(25.4);
    // agent 按文字替换：保留所在文字的格式
    const r = await edit(meta.id, { op: 'replace_text', find: '基线', replace: '基准' });
    expect(r.statusCode, r.body).toBe(200);
    const after = await storedDoc(meta.id);
    expect(after.getXmlFragment('default').toString()).toContain('color="#c00000"');
  });

  it('Excel（xlsx）：多工作表 v2 工作簿入库，markdown 按表分段，agent 可写第二张表，版本快照与恢复', async () => {
    const res = await postImport('sheet', '成绩表', workbookDoc());
    expect(res.statusCode, res.body).toBe(201);
    const meta = res.json<DocumentMeta>();
    const content = await readMarkdown(meta.id);
    expect(content.markdown).toContain('## 工作表：成绩');
    expect(content.markdown).toContain('## 工作表：汇总');
    expect(content.markdown).toContain('| 2 | GCN | 0.91 |');
    expect(content.markdown).toContain('=AVERAGE(B2:B3)');
    expect(content.outline).toEqual([
      { heading: '成绩', level: 1 },
      { heading: '汇总', level: 1 },
    ]);

    const snap = await t.app.inject({
      method: 'POST',
      url: `${base}/docs/${meta.id}/versions`,
      headers: t.as('usr_a'),
      payload: { label: '导入后' },
    });
    expect(snap.statusCode, snap.body).toBe(201);
    const version = snap.json<DocumentVersion>();

    const w = await edit(meta.id, {
      op: 'set_cells',
      sheet: '汇总',
      cells: [{ ref: 'A2', value: '备注：张三复核' }],
    });
    expect(w.statusCode, w.body).toBe(200);
    expect((await readMarkdown(meta.id)).markdown).toContain('备注：张三复核');

    const restore = await t.app.inject({
      method: 'POST',
      url: `${base}/docs/${meta.id}/versions/${version.id}/restore`,
      headers: t.as('usr_a'),
    });
    expect(restore.statusCode, restore.body).toBe(200);
    const restored = await readMarkdown(meta.id);
    expect(restored.markdown).not.toContain('备注：张三复核');
    expect(restored.markdown).toContain('| 2 | GCN | 0.91 |');
    // 恢复后样式 / 合并 / 冻结仍在
    const stored = await storedDoc(meta.id);
    expect(stored.getMap(SHEET_YDOC.styles).get('stbold')).toEqual({ b: true, bg: '#FFFF00' });
    expect(stored.getMap(sheetTypeName('s1', 'merges')).size).toBe(1);
    expect(stored.getMap(sheetTypeName('s1', 'view')).get('frozenRows')).toBe(1);
  });

  it('PowerPoint（pptx）：v2 页（无占位符文本框、形状、图片、表格）入库，markdown 与 agent 替换可用', async () => {
    const res = await postImport('slides', '组会汇报', deckDoc());
    expect(res.statusCode, res.body).toBe(201);
    const meta = res.json<DocumentMeta>();
    const content = await readMarkdown(meta.id);
    expect(content.markdown).toContain('## 组会汇报：图神经网络进展');
    expect(content.markdown).toContain('本周完成基线实验');
    expect(content.markdown).toContain('> 先讲背景');
    expect(content.markdown).toContain('| 模型 | 准确率 |');
    expect(content.markdown).toContain('![实验曲线]');
    expect(content.outline.map((o) => o.heading)).toEqual(['组会汇报：图神经网络进展', '结论']);
    const r = await edit(meta.id, {
      op: 'replace_text',
      find: '消融实验',
      replace: '消融与对比实验',
    });
    expect(r.statusCode, r.body).toBe(200);
    expect((await readMarkdown(meta.id)).markdown).toContain('消融与对比实验');
    const stored = await storedDoc(meta.id);
    expect(stored.getMap('slidesMeta').get('w')).toBe(960);
  });
});
