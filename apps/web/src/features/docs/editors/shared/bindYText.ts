import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';

/**
 * Y.Text ⇄ <textarea> / <input> 双向绑定（表格公式栏、幻灯片标题/正文/备注共用）。
 *
 * - 本地输入：把输入框的新值与上次同步的文本做最小 diff（公共前缀/后缀，按光标消歧），
 *   以一次 delete + insert 写进 Y.Text，包在 doc.transact(…, origin) 里（UndoManager 只追踪这个 origin）。
 * - 远端变化（其他人、agent、撤销重做）：用事件 delta 变换本地光标/选区位置，再写回输入框，
 *   光标不跳。
 * - 输入法组合期间（compositionstart → compositionend）不碰输入框的值；期间到达的远端 delta
 *   先排队，组合结束时把本地改动的位置按排队的 delta 变换后再写入，最后整体刷新。
 * - 可选拦截 Ctrl/⌘+Z / Ctrl+Y / ⌘+Shift+Z，交给 Y.UndoManager（否则浏览器原生撤销会和 Yjs 打架）。
 *
 * 输入框必须是非受控的（不要传 value），绑定负责它的 value。
 */

export interface TextDiff {
  index: number;
  remove: number;
  insert: string;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 计算 prev → next 的单段替换。cursor（next 里编辑后的光标位置）用于在重复字符时消歧：
 * 例如 "aa" → "aaa" 且光标在 1，结果是在 0 处插入而不是在 2 处。
 * 返回 null 表示没有变化。不会把代理对（emoji 等）劈成两半。
 */
export function diffText(prev: string, next: string, cursor?: number): TextDiff | null {
  if (prev === next) return null;
  const grow = next.length - prev.length;
  // 纯插入且光标在插入段末尾：优先按光标定位
  if (cursor !== undefined && grow > 0 && cursor >= grow && cursor <= next.length) {
    const index = cursor - grow;
    if (
      prev.slice(0, index) === next.slice(0, index) &&
      prev.slice(index) === next.slice(cursor) &&
      !splitsSurrogate(next, index) &&
      !splitsSurrogate(prev, index)
    ) {
      return { index, remove: 0, insert: next.slice(index, cursor) };
    }
  }
  // 纯删除（Backspace / Delete）且光标在删除点
  if (cursor !== undefined && grow < 0 && cursor >= 0 && cursor <= next.length) {
    const removed = -grow;
    if (
      prev.slice(0, cursor) === next.slice(0, cursor) &&
      prev.slice(cursor + removed) === next.slice(cursor) &&
      !splitsSurrogate(prev, cursor) &&
      !splitsSurrogate(prev, cursor + removed)
    ) {
      return { index: cursor, remove: removed, insert: '' };
    }
  }
  let start = 0;
  const minLen = Math.min(prev.length, next.length);
  while (start < minLen && prev.charCodeAt(start) === next.charCodeAt(start)) start += 1;
  let endPrev = prev.length;
  let endNext = next.length;
  while (
    endPrev > start &&
    endNext > start &&
    prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)
  ) {
    endPrev -= 1;
    endNext -= 1;
  }
  // 不劈开代理对：前缀退一格、后缀进一格
  if (start > 0 && isHighSurrogate(prev.charCodeAt(start - 1))) start -= 1;
  if (endPrev < prev.length && isLowSurrogate(prev.charCodeAt(endPrev))) {
    endPrev += 1;
    endNext += 1;
  }
  return { index: start, remove: endPrev - start, insert: next.slice(start, endNext) };
}

function splitsSurrogate(s: string, index: number): boolean {
  return (
    index > 0 &&
    index < s.length &&
    isHighSurrogate(s.charCodeAt(index - 1)) &&
    isLowSurrogate(s.charCodeAt(index))
  );
}

/** Y.Text 事件的 delta（retain / insert / delete）。 */
export type TextDelta = Array<{ retain?: number; insert?: unknown; delete?: number }>;

function insertLength(insert: unknown): number {
  return typeof insert === 'string' ? insert.length : 1;
}

/**
 * 把旧文本里的位置 pos 按 delta 变换到新文本。
 * assoc = 1：在 pos 处正好有插入时，位置跟到插入内容之后（光标的默认行为）；
 * assoc = -1：留在插入内容之前（选区起点用）。
 */
export function transformIndex(pos: number, delta: TextDelta, assoc: 1 | -1 = 1): number {
  let oldIndex = 0;
  let shift = 0;
  for (const op of delta) {
    if (op.retain !== undefined) {
      oldIndex += op.retain;
      if (oldIndex > pos) break;
    } else if (op.insert !== undefined) {
      const len = insertLength(op.insert);
      if (oldIndex < pos || (oldIndex === pos && assoc === 1)) shift += len;
      else break;
    } else if (op.delete !== undefined) {
      if (oldIndex >= pos) break;
      const end = oldIndex + op.delete;
      shift -= Math.min(end, pos) - oldIndex;
      oldIndex = end;
      if (end >= pos) break;
    }
  }
  return Math.max(0, pos + shift);
}

/** 本地 diff 应用到 Y.Text 的形式（insert/delete），包在调用方的事务里。 */
export function applyDiff(ytext: Y.Text, diff: TextDiff): void {
  if (diff.remove > 0) ytext.delete(diff.index, diff.remove);
  if (diff.insert) ytext.insert(diff.index, diff.insert);
}

/** 用最小 diff 把 Y.Text 整体改成 value（AI 替换、程序写入用，保留与之相交之外的并发编辑）。 */
export function setYText(ytext: Y.Text, value: string, origin?: unknown): void {
  const diff = diffText(ytext.toString(), value);
  if (!diff) return;
  const run = () => applyDiff(ytext, diff);
  if (ytext.doc) ytext.doc.transact(run, origin);
  else run();
}

