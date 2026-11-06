import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Slot } from './slot';

/**
 * 正文里输入 “@” 弹出成员列表（与斜杠菜单同一套写法，不依赖 @tiptap/suggestion）。
 * 激活时上下 / 回车 / Tab / Esc 交给 bridge.onKeyDown；菜单由 React（MentionMenu）渲染。
 */
export interface MentionState {
  active: boolean;
  /** “@” 所在位置 */
  from: number;
  to: number;
  query: string;
  dismissed: number | null;
}

export interface MentionBridge {
  onKeyDown: Slot<(event: KeyboardEvent) => boolean>;
}

export function createMentionBridge(): MentionBridge {
  return { onKeyDown: new Slot() };
}

export const mentionKey = new PluginKey<MentionState>('richMention');

const INACTIVE: MentionState = { active: false, from: 0, to: 0, query: '', dismissed: null };

/** 光标前的文字是否以 “@查询词” 结尾（@ 在行首或空白、标点之后）。返回查询词或 null。 */
export function matchMention(textBefore: string): string | null {
  const m = /(?:^|[\s，。、；：！？,.;:!?（(\u3000])@([^\s@]{0,20})$/u.exec(textBefore);
  return m ? (m[1] ?? '') : null;
}

function compute(state: EditorState, prev: MentionState, dismiss: boolean): MentionState {
  const sel = state.selection;
  if (!sel.empty) return INACTIVE;
  const $from = sel.$from;
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return INACTIVE;
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
  const query = matchMention(textBefore);
  if (query === null) return INACTIVE;
  const from = sel.from - query.length - 1;
  if (dismiss || prev.dismissed === from) {
    return { active: false, from, to: sel.from, query, dismissed: from };
  }
  return { active: true, from, to: sel.from, query, dismissed: null };
}

export function dismissMention(state: EditorState) {
  return state.tr.setMeta(mentionKey, { dismiss: true });
}

export const MentionSuggest = Extension.create<{ bridge: MentionBridge }>({
  name: 'richMentionSuggest',
  addOptions() {
    return { bridge: createMentionBridge() };
  },
  addProseMirrorPlugins() {
    const { bridge } = this.options;
    const editor = this.editor;
    return [
      new Plugin<MentionState>({
        key: mentionKey,
        state: {
          init: () => INACTIVE,
          apply(tr, prev, _old, next) {
            if (!editor.isEditable) return INACTIVE;
            const meta = tr.getMeta(mentionKey) as { dismiss?: boolean } | undefined;
            if (!tr.docChanged && !tr.selectionSet && !meta) return prev;
            return compute(next, prev, Boolean(meta?.dismiss));
          },
        },
        props: {
          handleKeyDown(view, event) {
            const s = mentionKey.getState(view.state);
            if (!s?.active || event.isComposing) return false;
            return bridge.onKeyDown.get()?.(event) ?? false;
          },
        },
      }),
    ];
  },
});
