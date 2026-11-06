import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { contentExtensions } from '../extensions';
import { mockLayoutApis } from '../test-utils';
import {
  normalizeColor,
  normalizeFontStack,
  sizeLabel,
  splitFontStack,
  stepFontSize,
  toPt,
} from './format';
import { PAGE_GAP, planPages, type PageUnit } from './pagination';
import { DEFAULT_PAGE, pageGeometry, paperMm, readPageSetup } from './page';
import { SearchReplace, buildRegex, findMatches, getSearchState } from './search';
import { FormatPainter, applyFormat, copyFormat } from './format-painter';

beforeAll(() => mockLayoutApis());

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function make(content: JSONContent): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [...contentExtensions(), SearchReplace, FormatPainter],
    content,
  });
  return editor;
}

const p = (text: string, attrs?: Record<string, unknown>): JSONContent => ({
  type: 'paragraph',
  ...(attrs ? { attrs } : {}),
  content: [{ type: 'text', text }],
});

describe('字号、字体、颜色', () => {
  it('字号换算成磅，中文字号显示名，沿 Word 字号表增减', () => {
    expect(toPt('16px')).toBe(12);
    expect(toPt('10.5pt')).toBe(10.5);
    expect(toPt('abc')).toBeNull();
    expect(sizeLabel('12pt')).toBe('小四');
    expect(sizeLabel('10.5pt')).toBe('五号');
    expect(sizeLabel('13pt')).toBe('13');
    expect(stepFontSize('11pt', 1)).toBe('12pt');
    expect(stepFontSize(null, -1)).toBe('10.5pt');
    expect(stepFontSize('72pt', 1)).toBe('82pt');
  });

  it('导入的字体名规整成带回退的字体栈，导出时拆回西文 / 中文', () => {
    expect(normalizeFontStack('SimHei')).toBe('黑体, SimHei, "Heiti SC", STHeiti, sans-serif');
    const mixed = normalizeFontStack('Arial, 黑体')!;
    expect(mixed.startsWith('Arial')).toBe(true);
    expect(splitFontStack(mixed)).toEqual({ ascii: 'Arial', eastAsia: '黑体' });
    expect(splitFontStack('"Microsoft YaHei", sans-serif')).toEqual({
      ascii: null,
      eastAsia: '微软雅黑',
    });
    expect(normalizeFontStack('serif')).toBeNull();
  });

  it('颜色统一成 #rrggbb', () => {
    expect(normalizeColor('#F00')).toBe('#ff0000');
    expect(normalizeColor('rgb(0, 128, 255)')).toBe('#0080ff');
    expect(normalizeColor('rgba(0,0,0,0)')).toBeNull();
    expect(normalizeColor('yellow')).toBe(normalizeColor('#ffff00'));
    expect(normalizeColor('auto')).toBeNull();
  });
});

describe('页面设置', () => {
  it('缺省 A4 纵向，横向时宽高互换，几何按 96dpi 换成像素', () => {
    const page = readPageSetup({});
    expect(page).toEqual(DEFAULT_PAGE);
    expect(paperMm({ ...page, orientation: 'landscape' })).toEqual({ width: 297, height: 210 });
    const g = pageGeometry(page);
    expect(Math.round(g.width)).toBe(794);
    expect(Math.round(g.height)).toBe(1123);
  });

  it('坏数据回退到默认值', () => {
    const page = readPageSetup({ size: 'Z9', marginTop: -5, orientation: 'sideways' });
    expect(page.size).toBe(DEFAULT_PAGE.size);
    expect(page.orientation).toBe(DEFAULT_PAGE.orientation);
    expect(page.marginTop).toBe(DEFAULT_PAGE.marginTop);
  });
});

