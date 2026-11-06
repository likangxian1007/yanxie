import { Extension, Node, mergeAttributes, type CommandProps } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { normalizeColor, stepFontSize } from './format';
import { tr } from '@/lib/i18n';

/**
 * Word 式排版扩展（schema 部分）：段落格式、分页符、目录、脚注、单元格底色、列表编号样式。
 * 名字、属性必须与服务端 `apps/server/src/modules/documents/pm-word.ts` 一致（两边测试对照 WORD_SCHEMA）。
 */
export const WORD_SCHEMA = {
  /** 段落 / 标题上的格式属性 */
  paragraphAttrs: ['lineHeight', 'spaceBefore', 'spaceAfter', 'textIndent', 'indent'],
  /** 有序 / 无序列表 */
  listAttrs: ['listStyle'],
  /** 单元格 / 表头 */
  cellAttrs: ['backgroundColor'],
  nodes: {
    pageBreak: [] as string[],
    tableOfContents: ['maxLevel'],
    footnote: ['id', 'content'],
  },
} as const;

export const MAX_INDENT = 10;
/** 每级缩进 2 个字符宽 */
export const INDENT_EM = 2;

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** CSS 长度 → 磅（段距用） */
function cssToPt(v: string): number | null {
  const m = /^(-?[\d.]+)(pt|px|em|rem)?$/u.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? 'px';
  if (unit === 'pt') return n;
  if (unit === 'px') return Math.round(n * 0.75 * 2) / 2;
  return Math.round(n * 11 * 2) / 2;
}

/** CSS 长度 → 字符（首行缩进用，1 字符 = 1em） */
function cssToEm(v: string): number | null {
  const m = /^(-?[\d.]+)(pt|px|em|rem)?$/u.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? 'px';
  const em = unit === 'em' || unit === 'rem' ? n : unit === 'pt' ? n / 11 : n / 15;
  return Math.round(em * 4) / 4;
}

export const ParagraphFormat = Extension.create({
  name: 'wordParagraphFormat',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (el) => {
              const v = el.style.lineHeight;
              if (!v || v === 'normal') return null;
              return /^[\d.]+$/u.test(v) ? v : null;
            },
            renderHTML: (a) => (a.lineHeight ? { style: `line-height: ${a.lineHeight}` } : {}),
          },
          spaceBefore: {
            default: null,
            parseHTML: (el) => (el.style.marginTop ? cssToPt(el.style.marginTop) : null),
            renderHTML: (a) =>
              num(a.spaceBefore) !== null ? { style: `margin-top: ${num(a.spaceBefore)}pt` } : {},
          },
          spaceAfter: {
            default: null,
            parseHTML: (el) => (el.style.marginBottom ? cssToPt(el.style.marginBottom) : null),
            renderHTML: (a) =>
              num(a.spaceAfter) !== null ? { style: `margin-bottom: ${num(a.spaceAfter)}pt` } : {},
          },
          textIndent: {
            default: null,
            parseHTML: (el) => {
              const v = el.style.textIndent;
              const em = v ? cssToEm(v) : null;
              return em ? em : null;
            },
            renderHTML: (a) =>
              num(a.textIndent) ? { style: `text-indent: ${num(a.textIndent)}em` } : {},
          },
          indent: {
            default: 0,
            parseHTML: (el) => {
              const data = el.getAttribute('data-indent');
              if (data) return Math.min(MAX_INDENT, Math.max(0, parseInt(data, 10) || 0));
              const ml = el.style.marginLeft;
              const em = ml ? cssToEm(ml) : null;
              return em && em > 0 ? Math.min(MAX_INDENT, Math.round(em / INDENT_EM)) : 0;
            },
            renderHTML: (a) => {
              const n = num(a.indent) ?? 0;
              return n > 0
                ? { 'data-indent': String(n), style: `margin-left: ${n * INDENT_EM}em` }
                : {};
            },
          },
        },
      },
      {
        types: ['orderedList', 'bulletList'],
        attributes: {
          listStyle: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-list-style') || null,
            renderHTML: (a) =>
              a.listStyle
                ? {
                    'data-list-style': String(a.listStyle),
                    style: `list-style-type: ${listStyleCss(String(a.listStyle))}`,
                  }
                : {},
          },
        },
      },
      {
        types: ['tableCell', 'tableHeader'],
        attributes: {
          backgroundColor: {
            default: null,
            parseHTML: (el) =>
              normalizeColor(el.getAttribute('data-background') || el.style.backgroundColor),
            renderHTML: (a) =>
              a.backgroundColor
                ? {
                    'data-background': String(a.backgroundColor),
                    style: `background-color: ${String(a.backgroundColor)}`,
                  }
                : {},
          },
        },
      },
    ];
  },
});

