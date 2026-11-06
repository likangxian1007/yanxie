import '@fontsource-variable/jetbrains-mono';
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { Compartment, EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
} from '@codemirror/view';
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { python } from '@codemirror/legacy-modes/mode/python';
import { defaultKeymap, indentLess, indentMore } from '@codemirror/commands';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  startCompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';
import { keepColorLight } from '@/features/docs/editors/latex/editor/awareness';

/**
 * 单元格编辑器：CodeMirror 6 绑定单元格的 Y.Text（y-codemirror：多人光标、协同撤销）。
 * 键位和 Jupyter 一致：Shift+Enter 运行并下移、Ctrl+Enter 运行、Alt+Enter 运行并在下方插入、
 * Esc 回到命令模式、Tab 补全（内核）/ 缩进、Shift+Tab 反缩进、Ctrl+Shift+- 拆分、
 * 在首行按 ↑ / 末行按 ↓ 跳到上 / 下一个单元格。
 */

export interface CellEditorKeys {
  run: (mode: 'stay' | 'advance' | 'insert') => void;
  escape: () => void;
  split: (at: number) => void;
  /** 光标在顶 / 底时继续 ↑ / ↓ */
  leave: (dir: -1 | 1) => void;
  complete?: (
    code: string,
    pos: number,
  ) => Promise<{ matches: string[]; from: number; to: number }>;
  focus: () => void;
}

export interface CellEditorHandle {
  focus: (where?: 'start' | 'end' | 'keep') => void;
  view: () => EditorView | null;
}

interface Props {
  text: Y.Text;
  awareness: Awareness | null;
  language: 'python' | 'markdown' | 'raw';
  editable: boolean;
  showLineNumbers: boolean;
  keys: React.RefObject<CellEditorKeys>;
  placeholder?: string;
}

const pythonLanguage = StreamLanguage.define(python);

/** JupyterLab 默认配色（亮 / 暗由 CSS 变量切换，见 notebook.css） */
const jupyterHighlight = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword],
    color: 'var(--nb-hl-keyword)',
    fontWeight: '600',
  },
  { tag: [t.string, t.special(t.string)], color: 'var(--nb-hl-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--nb-hl-number)' },
  { tag: t.comment, color: 'var(--nb-hl-comment)', fontStyle: 'italic' },
  { tag: [t.definition(t.variableName), t.function(t.variableName)], color: 'var(--nb-hl-def)' },
  { tag: [t.standard(t.variableName), t.special(t.variableName)], color: 'var(--nb-hl-builtin)' },
  { tag: [t.operator], color: 'var(--nb-hl-operator)', fontWeight: '600' },
  { tag: [t.meta], color: 'var(--nb-hl-meta)' },
  { tag: [t.propertyName], color: 'var(--fg)' },
]);

const theme = EditorView.theme({
  '&': { fontSize: '13.5px', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
    lineHeight: '1.55',
  },
  '.cm-content': { padding: '6px 0', caretColor: 'var(--fg)' },
  '.cm-line': { padding: '0 8px' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--fg-subtle)',
  },
  '.cm-placeholder': { color: 'var(--fg-subtle)' },
  '.cm-ySelectionInfo': {
    fontFamily: 'inherit',
    fontSize: '11px',
    padding: '1px 4px',
    borderRadius: '3px 3px 3px 0',
    opacity: '1',
    top: '-1.4em',
  },
  '.cm-ySelectionCaret': { borderLeftWidth: '2px' },
  '.cm-tooltip.cm-tooltip-autocomplete': {
    border: '1px solid var(--line)',
    background: 'var(--elevated)',
    borderRadius: '8px',
    boxShadow: 'var(--shadow-md)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    background: 'var(--accent-soft)',
    color: 'var(--fg)',
  },
});

function kernelCompletion(keys: React.RefObject<CellEditorKeys>) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const complete = keys.current?.complete;
    if (!complete) return null;
    const word = ctx.matchBefore(/[\w.]*$/);
    if (!ctx.explicit && (!word || word.from === word.to)) return null;
    try {
      const r = await complete(ctx.state.doc.toString(), ctx.pos);
      if (!r.matches.length) return null;
      return {
        from: r.from,
        to: r.to,
        options: r.matches.map((m) => ({
          label: m,
          type: m.endsWith('(') ? 'function' : 'variable',
        })),
        validFor: /^[\w.]*$/,
      };
    } catch {
      return null;
    }
  };
}

