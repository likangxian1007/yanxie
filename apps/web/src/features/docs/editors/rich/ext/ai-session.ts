import { Extension, type Editor, type MappablePosition } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { isChangeOrigin } from '@tiptap/extension-collaboration';
import { Slot } from './slot';

/**
 * 内嵌 AI 的编辑器侧状态（不写进 Y.Doc）：
 * - 会话打开时记住目标选区（改写类要替换的范围）和锚点（结果块出现的位置：目标所在顶层块之后），
 *   用 Tiptap 的 MappablePosition 跟踪——别人同时在改（Yjs 远端事务）时也能映射到正确位置；
 * - 锚点处放一个占位 widget（spacer），AI 面板浮在它上面，把后文往下推；
 * - 目标选区加 `rich-ai-target` 底色；插入后的内容加 `rich-ai-flash` 短暂高亮；
 * - 空的顶层段落里按空格 / Mod-J 打开 AI 输入条，会话打开时 Esc 丢弃。
 */
export interface AiBridge {
  /** 占位元素（插件创建；AI 面板按它的位置定位，并把自己的高度写回它） */
  spacer: Slot<HTMLElement>;
  onTrigger: Slot<(source: 'space' | 'shortcut') => void>;
  onEscape: Slot<() => void>;
}

export function createAiBridge(): AiBridge {
  return { spacer: new Slot(), onTrigger: new Slot(), onEscape: new Slot() };
}

interface FlashEntry {
  id: number;
  from: number;
  to: number;
  className: string;
}

export interface AiSessionState {
  open: boolean;
  from: MappablePosition | null;
  to: MappablePosition | null;
  anchor: MappablePosition | null;
  flashes: FlashEntry[];
}

type AiMeta =
  | { type: 'open'; from: number; to: number; anchor: number }
  | { type: 'close'; flash?: FlashEntry }
  | { type: 'flash'; flash: FlashEntry }
  | { type: 'unflash'; id: number };

export const aiSessionKey = new PluginKey<AiSessionState>('richAiSession');

const EMPTY: AiSessionState = { open: false, from: null, to: null, anchor: null, flashes: [] };

/** 结果块的位置：选区末端所在顶层块之后。 */
export function anchorFor(state: EditorState): number {
  const { $to } = state.selection;
  if ($to.depth === 0) return state.selection.to;
  return $to.after(1);
}

export interface AiSessionInfo {
  open: boolean;
  from: number;
  to: number;
  anchor: number;
}

export function readAiSession(state: EditorState): AiSessionInfo {
  const s = aiSessionKey.getState(state) ?? EMPTY;
  return {
    open: s.open,
    from: s.from?.position ?? 0,
    to: s.to?.position ?? 0,
    anchor: s.anchor?.position ?? 0,
  };
}

export function openAiSessionTr(state: EditorState, range: { from: number; to: number }) {
  const meta: AiMeta = { type: 'open', from: range.from, to: range.to, anchor: anchorFor(state) };
  return state.tr.setMeta(aiSessionKey, meta).setMeta('addToHistory', false);
}

let flashSeq = 0;
function nextFlash(from: number, to: number, className: string): FlashEntry {
  flashSeq += 1;
  return { id: flashSeq, from, to, className };
}

/** 关闭会话；可同时登记一段闪烁高亮（插入结果的那个事务里用），返回高亮 id。 */
export function closeAiSessionTr(
  tr: Transaction,
  flash?: { from: number; to: number; className: string },
): number | null {
  const spec = flash ? nextFlash(flash.from, flash.to, flash.className) : undefined;
  tr.setMeta(aiSessionKey, { type: 'close', ...(spec ? { flash: spec } : {}) } satisfies AiMeta);
  return spec?.id ?? null;
}

/** 单独登记一段闪烁高亮（大纲跳转用），返回 id。 */
export function flashTr(tr: Transaction, from: number, to: number, className: string): number {
  const spec = nextFlash(from, to, className);
  tr.setMeta(aiSessionKey, { type: 'flash', flash: spec } satisfies AiMeta);
  return spec.id;
}

export function unflashTr(state: EditorState, id: number) {
  return state.tr.setMeta(aiSessionKey, { type: 'unflash', id } satisfies AiMeta);
}

function clamp(n: number, doc: PMNode) {
  return Math.max(0, Math.min(n, doc.content.size));
}