/** 列表编号样式：存的值 → CSS list-style-type */
export const LIST_STYLES = {
  decimal: { label: '1. 2. 3.', css: 'decimal', ordered: true },
  'decimal-leading-zero': { label: '01. 02. 03.', css: 'decimal-leading-zero', ordered: true },
  'lower-alpha': { label: 'a. b. c.', css: 'lower-alpha', ordered: true },
  'upper-alpha': { label: 'A. B. C.', css: 'upper-alpha', ordered: true },
  'lower-roman': { label: 'i. ii. iii.', css: 'lower-roman', ordered: true },
  'upper-roman': { label: 'I. II. III.', css: 'upper-roman', ordered: true },
  'cjk-ideographic': { label: tr('一、二、三、'), css: 'cjk-ideographic', ordered: true },
  disc: { label: tr('● 实心圆'), css: 'disc', ordered: false },
  circle: { label: tr('○ 空心圆'), css: 'circle', ordered: false },
  square: { label: tr('■ 方块'), css: 'square', ordered: false },
} as const;
export type ListStyle = keyof typeof LIST_STYLES;

function listStyleCss(v: string): string {
  return (LIST_STYLES as Record<string, { css: string }>)[v]?.css ?? 'decimal';
}

// ---------------------------------------------------------------- 节点

export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  parseHTML() {
    return [{ tag: 'div[data-type="page-break"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'page-break',
        class: 'rich-page-break',
        contenteditable: 'false',
      }),
    ];
  },
});

export const TableOfContents = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      maxLevel: {
        default: 3,
        parseHTML: (el) => Number(el.getAttribute('data-max-level')) || 3,
        renderHTML: (a) => ({ 'data-max-level': String(a.maxLevel ?? 3) }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'nav[data-type="toc"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['nav', mergeAttributes(HTMLAttributes, { 'data-type': 'toc', class: 'rich-toc' })];
  },
});

export const Footnote = Node.create({
  name: 'footnote',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      id: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-id') ?? '',
        renderHTML: (a) => ({ 'data-id': String(a.id ?? '') }),
      },
      content: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-content') ?? '',
        renderHTML: (a) => ({ 'data-content': String(a.content ?? '') }),
      },
    };
  },
  parseHTML() {
    // 比上标标记（同样匹配 <sup>）先解析
    return [{ tag: 'sup[data-type="footnote"]', priority: 60 }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'sup',
      mergeAttributes(HTMLAttributes, { 'data-type': 'footnote', class: 'rich-footnote' }),
    ];
  },
  renderText() {
    return '';
  },
});

// ---------------------------------------------------------------- 命令

