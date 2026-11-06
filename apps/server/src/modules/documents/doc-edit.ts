import * as Y from 'yjs';
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap';
import { ApiError } from '@srh/shared';
import { markdownInlineToPm, markdownToPm, type PmMark, type PmNode } from './markdown';
import { docSchema } from './pm-schema';

/**
 * 富文本文档（kind = doc）按原文查找替换（replace_text）。
 *
 * agent 手里是 read_document 读出的 markdown，Y.Doc 里却是一段段带格式的文字：标题行前面的 `## `、
 * `**粗体**`、表格里的 `\|`、全角空格 / NBSP、中英文之间的空格在两边都可能不一样，同一句话也常被字体切成
 * 好几个 run（docx 导入尤其多）。这里把文档的每个文本块（段落、标题、代码块）展开成一串「单元」，
 * 每个单元记住它在哪一块、块内的行内偏移；查找分三档，前一档找不到才用下一档：
 *   1. 逐字：块内文字原样拼接（块之间是空行），跨 run / 跨行内元素都能命中；
 *   2. 宽松：去掉行首 `#`、`\` 转义、`<sup>`、`[^n]`、`==`，NFKC（全角 → 半角、NBSP / 全角空格 → 空格），
 *      只在两个西文词字符之间保留一个空格（「中文 English」「结果 ，」与「中文English」「结果，」视为相同）；
 *   3. 去标记：把 find 当 markdown 解析，取各文本块的文字再按第 2 档规整（粗体、链接、列表符号、表格竖线都去掉）。
 * 命中范围再换回 Y 结构里的位置：
 *   - 同一个文本块内、replace 不含空行：就地改文字，新文字沿用命中处的格式（字体、颜色）；
 *     find 正好是整块、replace 为空 → 删掉这一块（标题、空的重复标题都能这样删）；
 *   - replace 含空行 / 以 `#` 开头、或命中跨了几块：replace 按 markdown 解析成块。第一块能接上原段时
 *     并进原段（保留原格式），其余作为独立的新块插在后面（正文默认样式，不继承上一段的字体），
 *     命中处之后剩下的文字接到最后一块；
 *   - 跨了列表 / 表格 / 引用的边界：只有整块覆盖时才整体替换，否则报错让 agent 缩小范围。
 * 找不到时 not_found 带上最接近的原文片段（details.candidates），agent 下一步能照着改对。
 */

// ---------------------------------------------------------------- 特殊块属性、PM JSON → Y 节点

/**
 * 图片 / 附件 / 内嵌文档在 markdown 里只写得出地址和标题，宽度、对齐、高度、文件大小这些写不出来。
 * agent 用 replace_section / replace_all 整段重写时，按“同一个地址 / 同一篇文档”把旧节点上的这些属性带回来，
 * 这样读出来再原样写回不会把用户调好的尺寸弄丢。
 */
export type KeptAttrs = Map<string, Record<string, unknown>>;

function specialKey(type: string, attrs: Record<string, unknown> | undefined): string | null {
  if (type === 'image') return `image:${String(attrs?.src ?? '')}`;
  if (type === 'docEmbed') return `docEmbed:${String(attrs?.docId ?? '')}`;
  if (type === 'fileAttachment') return `fileAttachment:${String(attrs?.href ?? '')}`;
  return null;
}

export function collectSpecialAttrs(nodes: unknown[], out: KeptAttrs = new Map()): KeptAttrs {
  for (const n of nodes) {
    if (!(n instanceof Y.XmlElement)) continue;
    const attrs = n.getAttributes() as Record<string, unknown>;
    const key = specialKey(n.nodeName, attrs);
    if (key && !out.has(key)) out.set(key, attrs);
    collectSpecialAttrs(n.toArray(), out);
  }
  return out;
}

function restoreSpecialAttrs(node: PmNode, kept: KeptAttrs) {
  const key = specialKey(node.type, node.attrs);
  const old = key ? kept.get(key) : undefined;
  if (old) {
    const fresh = Object.fromEntries(
      Object.entries(node.attrs ?? {}).filter(([, v]) => v !== null && v !== undefined),
    );
    node.attrs = { ...old, ...fresh };
  }
  for (const c of node.content ?? []) restoreSpecialAttrs(c, kept);
}

