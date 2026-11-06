import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';
import type { DocComment } from '@srh/shared';
import { contentExtensions } from '../extensions';
import { mockLayoutApis } from '../test-utils';
import { matchMention } from '../ext/mention-suggest';
import { filterMembers } from '../components/MemberOptions';
import {
  encodeAnchor,
  groupThreads,
  mentionsInBody,
  quoteOf,
  resolveAnchor,
  sortThreads,
} from './anchor';
import { removeComment, upsertComment } from './api';
import {
  CommentHighlights,
  commentAt,
  commentKey,
  createCommentBridge,
  setCommentAnchors,
} from './plugin';

beforeAll(mockLayoutApis);

let editors: Editor[] = [];
afterEach(() => {
  for (const e of editors) e.destroy();
  editors = [];
});

function makeEditor(ydoc: Y.Doc) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      ...contentExtensions(),
      Collaboration.configure({ document: ydoc, field: 'default' }),
      CommentHighlights.configure({ bridge: createCommentBridge() }),
    ],
  });
  editors.push(editor);
  return editor;
}

function find(editor: Editor, text: string) {
  let found: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found || !node.isText) return;
    const i = node.text!.indexOf(text);
    if (i >= 0) found = { from: pos + i, to: pos + i + text.length };
  });
  if (!found) throw new Error(`没找到 ${text}`);
  return found as { from: number; to: number };
}

/** 两个客户端：A 有编辑器，B 是另一位成员（直接改 Y 文档），更新互相同步 */
function twoClients(html: string) {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(b, u, 'remote');
  });
  b.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(a, u, 'remote');
  });
  const editor = makeEditor(a);
  editor.commands.setContent(html);
  return { editor, a, b };
}

const textOf = (editor: Editor, r: { from: number; to: number } | null) =>
  r ? editor.state.doc.textBetween(r.from, r.to) : null;