describe('分页计算 planPages', () => {
  // 页高 300、上下边距各 50 → 每页内容区高 200；页距 P = 300 + 间隔
  const g = { width: 400, height: 300, top: 50, right: 40, bottom: 50, left: 40 };
  const P = g.height + PAGE_GAP;
  const units = (heights: number[], breakAfter: number[] = []): PageUnit[] => {
    let y = 0;
    let prevBottom = 0;
    return heights.map((h, i) => {
      const u: PageUnit = {
        pos: i * 10,
        top: y,
        bottom: y + h,
        prevMarginBottom: 0,
        marginTop: 0,
        prevBottom,
        forceBreakAfter: breakAfter.includes(i),
        inset: 40,
      };
      prevBottom = y + h;
      y += h;
      return u;
    });
  };

  it('一页放得下：不分页，末尾补白到页底', () => {
    const plan = planPages(units([50, 50]), g);
    expect(plan.breaks).toEqual([]);
    expect(plan.pageCount).toBe(1);
    expect(plan.fill).toBe(100);
    expect(plan.pages).toEqual([1, 1]);
  });

  it('放不下的块整块挪到下一页开头', () => {
    const plan = planPages(units([120, 120, 30]), g);
    expect(plan.breaks).toHaveLength(1);
    const b = plan.breaks[0]!;
    expect(b.pos).toBe(10);
    expect(b.page).toBe(1);
    // widget 从第一块底部（120）一直撑到第二页内容区顶部（P）
    expect(b.height).toBe(P - 120);
    expect(b.tail).toBe(200 - 120 + g.bottom);
    expect(plan.pages).toEqual([1, 2, 2]);
    expect(plan.pageCount).toBe(2);
  });

  it('分页符之后强制换页；比一页还高的块不拆', () => {
    const forced = planPages(units([20, 0, 20], [1]), g);
    expect(forced.breaks.map((b) => b.pos)).toEqual([20]);
    expect(forced.pages).toEqual([1, 1, 2]);
    const tall = planPages(units([10, 500, 10]), g);
    expect(tall.breaks.map((b) => b.pos)).toEqual([10]);
    expect(tall.pages).toEqual([1, 2, 3]);
  });
});

describe('Word 命令', () => {
  it('行距、段前段后、首行缩进、左缩进写在段落属性上，清除格式全部去掉', () => {
    const ed = make({ type: 'doc', content: [p('正文段落')] });
    ed.commands.setTextSelection(2);
    ed.chain()
      .setLineHeight('1.5')
      .setParagraphSpacing({ before: 6, after: 12 })
      .setTextIndent(2)
      .run();
    ed.commands.indentBlock();
    ed.commands.indentBlock();
    let attrs = ed.state.doc.firstChild!.attrs;
    expect(attrs).toMatchObject({
      lineHeight: '1.5',
      spaceBefore: 6,
      spaceAfter: 12,
      textIndent: 2,
      indent: 2,
    });
    ed.commands.outdentBlock();
    expect(ed.state.doc.firstChild!.attrs.indent).toBe(1);
    ed.commands.selectAll();
    ed.chain().setColor('#ff0000').setFontSize('14pt').toggleBold().run();
    ed.commands.clearFormatting();
    attrs = ed.state.doc.firstChild!.attrs;
    expect(attrs.lineHeight ?? null).toBeNull();
    expect(attrs.indent ?? 0).toBe(0);
    const marks: string[] = [];
    ed.state.doc.descendants((n) => {
      n.marks.forEach((m) => marks.push(m.type.name));
    });
    expect(marks).toEqual([]);
  });

  it('列表编号样式、分页符、目录、脚注', () => {
    const ed = make({
      type: 'doc',
      content: [
        { type: 'orderedList', content: [{ type: 'listItem', content: [p('第一项')] }] },
        p('结尾'),
      ],
    });
    ed.commands.setTextSelection(4);
    ed.commands.setListStyle('upper-roman');
    expect(ed.state.doc.firstChild!.attrs.listStyle).toBe('upper-roman');
    // 无序样式作用在有序列表上：换成无序列表
    ed.commands.setListStyle('square');
    expect(ed.state.doc.firstChild!.type.name).toBe('bulletList');
    expect(ed.state.doc.firstChild!.attrs.listStyle).toBe('square');

    const end = ed.state.doc.content.size - 1;
    ed.commands.setTextSelection(end);
    ed.commands.insertFootnote('数据来自 2024 年实验');
    const notes: unknown[] = [];
    ed.state.doc.descendants((n) => {
      if (n.type.name === 'footnote') notes.push(n.attrs.content);
    });
    expect(notes).toEqual(['数据来自 2024 年实验']);

    ed.commands.insertTableOfContents();
    ed.commands.setPageBreak();
    const types: string[] = [];
    ed.state.doc.forEach((n) => types.push(n.type.name));
    expect(types).toContain('tableOfContents');
    expect(types).toContain('pageBreak');
    // HTML 往返（复制粘贴）保留这些节点
    const again = make({ type: 'doc', content: [] });
    again.commands.setContent(ed.getHTML());
    expect(again.getJSON()).toEqual(ed.getJSON());
  });

  it('单元格底色', () => {
    const ed = make({ type: 'doc', content: [p('x')] });
    ed.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
    ed.commands.setCellBackground('#fff3a3');
    let bg: unknown = null;
    ed.state.doc.descendants((n) => {
      if ((n.type.name === 'tableCell' || n.type.name === 'tableHeader') && n.attrs.backgroundColor)
        bg = n.attrs.backgroundColor;
    });
    expect(bg).toBe('#fff3a3');
  });
});

