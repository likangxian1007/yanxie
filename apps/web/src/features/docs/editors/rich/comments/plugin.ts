import { Extension } from '@tiptap/core';
import { isChangeOrigin } from '@tiptap/extension-collaboration';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { DocCommentAnchor } from '@srh/shared';
import { Slot } from '../ext/slot';
import { resolveAnchor, type AnchorRange } from './anchor';

/**
 * 评论高亮：侧栏把“要高亮的评论串锚点”交给插件，插件算出区间并画下划线底色。
 * - 远端（Yjs）修改会整篇替换 ProseMirror 文档，这时按 Y 相对位置重新解析；
 * - 本地修改按事务 mapping 映射（更快，且和光标行为一致）。
 * 点高亮处 → bridge.onClick(评论 id)，侧栏打开并定位到那串评论。
 */
export interface CommentAnchorItem {
  id: string;
  anchor: DocCommentAnchor | null;
}

export interface CommentPluginState {
  items: CommentAnchorItem[];
  ranges: ReadonlyMap<string, AnchorRange | null>;
  active: string | null;
}

export type CommentMeta =
  { type: 'set'; items: CommentAnchorItem[] } | { type: 'active'; id: string | null };

/** 新建评论时的临时锚点 id */
export const PENDING_COMMENT_ID = '__pending__';

export const commentKey = new PluginKey<CommentPluginState>('richComments');

export interface CommentBridge {
  onClick: Slot<(id: string) => void>;
}

export function createCommentBridge(): CommentBridge {
  return { onClick: new Slot() };
}

function resolveAll(state: EditorState, items: CommentAnchorItem[]) {
  const ranges = new Map<string, AnchorRange | null>();
  for (const it of items) ranges.set(it.id, resolveAnchor(state, it.anchor));
  return ranges;
}

function mapAll(tr: Transaction, prev: ReadonlyMap<string, AnchorRange | null>) {
  const ranges = new Map<string, AnchorRange | null>();
  for (const [id, r] of prev) {
    if (!r) {
      ranges.set(id, null);
      continue;
    }
    const from = tr.mapping.map(r.from, 1);
    const to = tr.mapping.map(r.to, -1);
    ranges.set(id, to > from ? { from, to } : null);
  }
  return ranges;
}

export function setCommentAnchors(state: EditorState, items: CommentAnchorItem[]) {
  return state.tr.setMeta(commentKey, { type: 'set', items } satisfies CommentMeta);
}

export function setActiveComment(state: EditorState, id: string | null) {
  return state.tr.setMeta(commentKey, { type: 'active', id } satisfies CommentMeta);
}

/** pos 处（最内层）的评论 id */
export function commentAt(state: EditorState, pos: number): string | null {
  const s = commentKey.getState(state);
  if (!s) return null;
  let best: { id: string; len: number } | null = null;
  for (const [id, r] of s.ranges) {
    if (!r || id === PENDING_COMMENT_ID || pos < r.from || pos > r.to) continue;
    const len = r.to - r.from;
    if (!best || len < best.len) best = { id, len };
  }
  return best?.id ?? null;
}

export const CommentHighlights = Extension.create<{ bridge: CommentBridge }>({
  name: 'richComments',
  addOptions() {
    return { bridge: createCommentBridge() };
  },
  addProseMirrorPlugins() {
    const { bridge } = this.options;
    return [
      new Plugin<CommentPluginState>({
        key: commentKey,
        state: {
          init: () => ({ items: [], ranges: new Map(), active: null }),
          apply(tr, prev, _old, next) {
            const meta = tr.getMeta(commentKey) as CommentMeta | undefined;
            let s = prev;
            if (tr.docChanged && prev.items.length) {
              s = {
                ...s,
                ranges: isChangeOrigin(tr) ? resolveAll(next, s.items) : mapAll(tr, s.ranges),
              };
            }
            if (meta?.type === 'set') {
              s = { ...s, items: meta.items, ranges: resolveAll(next, meta.items) };
            } else if (meta?.type === 'active') {
              s = { ...s, active: meta.id };
            }
            return s;
          },
        },
        props: {
          decorations(state) {
            const s = commentKey.getState(state);
            if (!s || s.ranges.size === 0) return null;
            const decos: Decoration[] = [];
            for (const [id, r] of s.ranges) {
              if (!r) continue;
              const cls = [
                'rich-comment',
                id === PENDING_COMMENT_ID && 'rich-comment-pending',
                id === s.active && 'rich-comment-active',
              ]
                .filter(Boolean)
                .join(' ');
              decos.push(Decoration.inline(r.from, r.to, { class: cls, 'data-comment-id': id }));
            }
            return DecorationSet.create(state.doc, decos);
          },
          handleClick(view, pos) {
            const id = commentAt(view.state, pos);
            if (id) bridge.onClick.get()?.(id);
            return false;
          },
        },
      }),
    ];
  },
});