function flashDecorations(doc: PMNode, entry: FlashEntry, out: Decoration[]) {
  const from = clamp(entry.from, doc);
  const to = clamp(entry.to, doc);
  if (to <= from) return;
  // 完整落在范围里的块整块高亮，其余部分做行内高亮
  doc.nodesBetween(from, to, (node, pos) => {
    const end = pos + node.nodeSize;
    if (pos >= from && end <= to && !node.isInline) {
      out.push(Decoration.node(pos, end, { class: entry.className }));
      return false;
    }
    return true;
  });
  out.push(Decoration.inline(from, to, { class: entry.className }));
}

function isEmptyTopParagraph(state: EditorState): boolean {
  const { selection } = state;
  if (!selection.empty) return false;
  const { $from } = selection;
  return (
    $from.depth === 1 && $from.parent.type.name === 'paragraph' && $from.parent.content.size === 0
  );
}

export const AiSession = Extension.create<{ bridge: AiBridge }>({
  name: 'richAiSession',
  addOptions() {
    return { bridge: createAiBridge() };
  },
  addProseMirrorPlugins() {
    const editor: Editor = this.editor;
    const { bridge } = this.options;
    const map = (p: MappablePosition | null, tr: Transaction) =>
      p ? editor.utils.getUpdatedPosition(p, tr).position : null;
    const make = (pos: number) => editor.utils.createMappablePosition(pos);

    const spacer = () => {
      let el = bridge.spacer.get();
      if (!el) {
        el = document.createElement('div');
        el.className = 'rich-ai-spacer';
        el.contentEditable = 'false';
        el.setAttribute('aria-hidden', 'true');
        bridge.spacer.set(el);
      }
      return el;
    };

    return [
      new Plugin<AiSessionState>({
        key: aiSessionKey,
        state: {
          init: () => EMPTY,
          apply(tr, prev) {
            let next = prev;
            if (tr.docChanged && (prev.open || prev.flashes.length > 0)) {
              next = {
                open: prev.open,
                from: map(prev.from, tr),
                to: map(prev.to, tr),
                anchor: map(prev.anchor, tr),
                // 闪烁只持续 1.2s：本地事务按 mapping 映射；远端（Yjs）事务会整篇替换，直接去掉
                flashes: isChangeOrigin(tr)
                  ? []
                  : prev.flashes.map((f) => ({
                      ...f,
                      from: tr.mapping.map(f.from, -1),
                      to: tr.mapping.map(f.to, 1),
                    })),
              };
            }
            const meta = tr.getMeta(aiSessionKey) as AiMeta | undefined;
            if (!meta) return next;
            switch (meta.type) {
              case 'open':
                return {
                  ...next,
                  open: true,
                  from: make(meta.from),
                  to: make(meta.to),
                  anchor: make(meta.anchor),
                };
              case 'close':
                // flash 与插入在同一个事务里：位置已是插入后的坐标，不需要再映射
                return {
                  open: false,
                  from: null,
                  to: null,
                  anchor: null,
                  flashes: meta.flash ? [...next.flashes, meta.flash] : next.flashes,
                };
              case 'flash':
                return { ...next, flashes: [...next.flashes, meta.flash] };
              case 'unflash':
                return { ...next, flashes: next.flashes.filter((f) => f.id !== meta.id) };
              default:
                return next;
            }
          },
        },
        props: {
          decorations(state) {
            const s = aiSessionKey.getState(state);
            if (!s || (!s.open && s.flashes.length === 0)) return null;
            const doc = state.doc;
            const decos: Decoration[] = [];
            if (s.open && s.anchor) {
              const from = clamp(s.from?.position ?? 0, doc);
              const to = clamp(s.to?.position ?? 0, doc);
              if (to > from) decos.push(Decoration.inline(from, to, { class: 'rich-ai-target' }));
              decos.push(
                Decoration.widget(clamp(s.anchor.position, doc), spacer, {
                  key: 'rich-ai-spacer',
                  side: -1,
                  ignoreSelection: true,
                  stopEvent: () => true,
                }),
              );
            }
            for (const f of s.flashes) flashDecorations(doc, f, decos);
            return DecorationSet.create(doc, decos);
          },
          handleKeyDown(view, event) {
            if (event.isComposing || !editor.isEditable) return false;
            const s = aiSessionKey.getState(view.state);
            if (s?.open) {
              if (event.key === 'Escape') {
                bridge.onEscape.get()?.();
                return true;
              }
              return false;
            }
            const trigger = bridge.onTrigger.get();
            if (!trigger) return false;
            const mod = event.metaKey || event.ctrlKey;
            if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
              trigger('shortcut');
              return true;
            }
            if (
              event.key === ' ' &&
              !mod &&
              !event.altKey &&
              !event.shiftKey &&
              isEmptyTopParagraph(view.state)
            ) {
              trigger('space');
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});
