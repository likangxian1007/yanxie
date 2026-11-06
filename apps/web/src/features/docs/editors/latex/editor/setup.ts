import { basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import {
  HighlightStyle,
  StreamLanguage,
  indentUnit,
  syntaxHighlighting,
  syntaxTree,
} from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import {
  type Compartment,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { findMathRanges, type MathRange } from './mathRanges';
import { tr } from '@/lib/i18n';

/**
 * CodeMirror 6 的扩展组合：basicSetup（行号、当前行、括号匹配、自动缩进、搜索、折叠）
 * + stex 语法 + 自己的配色（命令 accent、注释 fg-subtle 斜体、公式 agent）+ yCollab 协同。
 */

// ---------------------------------------------------------------- 语法配色

const latexLanguage = StreamLanguage.define(stex);

/** stex 的 token 名 → 我们的 class */
const TOKEN_CLASS: Record<string, string> = {
  tag: 'cm-ltx-cmd',
  comment: 'cm-ltx-comment',
  atom: 'cm-ltx-arg',
  number: 'cm-ltx-num',
  bracket: 'cm-ltx-bracket',
  error: 'cm-ltx-error',
  keyword: 'cm-ltx-math',
};

const markCache = new Map<string, Decoration>();
const mark = (cls: string) => {
  let m = markCache.get(cls);
  if (!m) {
    m = Decoration.mark({ class: cls });
    markCache.set(cls, m);
  }
  return m;
};

const mathField = StateField.define<MathRange[]>({
  create: (state) => findMathRanges(state.doc.toString()),
  update: (value, tr) => (tr.docChanged ? findMathRanges(tr.state.doc.toString()) : value),
});

function buildHighlight(view: EditorView): DecorationSet {
  const marks: Range<Decoration>[] = [];
  const math = view.state.field(mathField);
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    // 公式区间
    let lo = 0;
    let hi = math.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((math[mid]?.[1] ?? 0) <= from) lo = mid + 1;
      else hi = mid;
    }
    const mathInView: MathRange[] = [];
    for (let k = lo; k < math.length; k += 1) {
      const r = math[k];
      if (!r || r[0] >= to) break;
      const a = Math.max(r[0], from);
      const b = Math.min(r[1], to);
      if (b > a) {
        mathInView.push([a, b]);
        marks.push(mark('cm-ltx-math').range(a, b));
      }
    }
    const inMath = (a: number, b: number) => mathInView.some((r) => a >= r[0] && b <= r[1]);
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const cls = TOKEN_CLASS[node.name];
        if (!cls || node.from >= node.to) return;
        // 公式里只保留注释的样式，其余统一为公式色
        if (cls !== 'cm-ltx-comment' && inMath(node.from, node.to)) return;
        if (cls === 'cm-ltx-math') return;
        marks.push(mark(cls).range(node.from, node.to));
      },
    });
  }
  return Decoration.set(marks, true);
}

const highlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildHighlight(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = buildHighlight(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ---------------------------------------------------------------- 跳转高亮

/** 跳转到某行时闪一下整行背景：传行首位置，null 清除 */
export const flashLineEffect = StateEffect.define<number | null>();

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashLineEffect)) {
        next =
          e.value === null
            ? Decoration.none
            : Decoration.set([Decoration.line({ class: 'cm-ltx-flash' }).range(e.value)]);
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------- 主题

const theme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--fg)',
    backgroundColor: 'var(--surface)',
    fontSize: '13px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.65',
    overscrollBehavior: 'contain',
  },
  '.cm-content': { padding: '12px 0 40vh', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 16px 0 8px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'color-mix(in oklab, var(--accent) 22%, transparent)' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface)',
    color: 'var(--fg-subtle)',
    border: 'none',
    borderRight: '1px solid var(--line)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '36px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--accent) 5%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg-muted)' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--fg-subtle)', padding: '0 4px' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--subtle)',
    border: '1px solid var(--line)',
    color: 'var(--fg-muted)',
    borderRadius: '4px',
    padding: '0 4px',
  },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in oklab, var(--accent) 18%, transparent)',
    outline: '1px solid color-mix(in oklab, var(--accent) 50%, transparent)',
    color: 'inherit',
  },
  '&.cm-focused .cm-nonmatchingBracket': {
    backgroundColor: 'var(--danger-soft)',
    color: 'var(--danger)',
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in oklab, var(--warning) 22%, transparent)' },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in oklab, var(--warning) 30%, transparent)',
    outline: '1px solid color-mix(in oklab, var(--warning) 60%, transparent)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in oklab, var(--accent) 30%, transparent)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--elevated)',
    color: 'var(--fg)',
    fontFamily: 'var(--font-sans)',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-panel.cm-search': { padding: '6px 32px 6px 10px', fontSize: '12px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
    fontSize: '12px',
    margin: '2px 4px 2px 0',
  },
  '.cm-textfield': {
    backgroundColor: 'var(--surface)',
    color: 'var(--fg)',
    border: '1px solid var(--line-strong)',
    borderRadius: '6px',
    padding: '3px 6px',
  },
  '.cm-textfield:focus': { outline: '2px solid var(--ring)', outlineOffset: '0' },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--subtle)',
    color: 'var(--fg)',
    border: '1px solid var(--line)',
    borderRadius: '6px',
    padding: '3px 8px',
  },
  '.cm-button:active': { backgroundImage: 'none', backgroundColor: 'var(--muted)' },
  '.cm-panel.cm-search [name=close]': { color: 'var(--fg-muted)', fontSize: '16px' },
  '.cm-tooltip': {
    backgroundColor: 'var(--elevated)',
    color: 'var(--fg)',
    border: '1px solid var(--line)',
    borderRadius: '8px',
    boxShadow: 'var(--shadow-md)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--accent-text)',
  },
  // 语法配色
  '.cm-ltx-cmd': { color: 'var(--accent-text)' },
  '.cm-ltx-comment': { color: 'var(--fg-subtle)', fontStyle: 'italic' },
  '.cm-ltx-arg': { color: 'var(--fg-muted)' },
  '.cm-ltx-num': { color: 'var(--fg-muted)' },
  '.cm-ltx-bracket': { color: 'var(--fg-muted)' },
  '.cm-ltx-error': { color: 'var(--danger)' },
  '.cm-ltx-math': { color: 'var(--agent-text)' },
  '.cm-ltx-flash': {
    backgroundColor: 'color-mix(in oklab, var(--accent) 16%, transparent)',
    transition: 'background-color 600ms var(--ease-out)',
  },
  // 远程光标标签：白字衬线体改成主题色无衬线
  '.cm-ySelectionInfo': {
    color: 'var(--accent-fg)',
    fontFamily: 'var(--font-sans)',
    fontWeight: '500',
    fontSize: '11px',
    lineHeight: '1.3',
    padding: '1px 5px',
    borderRadius: '4px 4px 4px 0',
    top: '-1.35em',
  },
  '.cm-ySelectionCaret': { borderLeftWidth: '2px' },
});

// ---------------------------------------------------------------- 组合

export interface LatexExtensionOptions {
  ytext: Y.Text;
  awareness: Awareness;
  undoManager: Y.UndoManager;
  readOnly: Compartment;
  editable: boolean;
  /** 额外快捷键（加粗、斜体等） */
  extraKeys: { key: string; run: (view: EditorView) => boolean }[];
  onUpdate: (update: ViewUpdate) => void;
}

export function readOnlyExtension(editable: boolean): Extension {
  return [EditorState.readOnly.of(!editable), EditorView.editable.of(editable)];
}

export function createLatexExtensions(opts: LatexExtensionOptions): Extension {
  return [
    // y 的撤销键位要排在 basicSetup 的 history 键位前面
    Prec.highest(keymap.of([...yUndoManagerKeymap, ...opts.extraKeys])),
    Prec.high(yCollab(opts.ytext, opts.awareness, { undoManager: opts.undoManager })),
    basicSetup,
    keymap.of([indentWithTab]),
    latexLanguage,
    // 空的 HighlightStyle：屏蔽 basicSetup 里默认（硬编码颜色）的 fallback 配色
    syntaxHighlighting(HighlightStyle.define([])),
    mathField,
    highlightPlugin,
    flashField,
    indentUnit.of('  '),
    EditorState.tabSize.of(2),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ 'aria-label': tr('LaTeX 源码'), spellcheck: 'false' }),
    opts.readOnly.of(readOnlyExtension(opts.editable)),
    theme,
    EditorView.updateListener.of(opts.onUpdate),
  ];
}
