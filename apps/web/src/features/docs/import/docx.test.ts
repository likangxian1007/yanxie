import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { buildSampleDocx, SAMPLE_PNG } from './docx-fixture';
import { importDocx, richSchema } from './docx';
import { docxToPm, type PmJSON } from '../editors/rich/word/docx-import';
import { exportDocx, imageSize } from '../editors/rich/word/docx-export';
import { DOC_PAGE_FIELD } from '../editors/rich/word/page';

function find(node: PmJSON, pred: (n: PmJSON) => boolean): PmJSON | undefined {
  if (pred(node)) return node;
  for (const c of node.content ?? []) {
    const r = find(c, pred);
    if (r) return r;
  }
  return undefined;
}

function textRun(doc: PmJSON, text: string) {
  return find(doc, (n) => n.type === 'text' && (n.text ?? '').includes(text));
}

const markOf = (n: PmJSON | undefined, type: string) => n?.marks?.find((m) => m.type === type);

async function asFile(blob: Blob, name: string): Promise<File> {
  return new File([await blob.arrayBuffer()], name, {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

describe('importDocx：真实 .docx（docx 库生成）→ 富文本', () => {
  it('写进空 Y.Doc：标题、文字格式、段落格式、列表、合并单元格表格、图片、脚注、分页、页面设置', async () => {
    const file = await asFile(await buildSampleDocx(), '季度报告.docx');
    const ydoc = new Y.Doc();
    const uploadFile = vi.fn(async (_blob: Blob, name: string) => ({
      id: 'fil_IMG1',
      url: `/api/v1/projects/p1/files/fil_IMG1?n=${name}`,
    }));
    const result = await importDocx(file, ydoc, { projectId: 'p1', uploadFile });
    expect(result.title).toBe('课题组季度研究报告');
    expect(result.warnings).toBeUndefined();

    const doc = yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment('default')) as PmJSON;
    // 写进去的结构符合编辑器 schema
    richSchema().nodeFromJSON(doc).check();
    const types = (doc.content ?? []).map((n) => n.type);
    expect(types.slice(0, 3)).toEqual(['heading', 'heading', 'paragraph']);
    expect(doc.content![0]!.attrs).toMatchObject({ level: 1, textAlign: 'center' });
    expect(types).toContain('table');
    expect(types).toContain('image');
    expect(types).toContain('pageBreak');

    // 段落格式：两端对齐、首行缩进 2 字符、1.5 倍行距、段前段后 6 磅
    const para = doc.content![2]!;
    expect(para.attrs).toMatchObject({
      textAlign: 'justify',
      textIndent: 2,
      lineHeight: '1.5',
      spaceBefore: 6,
      spaceAfter: 6,
    });
    // 文字格式
    const red = textRun(doc, '多模态大模型');
    expect(markOf(red, 'bold')).toBeDefined();
    expect(markOf(red, 'textStyle')?.attrs).toMatchObject({ color: '#c00000' });
    const em = textRun(doc, '重点');
    expect(markOf(em, 'italic')).toBeDefined();
    expect(markOf(em, 'underline')).toBeDefined();
    const font = markOf(textRun(doc, '评估了'), 'textStyle')?.attrs;
    expect(font?.fontSize).toBe('14pt');
    expect(String(font?.fontFamily)).toMatch(/^Arial, 黑体/u);
    expect(markOf(textRun(doc, '楷体文字'), 'textStyle')?.attrs?.fontFamily).toMatch(/^楷体/u);
    expect(markOf(textRun(doc, '三种方法'), 'highlight')?.attrs?.color).toBe('#ffff00');
    expect(markOf(textRun(doc, '删除线'), 'strike')).toBeDefined();
    const sub = find(para, (n) => n.text === '2' && !!markOf(n, 'subscript'));
    const sup = find(para, (n) => n.text === '2' && !!markOf(n, 'superscript'));
    expect(sub && sup).toBeTruthy();
    // 全文默认字体（Times New Roman / 宋体 12 磅）不写到每个字上
    expect(markOf(textRun(doc, '本季度围绕'), 'textStyle')).toBeUndefined();
    // 脚注
    expect(find(doc, (n) => n.type === 'footnote')?.attrs).toMatchObject({
      content: '数据来源：2026 年第三季度实验记录。',
    });
    // 超链接（链接样式的下划线 / 颜色不重复成标记）
    const link = textRun(doc, '课题组网站');
    expect(markOf(link, 'link')?.attrs?.href).toBe('https://example.com/lab');
    expect(markOf(link, 'underline')).toBeUndefined();

    // 多级编号：1. 下面嵌套 a)，然后是圆点列表、中文编号
    const lists = (doc.content ?? []).filter((n) => /List$/u.test(n.type));
    expect(lists.map((l) => [l.type, l.attrs?.listStyle ?? null])).toEqual([
      ['orderedList', null],
      ['bulletList', null],
      ['orderedList', 'cjk-ideographic'],
    ]);
    const steps = lists[0]!;
    expect(steps.content).toHaveLength(2);
    const nested = steps.content![0]!.content![1]!;
    expect(nested.type).toBe('orderedList');
    expect(nested.attrs?.listStyle).toBe('lower-alpha');
    expect(nested.content).toHaveLength(2);

    // 表格：标题行、横向合并、纵向合并、单元格底色
    const table = find(doc, (n) => n.type === 'table')!;
    const [head, r1, r2] = table.content!;
    expect(head!.content!.map((c) => c.type)).toEqual(['tableHeader', 'tableHeader']);
    expect(head!.content![1]!.attrs).toMatchObject({ colspan: 2, backgroundColor: '#d9e2f3' });
    expect(r1!.content![0]!.attrs).toMatchObject({ rowspan: 2 });
    expect(r2!.content).toHaveLength(2);
    expect(r2!.content![1]!.attrs?.backgroundColor).toBe('#fff2cc');

    // 图片：上传到项目文件，按原尺寸
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(uploadFile.mock.calls[0]![0].type).toBe('image/png');
    const image = find(doc, (n) => n.type === 'image')!;
    expect(image.attrs).toMatchObject({ fileId: 'fil_IMG1', width: 240 });
    expect(String(image.attrs!.src)).toMatch(/^\/api\/v1\/projects\/p1\/files\/fil_IMG1/u);

    // 页面设置：A4，页边距 25 / 30 毫米
    expect(ydoc.getMap(DOC_PAGE_FIELD).toJSON()).toMatchObject({
      size: 'A4',
      orientation: 'portrait',
      marginTop: 25,
      marginLeft: 30,
    });
  });

  it('不是 docx、空文件、非空 Y.Doc → 中文错误', async () => {
    await expect(importDocx(new File(['hello'], 'a.docx'), new Y.Doc())).rejects.toThrow(/Word/u);
    await expect(importDocx(new File([], 'a.docx'), new Y.Doc())).rejects.toThrow('这个文件是空的');
    const busy = new Y.Doc();
    busy.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
    const file = await asFile(await buildSampleDocx(), 'a.docx');
    await expect(importDocx(file, busy)).rejects.toThrow('只能导入到空文档里');
  });
});

const cell = (type: string, attrs: Record<string, unknown>, text: string): PmJSON => ({
  type,
  attrs,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** 一篇用到全部 Word 式排版的文档 */
const RICH_SAMPLE: PmJSON = {
  type: 'doc',
  content: [
    { type: 'tableOfContents', attrs: { maxLevel: 3 } },
    {
      type: 'heading',
      attrs: { level: 1, textAlign: 'center' },
      content: [{ type: 'text', text: '实验报告' }],
    },
    {
      type: 'paragraph',
      attrs: {
        textAlign: 'justify',
        lineHeight: '2',
        spaceBefore: 12,
        spaceAfter: 6,
        textIndent: 2,
      },
      content: [
        {
          type: 'text',
          text: '红色黑体',
          marks: [
            { type: 'bold' },
            {
              type: 'textStyle',
              attrs: { color: '#ff0000', fontFamily: '黑体, SimHei, sans-serif', fontSize: '16pt' },
            },
          ],
        },
        { type: 'text', text: '斜体下划线', marks: [{ type: 'italic' }, { type: 'underline' }] },
        { type: 'text', text: '高亮', marks: [{ type: 'highlight', attrs: { color: '#bae0ff' } }] },
        { type: 'text', text: 'x' },
        { type: 'text', text: '2', marks: [{ type: 'superscript' }] },
        { type: 'footnote', attrs: { id: 'a', content: '脚注正文' } },
        {
          type: 'text',
          text: '链接',
          marks: [{ type: 'link', attrs: { href: 'https://example.com/' } }],
        },
        { type: 'text', text: '，公式 ' },
        { type: 'inlineMath', attrs: { latex: '\\frac{a}{b}' } },
      ],
    },
    { type: 'paragraph', attrs: { indent: 2 }, content: [{ type: 'text', text: '左缩进两级' }] },
    {
      type: 'orderedList',
      attrs: { start: 3, listStyle: 'upper-roman' },
      content: [
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '第三项' }] },
            {
              type: 'bulletList',
              content: [
                {
                  type: 'listItem',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: '子项' }] }],
                },
              ],
            },
          ],
        },
      ],
    },
    { type: 'pageBreak' },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            cell(
              'tableHeader',
              { colspan: 2, rowspan: 1, colwidth: [200, 200], backgroundColor: '#ddeeff' },
              '表头',
            ),
          ],
        },
        {
          type: 'tableRow',
          content: [
            cell('tableCell', { colspan: 1, rowspan: 2, colwidth: [200] }, '纵向合并'),
            cell('tableCell', { colspan: 1, rowspan: 1, colwidth: [200] }, 'B'),
          ],
        },
        {
          type: 'tableRow',
          content: [
            cell(
              'tableCell',
              { colspan: 1, rowspan: 1, colwidth: [200], backgroundColor: '#fff3a3' },
              'C',
            ),
          ],
        },
      ],
    },
    {
      type: 'image',
      attrs: { src: '/img.png', alt: '曲线', caption: '图 1', width: 320, align: 'center' },
    },
    { type: 'blockMath', attrs: { latex: 'E = mc^2' } },
  ],
};