export interface ParagraphSpacing {
  before?: number | null;
  after?: number | null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    wordFormat: {
      /** 行距（倍数，如 '1.5'；null = 默认） */
      setLineHeight: (value: string | null) => ReturnType;
      /** 段前 / 段后（磅） */
      setParagraphSpacing: (spacing: ParagraphSpacing) => ReturnType;
      /** 首行缩进（字符；负数为悬挂缩进；null 清除） */
      setTextIndent: (em: number | null) => ReturnType;
      /** 增加 / 减少缩进：列表里是升降级，其他段落改左缩进 */
      indentBlock: () => ReturnType;
      outdentBlock: () => ReturnType;
      setListStyle: (style: ListStyle | null) => ReturnType;
      setCellBackground: (color: string | null) => ReturnType;
      /** 插入分页符 */
      setPageBreak: () => ReturnType;
      insertTableOfContents: () => ReturnType;
      insertFootnote: (content?: string) => ReturnType;
      /** 清除格式：去掉所有文字标记和段落格式（标题保留级别） */
      clearFormatting: () => ReturnType;
    };
  }
}

const TEXTBLOCKS = new Set(['paragraph', 'heading']);

function updateTextblocks(
  { state, tr, dispatch }: CommandProps,
  fn: (node: PMNode) => Record<string, unknown> | null,
): boolean {
  const { from, to } = state.selection;
  let changed = false;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!TEXTBLOCKS.has(node.type.name)) return true;
    const next = fn(node);
    if (next) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...next });
      changed = true;
    }
    return false;
  });
  if (changed && dispatch) dispatch(tr);
  return changed;
}

function inList(props: CommandProps): boolean {
  const { $from } = props.state.selection;
  for (let d = $from.depth; d > 0; d -= 1) {
    const name = $from.node(d).type.name;
    if (name === 'listItem' || name === 'taskItem') return true;
  }
  return false;
}

/** 刚插入、需要自动打开编辑框的脚注 id（脚注节点视图挂载时读一次） */
export const footnoteToOpen = { id: null as string | null };

