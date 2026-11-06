import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { generateNKeysBetween } from 'fractional-indexing';
import {
  applyEdit,
  initContent,
  outlineOf,
  replaceContent,
  toMarkdown,
} from '../../src/modules/documents/ydoc';
import {
  fragmentPlainText,
  orderedSlides,
  slidesArray,
  SLIDES_META_FIELD,
} from '../../src/modules/documents/slides';

/** 旧版（v1）页 */
function legacy(id: string, title: string, body: string, notes = '', layout = 'content') {
  const m = new Y.Map<unknown>();
  m.set('id', id);
  m.set('layout', layout);
  for (const [k, v] of [
    ['title', title],
    ['body', body],
    ['notes', notes],
  ] as const) {
    const t = new Y.Text();
    t.insert(0, v);
    m.set(k, t);
  }
  return m;
}

/** 与前端编辑器 / PPTX 导入器写出的结构相同的 v2 页（富文本 XmlFragment、表格、图片、无占位符） */
function importerShaped(doc: Y.Doc) {
  const [k1, k2] = generateNKeysBetween(null, null, 2);
  const page = (id: string, order: string, els: Y.Map<unknown>[], notes: string) => {
    const m = new Y.Map<unknown>();
    m.set('id', id);
    m.set('order', order);
    m.set('v', 2);
    m.set('layout', 'blank');
    m.set('bg', { type: 'color', color: '#F1F5F9' });
    const map = new Y.Map<Y.Map<unknown>>();
    els.forEach((e, i) => {
      e.set('z', `a${i}`);
      map.set(`${id}-e${i}`, e);
    });
    m.set('elements', map);
    const t = new Y.Text();
    t.insert(0, notes);
    m.set('notes', t);
    return m;
  };
  const text = (
    paras: Array<{ list?: boolean; runs: Array<[string, Record<string, unknown>?]> }>,
  ) => {
    const e = new Y.Map<unknown>();
    e.set('type', 'text');
    e.set('x', 72);
    e.set('y', 72);
    e.set('w', 400);
    e.set('h', 100);
    const frag = new Y.XmlFragment();
    const nodes: Y.XmlElement[] = [];
    let list: Y.XmlElement | null = null;
    for (const p of paras) {
      const el = new Y.XmlElement('paragraph');
      const xt = new Y.XmlText();
      xt.applyDelta(
        p.runs.map(([insert, attributes]) => (attributes ? { insert, attributes } : { insert })),
      );
      el.insert(0, [xt]);
      if (p.list) {
        if (!list) {
          list = new Y.XmlElement('bulletList');
          nodes.push(list);
        }
        const li = new Y.XmlElement('listItem');
        li.insert(0, [el]);
        list.push([li]);
      } else {
        list = null;
        nodes.push(el);
      }
    }
    frag.insert(0, nodes);
    e.set('text', frag);
    return e;
  };
  const table = () => {
    const e = new Y.Map<unknown>();
    e.set('type', 'table');
    const rows = new Y.Array<Y.Array<Y.Map<unknown>>>();
    rows.push(
      [
        ['模型', 'Top-1'],
        ['ViT-B/16', '81.2'],
      ].map((r) => {
        const row = new Y.Array<Y.Map<unknown>>();
        row.push(
          r.map((c) => {
            const cell = new Y.Map<unknown>();
            const t = new Y.Text();
            t.insert(0, c);
            cell.set('text', t);
            return cell;
          }),
        );
        return row;
      }),
    );
    e.set('cells', rows);
    return e;
  };
  const image = () => {
    const e = new Y.Map<unknown>();
    e.set('type', 'image');
    e.set('src', '/api/v1/projects/p/files/f1');
    return e;
  };
  doc.transact(() => {
    doc.getMap(SLIDES_META_FIELD).set('w', 960);
    doc.getMap(SLIDES_META_FIELD).set('h', 540);
    slidesArray(doc).push([
      // 故意把第二页放在数组前面：顺序按 order
      page('p2', k2!, [table(), image()], ''),
      page(
        'p1',
        k1!,
        [
          text([
            {
              runs: [
                [
                  '视觉 Transformer 复现',
                  { bold: {}, textStyle: { color: '#1F2937', fontSize: '40pt' } },
                ],
              ],
            },
          ]),
          text([
            { list: true, runs: [['复现 '], ['ViT', { bold: {} }]] },
            { list: true, runs: [['消融实验']] },
          ]),
        ],
        '先讲复现',
      ),
    ]);
  });
}

