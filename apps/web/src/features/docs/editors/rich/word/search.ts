import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * 查找与替换：匹配在每个文本块内进行（和 Word 一样不跨段落），结果用本地 decoration 高亮，不进协同文档。
 * 替换走普通事务，所以会进入本人的撤销栈（Y.UndoManager 只撤销自己的修改）。
 */
export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

export interface SearchMatch {
  from: number;
  to: number;
}

export interface SearchState {
  query: string;
  options: SearchOptions;
  matches: SearchMatch[];
  /** 当前项下标（-1 = 没有） */
  current: number;
  decorations: DecorationSet;
}

export const searchKey = new PluginKey<SearchState>('richSearch');

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

export function buildRegex(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null;
  let source = options.regex ? query : escapeRe(query);
  if (options.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(source, `gu${options.caseSensitive ? '' : 'i'}`);
  } catch {
    return null;
  }
}

/** 在文档里找出所有匹配（文本块内；行内公式、提及等原子节点算一个占位字符，不会被匹配进去） */
export function findMatches(
  doc: PMNode,
  query: string,
  options: SearchOptions = {},
): SearchMatch[] {
  const re = buildRegex(query, options);
  if (!re) return [];
  const out: SearchMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // 拼出文本块的文字，同时记下每个字符对应的文档位置
    let text = '';
    const map: number[] = [];
    node.forEach((child, offset) => {
      if (child.isText) {
        const t = child.text ?? '';
        for (let i = 0; i < t.length; i += 1) map.push(pos + 1 + offset + i);
        text += t;
      } else {
        map.push(pos + 1 + offset);
        text += '\uFFFC';
      }
    });
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      if (m[0].includes('\uFFFC')) continue;
      const from = map[m.index]!;
      const to = map[m.index + m[0].length - 1]! + 1;
      out.push({ from, to });
      if (out.length >= 5000) return false;
    }
    return false;
  });
  return out;
}

function decorate(doc: PMNode, matches: SearchMatch[], current: number): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    matches.map((m, i) =>
      Decoration.inline(m.from, m.to, {
        class: i === current ? 'rich-search-match rich-search-current' : 'rich-search-match',
      }),
    ),
  );
}

function compute(
  doc: PMNode,
  query: string,
  options: SearchOptions,
  near: number,
  current?: number,
): SearchState {
  const matches = findMatches(doc, query, options);
  let idx = current ?? matches.findIndex((m) => m.from >= near);
  if (matches.length === 0) idx = -1;
  else if (idx < 0 || idx >= matches.length) idx = current === undefined ? 0 : matches.length - 1;
  return { query, options, matches, current: idx, decorations: decorate(doc, matches, idx) };
}

const EMPTY: SearchState = {
  query: '',
  options: {},
  matches: [],
  current: -1,
  decorations: DecorationSet.empty,
};

export function getSearchState(state: EditorState): SearchState {
  return searchKey.getState(state) ?? EMPTY;
}

type SearchMeta =
  | { type: 'set'; query: string; options: SearchOptions }
  | { type: 'goto'; index: number }
  | { type: 'clear' };

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    search: {
      setSearch: (query: string, options?: SearchOptions) => ReturnType;
      clearSearch: () => ReturnType;
      /** 跳到下一个 / 上一个匹配，并选中它 */
      findNext: () => ReturnType;
      findPrevious: () => ReturnType;
      replaceCurrent: (replacement: string) => ReturnType;
      replaceAll: (replacement: string) => ReturnType;
    };
  }
}

/** 正则模式下支持 $1 这类分组引用 */
function replacementFor(text: string, s: SearchState, replacement: string): string {
  if (!s.options.regex) return replacement;
  const re = buildRegex(s.query, s.options);
  if (!re) return replacement;
  re.lastIndex = 0;
  return text.replace(re, replacement);
}

export const SearchReplace = Extension.create({
  name: 'searchReplace',
  addCommands() {
    const go =
      (dir: 1 | -1) =>
      () =>
      ({
        state,
        tr,
        dispatch,
      }: {
        state: EditorState;
        tr: EditorState['tr'];
        dispatch?: (t: EditorState['tr']) => void;
      }) => {
        const s = getSearchState(state);
        if (s.matches.length === 0) return false;
        const index = (s.current + dir + s.matches.length) % s.matches.length;
        const m = s.matches[index]!;
        if (dispatch) {
          tr.setMeta(searchKey, { type: 'goto', index } satisfies SearchMeta);
          tr.setSelection(TextSelection.create(tr.doc, m.from, m.to));
          tr.scrollIntoView();
          dispatch(tr);
        }
        return true;
      };
    return {
      setSearch:
        (query, options = {}) =>
        ({ tr, dispatch }) => {
          if (dispatch)
            dispatch(tr.setMeta(searchKey, { type: 'set', query, options } satisfies SearchMeta));
          return true;
        },
      clearSearch:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(searchKey, { type: 'clear' } satisfies SearchMeta));
          return true;
        },
      findNext: go(1),
      findPrevious: go(-1),
      replaceCurrent:
        (replacement) =>
        ({ state, tr, dispatch }) => {
          const s = getSearchState(state);
          const m = s.matches[s.current];
          if (!m) return false;
          if (dispatch) {
            const text = state.doc.textBetween(m.from, m.to);
            const marks = state.doc.resolve(m.from + 1).marks();
            const value = replacementFor(text, s, replacement);
            if (value) tr.replaceWith(m.from, m.to, state.schema.text(value, marks));
            else tr.delete(m.from, m.to);
            dispatch(tr);
          }
          return true;
        },
      replaceAll:
        (replacement) =>
        ({ state, tr, dispatch }) => {
          const s = getSearchState(state);
          if (s.matches.length === 0) return false;
          if (dispatch) {
            // 从后往前替换，前面的位置不受影响
            for (const m of [...s.matches].reverse()) {
              const text = state.doc.textBetween(m.from, m.to);
              const marks = state.doc.resolve(m.from + 1).marks();
              const value = replacementFor(text, s, replacement);
              if (value) tr.replaceWith(m.from, m.to, state.schema.text(value, marks));
              else tr.delete(m.from, m.to);
            }
            dispatch(tr);
          }
          return true;
        },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: searchKey,
        state: {
          init: () => EMPTY,
          apply(tr, prev, _old, next) {
            const meta = tr.getMeta(searchKey) as SearchMeta | undefined;
            if (meta?.type === 'clear') return EMPTY;
            if (meta?.type === 'set') {
              return compute(next.doc, meta.query, meta.options, next.selection.from);
            }
            if (meta?.type === 'goto') {
              return {
                ...prev,
                current: meta.index,
                decorations: decorate(next.doc, prev.matches, meta.index),
              };
            }
            if (tr.docChanged && prev.query) {
              return compute(next.doc, prev.query, prev.options, next.selection.from, prev.current);
            }
            return prev;
          },
        },
        props: {
          decorations: (state) => getSearchState(state).decorations,
        },
      }),
    ];
  },
});
