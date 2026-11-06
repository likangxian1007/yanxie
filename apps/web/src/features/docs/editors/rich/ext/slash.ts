import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Slot } from './slot';

/**
 * 轻量斜杠菜单（没有装 @tiptap/suggestion，自己写一个 ProseMirror 插件）：
 * 段落行首输入 “/” 后激活，记录 “/” 的位置和后面的查询词；菜单本身由 React 渲染（SlashMenu）。
 * 激活时上下 / 回车 / Tab / Esc 交给 bridge.onKeyDown 处理。
 */
export interface SlashState {
  active: boolean;
  /** “/” 所在位置 */
  from: number;
  /** 光标位置（命令执行时删掉 from..to） */
  to: number;
  query: string;
  /** 被 Esc 关掉的触发点（同一个 “/” 不再弹出） */
  dismissed: number | null;
}

export interface SlashBridge {
  onKeyDown: Slot<(event: KeyboardEvent) => boolean>;
}

export function createSlashBridge(): SlashBridge {
  return { onKeyDown: new Slot() };
}

export const slashKey = new PluginKey<SlashState>('richSlash');

const INACTIVE: SlashState = { active: false, from: 0, to: 0, query: '', dismissed: null };

/** 光标前的文字是否构成触发：“/” 在行首，后面最多 24 个非空白字符。返回查询词或 null。 */
export function matchSlash(textBefore: string): string | null {
  const m = /^\/([^\s/]{0,24})$/u.exec(textBefore);
  return m ? (m[1] ?? '') : null;
}

function compute(state: EditorState, prev: SlashState, dismiss: boolean): SlashState {
  const sel = state.selection;
  if (!sel.empty) return INACTIVE;
  const $from = sel.$from;
  if ($from.parent.type.name !== 'paragraph') return INACTIVE;
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
  const query = matchSlash(textBefore);
  if (query === null) return INACTIVE;
  const from = $from.start();
  if (dismiss || prev.dismissed === from) {
    return { active: false, from, to: sel.from, query, dismissed: from };
  }
  return { active: true, from, to: sel.from, query, dismissed: null };
}

export function dismissSlash(state: EditorState) {
  return state.tr.setMeta(slashKey, { dismiss: true });
}

export const SlashCommand = Extension.create<{ bridge: SlashBridge }>({
  name: 'richSlash',
  addOptions() {
    return { bridge: createSlashBridge() };
  },
  addProseMirrorPlugins() {
    const { bridge } = this.options;
    const editor = this.editor;
    return [
      new Plugin<SlashState>({
        key: slashKey,
        state: {
          init: () => INACTIVE,
          apply(tr, prev, _old, next) {
            if (!editor.isEditable) return INACTIVE;
            const meta = tr.getMeta(slashKey) as { dismiss?: boolean } | undefined;
            if (!tr.docChanged && !tr.selectionSet && !meta) return prev;
            return compute(next, prev, Boolean(meta?.dismiss));
          },
        },
        props: {
          handleKeyDown(view, event) {
            const s = slashKey.getState(view.state);
            if (!s?.active || event.isComposing) return false;
            return bridge.onKeyDown.get()?.(event) ?? false;
          },
        },
      }),
    ];
  },
});
