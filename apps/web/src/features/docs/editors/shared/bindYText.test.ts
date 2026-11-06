import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindYText, diffText, setYText, transformIndex, type TextDelta } from './bindYText';

describe('diffText', () => {
  it('returns null when equal', () => {
    expect(diffText('abc', 'abc')).toBeNull();
  });
  it('finds a simple insert', () => {
    expect(diffText('abc', 'abXc')).toEqual({ index: 2, remove: 0, insert: 'X' });
  });
  it('finds a simple delete', () => {
    expect(diffText('abcd', 'ad')).toEqual({ index: 1, remove: 2, insert: '' });
  });
  it('finds a replacement', () => {
    expect(diffText('hello world', 'hello there')).toEqual({
      index: 6,
      remove: 5,
      insert: 'there',
    });
  });
  it('uses the cursor to disambiguate repeated characters', () => {
    expect(diffText('aa', 'aaa', 1)).toEqual({ index: 0, remove: 0, insert: 'a' });
    expect(diffText('aa', 'aaa')).toEqual({ index: 2, remove: 0, insert: 'a' });
    expect(diffText('aaa', 'aa', 0)).toEqual({ index: 0, remove: 1, insert: '' });
  });
  it('does not split surrogate pairs', () => {
    const d = diffText('a😀b', 'a😃b');
    expect(d).not.toBeNull();
    expect(d?.index).toBe(1);
    expect(d?.remove).toBe(2);
    expect(d?.insert).toBe('😃');
  });
  it('handles CJK text', () => {
    expect(diffText('研究进展', '研究的进展', 3)).toEqual({ index: 2, remove: 0, insert: '的' });
  });
});

describe('transformIndex', () => {
  const ins = (at: number, s: string): TextDelta =>
    at ? [{ retain: at }, { insert: s }] : [{ insert: s }];
  const del = (at: number, n: number): TextDelta =>
    at ? [{ retain: at }, { delete: n }] : [{ delete: n }];
  it('shifts positions after an insert', () => {
    expect(transformIndex(5, ins(2, 'xyz'))).toBe(8);
    expect(transformIndex(1, ins(2, 'xyz'))).toBe(1);
  });
  it('respects assoc at the insert point', () => {
    expect(transformIndex(2, ins(2, 'xyz'), 1)).toBe(5);
    expect(transformIndex(2, ins(2, 'xyz'), -1)).toBe(2);
  });
  it('clamps positions inside a deletion', () => {
    expect(transformIndex(5, del(2, 6))).toBe(2);
    expect(transformIndex(10, del(2, 6))).toBe(4);
    expect(transformIndex(1, del(2, 6))).toBe(1);
  });
});

function makePair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'from-b') Y.applyUpdate(b, u, 'from-a');
  });
  b.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'from-a') Y.applyUpdate(a, u, 'from-b');
  });
  return { a, b, ta: a.getText('t'), tb: b.getText('t') };
}

function typeInto(el: HTMLTextAreaElement, value: string, caret = value.length) {
  el.value = value;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event('input'));
}

describe('bindYText', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    cleanups.splice(0).forEach((fn) => fn());
    document.body.innerHTML = '';
  });

  function mount(ytext: Y.Text, origin?: unknown) {
    const el = document.createElement('textarea');
    document.body.appendChild(el);
    cleanups.push(bindYText(ytext, el, { origin }));
    return el;
  }

  it('initialises the field from Y.Text', () => {
    const { ta } = makePair();
    ta.insert(0, 'hello');
    const el = mount(ta);
    expect(el.value).toBe('hello');
  });

  it('writes local input as a minimal diff with the given origin', () => {
    const { a, ta, tb } = makePair();
    ta.insert(0, 'hello');
    const origin = { local: true };
    const el = mount(ta, origin);
    const origins: unknown[] = [];
    a.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin));
    typeInto(el, 'hello world');
    expect(ta.toString()).toBe('hello world');
    expect(tb.toString()).toBe('hello world');
    expect(origins).toContain(origin);
  });

  it('keeps the caret in place when a remote peer types before it', () => {
    const { ta, tb } = makePair();
    ta.insert(0, 'abcdef');
    const el = mount(ta);
    el.focus();
    el.setSelectionRange(4, 4);
    tb.insert(0, 'XYZ');
    expect(el.value).toBe('XYZabcdef');
    expect(el.selectionStart).toBe(7);
    expect(el.selectionEnd).toBe(7);
  });

  it('does not move the caret for remote edits after it', () => {
    const { ta, tb } = makePair();
    ta.insert(0, 'abcdef');
    const el = mount(ta);
    el.focus();
    el.setSelectionRange(2, 2);
    tb.insert(6, '!!');
    expect(el.value).toBe('abcdef!!');
    expect(el.selectionStart).toBe(2);
  });

  it('defers remote changes during IME composition and merges afterwards', () => {
    const { ta, tb } = makePair();
    ta.insert(0, 'abc');
    const el = mount(ta);
    el.focus();
    el.setSelectionRange(3, 3);
    el.dispatchEvent(new Event('compositionstart'));
    el.value = 'abc研究';
    el.dispatchEvent(new Event('input'));
    // 远端在开头插入
    tb.insert(0, '>');
    expect(el.value).toBe('abc研究');
    el.setSelectionRange(5, 5);
    el.dispatchEvent(new Event('compositionend'));
    expect(ta.toString()).toBe('>abc研究');
    expect(tb.toString()).toBe('>abc研究');
    expect(el.value).toBe('>abc研究');
  });

  it('setYText applies a minimal diff', () => {
    const { ta, tb } = makePair();
    ta.insert(0, 'one two three');
    setYText(ta, 'one 2 three');
    expect(tb.toString()).toBe('one 2 three');
  });

  it('undo through Y.UndoManager restores the field', () => {
    const { ta } = makePair();
    const origin = { local: true };
    const um = new Y.UndoManager(ta, { trackedOrigins: new Set([origin]) });
    const el = document.createElement('textarea');
    document.body.appendChild(el);
    cleanups.push(bindYText(ta, el, { origin, onUndo: () => um.undo(), onRedo: () => um.redo() }));
    typeInto(el, 'draft');
    expect(ta.toString()).toBe('draft');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    expect(ta.toString()).toBe('');
    expect(el.value).toBe('');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }));
    expect(el.value).toBe('draft');
  });
});
