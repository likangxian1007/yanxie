import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { CONTENT_MARK_NAMES, CONTENT_NODE_NAMES, contentExtensions } from '../extensions';
import { collectHeadings, extractOutline, sameOutline } from './outline';
import { SLASH_ITEMS, filterSlashItems } from './slash-items';
import { matchSlash } from '../ext/slash';
import { countWords, normalizeHref, shortcutLabel } from './text';
import { RICH_CUSTOM_NODES } from '../nodes';
import { WORD_SCHEMA } from '../word/schema';

const schema = getSchema(contentExtensions());

describe('contentExtensions（与服务端 docSchema 保持一致）', () => {
  it('节点 / 标记名是 Tiptap v3 默认名，没有多余或缺少', () => {
    expect(Object.keys(schema.nodes).sort()).toEqual([...CONTENT_NODE_NAMES].sort());
    expect(Object.keys(schema.marks).sort()).toEqual([...CONTENT_MARK_NAMES].sort());
  });

  it('关键属性与服务端一致', () => {
    expect(schema.nodes.taskItem!.spec.content).toBe('paragraph block*'); // nested: true
    expect(Object.keys(schema.nodes.taskItem!.spec.attrs ?? {})).toContain('checked');
    expect(Object.keys(schema.nodes.codeBlock!.spec.attrs ?? {})).toContain('language');
    expect(Object.keys(schema.nodes.inlineMath!.spec.attrs ?? {})).toEqual(['latex']);
    expect(Object.keys(schema.nodes.blockMath!.spec.attrs ?? {})).toEqual(['latex']);
    expect(Object.keys(schema.nodes.paragraph!.spec.attrs ?? {})).toContain('textAlign');
    expect(Object.keys(schema.nodes.tableCell!.spec.attrs ?? {})).toEqual(
      expect.arrayContaining(['colspan', 'rowspan', 'colwidth']),
    );
    expect(Object.keys(schema.marks.link!.spec.attrs ?? {})).toContain('href');
  });

  it('图片 / 附件 / 内嵌文档 / 提及的属性与服务端 pm-nodes.ts 一致', () => {
    for (const [name, attrs] of Object.entries(RICH_CUSTOM_NODES)) {
      expect(Object.keys(schema.nodes[name]!.spec.attrs ?? {}).sort(), name).toEqual(
        [...attrs].sort(),
      );
    }
    expect(schema.nodes.mention!.isInline).toBe(true);
    expect(schema.nodes.image!.isBlock && schema.nodes.image!.isAtom).toBe(true);
    expect(schema.nodes.docEmbed!.isBlock && schema.nodes.docEmbed!.isAtom).toBe(true);
  });

  it('Word 式属性 / 节点与服务端 pm-word.ts 的 WORD_SCHEMA 一致', () => {
    // 与 apps/server/src/modules/documents/pm-word.ts 的 WORD_SCHEMA 逐项相同（服务端测试对照同一份）
    expect(WORD_SCHEMA).toEqual({
      paragraphAttrs: ['lineHeight', 'spaceBefore', 'spaceAfter', 'textIndent', 'indent'],
      listAttrs: ['listStyle'],
      cellAttrs: ['backgroundColor'],
      nodes: { pageBreak: [], tableOfContents: ['maxLevel'], footnote: ['id', 'content'] },
    });
    const attrs = (name: string) => Object.keys(schema.nodes[name]!.spec.attrs ?? {});
    for (const n of ['paragraph', 'heading'])
      expect(attrs(n)).toEqual(expect.arrayContaining([...WORD_SCHEMA.paragraphAttrs]));
    for (const n of ['bulletList', 'orderedList'])
      expect(attrs(n)).toEqual(expect.arrayContaining([...WORD_SCHEMA.listAttrs]));
    for (const n of ['tableCell', 'tableHeader'])
      expect(attrs(n)).toEqual(expect.arrayContaining([...WORD_SCHEMA.cellAttrs]));
    for (const [n, a] of Object.entries(WORD_SCHEMA.nodes))
      expect(attrs(n).sort(), n).toEqual([...a].sort());
    expect(schema.nodes.footnote!.isInline && schema.nodes.footnote!.isAtom).toBe(true);
    expect(schema.nodes.pageBreak!.isBlock).toBe(true);
    expect(Object.keys(schema.marks.textStyle!.spec.attrs ?? {})).toEqual(
      expect.arrayContaining(['color', 'fontFamily', 'fontSize']),
    );
    expect(Object.keys(schema.marks.highlight!.spec.attrs ?? {})).toContain('color');
  });
});

