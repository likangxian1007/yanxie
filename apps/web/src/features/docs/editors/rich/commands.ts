import type { Editor } from '@tiptap/core';
import type { DocumentAiAction } from '@srh/shared';
import type { SlashItemId } from './lib/slash-items';
import { normalizeHref } from './lib/text';
import type { EmbedKind } from './embed/DocPicker';
import { insertBlockAt } from './media/upload-plugin';
import { tr } from '@/lib/i18n';

/** 工具栏与斜杠菜单共用的编辑命令。 */
export type BlockStyle = 'paragraph' | 'h1' | 'h2' | 'h3';

export const BLOCK_STYLE_LABEL: Record<BlockStyle, string> = {
  paragraph: tr('正文'),
  h1: tr('标题 1'),
  h2: tr('标题 2'),
  h3: tr('标题 3'),
};

export const BLOCK_STYLE_SHORTCUT: Record<BlockStyle, string> = {
  paragraph: 'Mod-Alt-0',
  h1: 'Mod-Alt-1',
  h2: 'Mod-Alt-2',
  h3: 'Mod-Alt-3',
};

export function currentBlockStyle(editor: Editor): BlockStyle {
  for (const level of [1, 2, 3] as const) {
    if (editor.isActive('heading', { level })) return `h${level}`;
  }
  return 'paragraph';
}

export function setBlockStyle(editor: Editor, style: BlockStyle) {
  const chain = editor.chain().focus();
  if (style === 'paragraph') chain.setParagraph().run();
  else chain.setHeading({ level: Number(style.slice(1)) as 1 | 2 | 3 }).run();
}

/** 把当前选区设为链接；选区为空时插入链接文字本身。返回是否成功。 */
export function applyLink(editor: Editor, input: string): boolean {
  const href = normalizeHref(input);
  if (!href) return false;
  const { empty } = editor.state.selection;
  if (empty && !editor.isActive('link')) {
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'text',
        text: input.trim(),
        marks: [{ type: 'link', attrs: { href } }],
      })
      .run();
  } else {
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  }
  return true;
}

export function removeLink(editor: Editor) {
  editor.chain().focus().extendMarkRange('link').unsetLink().run();
}

export function insertTable(editor: Editor) {
  editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
}

export interface SlashContext {
  openMath: (kind: 'inline' | 'block') => void;
  startAi: (action: DocumentAiAction) => void;
  /** 选文件上传（图片 / 附件） */
  pickMedia: (kind: 'image' | 'attachment') => void;
  /** 打开“嵌入文档”选择框；createFirst = 直接新建 */
  openEmbed: (kind: EmbedKind, createFirst?: boolean) => void;
}

/** 在光标处插入内嵌文档块（光标在空段落里时替换掉这个段落） */
export function insertEmbed(
  editor: Editor,
  doc: { id: string; kind: EmbedKind; title: string },
  pos = editor.state.selection.from,
) {
  insertBlockAt(editor, pos, {
    type: 'docEmbed',
    attrs: { docId: doc.id, kind: doc.kind, title: doc.title },
  });
  editor.commands.focus();
}

/** 执行斜杠命令：先删掉 “/查询词”，再执行。 */
export function runSlashItem(
  editor: Editor,
  id: SlashItemId,
  range: { from: number; to: number },
  ctx: SlashContext,
) {
  const chain = editor.chain().focus().deleteRange(range);
  switch (id) {
    case 'paragraph':
      chain.setParagraph().run();
      return;
    case 'h1':
    case 'h2':
    case 'h3':
      chain.setHeading({ level: Number(id.slice(1)) as 1 | 2 | 3 }).run();
      return;
    case 'bulletList':
      chain.toggleBulletList().run();
      return;
    case 'orderedList':
      chain.toggleOrderedList().run();
      return;
    case 'taskList':
      chain.toggleTaskList().run();
      return;
    case 'blockquote':
      chain.toggleBlockquote().run();
      return;
    case 'codeBlock':
      chain.toggleCodeBlock().run();
      return;
    case 'table':
      chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
      return;
    case 'divider':
      chain.setHorizontalRule().run();
      return;
    case 'blockMath':
    case 'inlineMath':
      chain.run();
      ctx.openMath(id === 'blockMath' ? 'block' : 'inline');
      return;
    case 'image':
    case 'attachment':
      chain.run();
      ctx.pickMedia(id);
      return;
    case 'mention':
      // 插入 “@”，由提及菜单接着选人
      chain.insertContent('@').run();
      return;
    case 'embedSheet':
    case 'embedSlides':
    case 'embedDoc':
      chain.run();
      ctx.openEmbed(id === 'embedSheet' ? 'sheet' : id === 'embedSlides' ? 'slides' : 'doc');
      return;
    case 'newSheet':
      chain.run();
      ctx.openEmbed('sheet', true);
      return;
    case 'aiContinue':
    case 'aiOutline':
    case 'aiSummarize':
      chain.run();
      ctx.startAi(id === 'aiContinue' ? 'continue' : id === 'aiOutline' ? 'outline' : 'summarize');
      return;
  }
}
