import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap';
import {
  documentExcerpt,
  markdownToPm,
  pmToMarkdown,
  type PmNode,
} from '../../src/modules/documents/markdown';
import { DOC_PAGE_FIELD, WORD_SCHEMA } from '../../src/modules/documents/pm-word';
import { docSchema } from '../../src/modules/documents/pm-schema';
import {
  applyEdit,
  docJson,
  initContent,
  replaceContent,
  toMarkdown,
} from '../../src/modules/documents/ydoc';

const types = (json: PmNode) => (json.content ?? []).map((n) => n.type);

/** 一篇带 Word 式排版的文档（前端编辑器 / docx 导入会写出的结构） */
const WORD_DOC: PmNode = {
  type: 'doc',
  content: [
    { type: 'tableOfContents', attrs: { maxLevel: 3 } },
    {
      type: 'heading',
      attrs: { level: 1, textAlign: 'center', lineHeight: '1.5', spaceBefore: 12, spaceAfter: 6 },
      content: [{ type: 'text', text: '研究报告' }],
    },
    {
      type: 'paragraph',
      attrs: { textIndent: 2, indent: 1, lineHeight: '2' },
      content: [
        {
          type: 'text',
          text: '红色黑体',
          marks: [
            {
              type: 'textStyle',
              attrs: { color: '#ff0000', fontFamily: '黑体, SimHei', fontSize: '14pt' },
            },
            { type: 'bold' },
          ],
        },
        { type: 'text', text: 'H' },
        { type: 'text', text: '2', marks: [{ type: 'subscript' }] },
        { type: 'text', text: 'O 与 x' },
        { type: 'text', text: '2', marks: [{ type: 'superscript' }] },
        { type: 'footnote', attrs: { id: 'fn1', content: '数据来自 2024 年实验' } },
        {
          type: 'text',
          text: '，高亮',
          marks: [{ type: 'highlight', attrs: { color: '#fff3a3' } }],
        },
      ],
    },
    { type: 'pageBreak' },
    {
      type: 'orderedList',
      attrs: { start: 1, listStyle: 'cjk-ideographic' },
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '第一项' }] }],
        },
      ],
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableHeader',
              attrs: { colspan: 2, rowspan: 1, backgroundColor: '#ddeeff' },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '合并表头' }] }],
            },
          ],
        },
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }],
            },
            {
              type: 'tableCell',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }],
            },
          ],
        },
      ],
    },
  ],
};

function wordYDoc(): Y.Doc {
  const doc = new Y.Doc();
  prosemirrorJSONToYXmlFragment(docSchema(), WORD_DOC, doc.getXmlFragment('default'));
  return doc;
}

describe('Word 式排版的 schema（与前端 word/schema.ts 一致）', () => {
  it('节点、段落 / 列表 / 单元格属性、标记都在', () => {
    const schema = docSchema();
    for (const [name, attrs] of Object.entries(WORD_SCHEMA.nodes)) {
      expect(schema.nodes[name], name).toBeDefined();
      expect(Object.keys(schema.nodes[name]!.spec.attrs ?? {}).sort()).toEqual([...attrs].sort());
    }
    for (const t of ['paragraph', 'heading']) {
      expect(Object.keys(schema.nodes[t]!.spec.attrs ?? {})).toEqual(
        expect.arrayContaining([...WORD_SCHEMA.paragraphAttrs, 'textAlign']),
      );
    }
    for (const t of ['orderedList', 'bulletList']) {
      expect(Object.keys(schema.nodes[t]!.spec.attrs ?? {})).toEqual(
        expect.arrayContaining([...WORD_SCHEMA.listAttrs]),
      );
    }
    for (const t of ['tableCell', 'tableHeader']) {
      expect(Object.keys(schema.nodes[t]!.spec.attrs ?? {})).toEqual(
        expect.arrayContaining([...WORD_SCHEMA.cellAttrs, 'colspan', 'rowspan', 'colwidth']),
      );
    }
    expect(Object.keys(schema.marks.textStyle!.spec.attrs ?? {})).toEqual(
      expect.arrayContaining(['color', 'fontFamily', 'fontSize']),
    );
    expect(Object.keys(schema.marks.highlight!.spec.attrs ?? {})).toContain('color');
    expect(schema.marks.subscript).toBeDefined();
    expect(schema.marks.superscript).toBeDefined();
    expect(schema.nodes.footnote!.isInline).toBe(true);
    schema.nodeFromJSON(WORD_DOC).check();
  });
});