describe('大纲提取', () => {
  const doc = schema.nodeFromJSON({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '引言' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '正文' }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '  相关   工作 ' }] },
      { type: 'heading', attrs: { level: 2 } },
      {
        type: 'blockquote',
        content: [
          {
            type: 'heading',
            attrs: { level: 3 },
            content: [{ type: 'text', text: '引用里的标题' }],
          },
        ],
      },
      {
        type: 'heading',
        attrs: { level: 3 },
        content: [
          { type: 'text', text: '方法 ' },
          { type: 'inlineMath', attrs: { latex: 'x^2' } },
          { type: 'text', marks: [{ type: 'bold' }], text: '与实验' },
        ],
      },
    ],
  });

  it('按文档顺序收集非空标题，规整空白', () => {
    expect(extractOutline(doc)).toEqual([
      { heading: '引言', level: 1 },
      { heading: '相关 工作', level: 2 },
      { heading: '引用里的标题', level: 3 },
      { heading: '方法 与实验', level: 3 },
    ]);
  });

  it('带上节点位置，位置处确实是标题', () => {
    for (const h of collectHeadings(doc)) {
      expect(doc.nodeAt(h.pos)?.type.name).toBe('heading');
    }
  });

  it('sameOutline 比较内容', () => {
    const a = extractOutline(doc);
    expect(sameOutline(a, [...a])).toBe(true);
    expect(sameOutline(a, a.slice(1))).toBe(false);
    expect(sameOutline([{ heading: 'a', level: 1 }], [{ heading: 'a', level: 2 }])).toBe(false);
  });
});

describe('斜杠菜单', () => {
  const ids = (q: string) => filterSlashItems(SLASH_ITEMS, q).map((i) => i.id);

  it('空查询返回全部（保持顺序）', () => {
    expect(ids('')).toEqual(SLASH_ITEMS.map((i) => i.id));
    expect(ids('   ')).toHaveLength(SLASH_ITEMS.length);
  });

  it('中文标题与关键词匹配', () => {
    expect(ids('标题')).toEqual(['h1', 'h2', 'h3']);
    expect(ids('表格')[0]).toBe('table');
    expect(ids('待办')).toEqual(['taskList']);
    expect(ids('公式')).toEqual(['blockMath', 'inlineMath']);
    expect(ids('总结')).toEqual(['aiSummarize']);
  });

  it('英文关键词匹配，标题命中排在关键词命中之前', () => {
    expect(ids('h2')).toEqual(['h2']);
    expect(ids('todo')).toEqual(['taskList']);
    expect(ids('code')).toEqual(['codeBlock']);
    expect(ids('ai')[0]).toBe('aiContinue');
    expect(ids('ai')).toEqual(['aiContinue', 'aiOutline', 'aiSummarize']);
    expect(ids('LaTeX')).toEqual(['blockMath', 'inlineMath']);
  });

  it('多个词都要命中，标题忽略空格', () => {
    expect(ids('ai 大纲')).toEqual(['aiOutline']);
    expect(ids('标题1')).toEqual(['h1']);
    expect(ids('不存在的命令')).toEqual([]);
  });

  it('触发条件：“/” 在行首', () => {
    expect(matchSlash('/')).toBe('');
    expect(matchSlash('/表格')).toBe('表格');
    expect(matchSlash('/h1')).toBe('h1');
    expect(matchSlash('文字/')).toBeNull();
    expect(matchSlash('/a b')).toBeNull();
    expect(matchSlash('//')).toBeNull();
    expect(matchSlash('')).toBeNull();
  });
});

describe('文本工具', () => {
  it('字数：中文按字、英文按词', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('研协 AI 平台 v2.0')).toBe(6);
    expect(countWords('Hello, world!')).toBe(2);
    expect(countWords('我们提出了一种新方法。')).toBe(10);
    expect(countWords("don't stop 3.14")).toBe(3);
  });

  it('链接规整与安全', () => {
    expect(normalizeHref('example.com')).toBe('https://example.com');
    expect(normalizeHref(' https://a.b/c?d=1 ')).toBe('https://a.b/c?d=1');
    expect(normalizeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(normalizeHref('a@b.cn')).toBe('mailto:a@b.cn');
    expect(normalizeHref('#引言')).toBe('#引言');
    expect(normalizeHref('javascript:alert(1)')).toBeNull();
    expect(normalizeHref('JaVaScRiPt:alert(1)')).toBeNull();
    expect(normalizeHref('data:text/html,x')).toBeNull();
    expect(normalizeHref('two words')).toBeNull();
    expect(normalizeHref('   ')).toBeNull();
  });

  it('快捷键显示', () => {
    expect(shortcutLabel('Mod-b', true)).toBe('⌘B');
    expect(shortcutLabel('Mod-Shift-z', true)).toBe('⌘⇧Z');
    expect(shortcutLabel('Mod-Shift-z', false)).toBe('Ctrl+Shift+Z');
    expect(shortcutLabel('Mod-Alt-1', false)).toBe('Ctrl+Alt+1');
  });
});