/** 块级 PM JSON 转到一个临时 Y.Doc 里（已集成，可以读子节点）；先按 schema 校验，不合法 → 422 */
function pmBlocksToTmp(blocks: PmNode[], kept?: KeptAttrs): Y.XmlFragment {
  const json: PmNode = { type: 'doc', content: blocks };
  if (kept?.size) restoreSpecialAttrs(json, kept);
  const schema = docSchema();
  try {
    schema.nodeFromJSON(json).check();
  } catch {
    throw new ApiError('validation_failed', '这段内容的结构无法放进文档，请简化后再试');
  }
  const tmp = new Y.Doc();
  return prosemirrorJSONToYXmlFragment(schema, json, tmp.getXmlFragment('t'));
}

/** 一组块级 PM JSON → 可直接插入的 Y 节点 */
export function pmBlocksToY(blocks: PmNode[], kept?: KeptAttrs): (Y.XmlElement | Y.XmlText)[] {
  if (!blocks.length) return [];
  return pmBlocksToTmp(blocks, kept)
    .toArray()
    .map((n) => (n as Y.XmlElement | Y.XmlText).clone());
}

/** 一个文本块的 PM JSON → 它的行内 Y 子节点（可直接插入） */
export function pmInlineToY(block: PmNode): (Y.XmlElement | Y.XmlText)[] {
  const el = pmBlocksToTmp([block]).get(0) as Y.XmlElement;
  return el.toArray().map((c) => (c as Y.XmlElement | Y.XmlText).clone());
}

// ---------------------------------------------------------------- Y ⇄ 行内 JSON

interface Delta {
  insert: unknown;
  attributes?: Record<string, unknown>;
}

export const TEXTBLOCKS = new Set(['paragraph', 'heading', 'codeBlock']);

/** y-prosemirror 给可重叠标记的属性名加了 `--哈希` 后缀 */
const HASHED_MARK = /(.*)(--[a-zA-Z0-9+/=]{8})$/u;

function marksOf(attrs: Record<string, unknown> | undefined): PmMark[] {
  return Object.entries(attrs ?? {})
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => ({
      type: HASHED_MARK.exec(k)?.[1] ?? k,
      attrs: (typeof v === 'object' ? v : {}) as Record<string, unknown>,
    }));
}

/** Y 元素 → PM JSON（与 yXmlFragmentToProsemirrorJSON 对单个元素的结果一致） */
export function yToJson(el: Y.XmlElement): PmNode {
  const content: PmNode[] = [];
  for (const c of el.toArray()) {
    if (c instanceof Y.XmlText) {
      for (const d of c.toDelta() as Delta[]) {
        if (typeof d.insert !== 'string' || !d.insert) continue;
        const marks = marksOf(d.attributes);
        content.push(
          marks.length ? { type: 'text', text: d.insert, marks } : { type: 'text', text: d.insert },
        );
      }
    } else if (c instanceof Y.XmlElement) content.push(yToJson(c));
  }
  const attrs = el.getAttributes() as Record<string, unknown>;
  return {
    type: el.nodeName,
    ...(Object.keys(attrs).length ? { attrs } : {}),
    ...(content.length ? { content } : {}),
  };
}

const inlineSize = (n: PmNode) => (n.type === 'text' ? (n.text ?? '').length : 1);

/** 行内内容按偏移切片（文字按 UTF-16，行内原子节点各算 1） */
function sliceInline(nodes: PmNode[], from: number, to: number): PmNode[] {
  const out: PmNode[] = [];
  let pos = 0;
  for (const n of nodes) {
    const size = inlineSize(n);
    const a = Math.max(from, pos);
    const b = Math.min(to, pos + size);
    if (a < b) out.push(n.type === 'text' ? { ...n, text: n.text!.slice(a - pos, b - pos) } : n);
    pos += size;
  }
  return out;
}

/** 偏移 pos 处文字的标记（落在末尾时取最后一段文字） */
function marksAt(nodes: PmNode[], pos: number): PmMark[] {
  let at = 0;
  let last: PmMark[] = [];
  for (const n of nodes) {
    const size = inlineSize(n);
    if (n.type === 'text') {
      if (pos < at + size) return n.marks ?? [];
      last = n.marks ?? [];
    }
    at += size;
  }
  return last;
}