describe('slides server model', () => {
  it('writes v2 pages with placeholders and reads them back as markdown', () => {
    const doc = new Y.Doc();
    initContent(
      doc,
      'slides',
      '# 组会汇报\n张三\n\n## 进展\n- **ViT** 复现\n- 消融\n  - 16 优于 32\n> 讲慢一点',
      '组会',
    );
    const pages = orderedSlides(doc);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.get('v')).toBe(2);
    expect(typeof pages[0]!.get('order')).toBe('string');
    const els = pages[1]!.get('elements') as Y.Map<Y.Map<unknown>>;
    const title = [...els.values()].find((e) => e.get('ph') === 'title')!;
    expect(title.get('style')).toMatchObject({ fontFamily: 'theme:title', bold: true });
    expect(fragmentPlainText(title.get('text') as Y.XmlFragment)).toBe('进展');
    const md = toMarkdown(doc, 'slides');
    expect(md).toContain('## 组会汇报');
    expect(md).toContain('<!-- layout: title -->');
    expect(md).toContain('- **ViT** 复现');
    expect(md).toContain('  - 16 优于 32');
    expect(md).toContain('> 讲慢一点');
    expect(outlineOf(doc, 'slides').map((o) => o.heading)).toEqual(['组会汇报', '进展']);
  });

  it('defaults to a title slide', () => {
    const doc = new Y.Doc();
    initContent(doc, 'slides', undefined, '分享');
    expect(outlineOf(doc, 'slides')).toEqual([{ heading: '分享', level: 1 }]);
  });

  it('reads legacy v1 pages and mixed decks', () => {
    const doc = new Y.Doc();
    slidesArray(doc).push([
      legacy('a', '旧封面', '张三', '备注', 'title'),
      legacy('b', '旧正文', '- 一'),
    ]);
    applyEdit(doc, 'slides', { op: 'append_slides', slides: [{ title: '新页', body: '- 二' }] });
    expect(outlineOf(doc, 'slides').map((o) => o.heading)).toEqual(['旧封面', '旧正文', '新页']);
    const md = toMarkdown(doc, 'slides');
    expect(md).toContain('## 旧封面');
    expect(md).toContain('> 备注');
    expect(md).toContain('## 新页');
    expect(md).toContain('- 二');
  });

  it('reads importer-shaped decks (no placeholders, tables, images) in order', () => {
    const doc = new Y.Doc();
    importerShaped(doc);
    const md = toMarkdown(doc, 'slides');
    expect(md.indexOf('## 视觉 Transformer 复现')).toBe(0);
    // 标题取自第一个文本框，不在正文里重复
    expect(md).not.toContain('**视觉 Transformer 复现**');
    expect(md).not.toContain('<!-- layout: blank -->');
    expect(md).toContain('- 复现 **ViT**');
    expect(md).toContain('> 先讲复现');
    expect(md).toContain('| 模型 | Top-1 |');
    expect(md).toContain('| ViT-B/16 | 81.2 |');
    expect(md).toContain('![图片](/api/v1/projects/p/files/f1)');
    expect(outlineOf(doc, 'slides').map((o) => o.heading)).toEqual([
      '视觉 Transformer 复现',
      '第 2 页',
    ]);
  });

  it('appends after the last page by order, even when the array order differs', () => {
    const doc = new Y.Doc();
    importerShaped(doc);
    applyEdit(doc, 'slides', { op: 'append', markdown: '## 下期计划\n- 写论文' });
    expect(outlineOf(doc, 'slides').map((o) => o.heading)).toEqual([
      '视觉 Transformer 复现',
      '第 2 页',
      '下期计划',
    ]);
  });

  it('replace_text finds text in rich text boxes, tables and notes keeping formatting', () => {
    const doc = new Y.Doc();
    importerShaped(doc);
    applyEdit(doc, 'slides', { op: 'replace_text', find: 'ViT', replace: 'DeiT', all: true });
    const md = toMarkdown(doc, 'slides');
    expect(md).toContain('- 复现 **DeiT**');
    expect(md).toContain('| DeiT-B/16 | 81.2 |');
    expect(() =>
      applyEdit(doc, 'slides', { op: 'replace_text', find: '不存在的词', replace: 'x' }),
    ).toThrow(/找不到/u);
  });

  it('replace_all / replace_slides rewrite the deck', () => {
    const doc = new Y.Doc();
    importerShaped(doc);
    applyEdit(doc, 'slides', {
      op: 'replace_slides',
      slides: [{ title: '只剩一页', body: '左\n\n---\n\n右', layout: 'two-column' }],
    });
    const pages = orderedSlides(doc);
    expect(pages).toHaveLength(1);
    const els = [...(pages[0]!.get('elements') as Y.Map<Y.Map<unknown>>).values()];
    expect(els.filter((e) => e.get('ph') === 'body')).toHaveLength(2);
    expect(toMarkdown(doc, 'slides')).toContain('<!-- layout: two-column -->');
  });

  it('restores a version snapshot including page settings', () => {
    const source = new Y.Doc();
    importerShaped(source);
    source.getMap(SLIDES_META_FIELD).set('w', 720);
    const target = new Y.Doc();
    initContent(target, 'slides', '## 当前', '当前');
    replaceContent(target, source, 'slides');
    expect(toMarkdown(target, 'slides')).toBe(toMarkdown(source, 'slides'));
    expect(target.getMap(SLIDES_META_FIELD).get('w')).toBe(720);
  });

  it('server-written pages sync to another replica unchanged', () => {
    const a = new Y.Doc();
    initContent(a, 'slides', '## 一\n- 甲\n\n## 二\n- 乙', 'x');
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(toMarkdown(b, 'slides')).toBe(toMarkdown(a, 'slides'));
  });
});