describe('查找与替换', () => {
  it('普通 / 区分大小写 / 全字 / 正则', () => {
    expect(buildRegex('a.b', {})!.source).toBe('a\\.b');
    expect(buildRegex('(', { regex: true })).toBeNull();
    const ed = make({ type: 'doc', content: [p('Cat cat category'), p('猫 cat')] });
    expect(findMatches(ed.state.doc, 'cat')).toHaveLength(4);
    expect(findMatches(ed.state.doc, 'cat', { caseSensitive: true })).toHaveLength(3);
    expect(findMatches(ed.state.doc, 'cat', { wholeWord: true })).toHaveLength(3);
    expect(findMatches(ed.state.doc, 'c.t\\b', { regex: true })).toHaveLength(3);
  });

  it('下一个选中匹配，替换当前与全部替换保留格式', () => {
    const ed = make({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '旧词 和 旧词', marks: [{ type: 'bold' }] }],
        },
      ],
    });
    ed.commands.setSearch('旧词');
    expect(getSearchState(ed.state).matches).toHaveLength(2);
    ed.commands.findNext();
    const s = getSearchState(ed.state);
    expect(s.current).toBeGreaterThanOrEqual(0);
    expect(ed.state.doc.textBetween(ed.state.selection.from, ed.state.selection.to)).toBe('旧词');
    ed.commands.replaceAll('新词');
    expect(ed.state.doc.textContent).toBe('新词 和 新词');
    expect(getSearchState(ed.state).matches).toHaveLength(0);
    let bold = true;
    ed.state.doc.descendants((n) => {
      if (n.isText && !n.marks.some((m) => m.type.name === 'bold')) bold = false;
    });
    expect(bold).toBe(true);
    ed.commands.clearSearch();
    expect(getSearchState(ed.state).query).toBe('');
  });
});

describe('格式刷', () => {
  it('复制文字格式与段落格式，应用到另一段选区', () => {
    const ed = make({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { textAlign: 'center', lineHeight: '2' },
          content: [
            {
              type: 'text',
              text: '样板',
              marks: [
                { type: 'bold' },
                { type: 'textStyle', attrs: { color: '#c00000', fontSize: '14pt' } },
              ],
            },
          ],
        },
        p('目标文字'),
      ],
    });
    ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 1, 3)));
    const fmt = copyFormat(ed.state);
    expect(fmt.marks.map((m) => m.type.name).sort()).toEqual(['bold', 'textStyle']);
    const second = ed.state.doc.firstChild!.nodeSize;
    ed.view.dispatch(
      ed.state.tr.setSelection(TextSelection.create(ed.state.doc, second + 1, second + 5)),
    );
    const tr = applyFormat(ed.state, fmt)!;
    ed.view.dispatch(tr);
    const target = ed.state.doc.child(1);
    expect(target.attrs).toMatchObject({ textAlign: 'center', lineHeight: '2' });
    expect(target.firstChild!.marks.map((m) => m.type.name).sort()).toEqual(['bold', 'textStyle']);
  });
});
