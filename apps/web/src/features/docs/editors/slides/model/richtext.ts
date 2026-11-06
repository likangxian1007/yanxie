import * as Y from 'yjs';
import { parseBody, type Block, type Run } from '../lib/body';

/**
 * 文本框里的富文本：Y.XmlFragment，结构与 y-prosemirror / Tiptap Collaboration 写入的完全一致
 * （元素名 = 节点名，元素属性 = 节点 attrs；文字是 Y.XmlText，格式属性名 = 标记名、值 = 标记 attrs），
 * 所以编辑时直接交给 Tiptap 的 ySyncPlugin，导入 / 迁移 / 服务端写入也按这个格式手写，不需要 DOM。
 *
 * 节点：doc、paragraph（attrs: textAlign、lineHeight）、bulletList、orderedList（start）、listItem、hardBreak。
 * 标记：bold、italic、underline、strike、code、link（href）、
 *       textStyle（color、fontSize 例 '24pt'、fontFamily、backgroundColor）。
 */

export interface PmMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface PmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  text?: string;
  marks?: PmMark[];
}

export const TEXT_NODE_NAMES = [
  'doc',
  'paragraph',
  'text',
  'bulletList',
  'orderedList',
  'listItem',
  'hardBreak',
] as const;

export const TEXT_MARK_NAMES = [
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'link',
  'textStyle',
] as const;

export function emptyDoc(): PmNode {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

// ---------------------------------------------------------------- PM JSON → Y

function cleanAttrs(attrs: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

function marksToAttributes(marks: PmMark[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of marks ?? []) out[m.type] = cleanAttrs(m.attrs);
  return out;
}

function toYNodes(nodes: PmNode[]): Array<Y.XmlElement | Y.XmlText> {
  const out: Array<Y.XmlElement | Y.XmlText> = [];
  let texts: PmNode[] = [];
  const flush = () => {
    if (texts.length === 0) return;
    const t = new Y.XmlText();
    t.applyDelta(
      texts
        .filter((n) => n.text)
        .map((n) => {
          const attributes = marksToAttributes(n.marks);
          return Object.keys(attributes).length
            ? { insert: n.text as string, attributes }
            : { insert: n.text as string };
        }),
    );
    out.push(t);
    texts = [];
  };
  for (const n of nodes) {
    if (n.type === 'text') {
      if (n.text) texts.push(n);
      continue;
    }
    flush();
    const el = new Y.XmlElement(n.type);
    for (const [k, v] of Object.entries(cleanAttrs(n.attrs))) {
      el.setAttribute(k, v as string);
    }
    const children = toYNodes(n.content ?? []);
    if (children.length) el.insert(0, children);
    out.push(el);
  }
  flush();
  return out;
}

/** 用 PM JSON（doc 节点）整体替换 fragment 的内容 */
export function writePm(frag: Y.XmlFragment, doc: PmNode): void {
  if (frag.length) frag.delete(0, frag.length);
  const nodes = toYNodes(doc.content?.length ? doc.content : [{ type: 'paragraph' }]);
  if (nodes.length) frag.insert(0, nodes);
}

/** 新建一个带内容的 fragment（还没挂进文档；挂进去之后内容才生效） */
export function fragmentFromPm(doc: PmNode): Y.XmlFragment {
  const frag = new Y.XmlFragment();
  const nodes = toYNodes(doc.content?.length ? doc.content : [{ type: 'paragraph' }]);
  if (nodes.length) frag.insert(0, nodes);
  return frag;
}

// ---------------------------------------------------------------- Y → PM JSON

/** y-prosemirror 遇到可叠加的标记会写成 `name--hash`，读回来时去掉后缀 */
function markName(key: string): string {
  const i = key.indexOf('--');
  return i > 0 ? key.slice(0, i) : key;
}

function readChildren(parent: Y.XmlFragment | Y.XmlElement): PmNode[] {
  const out: PmNode[] = [];
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlText) {
      const delta = child.toDelta() as Array<{
        insert: unknown;
        attributes?: Record<string, unknown>;
      }>;
      for (const d of delta) {
        if (typeof d.insert !== 'string' || !d.insert) continue;
        const node: PmNode = { type: 'text', text: d.insert };
        const attrs = d.attributes ?? {};
        const keys = Object.keys(attrs);
        if (keys.length) {
          node.marks = keys.map((k) => {
            const a = attrs[k];
            return a && typeof a === 'object' && Object.keys(a).length
              ? { type: markName(k), attrs: { ...(a as Record<string, unknown>) } }
              : { type: markName(k) };
          });
        }
        out.push(node);
      }
    } else if (child instanceof Y.XmlElement) {
      const node: PmNode = { type: child.nodeName };
      const attrs = child.getAttributes() as Record<string, unknown>;
      if (Object.keys(attrs).length) node.attrs = { ...attrs };
      const content = readChildren(child);
      if (content.length) node.content = content;
      out.push(node);
    }
  }
  return out;
}

export function readPm(frag: Y.XmlFragment): PmNode {
  return { type: 'doc', content: readChildren(frag) };
}

// ---------------------------------------------------------------- 纯文本 / markdown

function inlineText(node: PmNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  return (node.content ?? []).map(inlineText).join('');
}

