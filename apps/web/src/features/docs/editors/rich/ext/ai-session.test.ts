import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';
import { contentExtensions } from '../extensions';
import { mockLayoutApis } from '../test-utils';
import { planInsert } from '../ai/useRichAi';
import {
  AiSession,
  closeAiSessionTr,
  createAiBridge,
  openAiSessionTr,
  readAiSession,
} from './ai-session';
import { SlashCommand, createSlashBridge, dismissSlash, slashKey } from './slash';

beforeAll(mockLayoutApis);
// 每条测试都建真实的 Tiptap 编辑器：完整 `pnpm check` 并行跑时 CPU 吃紧，默认 5s 会偶发超时
vi.setConfig({ testTimeout: 30_000 });

let editors: Editor[] = [];
afterEach(() => {
  for (const e of editors) e.destroy();
  editors = [];
});

function setup(html: string) {
  const ydoc = new Y.Doc();
  const bridge = createAiBridge();
  const slash = createSlashBridge();
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      ...contentExtensions(),
      Collaboration.configure({ document: ydoc, field: 'default' }),
      AiSession.configure({ bridge }),
      SlashCommand.configure({ bridge: slash }),
    ],
  });
  editors.push(editor);
  editor.commands.setContent(html);
  return { editor, ydoc, bridge, slash };
}

/** 在文档里找一段文字的位置 */
function find(editor: Editor, text: string) {
  let found: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found || !node.isText) return;
    const i = node.text!.indexOf(text);
    if (i >= 0) found = { from: pos + i, to: pos + i + text.length };
  });
  if (!found) throw new Error(`not found: ${text}`);
  return found as { from: number; to: number };
}

function remoteInsertParagraphAtStart(ydoc: Y.Doc, text: string) {
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  remote.getXmlFragment('default').insert(0, [p]);
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(ydoc)));
}

describe('AI 会话插件', () => {
  it('打开时记录目标与锚点，并放置占位 widget', () => {
    const { editor, bridge } = setup('<p>第一段</p><p>第二段文字</p><p>第三段</p>');
    const range = find(editor, '文字');
    editor.commands.setTextSelection(range);
    editor.view.dispatch(openAiSessionTr(editor.state, range));
    const info = readAiSession(editor.state);
    expect(info.open).toBe(true);
    expect(editor.state.doc.textBetween(info.from, info.to)).toBe('文字');
    // 锚点 = 第二段之后
    expect(editor.state.doc.resolve(info.anchor).nodeBefore?.textContent).toBe('第二段文字');
    const spacer = bridge.spacer.get();
    expect(spacer).not.toBeNull();
    expect(editor.view.dom.contains(spacer)).toBe(true);
    expect(editor.view.dom.querySelector('.rich-ai-target')?.textContent).toBe('文字');
  });

  it('别人同时在前面插入内容（Yjs 远端事务），目标位置仍然正确', () => {
    const { editor, ydoc } = setup('<p>第一段</p><p>第二段文字</p>');
    const range = find(editor, '文字');
    editor.commands.setTextSelection(range);
    editor.view.dispatch(openAiSessionTr(editor.state, range));
    remoteInsertParagraphAtStart(ydoc, '远端插入的新段落');
    expect(editor.state.doc.firstChild?.textContent).toBe('远端插入的新段落');
    const info = readAiSession(editor.state);
    expect(editor.state.doc.textBetween(info.from, info.to)).toBe('文字');
    expect(editor.state.doc.resolve(info.anchor).nodeBefore?.textContent).toBe('第二段文字');
  });

  it('本地在前面打字，位置跟着映射', () => {
    const { editor } = setup('<p>第一段</p><p>第二段文字</p>');
    const range = find(editor, '文字');
    editor.view.dispatch(openAiSessionTr(editor.state, range));
    editor.commands.insertContentAt(1, '加了几个字');
    const info = readAiSession(editor.state);
    expect(editor.state.doc.textBetween(info.from, info.to)).toBe('文字');
  });

  it('planInsert：替换段内选区按行内插入；锚点前是空段落时替换它', () => {
    const { editor } = setup('<p>第一段</p><p>第二段文字</p><p></p>');
    const range = find(editor, '文字');
    editor.view.dispatch(openAiSessionTr(editor.state, range));
    const replace = planInsert(editor, 'replace', readAiSession(editor.state));
    expect(replace).toEqual({ range, preferInline: true });

    const closeTr = editor.state.tr;
    closeAiSessionTr(closeTr);
    editor.view.dispatch(closeTr);
    // 光标放到最后的空段落
    const end = editor.state.doc.content.size - 1;
    editor.commands.setTextSelection(end);
    editor.view.dispatch(openAiSessionTr(editor.state, { from: end, to: end }));
    const below = planInsert(editor, 'below', readAiSession(editor.state));
    expect(below.preferInline).toBe(false);
    expect(editor.state.doc.nodeAt(below.range.from)?.type.name).toBe('paragraph');
    expect(below.range.to - below.range.from).toBe(2);
  });

  it('关闭时登记闪烁高亮；生成过程中不写 Y.Doc', () => {
    const { editor, ydoc } = setup('<p>正文</p>');
    const before = Y.encodeStateAsUpdate(ydoc);
    editor.view.dispatch(openAiSessionTr(editor.state, { from: 1, to: 1 }));
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
    const tr = editor.state.tr.insertText('新内容', 3);
    const id = closeAiSessionTr(tr, { from: 3, to: 6, className: 'rich-ai-flash' });
    editor.view.dispatch(tr);
    expect(id).not.toBeNull();
    expect(readAiSession(editor.state).open).toBe(false);
    expect(editor.view.dom.querySelector('.rich-ai-flash')?.textContent).toBe('新内容');
  });

  it('空的顶层段落里按空格触发 AI；有字时不触发', () => {
    const { editor, bridge } = setup('<p>有字</p><p></p>');
    const calls: string[] = [];
    bridge.onTrigger.set((s) => calls.push(s));
    const press = (key: string, init: KeyboardEventInit = {}) =>
      editor.view.someProp('handleKeyDown', (f) =>
        f(editor.view, new KeyboardEvent('keydown', { key, ...init })),
      );
    editor.commands.setTextSelection(2);
    expect(press(' ')).toBeFalsy();
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(press(' ')).toBe(true);
    expect(press('j', { ctrlKey: true })).toBe(true);
    expect(calls).toEqual(['space', 'shortcut']);
  });
});

describe('斜杠插件', () => {
  it('行首输入 / 激活，Esc 后同一个触发点不再弹出', () => {
    const { editor } = setup('<p></p>');
    editor.commands.setTextSelection(1);
    editor.commands.insertContent('/表');
    let s = slashKey.getState(editor.state)!;
    expect(s.active).toBe(true);
    expect(s.query).toBe('表');
    expect(editor.state.doc.textBetween(s.from, s.to)).toBe('/表');
    editor.view.dispatch(dismissSlash(editor.state));
    expect(slashKey.getState(editor.state)!.active).toBe(false);
    editor.commands.insertContent('格');
    expect(slashKey.getState(editor.state)!.active).toBe(false);
    // 删掉重来：重新激活
    editor.commands.setContent('<p></p>');
    editor.commands.setTextSelection(1);
    editor.commands.insertContent('/');
    s = slashKey.getState(editor.state)!;
    expect(s.active).toBe(true);
  });

  it('非行首的 / 不激活', () => {
    const { editor } = setup('<p>文字</p>');
    editor.commands.setTextSelection(3);
    editor.commands.insertContent('/');
    expect(slashKey.getState(editor.state)!.active).toBe(false);
  });
});