/** 新文字沿用命中处的格式；新文字自己带的同类标记优先 */
function withBase(nodes: PmNode[], base: PmMark[]): PmNode[] {
  if (!base.length) return nodes;
  return nodes.map((n) => {
    if (n.type !== 'text') return n;
    const own = n.marks ?? [];
    return { ...n, marks: [...base.filter((b) => !own.some((m) => m.type === b.type)), ...own] };
  });
}

/** 按 el 的类型和属性把行内内容转成 Y 子节点（校验 schema），供 setInline 写回 */
function prepareInline(el: Y.XmlElement, nodes: PmNode[]): (Y.XmlElement | Y.XmlText)[] {
  const attrs = el.getAttributes() as Record<string, unknown>;
  return pmInlineToY({ type: el.nodeName, attrs, ...(nodes.length ? { content: nodes } : {}) });
}

function setInline(el: Y.XmlElement, kids: (Y.XmlElement | Y.XmlText)[]) {
  if (el.length) el.delete(0, el.length);
  if (kids.length) el.insert(0, kids);
}

/** 行内文字 → Y 文本操作（属性是 y-prosemirror 的格式） */
function inlineTextOps(nodes: PmNode[]): { text: string; attrs: Record<string, unknown> }[] {
  if (!nodes.length) return [];
  const schema = docSchema();
  const tmp = new Y.Doc();
  const frag = prosemirrorJSONToYXmlFragment(
    schema,
    { type: 'doc', content: [{ type: 'paragraph', content: nodes }] },
    tmp.getXmlFragment('t'),
  );
  const para = frag.get(0) as Y.XmlElement;
  const ops: { text: string; attrs: Record<string, unknown> }[] = [];
  for (const c of para.toArray()) {
    if (!(c instanceof Y.XmlText)) continue;
    for (const d of c.toDelta() as Delta[]) {
      if (typeof d.insert === 'string') ops.push({ text: d.insert, attrs: d.attributes ?? {} });
    }
  }
  return ops;
}

/** el 里偏移 pos 处文字的 Y 格式属性 */
function yAttrsAt(el: Y.XmlElement, pos: number): Record<string, unknown> {
  let off = 0;
  let last: Record<string, unknown> | undefined;
  for (const c of el.toArray()) {
    if (c instanceof Y.XmlText) {
      for (const d of c.toDelta() as Delta[]) {
        const len = typeof d.insert === 'string' ? d.insert.length : 1;
        if (pos < off + len) return { ...(d.attributes ?? {}) };
        last = d.attributes;
        off += len;
      }
    } else off += 1;
  }
  return { ...(last ?? {}) };
}

function childSize(c: unknown): number {
  return c instanceof Y.XmlText ? c.length : 1;
}

/** 删掉 el 行内 [from, to)：可以跨几个文本节点和行内元素 */
function deleteInline(el: Y.XmlElement, from: number, to: number) {
  const kids = el.toArray();
  const starts: number[] = [];
  let off = 0;
  for (const c of kids) {
    starts.push(off);
    off += childSize(c);
  }
  for (let i = kids.length - 1; i >= 0; i -= 1) {
    const c = kids[i]!;
    const a = starts[i]!;
    const lo = Math.max(from, a);
    const hi = Math.min(to, a + childSize(c));
    if (lo >= hi) continue;
    if (c instanceof Y.XmlText) c.delete(lo - a, hi - lo);
    else el.delete(i, 1);
  }
}

/** 在 el 行内偏移 pos 处插入文字（落在两个行内元素之间时新建文本节点） */
function insertTextAt(
  el: Y.XmlElement,
  pos: number,
  ops: { text: string; attrs: Record<string, unknown> }[],
) {
  if (!ops.length) return;
  const kids = el.toArray();
  let off = 0;
  let target: Y.XmlText | null = null;
  let local = 0;
  let at = kids.length;
  for (let i = 0; i < kids.length; i += 1) {
    const c = kids[i]!;
    if (c instanceof Y.XmlText) {
      if (pos <= off + c.length) {
        target = c;
        local = pos - off;
        break;
      }
      off += c.length;
    } else {
      if (pos <= off) {
        at = i;
        break;
      }
      off += 1;
    }
  }
  if (!target) {
    target = new Y.XmlText();
    el.insert(at, [target]);
    local = 0;
  }
  for (const op of ops) {
    target.insert(local, op.text, op.attrs);
    local += op.text.length;
  }
}

// ---------------------------------------------------------------- 删除整块（连带清掉变空的容器）

