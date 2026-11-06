import { Extension, Node, mergeAttributes } from '@tiptap/core';

/**
 * 富文本 Word 式排版的 schema 部分（前端 `apps/web/src/features/docs/editors/rich/word/schema.ts`
 * 在同名节点 / 属性上加了命令、快捷键和 NodeView）。名字、属性必须两边一致（两边测试对照 WORD_SCHEMA）。
 *
 * - 段落 / 标题：lineHeight（倍数字符串）、spaceBefore / spaceAfter（磅）、textIndent（首行缩进，字符；负数悬挂）、indent（左缩进级数）
 * - 有序 / 无序列表：listStyle（decimal、lower-alpha、cjk-ideographic…）
 * - 单元格 / 表头：backgroundColor（#rrggbb）
 * - 节点：pageBreak（分页符）、tableOfContents（目录，maxLevel）、footnote（脚注，行内，id + content 纯文字）
 * - 标记（在 pm-schema.ts 里加）：textStyle（color、fontFamily、fontSize）、subscript、superscript、highlight.color
 */
export const WORD_SCHEMA = {
  paragraphAttrs: ['lineHeight', 'spaceBefore', 'spaceAfter', 'textIndent', 'indent'],
  listAttrs: ['listStyle'],
  cellAttrs: ['backgroundColor'],
  nodes: {
    pageBreak: [] as string[],
    tableOfContents: ['maxLevel'],
    footnote: ['id', 'content'],
  },
} as const;

/** 页面设置（纸张、方向、页边距）所在的 Y.Map 名；版本恢复时一起恢复 */
export const DOC_PAGE_FIELD = 'page';

export const ParagraphFormat = Extension.create({
  name: 'wordParagraphFormat',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          lineHeight: { default: null },
          spaceBefore: { default: null },
          spaceAfter: { default: null },
          textIndent: { default: null },
          indent: { default: 0 },
        },
      },
      { types: ['orderedList', 'bulletList'], attributes: { listStyle: { default: null } } },
      { types: ['tableCell', 'tableHeader'], attributes: { backgroundColor: { default: null } } },
    ];
  },
});

export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML() {
    return [{ tag: 'div[data-type="page-break"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'page-break' })];
  },
});

export const TableOfContents = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { maxLevel: { default: 3 } };
  },
  parseHTML() {
    return [{ tag: 'nav[data-type="toc"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['nav', mergeAttributes(HTMLAttributes, { 'data-type': 'toc' })];
  },
});

export const Footnote = Node.create({
  name: 'footnote',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { id: { default: '' }, content: { default: '' } };
  },
  parseHTML() {
    // 比上标标记（同样匹配 <sup>）先解析
    return [{ tag: 'sup[data-type="footnote"]', priority: 60 }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['sup', mergeAttributes(HTMLAttributes, { 'data-type': 'footnote' })];
  },
  renderText() {
    return '';
  },
});

export const WORD_EXTENSIONS = [ParagraphFormat, PageBreak, TableOfContents, Footnote];