describe('Word 式排版的 markdown 表示', () => {
  it('分页符、目录、脚注、上下标 ⇄ markdown，往返稳定', () => {
    const md = pmToMarkdown(WORD_DOC);
    expect(md).toContain('<!-- toc -->');
    expect(md).toContain('<!-- pagebreak -->');
    expect(md).toContain('H<sub>2</sub>O 与 x<sup>2</sup>[^1]');
    expect(md).toMatch(/\n\[\^1\]: 数据来自 2024 年实验$/u);
    // 字体颜色写不出，但文字还在
    expect(md).toContain('**红色黑体**');

    const back = markdownToPm(md);
    docSchema().nodeFromJSON(back).check();
    expect(types(back)).toEqual([
      'tableOfContents',
      'heading',
      'paragraph',
      'pageBreak',
      'orderedList',
      'table',
    ]);
    const para = back.content![2]!.content!;
    expect(para.find((n) => n.type === 'footnote')?.attrs).toMatchObject({
      content: '数据来自 2024 年实验',
    });
    expect(para.find((n) => n.marks?.some((m) => m.type === 'subscript'))?.text).toBe('2');
    expect(para.find((n) => n.marks?.some((m) => m.type === 'superscript'))?.text).toBe('2');
    expect(pmToMarkdown(back)).toBe(md);
  });

  it('没有定义的 [^x] 保持原文；代码块里的定义行不当脚注', () => {
    const json = markdownToPm('见 [^x] 说明\n\n```\n[^1]: 不是脚注\n```');
    expect(json.content![0]!.content).toEqual([{ type: 'text', text: '见 [^x] 说明' }]);
    expect(json.content![1]!.type).toBe('codeBlock');
  });

  it('摘要里不出现脚注标记和上下标标签', () => {
    const ex = documentExcerpt('doc', pmToMarkdown(WORD_DOC));
    expect(ex).not.toMatch(/\[\^|<su[bp]>|<!--/u);
    expect(ex).toContain('H2O');
  });
});

describe('Word 式排版在服务端读写路径上不丢', () => {
  it('Y.Doc → markdown / outline 正常；replace_text 保留字体颜色等格式', () => {
    const doc = wordYDoc();
    expect(toMarkdown(doc, 'doc')).toContain('研究报告');
    doc.transact(() =>
      applyEdit(doc, 'doc', { op: 'replace_text', find: '红色黑体', replace: '红色标题' }),
    );
    const run = docJson(doc).content![2]!.content![0]!;
    expect(run.text).toBe('红色标题');
    expect(run.marks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'textStyle',
          attrs: expect.objectContaining({ color: '#ff0000', fontSize: '14pt' }),
        }),
      ]),
    );
    // 段落属性还在
    expect(docJson(doc).content![2]!.attrs).toMatchObject({ textIndent: 2, indent: 1 });
  });

  it('导入器写出的 Y.Doc 状态（正文 + 页面设置）经过更新编码后，服务端 toMarkdown 能读', () => {
    const local = wordYDoc();
    local.getMap(DOC_PAGE_FIELD).set('size', 'A4');
    local.getMap(DOC_PAGE_FIELD).set('marginTop', 25);
    const server = new Y.Doc();
    Y.applyUpdate(server, Y.encodeStateAsUpdate(local));
    const md = toMarkdown(server, 'doc');
    expect(md).toContain('# 研究报告');
    expect(md).toContain('[^1]: 数据来自 2024 年实验');
    expect(md).toContain('合并表头');
  });

  it('replace_section 只带 [^1] 时沿用文档里第 1 条脚注的内容', () => {
    const doc = new Y.Doc();
    initContent(doc, 'doc', '# 方法\n\n旧内容[^1]\n\n# 讨论\n\n结尾\n\n[^1]: 原始脚注', 't');
    doc.transact(() =>
      applyEdit(doc, 'doc', { op: 'replace_section', heading: '方法', markdown: '新内容[^1]' }),
    );
    const fn = docJson(doc).content![1]!.content!.find((n) => n.type === 'footnote');
    expect(fn?.attrs).toMatchObject({ content: '原始脚注' });
  });

  it('版本恢复：正文与页面设置一起恢复', () => {
    const source = wordYDoc();
    source.getMap(DOC_PAGE_FIELD).set('size', 'A3');
    source.getMap(DOC_PAGE_FIELD).set('marginLeft', 20);
    const target = new Y.Doc();
    target.getMap(DOC_PAGE_FIELD).set('orientation', 'landscape');
    replaceContent(target, source, 'doc');
    expect(target.getMap(DOC_PAGE_FIELD).toJSON()).toEqual({ size: 'A3', marginLeft: 20 });
    expect(types(docJson(target))).toEqual(types(WORD_DOC));
    expect(docJson(target).content![5]!.content![0]!.content![0]!.attrs).toMatchObject({
      colspan: 2,
      backgroundColor: '#ddeeff',
    });
  });
});