function newId(): string {
  return `fn${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const WordCommands = Extension.create({
  name: 'wordCommands',
  // 比 StarterKit 的硬换行（也绑了 Mod-Enter）先处理：Ctrl+Enter 和 Word 一样是分页符
  priority: 110,
  addCommands() {
    return {
      setLineHeight: (value) => (props) =>
        updateTextblocks(props, () => ({ lineHeight: value || null })),
      setParagraphSpacing: (spacing) => (props) =>
        updateTextblocks(props, () => ({
          ...(spacing.before !== undefined ? { spaceBefore: spacing.before } : {}),
          ...(spacing.after !== undefined ? { spaceAfter: spacing.after } : {}),
        })),
      setTextIndent: (em) => (props) => updateTextblocks(props, () => ({ textIndent: em || null })),
      indentBlock: () => (props) => {
        if (inList(props)) {
          return props.commands.sinkListItem('listItem') || props.commands.sinkListItem('taskItem');
        }
        return updateTextblocks(props, (n) =>
          (Number(n.attrs.indent) || 0) < MAX_INDENT
            ? { indent: (Number(n.attrs.indent) || 0) + 1 }
            : null,
        );
      },
      outdentBlock: () => (props) => {
        if (inList(props)) {
          return props.commands.liftListItem('listItem') || props.commands.liftListItem('taskItem');
        }
        return updateTextblocks(props, (n) =>
          (Number(n.attrs.indent) || 0) > 0 ? { indent: (Number(n.attrs.indent) || 0) - 1 } : null,
        );
      },
      setListStyle:
        (style) =>
        ({ state, tr, dispatch, commands }) => {
          const ordered = style ? LIST_STYLES[style].ordered : null;
          const want = ordered === null ? null : ordered ? 'orderedList' : 'bulletList';
          const { $from } = state.selection;
          let depth = -1;
          for (let d = $from.depth; d > 0; d -= 1) {
            const n = $from.node(d).type.name;
            if (n === 'orderedList' || n === 'bulletList') {
              depth = d;
              break;
            }
          }
          if (depth < 0) {
            if (!want) return false;
            const ok =
              want === 'orderedList' ? commands.toggleOrderedList() : commands.toggleBulletList();
            if (!ok) return false;
            return commands.setListStyle(style);
          }
          const list = $from.node(depth);
          const pos = $from.before(depth);
          const type = want ? state.schema.nodes[want]! : list.type;
          if (dispatch) {
            tr.setNodeMarkup(pos, type, { ...list.attrs, listStyle: style });
            dispatch(tr);
          }
          return true;
        },
      setCellBackground:
        (color) =>
        ({ commands }) =>
          commands.setCellAttribute('backgroundColor', color ? normalizeColor(color) : null),
      setPageBreak:
        () =>
        ({ chain, state }) => {
          const { $to } = state.selection;
          const atEnd = $to.after(1) >= state.doc.content.size;
          return chain()
            .insertContent(
              atEnd ? [{ type: 'pageBreak' }, { type: 'paragraph' }] : [{ type: 'pageBreak' }],
            )
            .run();
        },
      insertTableOfContents:
        () =>
        ({ chain }) =>
          chain()
            .insertContent([
              { type: 'tableOfContents', attrs: { maxLevel: 3 } },
              { type: 'paragraph' },
            ])
            .run(),
      insertFootnote:
        (content = '') =>
        ({ state, tr, dispatch }) => {
          const type = state.schema.nodes.footnote;
          if (!type) return false;
          const node = type.create({ id: newId(), content });
          const pos = state.selection.to;
          if (dispatch) {
            if (!content) footnoteToOpen.id = String(node.attrs.id);
            tr.insert(pos, node);
            tr.setSelection(TextSelection.create(tr.doc, pos + node.nodeSize));
            dispatch(tr);
          }
          return true;
        },
      clearFormatting:
        () =>
        ({ chain }) =>
          chain()
            .unsetAllMarks()
            .command((props) => {
              updateTextblocks(props, () => ({
                lineHeight: null,
                spaceBefore: null,
                spaceAfter: null,
                textIndent: null,
                indent: 0,
                textAlign: null,
              }));
              return true;
            })
            .run(),
    };
  },
  addKeyboardShortcuts() {
    const atBlockStart = () => {
      const { selection } = this.editor.state;
      return selection.empty && selection.$from.parentOffset === 0;
    };
    const inCodeOrTable = () => this.editor.isActive('codeBlock') || this.editor.isActive('table');
    const stepSize = (dir: 1 | -1) => {
      const cur = this.editor.getAttributes('textStyle').fontSize as string | undefined;
      return this.editor.chain().focus().setFontSize(stepFontSize(cur, dir)).run();
    };
    return {
      'Mod-Shift-.': () => stepSize(1),
      'Mod-Shift-,': () => stepSize(-1),
      'Mod-Enter': () => this.editor.commands.setPageBreak(),
      'Mod-]': () => this.editor.commands.indentBlock(),
      'Mod-[': () => this.editor.commands.outdentBlock(),
      'Mod-\\': () => this.editor.commands.clearFormatting(),
      'Mod-Alt-f': () => this.editor.commands.insertFootnote(),
      // 段首 Tab 增加缩进（列表、表格、代码块里交给它们自己处理）
      Tab: () => {
        if (inCodeOrTable() || this.editor.isActive('listItem') || this.editor.isActive('taskItem'))
          return false;
        if (!atBlockStart()) return false;
        return this.editor.commands.indentBlock();
      },
      'Shift-Tab': () => {
        if (inCodeOrTable() || this.editor.isActive('listItem') || this.editor.isActive('taskItem'))
          return false;
        return this.editor.commands.outdentBlock();
      },
      // 段首退格先减缩进
      Backspace: () => {
        if (!atBlockStart()) return false;
        const node = this.editor.state.selection.$from.parent;
        if (!TEXTBLOCKS.has(node.type.name)) return false;
        if ((Number(node.attrs.indent) || 0) > 0) return this.editor.commands.outdentBlock();
        return false;
      },
    };
  },
});