export const CellEditor = forwardRef<CellEditorHandle, Props>(function CellEditor(
  { text, awareness, language, editable, showLineNumbers, keys, placeholder },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editableC = useRef(new Compartment());
  const numbersC = useRef(new Compartment());
  const langC = useRef(new Compartment());

  useImperativeHandle(ref, () => ({
    view: () => viewRef.current,
    focus: (where = 'keep') => {
      const v = viewRef.current;
      if (!v) return;
      if (where !== 'keep') {
        const pos = where === 'start' ? 0 : v.state.doc.length;
        v.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true });
      }
      v.focus();
    },
  }));

  // 同步创建（layout effect）：父组件在同一次提交里就能把焦点交给新编辑器，
  // 不用等下一帧，快速按 Enter 后接着输入的字不会丢、也不会落到别的单元格
  useLayoutEffect(() => {
    if (!host.current) return;
    const undoManager = new Y.UndoManager(text);
    const k = keys;
    const atEdge = (v: EditorView, dir: -1 | 1) => {
      const sel = v.state.selection.main;
      if (!sel.empty) return false;
      const line = v.state.doc.lineAt(sel.head);
      return dir < 0 ? line.number === 1 : line.number === v.state.doc.lines;
    };
    const jupyterKeys = keymap.of([
      { key: 'Shift-Enter', run: () => (k.current?.run('advance'), true) },
      { key: 'Mod-Enter', run: () => (k.current?.run('stay'), true) },
      { key: 'Alt-Enter', run: () => (k.current?.run('insert'), true) },
      { key: 'Escape', run: () => (k.current?.escape(), true) },
      {
        key: 'Mod-Shift--',
        run: (v) => (k.current?.split(v.state.selection.main.head), true),
      },
      {
        key: 'ArrowUp',
        run: (v) => (atEdge(v, -1) ? (k.current?.leave(-1), true) : false),
      },
      {
        key: 'ArrowDown',
        run: (v) => (atEdge(v, 1) ? (k.current?.leave(1), true) : false),
      },
      {
        key: 'Tab',
        run: (v) => {
          const sel = v.state.selection.main;
          const before = v.state.doc.sliceString(v.state.doc.lineAt(sel.head).from, sel.head);
          if (sel.empty && /[\w.]$/.test(before) && k.current?.complete) return startCompletion(v);
          return indentMore(v);
        },
      },
      { key: 'Shift-Tab', run: indentLess },
    ]);
    const extensions: Extension[] = [
      Prec.highest(jupyterKeys),
      Prec.highest(keymap.of(yUndoManagerKeymap)),
      Prec.high(keymap.of([...completionKeymap, ...closeBracketsKeymap])),
      keymap.of(defaultKeymap),
      yCollab(text, awareness ?? null, { undoManager }),
      highlightSpecialChars(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      indentUnit.of('    '),
      EditorState.tabSize.of(4),
      syntaxHighlighting(jupyterHighlight),
      autocompletion({ override: [kernelCompletion(k)], activateOnTyping: false, icons: false }),
      EditorView.lineWrapping,
      theme,
      langC.current.of(language === 'python' ? pythonLanguage : []),
      numbersC.current.of(showLineNumbers ? lineNumbers() : []),
      editableC.current.of([EditorState.readOnly.of(!editable), EditorView.editable.of(editable)]),
      EditorView.domEventHandlers({ focus: () => (k.current?.focus(), false) }),
    ];
    if (placeholder) extensions.push(cmPlaceholder(placeholder));
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: text.toString(), extensions }),
    });
    viewRef.current = view;
    const stopColor = awareness ? keepColorLight(awareness) : () => {};
    return () => {
      stopColor();
      view.destroy();
      undoManager.destroy();
      viewRef.current = null;
    };
    // 编辑器只在换了 Y.Text / 连接时重建；其他选项走 Compartment
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, awareness]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editableC.current.reconfigure([
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
      ]),
    });
  }, [editable]);
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: numbersC.current.reconfigure(showLineNumbers ? lineNumbers() : []),
    });
  }, [showLineNumbers]);
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: langC.current.reconfigure(language === 'python' ? pythonLanguage : []),
    });
  }, [language]);

  return <div ref={host} className="nb-editor min-w-0" />;
});