describe('评论锚点（Y 相对位置）', () => {
  it('别人在前面插字、在前面加段落，锚点仍指向原来那段文字', () => {
    const { editor, b } = twoClients('<p>研究背景与动机</p><p>方法部分</p>');
    const r = find(editor, '背景与动机');
    const anchor = encodeAnchor(editor.state, r.from, r.to)!;
    expect(anchor).not.toBeNull();
    expect(textOf(editor, resolveAnchor(editor.state, anchor))).toBe('背景与动机');

    // 另一位成员在同一段开头插字
    const frag = b.getXmlFragment('default');
    const firstText = (frag.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    firstText.insert(0, '本文的');
    expect(editor.state.doc.textContent).toContain('本文的研究背景与动机');
    expect(textOf(editor, resolveAnchor(editor.state, anchor))).toBe('背景与动机');

    // 再在最前面插入一个新段落
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText('摘要')]);
    frag.insert(0, [p]);
    expect(textOf(editor, resolveAnchor(editor.state, anchor))).toBe('背景与动机');
  });

  it('本地编辑后锚点也跟着走；锚点所在文字被删掉 → 失效（null）', () => {
    const { editor, b } = twoClients('<p>研究背景与动机</p>');
    const r = find(editor, '背景');
    const anchor = encodeAnchor(editor.state, r.from, r.to)!;
    editor.chain().insertContentAt(1, '我们的').run();
    expect(textOf(editor, resolveAnchor(editor.state, anchor))).toBe('背景');

    const text = (b.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    const idx = text.toString().indexOf('背景');
    text.delete(idx, 2);
    expect(resolveAnchor(editor.state, anchor)).toBeNull();
  });

  it('空选区不能评论；坏数据解析不报错', () => {
    const { editor } = twoClients('<p>文字</p>');
    expect(encodeAnchor(editor.state, 2, 2)).toBeNull();
    expect(resolveAnchor(editor.state, null)).toBeNull();
    expect(resolveAnchor(editor.state, { start: { bad: 1 }, end: {} })).toBeNull();
  });

  it('高亮插件：远端修改后重新解析，点击位置能找到评论（最内层优先）', () => {
    const { editor, b } = twoClients('<p>对比学习的增广策略很关键</p>');
    const outer = find(editor, '对比学习的增广策略');
    const inner = find(editor, '增广');
    editor.view.dispatch(
      setCommentAnchors(editor.state, [
        { id: 'c1', anchor: encodeAnchor(editor.state, outer.from, outer.to) },
        { id: 'c2', anchor: encodeAnchor(editor.state, inner.from, inner.to) },
      ]),
    );
    expect(commentAt(editor.state, inner.from + 1)).toBe('c2');
    expect(commentAt(editor.state, outer.from + 1)).toBe('c1');

    const t = (b.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    t.insert(0, '其实');
    const ranges = commentKey.getState(editor.state)!.ranges;
    expect(textOf(editor, ranges.get('c2') ?? null)).toBe('增广');
    expect(textOf(editor, ranges.get('c1') ?? null)).toBe('对比学习的增广策略');
    expect(editor.view.dom.querySelectorAll('.rich-comment').length).toBeGreaterThan(0);
  });

  it('quoteOf 截断与空白折叠', () => {
    const { editor } = twoClients('<p>甲</p><p>乙</p>');
    expect(quoteOf(editor.state.doc, 0, editor.state.doc.content.size)).toBe('甲 乙');
    const long = twoClients(`<p>${'字'.repeat(300)}</p>`).editor;
    const q = quoteOf(long.state.doc, 1, 301);
    expect(q).toHaveLength(200);
    expect(q.endsWith('…')).toBe(true);
  });
});

function c(p: Partial<DocComment> & { id: string }): DocComment {
  return {
    documentId: 'd',
    projectId: 'p',
    parentId: null,
    author: { kind: 'user', id: 'u', name: '张三' },
    body: 'x',
    mentions: [],
    anchor: null,
    quote: '',
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...p,
  };
}

describe('评论列表的纯逻辑', () => {
  it('按首条分串，回复按时间排；首条被删的回复丢弃', () => {
    const threads = groupThreads([
      c({ id: 'r2', parentId: 'a', createdAt: '2026-01-03T00:00:00.000Z' }),
      c({ id: 'a' }),
      c({ id: 'r1', parentId: 'a', createdAt: '2026-01-02T00:00:00.000Z' }),
      c({ id: 'orphanReply', parentId: 'gone' }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.replies.map((x) => x.id)).toEqual(['r1', 'r2']);
  });

  it('侧栏顺序：按在文中的位置，原文已删的排最后', () => {
    const threads = groupThreads([c({ id: 'a' }), c({ id: 'b' }), c({ id: 'z' })]);
    const ranges = new Map([
      ['a', { from: 30, to: 40 }],
      ['b', { from: 5, to: 8 }],
      ['z', null],
    ]);
    expect(sortThreads(threads, ranges).map((t) => t.root.id)).toEqual(['b', 'a', 'z']);
  });

  it('实时事件合并：新增、替换、旧事件不覆盖新数据、删首条连回复', () => {
    let list = upsertComment(undefined, c({ id: 'a' }));
    list = upsertComment(list, c({ id: 'r', parentId: 'a' }));
    list = upsertComment(
      list,
      c({ id: 'a', resolved: true, updatedAt: '2026-02-01T00:00:00.000Z' }),
    );
    expect(list.find((x) => x.id === 'a')!.resolved).toBe(true);
    list = upsertComment(list, c({ id: 'a', resolved: false }));
    expect(list.find((x) => x.id === 'a')!.resolved).toBe(true);
    expect(removeComment(list, 'a')).toEqual([]);
  });

  it('@ 识别：行首或空白后的 @ 才算；正文里还留着的 @名字 才算提及', () => {
    expect(matchMention('请 @王')).toBe('王');
    expect(matchMention('@')).toBe('');
    expect(matchMention('mail@example')).toBeNull();
    expect(matchMention('@王 老师')).toBeNull();
    const picked = new Map([
      ['u1', '王老师'],
      ['u2', '李四'],
    ]);
    expect(mentionsInBody('请 @王老师 看看', picked)).toEqual(['u1']);
  });

  it('成员过滤：名字前缀优先，其次包含、邮箱', () => {
    const m = (id: string, name: string, email: string) => ({
      projectId: 'p',
      user: { id, name, email, avatarColor: 0, avatarUrl: null },
      role: 'member' as const,
      joinedAt: '',
    });
    const list = [m('1', '小王', 'a@x'), m('2', '王老师', 'b@x'), m('3', '李四', 'wang@x')];
    expect(filterMembers(list, '王').map((x) => x.user.id)).toEqual(['2', '1']);
    expect(filterMembers(list, 'wang').map((x) => x.user.id)).toEqual(['3']);
    expect(filterMembers(list, '')).toHaveLength(3);
  });
});