const COLLAPSIBLE = new Set([
  'listItem',
  'taskItem',
  'blockquote',
  'bulletList',
  'orderedList',
  'taskList',
]);

function clearBlock(el: Y.XmlElement) {
  if (TEXTBLOCKS.has(el.nodeName)) {
    if (el.length) el.delete(0, el.length);
    return;
  }
  const parent = el.parent;
  if (!(parent instanceof Y.XmlFragment)) return;
  const i = parent.toArray().indexOf(el);
  parent.delete(i, 1);
  parent.insert(i, [new Y.XmlElement('paragraph')]);
}

/** 删掉一个块；列表项 / 引用变空时一并删掉，表格单元格里留一个空段落（schema 要求） */
export function removeBlock(el: Y.XmlElement) {
  const parent = el.parent;
  if (!(parent instanceof Y.XmlFragment)) return;
  const i = parent.toArray().indexOf(el);
  if (i < 0) return;
  if (!(parent instanceof Y.XmlElement)) {
    parent.delete(i, 1);
    return;
  }
  const name = parent.nodeName;
  if (parent.length > 1) {
    // 列表项第一个子节点必须是段落
    if ((name === 'listItem' || name === 'taskItem') && i === 0) clearBlock(el);
    else parent.delete(i, 1);
    return;
  }
  if (COLLAPSIBLE.has(name)) removeBlock(parent);
  else clearBlock(el);
}

// ---------------------------------------------------------------- 文本单元与规整

/** 非文本的叶子块（图片、块公式、分隔线、分页符、目录、附件、内嵌文档）在文字串里的占位 */
const OBJ = '\uFFFC';

interface Leaf {
  el: Y.XmlElement;
  /** 所在顶层块（fragment 直接子节点）的下标 */
  top: number;
  text: boolean;
  /** 单元下标 [first, end) */
  first: number;
  end: number;
  /** 行内长度 */
  size: number;
}

interface DocIndex {
  leaves: Leaf[];
  /** 每个单元一个码点 */
  chars: string[];
  /** 单元所在叶子块；-1 = 块之间的分隔 */
  leaf: number[];
  /** 单元在块内的行内偏移与长度 */
  off: number[];
  len: number[];
}

function atomText(el: Y.XmlElement): string {
  switch (el.nodeName) {
    case 'inlineMath':
      return `$${String(el.getAttribute('latex') ?? '')}$`;
    case 'mention':
      return `@${String(el.getAttribute('label') ?? '')}`;
    case 'hardBreak':
      return '\n';
    default:
      return ''; // 脚注、行内图片：markdown 里是 [^n] / 图片语法，比对时都去掉
  }
}

function buildIndex(frag: Y.XmlFragment): DocIndex {
  const ix: DocIndex = { leaves: [], chars: [], leaf: [], off: [], len: [] };
  const push = (c: string, leaf: number, off: number, len: number) => {
    ix.chars.push(c);
    ix.leaf.push(leaf);
    ix.off.push(off);
    ix.len.push(len);
  };
  const startLeaf = (el: Y.XmlElement, top: number, text: boolean): Leaf => {
    if (ix.leaves.length) {
      push('\n', -1, 0, 0);
      push('\n', -1, 0, 0);
    }
    const leaf: Leaf = { el, top, text, first: ix.chars.length, end: ix.chars.length, size: 0 };
    ix.leaves.push(leaf);
    return leaf;
  };
  const visit = (el: Y.XmlElement, top: number) => {
    if (TEXTBLOCKS.has(el.nodeName)) {
      const leaf = startLeaf(el, top, true);
      const li = ix.leaves.length - 1;
      let off = 0;
      for (const c of el.toArray()) {
        if (c instanceof Y.XmlText) {
          for (const d of c.toDelta() as Delta[]) {
            if (typeof d.insert !== 'string') {
              off += 1;
              continue;
            }
            for (const cp of d.insert) {
              push(cp, li, off, cp.length);
              off += cp.length;
            }
          }
        } else if (c instanceof Y.XmlElement) {
          for (const cp of atomText(c)) push(cp, li, off, 1);
          off += 1;
        }
      }
      leaf.size = off;
      leaf.end = ix.chars.length;
      return;
    }
    const kids = el.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
    if (!kids.length) {
      const leaf = startLeaf(el, top, false);
      push(OBJ, ix.leaves.length - 1, 0, 1);
      leaf.size = 1;
      leaf.end = ix.chars.length;
      return;
    }
    for (const k of kids) visit(k, top);
  };
  frag.toArray().forEach((n, i) => {
    if (n instanceof Y.XmlElement) visit(n, i);
  });
  return ix;
}