export interface BindYTextOptions {
  /** 本地事务的 origin（交给 Y.UndoManager 的 trackedOrigins） */
  origin?: unknown;
  /** 拦截撤销/重做快捷键 */
  onUndo?: () => void;
  onRedo?: () => void;
  /** 值因远端变化被改写后回调（自动增高等） */
  onRemoteChange?: (el: HTMLTextAreaElement | HTMLInputElement) => void;
}

type Field = HTMLTextAreaElement | HTMLInputElement;

/** 绑定，返回解绑函数。 */
export function bindYText(ytext: Y.Text, el: Field, options: BindYTextOptions = {}): () => void {
  const { origin } = options;
  let synced = ytext.toString();
  let composing = false;
  let applyingLocal = false;
  /** 组合输入期间到达的远端 delta（按到达顺序） */
  let pending: TextDelta[] = [];

  if (el.value !== synced) el.value = synced;

  const transact = (fn: () => void) => {
    applyingLocal = true;
    try {
      if (ytext.doc) ytext.doc.transact(fn, origin);
      else fn();
    } finally {
      applyingLocal = false;
    }
  };

  const flushLocal = () => {
    const value = el.value;
    const cursor = el.selectionEnd ?? undefined;
    const diff = diffText(synced, value, cursor);
    if (!diff) {
      pending = [];
      return;
    }
    if (pending.length === 0) {
      transact(() => applyDiff(ytext, diff));
      synced = value;
      return;
    }
    // 组合期间有远端改动：把本地改动的位置变换到当前 Y.Text 上
    let index = diff.index;
    let end = diff.index + diff.remove;
    for (const delta of pending) {
      index = transformIndex(index, delta, -1);
      end = transformIndex(end, delta, -1);
    }
    pending = [];
    const remove = Math.max(0, end - index);
    transact(() => applyDiff(ytext, { index, remove, insert: diff.insert }));
    const latest = ytext.toString();
    synced = latest;
    if (el.value !== latest) {
      el.value = latest;
      const caret = index + diff.insert.length;
      if (document.activeElement === el) el.setSelectionRange(caret, caret);
      options.onRemoteChange?.(el);
    }
  };

  const onInput = () => {
    if (composing) return;
    flushLocal();
  };
  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = () => {
    composing = false;
    flushLocal();
  };
  const onKeyDown = (e: Event) => {
    const ke = e as KeyboardEvent;
    if (!(ke.ctrlKey || ke.metaKey) || ke.altKey) return;
    const key = ke.key.toLowerCase();
    if (key === 'z' && !ke.shiftKey && options.onUndo) {
      ke.preventDefault();
      options.onUndo();
    } else if (((key === 'z' && ke.shiftKey) || key === 'y') && options.onRedo) {
      ke.preventDefault();
      options.onRedo();
    }
  };

  const observer = (event: Y.YTextEvent) => {
    if (applyingLocal) return;
    const delta = event.delta as TextDelta;
    if (composing) {
      pending.push(delta);
      return;
    }
    const next = ytext.toString();
    // 输入框里还有没同步的本地内容（极少见：input 事件尚未触发）：先按旧基线算出来
    if (el.value !== synced) {
      pending.push(delta);
      flushLocal();
      return;
    }
    synced = next;
    if (el.value === next) return;
    const focused = document.activeElement === el;
    const selStart = el.selectionStart ?? 0;
    const selEnd = el.selectionEnd ?? 0;
    const dir = el.selectionDirection;
    el.value = next;
    if (focused) {
      const collapsed = selStart === selEnd;
      const start = transformIndex(selStart, delta, collapsed ? 1 : -1);
      const end = collapsed ? start : transformIndex(selEnd, delta, 1);
      el.setSelectionRange(start, Math.max(start, end), dir ?? undefined);
    }
    options.onRemoteChange?.(el);
  };

  el.addEventListener('input', onInput);
  el.addEventListener('compositionstart', onCompositionStart);
  el.addEventListener('compositionend', onCompositionEnd);
  el.addEventListener('keydown', onKeyDown);
  ytext.observe(observer);

  return () => {
    el.removeEventListener('input', onInput);
    el.removeEventListener('compositionstart', onCompositionStart);
    el.removeEventListener('compositionend', onCompositionEnd);
    el.removeEventListener('keydown', onKeyDown);
    ytext.unobserve(observer);
  };
}

/**
 * React 用法：`const ref = useYTextBinding(ytext, { origin, onUndo, onRedo });`
 * 然后 `<textarea ref={ref} />`（不要传 value）。ytext 为 null 时不绑定。
 */
export function useYTextBinding<T extends Field>(
  ytext: Y.Text | null,
  options: BindYTextOptions = {},
): (el: T | null) => void {
  const [el, setEl] = useState<T | null>(null);
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  const origin = options.origin;
  const hasUndo = Boolean(options.onUndo);
  const hasRedo = Boolean(options.onRedo);
  useEffect(() => {
    if (!el || !ytext) return;
    return bindYText(ytext, el, {
      origin,
      ...(hasUndo ? { onUndo: () => optionsRef.current.onUndo?.() } : {}),
      ...(hasRedo ? { onRedo: () => optionsRef.current.onRedo?.() } : {}),
      onRemoteChange: (field) => optionsRef.current.onRemoteChange?.(field),
    });
  }, [el, ytext, origin, hasUndo, hasRedo]);
  return setEl;
}
