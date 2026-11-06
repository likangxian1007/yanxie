import { Extension, type Editor } from '@tiptap/core';
import type { Mark } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';

/**
 * 格式刷（Word 行为）：单击 = 刷一次；双击 = 一直刷，按 Esc 或再点一次按钮退出。
 * 复制光标处的文字格式（全部标记，链接、评论这类除外）和段落格式（对齐、行距、段距、缩进），
 * 下一次在正文里拖选松开鼠标时应用到选区。也有快捷键：Mod-Alt-Shift-c 复制格式，Mod-Alt-Shift-v 粘贴格式（Ctrl+Shift+V 留给浏览器的“粘贴为纯文本”）。
 */
const SKIP_MARKS = new Set(['link', 'code']);
const BLOCK_ATTRS = [
  'textAlign',
  'lineHeight',
  'spaceBefore',
  'spaceAfter',
  'textIndent',
  'indent',
];

export interface CopiedFormat {
  marks: Mark[];
  block: Record<string, unknown> | null;
}

interface PainterStorage {
  copied: CopiedFormat | null;
  /** 刷子是否拿在手上 */
  active: boolean;
  sticky: boolean;
  listeners: Set<() => void>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    formatPainter: {
      /** 拿起格式刷（sticky = 连续刷） */
      pickFormat: (sticky?: boolean) => ReturnType;
      dropFormat: () => ReturnType;
      /** 把复制的格式应用到当前选区 */
      pasteFormat: () => ReturnType;
    };
  }
}

export function copyFormat(state: EditorState): CopiedFormat {
  const { $from, empty } = state.selection;
  const marks = (
    empty
      ? (state.storedMarks ?? $from.marks())
      : state.doc.resolve(Math.min($from.pos + 1, state.selection.to)).marks()
  ).filter((m) => !SKIP_MARKS.has(m.type.name) && !m.type.name.startsWith('comment'));
  const parent = $from.parent;
  const block = parent.isTextblock
    ? Object.fromEntries(
        BLOCK_ATTRS.filter((k) => k in parent.attrs).map((k) => [k, parent.attrs[k]]),
      )
    : null;
  return { marks, block };
}

export function applyFormat(state: EditorState, format: CopiedFormat): Transaction | null {
  const { from, to, empty } = state.selection;
  const tr = state.tr;
  if (!empty) {
    for (const type of Object.values(state.schema.marks)) {
      if (SKIP_MARKS.has(type.name) || type.name.startsWith('comment')) continue;
      tr.removeMark(from, to, type);
    }
    for (const mark of format.marks) tr.addMark(from, to, mark);
  } else {
    tr.setStoredMarks(format.marks);
  }
  if (format.block) {
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) return true;
      const next = { ...node.attrs };
      for (const [k, v] of Object.entries(format.block!)) if (k in next) next[k] = v;
      tr.setNodeMarkup(pos, undefined, next);
      return false;
    });
  }
  return tr.docChanged || tr.storedMarksSet ? tr : null;
}

const key = new PluginKey('richFormatPainter');

function notify(storage: PainterStorage, editor: Editor) {
  editor.view.dom.classList.toggle('rich-painter-active', storage.active);
  for (const l of storage.listeners) l();
}

export const FormatPainter = Extension.create<Record<string, never>, PainterStorage>({
  name: 'formatPainter',
  addStorage() {
    return { copied: null, active: false, sticky: false, listeners: new Set() };
  },
  addCommands() {
    return {
      pickFormat:
        (sticky = false) =>
        ({ state }) => {
          this.storage.copied = copyFormat(state);
          this.storage.active = true;
          this.storage.sticky = sticky;
          notify(this.storage, this.editor);
          return true;
        },
      dropFormat: () => () => {
        this.storage.active = false;
        this.storage.sticky = false;
        notify(this.storage, this.editor);
        return true;
      },
      pasteFormat:
        () =>
        ({ state, dispatch }) => {
          const copied = this.storage.copied;
          if (!copied) return false;
          const tr = applyFormat(state, copied);
          if (!tr) return false;
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Alt-Shift-c': () => {
        this.storage.copied = copyFormat(this.editor.state);
        return true;
      },
      'Mod-Alt-Shift-v': () => this.editor.commands.pasteFormat(),
      Escape: () => {
        if (!this.storage.active) return false;
        return this.editor.commands.dropFormat();
      },
    };
  },
  addProseMirrorPlugins() {
    const storage = this.storage;
    const editor = this.editor;
    return [
      new Plugin({
        key,
        props: {
          handleDOMEvents: {
            mouseup: () => {
              if (!storage.active) return false;
              // 等 ProseMirror 根据这次拖选更新完选区
              window.setTimeout(() => {
                if (editor.isDestroyed || !storage.active || editor.state.selection.empty) return;
                editor.commands.pasteFormat();
                if (!storage.sticky) editor.commands.dropFormat();
              }, 0);
              return false;
            },
          },
        },
      }),
    ];
  },
});

/** 给工具栏订阅格式刷状态 */
export function subscribePainter(editor: Editor, fn: () => void): () => void {
  const storage = (editor.storage as unknown as { formatPainter?: PainterStorage }).formatPainter;
  if (!storage) return () => {};
  storage.listeners.add(fn);
  return () => storage.listeners.delete(fn);
}

export function painterState(editor: Editor): { active: boolean; sticky: boolean } {
  const storage = (editor.storage as unknown as { formatPainter?: PainterStorage }).formatPainter;
  return { active: !!storage?.active, sticky: !!storage?.sticky };
}