interface Flat {
  text: string;
  /** text 的每个 UTF-16 下标 → 单元下标 */
  map: number[];
}

function flatRaw(chars: string[]): Flat {
  let text = '';
  const map: number[] = [];
  chars.forEach((c, i) => {
    text += c;
    for (let k = 0; k < c.length; k += 1) map.push(i);
  });
  return { text, map };
}

const ZERO_WIDTH = /^[\u200b-\u200d\u2060\ufeff]$/u;
const SPACE = /^\s$/u;
const ESCAPABLE = /^[!-/:-@[-`{-~]$/u;
const WIDE =
  /[\u1100-\u11ff\u2e80-\u303f\u3040-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/u;
const WORD = /[\p{L}\p{N}]/u;
const QUOTES: Record<string, string> = { '“': '"', '”': '"', '‘': "'", '’': "'" };

const isWordChar = (c: string | undefined) => !!c && WORD.test(c) && !WIDE.test(c);

/**
 * 宽松比对用的规整：去 `\` 转义、去零宽字符、NFKC（全角字母标点 → 半角、NBSP / 全角空格 → 空格）、
 * 弯引号 → 直引号；空白只在两个西文词字符之间保留一个空格，其余（中文前后、标点前后、块与块之间）都去掉。
 */
function normalize(chars: string[]): Flat {
  const toks: { c: string; u: number; ws: boolean }[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i]!;
    if (c === '\\' && ESCAPABLE.test(chars[i + 1] ?? '')) continue;
    if (ZERO_WIDTH.test(c)) continue;
    if (SPACE.test(c)) {
      toks.push({ c: ' ', u: i, ws: true });
      continue;
    }
    for (const n of QUOTES[c] ?? c.normalize('NFKC')) {
      toks.push({ c: n, u: i, ws: SPACE.test(n) });
    }
  }
  let text = '';
  const map: number[] = [];
  let prev: string | undefined;
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!;
    if (!t.ws) {
      text += t.c;
      for (let k = 0; k < t.c.length; k += 1) map.push(t.u);
      prev = t.c;
      continue;
    }
    let j = i;
    while (j < toks.length && toks[j]!.ws) j += 1;
    if (isWordChar(prev) && isWordChar(toks[j]?.c)) {
      text += ' ';
      map.push(t.u);
    }
    i = j - 1;
  }
  return { text, map };
}

// ---------------------------------------------------------------- find 的三种读法

/** 行内的 markdown 小记号：上下标标签、脚注引用、高亮 */
function stripInlineMarks(s: string): string {
  return s
    .replace(/\r\n?/gu, '\n')
    .replace(/<\/?su[bp]>/gu, '')
    .replace(/\[\^[^\]\s]+\](?!:)/gu, '')
    .replace(/==([^=\n]+)==/gu, '$1');
}

/** 第 2 档：去掉行首 `#` 和行内小记号 */
function lightFind(find: string): string {
  return stripInlineMarks(find)
    .split('\n')
    .map((l) => l.replace(/^\s{0,3}#{1,6}[ \t]+/u, '').replace(/[ \t]+#+[ \t]*$/u, ''))
    .join('\n');
}

function inlinePlain(nodes: PmNode[] | undefined): string {
  return (nodes ?? [])
    .map((n) => {
      if (n.type === 'text') return n.text ?? '';
      if (n.type === 'inlineMath') return `$${String(n.attrs?.latex ?? '')}$`;
      if (n.type === 'mention') return `@${String(n.attrs?.label ?? '')}`;
      if (n.type === 'hardBreak') return '\n';
      return '';
    })
    .join('');
}

/** 第 3 档：把 find 当 markdown 解析，取文字（与文档这边的文本块 / 占位对应） */
function plainFind(find: string): string {
  let json: PmNode;
  try {
    json = markdownToPm(stripInlineMarks(find));
  } catch {
    return '';
  }
  const out: string[] = [];
  const walk = (n: PmNode) => {
    if (TEXTBLOCKS.has(n.type)) out.push(inlinePlain(n.content));
    else if (!n.content?.length) out.push(OBJ);
    else n.content.forEach(walk);
  };
  (json.content ?? []).forEach(walk);
  return out.join('\n\n');
}

const HEADING_LINE = /^\s{0,3}#{1,6}[ \t]/u;

interface Range {
  a: number;
  s: number;
  b: number;
  e: number;
}

function search(ix: DocIndex, hay: Flat, needle: string): Range[] {
  const out: Range[] = [];
  if (!needle) return out;
  for (let i = hay.text.indexOf(needle); i >= 0; i = hay.text.indexOf(needle, i + needle.length)) {
    let u0 = hay.map[i]!;
    let u1 = hay.map[i + needle.length - 1]!;
    while (u0 <= u1 && ix.leaf[u0] === -1) u0 += 1;
    while (u1 >= u0 && ix.leaf[u1] === -1) u1 -= 1;
    if (u0 > u1) continue;
    out.push({ a: ix.leaf[u0]!, s: ix.off[u0]!, b: ix.leaf[u1]!, e: ix.off[u1]! + ix.len[u1]! });
  }
  return out;
}

/** 按三档依次找，返回第一档的全部命中（文档顺序，不重叠） */
function locate(ix: DocIndex, find: string): Range[] {
  const exact = search(ix, flatRaw(ix.chars), find);
  if (exact.length) return exact;
  const norm = normalize(ix.chars);
  // find 以 `## ` 开头：只认从标题块开头开始的命中，不把正文里同样的字当成标题
  const wantHeading = HEADING_LINE.test(find);
  const keep = (r: Range) =>
    !wantHeading || (ix.leaves[r.a]!.el.nodeName === 'heading' && r.s === 0);
  const tried = new Set<string>();
  for (const variant of [lightFind(find), plainFind(find)]) {
    const needle = normalize([...variant]).text;
    if (!needle || tried.has(needle)) continue;
    tried.add(needle);
    const hits = search(ix, norm, needle).filter(keep);
    if (hits.length) return hits;
  }
  return [];
}

// ---------------------------------------------------------------- 找不到时的候选

function grams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const cps = [...s];
  const n = cps.length < 2 ? 1 : 2;
  for (let i = 0; i + n <= cps.length; i += 1) {
    const g = cps.slice(i, i + n).join('');
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

function dice(a: Map<string, number>, b: Map<string, number>): number {
  let inter = 0;
  let total = 0;
  for (const [g, n] of a) {
    inter += Math.min(n, b.get(g) ?? 0);
    total += n;
  }
  for (const n of b.values()) total += n;
  return total ? (2 * inter) / total : 0;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 与 find 最像的几段原文（整块较短时给整块，标题写成 `## 标题`；长段落给最像的一截） */
function suggest(ix: DocIndex, find: string): string[] {
  const needle = normalize([...plainFind(find)]).text || normalize([...lightFind(find)]).text;
  if (!needle) return [];
  const ng = grams(needle);
  const L = needle.length;
  const scored: { score: number; text: string }[] = [];
  for (const leaf of ix.leaves) {
    if (!leaf.text || leaf.end <= leaf.first) continue;
    const chars = ix.chars.slice(leaf.first, leaf.end);
    const nf = normalize(chars);
    if (!nf.text) continue;
    let score: number;
    let text: string;
    if (nf.text.length <= L * 1.5 + 10) {
      score = dice(ng, grams(nf.text));
      text = chars.join('').trim();
      if (leaf.el.nodeName === 'heading') {
        text = `${'#'.repeat(Number(leaf.el.getAttribute('level') ?? 1) || 1)} ${text}`;
      }
    } else {
      const step = Math.max(1, Math.floor(L / 4));
      let best = { score: -1, i: 0 };
      for (let i = 0; i < nf.text.length; i += step) {
        const sc = dice(ng, grams(nf.text.slice(i, i + L)));
        if (sc > best.score) best = { score: sc, i };
        if (i + L >= nf.text.length) break;
      }
      const j = Math.min(nf.text.length, best.i + L) - 1;
      score = best.score;
      text = chars
        .slice(nf.map[best.i]!, nf.map[j]! + 1)
        .join('')
        .trim();
    }
    if (score >= 0.3 && text) scored.push({ score, text: clip(text, 160) });
  }
  scored.sort((x, y) => y.score - x.score);
  return [...new Set(scored.map((s) => s.text))].slice(0, 3);
}

function notFound(ix: DocIndex, find: string): ApiError {
  const candidates = suggest(ix, find);
  const head = `文档里找不到「${clip(find, 40)}」`;
  return candidates.length
    ? new ApiError(
        'not_found',
        `${head}。最接近的原文：「${candidates[0]}」。find 照抄 read_document 读出的原文（标题行可写成「## 标题」）`,
        { candidates },
      )
    : new ApiError('not_found', `${head}，先 read_document 重读再改`);
}

// ---------------------------------------------------------------- 应用一处命中

const FORMAT_TYPES = new Set(['paragraph', 'heading']);

/** replace 解析出的第一块能否并进命中处所在的块（并进去就保留原块的格式） */
function canMerge(first: PmNode, el: Y.XmlElement, hasPrefix: boolean): boolean {
  const t = el.nodeName;
  if (first.type === t) {
    return (
      t !== 'heading' || Number(first.attrs?.level ?? 1) === Number(el.getAttribute('level') ?? 1)
    );
  }
  return first.type === 'paragraph' && hasPrefix && t !== 'codeBlock';
}

/** 同一块内、replace 是一句话：就地改文字 */
function inlineReplace(
  el: Y.XmlElement,
  s: number,
  e: number,
  replace: string,
  notes: Map<string, string>,
) {
  const nodes = markdownInlineToPm(replace, notes);
  if (nodes.some((n) => n.type !== 'text')) {
    // 带公式、提及、脚注：按 JSON 重建这一块的行内内容
    const cur = yToJson(el).content ?? [];
    const next = [
      ...sliceInline(cur, 0, s),
      ...withBase(nodes, marksAt(cur, s)),
      ...sliceInline(cur, e, Infinity),
    ];
    setInline(el, prepareInline(el, next));
    return;
  }
  const ops = inlineTextOps(nodes);
  const base = yAttrsAt(el, s);
  deleteInline(el, s, e);
  insertTextAt(
    el,
    s,
    ops.map((o) => ({ text: o.text, attrs: { ...base, ...o.attrs } })),
  );
}

/** 同一父节点下从块 A 的 s 到块 B 的 e：按块替换 */
function replaceAcross(
  A: Leaf,
  s: number,
  B: Leaf,
  e: number,
  replace: string,
  notes: Map<string, string>,
) {
  const parent = A.el.parent as Y.XmlFragment;
  const kids = parent.toArray();
  const ia = kids.indexOf(A.el);
  const ib = kids.indexOf(B.el);
  const kept = collectSpecialAttrs(kids.slice(ia, ib + 1));
  const aJson = A.text ? (yToJson(A.el).content ?? []) : [];
  const bJson = B === A ? aJson : B.text ? (yToJson(B.el).content ?? []) : [];
  const prefix = A.text ? sliceInline(aJson, 0, s) : [];
  const suffix = B.text ? sliceInline(bJson, e, Infinity) : [];
  const blocks = markdownToPm(replace, notes).content ?? [];

  // A 的新行内内容；null = A 不留
  let head: PmNode[] | null = A.text ? prefix : null;
  let rest = blocks;
  let merged = false;
  const first = blocks[0];
  if (
    first?.type === 'heading' &&
    A.el.nodeName === 'heading' &&
    !prefix.length &&
    blocks.length === 1
  ) {
    // 标题换成一个标题（agent 常把 `#` 写成 `##`）：沿用原级别，不悄悄改大纲层级
    first.attrs = { ...(first.attrs ?? {}), level: Number(A.el.getAttribute('level') ?? 1) };
  }
  if (A.text && first && canMerge(first, A.el, prefix.length > 0)) {
    head = [...prefix, ...withBase(first.content ?? [], marksAt(aJson, s))];
    rest = blocks.slice(1);
    merged = true;
  } else if (
    A.text &&
    first &&
    !prefix.length &&
    FORMAT_TYPES.has(first.type) &&
    FORMAT_TYPES.has(A.el.nodeName)
  ) {
    // 整块换成另一种块（例如标题换级别）：段落格式（对齐、间距、缩进）沿用原块
    const { level: _l, ...fmt } = A.el.getAttributes() as Record<string, unknown>;
    first.attrs = { ...fmt, ...(first.attrs ?? {}) };
  }
  if (suffix.length) {
    // 命中处之后剩下的文字：接到最后一块（保留它原来的格式）
    const last = rest[rest.length - 1];
    if (!rest.length && head !== null) head = [...head, ...suffix];
    else if (
      last &&
      TEXTBLOCKS.has(last.type) &&
      last.type !== 'codeBlock' &&
      (last.type === 'paragraph' || last.type === B.el.nodeName)
    ) {
      last.content = [...(last.content ?? []), ...suffix];
    } else {
      rest = [
        ...rest,
        {
          type: B.el.nodeName,
          attrs: B.el.getAttributes() as Record<string, unknown>,
          content: suffix,
        },
      ];
    }
  }
  const removeA = head === null || (head.length === 0 && !merged);
  const unchangedHead = !removeA && !merged && head === prefix;

  // 先把要写入的都转换、校验好，再动文档
  const restY = pmBlocksToY(rest, kept);
  const headKids = !removeA && !unchangedHead ? prepareInline(A.el, head!) : null;

  if (ib > ia) parent.delete(ia + 1, ib - ia);
  if (removeA) {
    if (restY.length) {
      parent.delete(ia, 1);
      parent.insert(ia, restY);
    } else removeBlock(A.el);
    return;
  }
  if (unchangedHead) deleteInline(A.el, s, A.size);
  else setInline(A.el, headKids!);
  if (restY.length) parent.insert(ia + 1, restY);
}

function applyRange(
  frag: Y.XmlFragment,
  ix: DocIndex,
  r: Range,
  replace: string,
  notes: Map<string, string>,
) {
  const A = ix.leaves[r.a]!;
  const B = ix.leaves[r.b]!;
  const blockReplace = /\n[ \t]*\n/u.test(replace.trim()) || HEADING_LINE.test(replace);
  if (r.a === r.b && A.text && !blockReplace) {
    if (!replace.trim() && r.s === 0 && r.e === A.size) removeBlock(A.el);
    else inlineReplace(A.el, r.s, r.e, replace, notes);
    return;
  }
  if (A.el.parent === B.el.parent) {
    replaceAcross(A, r.s, B, r.e, replace, notes);
    return;
  }
  // 跨了列表 / 表格 / 引用的边界：只接受整块覆盖（从第一个顶层块开头到最后一个顶层块末尾）
  const firstOfTop = ix.leaves.find((l) => l.top === A.top);
  const lastOfTop = [...ix.leaves].reverse().find((l) => l.top === B.top);
  if (r.s === 0 && firstOfTop === A && r.e === B.size && lastOfTop === B) {
    const old = frag.slice(A.top, B.top + 1);
    const nodes = pmBlocksToY(markdownToPm(replace, notes).content ?? [], collectSpecialAttrs(old));
    frag.delete(A.top, B.top - A.top + 1);
    if (nodes.length) frag.insert(A.top, nodes);
    return;
  }
  throw new ApiError(
    'validation_failed',
    '要替换的原文跨过了列表、表格或引用的边界，没法按文字替换。缩小 find 的范围，或用 replace_section 重写这一节',
  );
}

/**
 * replace_text（doc）：找不到 → not_found（details.candidates 是最接近的原文）；
 * occurrence 指定第几处（1 起，all=false 时有效），超出命中数 → not_found。
 */
export function replaceDocText(
  frag: Y.XmlFragment,
  find: string,
  replace: string,
  opts: { all?: boolean; occurrence?: number; notes?: Map<string, string> } = {},
): number {
  const ix = buildIndex(frag);
  const ranges = locate(ix, find);
  if (!ranges.length) throw notFound(ix, find);
  let chosen = ranges;
  if (!opts.all) {
    const k = Math.max(1, opts.occurrence ?? 1);
    const hit = ranges[k - 1];
    if (!hit) {
      throw new ApiError(
        'not_found',
        `「${clip(find, 40)}」在文档里只出现了 ${ranges.length} 处，没有第 ${k} 处`,
        { count: ranges.length },
      );
    }
    chosen = [hit];
  }
  const notes = opts.notes ?? new Map<string, string>();
  // 从后往前改：前面命中的位置不受影响
  for (const r of [...chosen].reverse()) applyRange(frag, ix, r, replace, notes);
  return chosen.length;
}

// ---------------------------------------------------------------- 标题比对（replace_section / insert_after_heading）

/** 标题比对用的键：去掉 `#`，按宽松规则规整（忽略编号前后空白、全半角标点） */
export function headingKey(s: string): string {
  return normalize([...lightFind(s.trim())]).text;
}