describe('exportDocx：富文本 → .docx，再导入回来格式不丢', () => {
  it('导出后再导入：标题、格式、列表、合并单元格、图片、脚注、公式、页面设置都在', async () => {
    const loadImage = vi.fn(async () => ({
      data: SAMPLE_PNG,
      type: 'png' as const,
      ...imageSize(SAMPLE_PNG)!,
    }));
    const blob = await exportDocx(RICH_SAMPLE, {
      title: '实验报告',
      page: {
        size: 'A4',
        orientation: 'landscape',
        marginTop: 20,
        marginRight: 20,
        marginBottom: 20,
        marginLeft: 20,
      },
      loadImage,
    });
    expect(loadImage).toHaveBeenCalledWith('/img.png');
    const back = await docxToPm(blob, undefined, 'x.docx');
    const doc = back.doc;
    expect(back.page).toMatchObject({
      size: 'A4',
      orientation: 'landscape',
      marginTop: 20,
      marginLeft: 20,
    });

    const types = (doc.content ?? []).map((n) => n.type);
    expect(types).toContain('tableOfContents');
    expect(types).toContain('pageBreak');
    expect(types).toContain('blockMath');
    const h1 = find(doc, (n) => n.type === 'heading' && n.attrs?.level === 1)!;
    expect(h1.attrs?.textAlign).toBe('center');
    expect(textRun(h1, '实验报告')).toBeDefined();
    // 标题的加粗来自标题样式：再导入不会多出加粗标记（否则每往返一次 markdown 里就多一层 **）
    expect(markOf(textRun(h1, '实验报告'), 'bold')).toBeUndefined();

    const para = find(doc, (n) => n.type === 'paragraph' && !!textRun(n, '红色黑体'))!;
    expect(para.attrs).toMatchObject({
      textAlign: 'justify',
      lineHeight: '2',
      spaceBefore: 12,
      spaceAfter: 6,
      textIndent: 2,
    });
    const red = textRun(para, '红色黑体');
    expect(markOf(red, 'bold')).toBeDefined();
    expect(markOf(red, 'textStyle')?.attrs).toMatchObject({ color: '#ff0000', fontSize: '16pt' });
    expect(String(markOf(red, 'textStyle')?.attrs?.fontFamily)).toMatch(/黑体/u);
    expect(markOf(textRun(para, '斜体下划线'), 'underline')).toBeDefined();
    expect(markOf(textRun(para, '高亮'), 'highlight')?.attrs?.color).toBe('#bae0ff');
    expect(find(para, (n) => n.text === '2' && !!markOf(n, 'superscript'))).toBeDefined();
    expect(find(para, (n) => n.type === 'footnote')?.attrs?.content).toBe('脚注正文');
    expect(markOf(textRun(para, '链接'), 'link')?.attrs?.href).toBe('https://example.com/');
    expect(String(find(para, (n) => n.type === 'inlineMath')?.attrs?.latex)).toMatch(
      /\\frac\{a\}\{b\}/u,
    );

    expect(
      find(doc, (n) => n.type === 'paragraph' && !!textRun(n, '左缩进两级'))?.attrs?.indent,
    ).toBe(2);

    const list = find(doc, (n) => n.type === 'orderedList')!;
    expect(list.attrs).toMatchObject({ start: 3, listStyle: 'upper-roman' });
    expect(find(list, (n) => n.type === 'bulletList' && !!textRun(n, '子项'))).toBeDefined();

    const table = find(doc, (n) => n.type === 'table')!;
    const [head, r1, r2] = table.content!;
    expect(head!.content![0]!).toMatchObject({
      type: 'tableHeader',
      attrs: { colspan: 2, backgroundColor: '#ddeeff' },
    });
    expect(r1!.content![0]!.attrs).toMatchObject({ rowspan: 2 });
    expect(r2!.content).toHaveLength(1);
    expect(r2!.content![0]!.attrs?.backgroundColor).toBe('#fff3a3');

    const image = find(doc, (n) => n.type === 'image')!;
    expect(image.attrs?.width).toBe(320);
    expect(String(image.attrs?.src)).toMatch(/^data:image\/png/u);
    expect(textRun(doc, '图 1')).toBeDefined();
    expect(String(find(doc, (n) => n.type === 'blockMath')?.attrs?.latex)).toMatch(
      /E\s*=\s*m\s*\{?c\}?\^\{?2/u,
    );
    // 还原出的结构符合 schema
    richSchema().nodeFromJSON(doc).check();
  });

  it('图片取不到时写“［图片］”占位，不让导出失败', async () => {
    const blob = await exportDocx(
      { type: 'doc', content: [{ type: 'image', attrs: { src: '/missing.png' } }] },
      { title: 't', loadImage: async () => null },
    );
    const back = await docxToPm(blob);
    expect(textRun(back.doc, '［图片］')).toBeDefined();
  });

  it('imageSize 读 PNG 尺寸', () => {
    expect(imageSize(SAMPLE_PNG)).toEqual({ width: 64, height: 48 });
  });
});