/** 段落按行拼接（列表项也是一行），给大纲、搜索、AI 用 */
export function pmPlainText(doc: PmNode): string {
  const lines: string[] = [];
  const visit = (n: PmNode) => {
    if (n.type === 'paragraph') lines.push(inlineText(n));
    else (n.content ?? []).forEach(visit);
  };
  visit(doc);
  return lines.join('\n');
}

export function pmIsEmpty(doc: PmNode): boolean {
  return pmPlainText(doc).trim() === '';
}

function runsToMarkdown(nodes: PmNode[]): string {
  return nodes
    .map((n) => {
      if (n.type === 'hardBreak') return '\n';
      const t = n.text ?? '';
      if (!t) return '';
      const has = (m: string) => n.marks?.some((x) => x.type === m);
      if (has('code')) return `\`${t}\``;
      if (has('bold')) return `**${t}**`;
      return t;
    })
    .join('')
    .replace(/\*\*\*\*/gu, '');
}

/** 文本框 → markdown 子集（与 lib/body.ts 的解析规则对应：段落、`- ` / `1. ` 列表、**粗体**） */
export function pmToMarkdown(doc: PmNode): string {
  const out: string[] = [];
  const list = (n: PmNode, level: number) => {
    const ordered = n.type === 'orderedList';
    let num = Number(n.attrs?.start ?? 1) || 1;
    for (const item of n.content ?? []) {
      let first = true;
      for (const c of item.content ?? []) {
        if (c.type === 'paragraph') {
          const prefix = first ? (ordered ? `${num}. ` : '- ') : '  ';
          out.push(`${'  '.repeat(level)}${prefix}${runsToMarkdown(c.content ?? [])}`);
          first = false;
        } else if (c.type === 'bulletList' || c.type === 'orderedList') list(c, level + 1);
      }
      num += 1;
    }
  };
  for (const n of doc.content ?? []) {
    if (n.type === 'paragraph') {
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(runsToMarkdown(n.content ?? []));
    } else if (n.type === 'bulletList' || n.type === 'orderedList') {
      if (
        out.length &&
        out[out.length - 1] !== '' &&
        !/^\s*(-|\d+\.)\s/u.test(out[out.length - 1]!)
      )
        out.push('');
      list(n, 0);
    }
  }
  return out
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function runsToPm(runs: Run[]): PmNode[] {
  const out: PmNode[] = [];
  for (const r of runs) {
    const parts = r.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) out.push({ type: 'hardBreak' });
      if (!part) return;
      const text = r.math ? `$${part}$` : part;
      const marks: PmMark[] = [];
      if (r.bold) marks.push({ type: 'bold' });
      if (r.code) marks.push({ type: 'code' });
      out.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text });
    });
  }
  return out;
}

function paragraph(content: PmNode[], attrs?: Record<string, unknown>): PmNode {
  const p: PmNode = { type: 'paragraph' };
  if (attrs && Object.keys(attrs).length) p.attrs = attrs;
  if (content.length) p.content = content;
  return p;
}

/**
 * markdown 子集（lib/body.ts：段落、多级 `- ` / `1. ` 列表、`# 标题` 当加粗段落、**粗体**、`代码`）→ PM JSON。
 * 行内公式保留成 `$…$` 文字。
 */
export function markdownToPm(body: string, paraAttrs?: Record<string, unknown>): PmNode {
  const blocks = parseBody(body);
  const content: PmNode[] = [];
  // 列表栈：每级一个 list 节点
  let stack: PmNode[] = [];
  const closeLists = () => {
    stack = [];
  };
  for (const b of blocks as Block[]) {
    if (b.kind !== 'li') {
      closeLists();
      const runs = b.kind === 'h' ? b.runs.map((r) => ({ ...r, bold: true })) : b.runs;
      content.push(paragraph(runsToPm(runs), paraAttrs));
      continue;
    }
    const type = b.ordered ? 'orderedList' : 'bulletList';
    const level = Math.min(b.level, stack.length);
    stack = stack.slice(0, level + 1);
    let list = stack[level];
    if (!list || list.type !== type) {
      list = { type, content: [] };
      if (b.ordered && b.number !== 1) list.attrs = { start: b.number };
      if (level === 0) content.push(list);
      else {
        const parent = stack[level - 1];
        const lastItem = parent?.content?.[parent.content.length - 1];
        if (lastItem) (lastItem.content ??= []).push(list);
        else content.push(list);
      }
      stack[level] = list;
      stack = stack.slice(0, level + 1);
    }
    (list.content ??= []).push({
      type: 'listItem',
      content: [paragraph(runsToPm(b.runs), paraAttrs)],
    });
  }
  if (content.length === 0) content.push(paragraph([], paraAttrs));
  return { type: 'doc', content };
}

/** 纯文本（按行）→ PM JSON；每行一个段落 */
export function plainToPm(text: string, paraAttrs?: Record<string, unknown>): PmNode {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  return {
    type: 'doc',
    content: lines.map((l) => paragraph(l ? [{ type: 'text', text: l }] : [], paraAttrs)),
  };
}

/** 给整篇里的每段文字加 / 改一个标记（工具栏对“整个文本框”设格式时用，纯函数） */
export function mapTextNodes(doc: PmNode, fn: (n: PmNode) => PmNode): PmNode {
  const visit = (n: PmNode): PmNode => {
    if (n.type === 'text') return fn(n);
    if (!n.content) return n;
    return { ...n, content: n.content.map(visit) };
  };
  return visit(doc);
}
