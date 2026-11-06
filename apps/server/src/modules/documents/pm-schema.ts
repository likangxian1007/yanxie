import { getSchema } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics';
import { Color, FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { RICH_CUSTOM_EXTENSIONS } from './pm-nodes';
import { WORD_EXTENSIONS } from './pm-word';

/**
 * 富文本文档（kind = doc）的 ProseMirror schema，与前端 Tiptap 编辑器使用同一组扩展，
 * 服务端据此在 markdown 与 Y.XmlFragment('default') 之间转换并校验结构。
 * 前端编辑器新增节点/标记时，这里要同步加上。
 */
let cached: Schema | null = null;

export function docSchema(): Schema {
  if (cached) return cached;
  cached = getSchema([
    StarterKit.configure({ undoRedo: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: true } }),
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    InlineMath,
    BlockMath,
    TextStyle,
    Color,
    FontFamily,
    FontSize,
    Subscript,
    Superscript,
    ...RICH_CUSTOM_EXTENSIONS,
    ...WORD_EXTENSIONS,
  ]);
  return cached;
}
