import type { AnyExtension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics';
import { Color, FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { RICH_CUSTOM_EXTENSIONS } from './nodes';
import { TocNodeView } from './nodes/TocView';
import { FootnoteNodeView } from './nodes/FootnoteView';
import { Footnote, PageBreak, ParagraphFormat, TableOfContents, WordCommands } from './word/schema';

/**
 * 富文本文档的“内容型”扩展（产生节点 / 标记的那一组）。
 *
 * 必须与服务端 `apps/server/src/modules/documents/pm-schema.ts` 的 `docSchema()` 完全一致：
 * 服务端按同一套 schema 在 markdown 与 Y.XmlFragment('default') 之间转换，
 * 前端多一个节点（例如 image）或少一个，agent 写入 / 服务端转换时都会丢内容。
 *
 * 这里传入的选项只影响编辑行为（点击公式、链接是否点开、拖放光标颜色等），不改变 schema。
 * 不产生节点的扩展（Collaboration、CollaborationCaret、Placeholder、CharacterCount、
 * 斜杠菜单、AI 会话）在 RichTextEditor 里另外加。
 */
export interface ContentExtensionOptions {
  /** 点击公式（编辑 latex）。只在可编辑时由调用方处理。 */
  onMathClick?: (node: PMNode, pos: number, kind: 'inline' | 'block') => void;
}

/** 节点名（Tiptap v3 默认名），供测试与服务端对照。 */
export const CONTENT_NODE_NAMES = [
  'doc',
  'paragraph',
  'text',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'hardBreak',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'inlineMath',
  'blockMath',
  // 自定义节点（nodes/index.ts，服务端 pm-nodes.ts）
  'image',
  'fileAttachment',
  'docEmbed',
  'mention',
  // Word 式排版（word/schema.ts，服务端 pm-word.ts）
  'pageBreak',
  'tableOfContents',
  'footnote',
] as const;

/** 标记名（Tiptap v3 默认名）。 */
export const CONTENT_MARK_NAMES = [
  'bold',
  'italic',
  'strike',
  'code',
  'link',
  'underline',
  'highlight',
  'textStyle',
  'subscript',
  'superscript',
] as const;

const KATEX_OPTIONS = { throwOnError: false, strict: false } as const;

export function contentExtensions(options: ContentExtensionOptions = {}): AnyExtension[] {
  const { onMathClick } = options;
  return [
    StarterKit.configure({
      // 协同文档用 Yjs 的撤销（@tiptap/extension-collaboration 自带 undo/redo）
      undoRedo: false,
      // 不自动在文末补段落：多人同时打开一篇以表格结尾的文档时会各补一个空段落
      trailingNode: false,
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      dropcursor: { color: 'var(--accent)', width: 2 },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: true, cellMinWidth: 64 } }),
    // 多色高亮（color 为空时用主题的默认高亮色）
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    // 字体、字号、文字颜色都记在 textStyle 标记上
    TextStyle,
    Color,
    FontFamily,
    FontSize,
    Subscript,
    Superscript,
    ParagraphFormat,
    PageBreak,
    TableOfContents.extend({ addNodeView: () => TocNodeView }),
    Footnote.extend({ addNodeView: () => FootnoteNodeView }),
    WordCommands,
    InlineMath.configure({
      katexOptions: KATEX_OPTIONS,
      ...(onMathClick
        ? { onClick: (node: PMNode, pos: number) => onMathClick(node, pos, 'inline') }
        : {}),
    }),
    BlockMath.configure({
      katexOptions: { ...KATEX_OPTIONS, displayMode: true },
      ...(onMathClick
        ? { onClick: (node: PMNode, pos: number) => onMathClick(node, pos, 'block') }
        : {}),
    }),
    ...RICH_CUSTOM_EXTENSIONS,
  ];
}
