import { Extension, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import { ySyncPlugin, yCursorPlugin } from '@tiptap/y-tiptap';
import type { Plugin } from '@tiptap/pm/state';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { cssFont } from '../model/themes';
import { peerColor, isAgentUser } from '../../rich/ext/caret';
import { tr } from '@/lib/i18n';

/**
 * 文本框的 Tiptap 扩展。节点 / 标记集合与 model/richtext.ts 一致（服务端 documents/slides.ts 也按这个写）。
 * textStyle 的属性（颜色、字号、字体、底色）和段落行距自己声明，解析 HTML 时把浏览器给的 rgb() 转回 #hex，
 * 导入 PPTX（pptxtojson 输出 HTML）也走这里。
 */

function toHex(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  if (/^#[0-9a-f]{3,8}$/iu.test(s)) return s.toUpperCase();
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?\s*\)$/iu.exec(s);
  if (!m) return s;
  if (m[4] !== undefined && Number(m[4]) === 0) return null;
  return `#${[m[1], m[2], m[3]]
    .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase();
}

function firstFamily(v: string): string | null {
  const first = v.split(',')[0]?.replace(/["']/gu, '').trim();
  return first || null;
}

const SlideTextAttrs = Extension.create({
  name: 'slideTextAttrs',
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          color: {
            default: null,
            parseHTML: (el) => toHex(el.style.color),
            renderHTML: (a) => (a.color ? { style: `color: ${a.color}` } : {}),
          },
          backgroundColor: {
            default: null,
            parseHTML: (el) => toHex(el.style.backgroundColor),
            renderHTML: (a) =>
              a.backgroundColor ? { style: `background-color: ${a.backgroundColor}` } : {},
          },
          fontSize: {
            default: null,
            parseHTML: (el) => el.style.fontSize || null,
            renderHTML: (a) => (a.fontSize ? { style: `font-size: ${a.fontSize}` } : {}),
          },
          fontFamily: {
            default: null,
            parseHTML: (el) => firstFamily(el.style.fontFamily),
            renderHTML: (a) =>
              a.fontFamily ? { style: `font-family: ${cssFont(String(a.fontFamily))}` } : {},
          },
        },
      },
      {
        types: ['paragraph'],
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (el) => {
              const v = el.style.lineHeight;
              if (!v || v === 'normal') return null;
              const n = Number(v);
              return Number.isFinite(n) ? n : null;
            },
            renderHTML: (a) => (a.lineHeight ? { style: `line-height: ${a.lineHeight}` } : {}),
          },
        },
      },
    ];
  },
});

/** 内容扩展（产生节点 / 标记的那组），导入时 generateJSON 也用它 */
export function slideTextExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      undoRedo: false,
      trailingNode: false,
      heading: false,
      blockquote: false,
      codeBlock: false,
      horizontalRule: false,
      dropcursor: false,
      gapcursor: false,
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
    }),
    TextStyle,
    SlideTextAttrs,
    TextAlign.configure({ types: ['paragraph'] }),
  ];
}

type AwarenessUser = Record<string, unknown>;

function caret(user: AwarenessUser): HTMLElement {
  const el = document.createElement('span');
  el.className = isAgentUser(user) ? 'sl-caret sl-caret--agent' : 'sl-caret';
  el.style.setProperty('--peer-color', peerColor(user));
  el.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'sl-caret__label';
  label.textContent = String(user.name ?? tr('协作者'));
  el.appendChild(label);
  return el;
}

export interface SlidesCollabOptions {
  fragment: Y.XmlFragment | null;
  awareness: Awareness | null;
  onUndo: () => void;
  onRedo: () => void;
}

/**
 * 文本框与 Y.XmlFragment 的绑定 + 协作者光标。撤销交给整份幻灯片共用的 Y.UndoManager
 * （它追踪 ySyncPluginKey），所以 Ctrl+Z 在文本框里和在画布上是同一个撤销栈。
 */
export const SlidesCollab = Extension.create<SlidesCollabOptions>({
  name: 'slidesCollab',
  priority: 1000,
  addOptions() {
    return { fragment: null, awareness: null, onUndo: () => {}, onRedo: () => {} };
  },
  addKeyboardShortcuts() {
    return {
      'Mod-z': () => {
        this.options.onUndo();
        return true;
      },
      'Mod-y': () => {
        this.options.onRedo();
        return true;
      },
      'Shift-Mod-z': () => {
        this.options.onRedo();
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    const { fragment, awareness } = this.options;
    if (!fragment) return [];
    const plugins: Plugin[] = [ySyncPlugin(fragment) as Plugin];
    if (awareness) {
      plugins.push(
        yCursorPlugin(awareness, {
          cursorBuilder: (user) => caret(user as unknown as AwarenessUser),
          selectionBuilder: (user) => ({
            nodeName: 'span',
            class: 'sl-peer-selection',
            style: `--peer-color: ${peerColor(user as unknown as AwarenessUser)}`,
          }),
        }) as Plugin,
      );
    }
    return plugins;
  },
});
