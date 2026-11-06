import * as Y from 'yjs';
import { generateNKeysBetween } from 'fractional-indexing';
import {
  ApiError,
  YDOC_FIELD,
  markdownToSlideDoc,
  parseSlideDrafts,
  planSlide,
  type DocumentEdit,
  type PlannedElement,
  type PlannedSlide,
  type SlideInput,
  type SlidePmNode,
} from '@srh/shared';

/**
 * 幻灯片（slides）的服务端读写。Y 结构与前端 editors/slides/model/deck.ts 一致（见 API.md §2.7.1）：
 *
 * - `slides`：Y.Array<Y.Map>，每页 `{ id, order, v: 2, layout, elements: Y.Map<id, Y.Map>, bg?, notes: Y.Text }`；
 *   页顺序按 `order`（fractional-indexing 键，按字节序比较）排，数组下标没有意义（拖动排序只改 order）。
 * - 元素 Y.Map：`{ id, type: text|shape|image|line|table, x, y, w, h, rot, z, ph?, name?, style?, … }`，单位 pt；
 *   文本框 / 形状的文字是 `text: Y.XmlFragment`（与 Tiptap Collaboration 同格式：paragraph / bulletList /
 *   orderedList / listItem / hardBreak，标记 bold / italic / underline / strike / code / link / textStyle）；
 *   表格是 `cells: Y.Array<Y.Array<Y.Map{ text: Y.Text, … }>>`。
 * - `slidesMeta`：Y.Map `{ w, h, theme }`（页面尺寸 pt，默认 960×540 即 16:9）。
 * - 旧版页（v1，没有 v / elements）：`{ id, layout, title: Y.Text, body: Y.Text, notes: Y.Text }`，照样能读；
 *   编辑器打开时会迁移成 v2。
 *
 * 服务端新写入的页都是 v2。Markdown 怎么分页、怎么推断版式、表格 / 图片 / 长正文怎么排，全在
 * @srh/shared 的 slides-collab.ts（前端 AI 生成幻灯片用的是同一份），这里只把规划结果写成 Y 结构。
 */

export const SLIDES_META_FIELD = 'slidesMeta';

// ---------------------------------------------------------------- markdown → 草稿

/**
 * slides 的 markdown 表示（创建初始内容、agent 读写），规则见 @srh/shared slides-collab.ts：
 * `---` 或 `#` / `##` 分页（Marp / Slidev / 普通写法都行），`>` 行、非指令 HTML 注释、`备注：` 段落是演讲者备注，
 * `<!-- layout: x -->` 显式指定版式，否则按内容推断；Markdown 表格变成表格元素。
 */
export function parseSlidesMarkdown(src: string): Required<SlideInput>[] {
  return parseSlideDrafts(src);
}

// ---------------------------------------------------------------- 富文本（PM JSON 子集 ⇄ Y.XmlFragment）

type PmNode = SlidePmNode;

/** markdown 子集（段落、多级列表、标题当粗体段落、行内格式）→ PM JSON */
export function markdownToSlidePm(body: string): PmNode {
  return markdownToSlideDoc(body);
}

function cleanAttrs(attrs: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

function toYNodes(nodes: PmNode[]): Array<Y.XmlElement | Y.XmlText> {
  const out: Array<Y.XmlElement | Y.XmlText> = [];
  let texts: PmNode[] = [];
  const flush = () => {
    if (texts.length === 0) return;
    const t = new Y.XmlText();
    t.applyDelta(
      texts.map((n) => {
        const attributes: Record<string, unknown> = {};
        for (const m of n.marks ?? []) attributes[m.type] = cleanAttrs(m.attrs);
        return Object.keys(attributes).length
          ? { insert: n.text!, attributes }
          : { insert: n.text! };
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
    for (const [k, v] of Object.entries(cleanAttrs(n.attrs))) el.setAttribute(k, v as string);
    const children = toYNodes(n.content ?? []);
    if (children.length) el.insert(0, children);
    out.push(el);
  }
  flush();
  return out;
}

function fragmentFromPm(doc: PmNode): Y.XmlFragment {
  const frag = new Y.XmlFragment();
  const nodes = toYNodes(doc.content?.length ? doc.content : [{ type: 'paragraph' }]);
  if (nodes.length) frag.insert(0, nodes);
  return frag;
}

function markName(key: string): string {
  const i = key.indexOf('--');
  return i > 0 ? key.slice(0, i) : key;
}

type Delta = Array<{ insert: unknown; attributes?: Record<string, unknown> }>;

function runsMarkdown(t: Y.XmlText): string {
  return (t.toDelta() as Delta)
    .map((d) => {
      if (typeof d.insert !== 'string') return '';
      const attrs = d.attributes ?? {};
      const marks = Object.keys(attrs).map(markName);
      if (marks.includes('code')) return `\`${d.insert}\``;
      let s = d.insert;
      if (marks.includes('italic')) s = `*${s}*`;
      if (marks.includes('bold')) s = `**${s}**`;
      if (marks.includes('strike')) s = `~~${s}~~`;
      const linkKey = Object.keys(attrs).find((k) => markName(k) === 'link');
      const href = linkKey ? (attrs[linkKey] as { href?: unknown } | null)?.href : undefined;
      if (typeof href === 'string' && href) s = `[${s}](${href})`;
      return s;
    })
    .join('');
}

function inlineMarkdown(el: Y.XmlElement): string {
  return el
    .toArray()
    .map((c) =>
      c instanceof Y.XmlText
        ? runsMarkdown(c)
        : c instanceof Y.XmlElement && c.nodeName === 'hardBreak'
          ? '\n'
          : '',
    )
    .join('')
    .replace(/\*\*\*\*/gu, '');
}

/** 文本框 → markdown 子集（段落、列表、**粗体**） */
export function fragmentToMarkdown(frag: Y.XmlFragment): string {
  const out: string[] = [];
  const list = (n: Y.XmlElement, level: number) => {
    const ordered = n.nodeName === 'orderedList';
    let num = Number(n.getAttribute('start') ?? 1) || 1;
    for (const item of n.toArray()) {
      if (!(item instanceof Y.XmlElement)) continue;
      let first = true;
      for (const c of item.toArray()) {
        if (!(c instanceof Y.XmlElement)) continue;
        if (c.nodeName === 'paragraph') {
          const prefix = first ? (ordered ? `${num}. ` : '- ') : '  ';
          out.push(`${'  '.repeat(level)}${prefix}${inlineMarkdown(c)}`);
          first = false;
        } else if (c.nodeName === 'bulletList' || c.nodeName === 'orderedList') list(c, level + 1);
      }
      num += 1;
    }
  };
  for (const n of frag.toArray()) {
    if (!(n instanceof Y.XmlElement)) continue;
    if (n.nodeName === 'paragraph') {
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(inlineMarkdown(n));
    } else if (n.nodeName === 'bulletList' || n.nodeName === 'orderedList') {
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

/** 纯文本（大纲、标题） */
export function fragmentPlainText(frag: Y.XmlFragment): string {
  const lines: string[] = [];
  const visit = (n: Y.XmlElement | Y.XmlFragment) => {
    for (const c of n.toArray()) {
      if (!(c instanceof Y.XmlElement)) continue;
      if (c.nodeName === 'paragraph') {
        lines.push(
          c
            .toArray()
            .map((x) =>
              x instanceof Y.XmlText
                ? (x.toDelta() as Delta)
                    .map((d) => (typeof d.insert === 'string' ? d.insert : ''))
                    .join('')
                : x instanceof Y.XmlElement && x.nodeName === 'hardBreak'
                  ? '\n'
                  : '',
            )
            .join(''),
        );
      } else visit(c);
    }
  };
  visit(frag);
  return lines.join('\n');
}

// ---------------------------------------------------------------- 规划结果 → Y 结构

const DEFAULT_W = 960;
const DEFAULT_H = 540;

let slideSeq = 0;
function slideId(): string {
  slideSeq = (slideSeq + 1) % 1e6;
  return `sl_${Date.now().toString(36)}${slideSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function elementMap(el: PlannedElement, id: string, z: string): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set('id', id);
  m.set('type', el.type);
  m.set('rot', 0);
  m.set('x', el.x);
  m.set('y', el.y);
  m.set('w', el.w);
  m.set('h', el.h);
  m.set('z', z);
  m.set('name', el.name);
  if (el.type === 'table') {
    m.set('colW', el.colW);
    m.set('rowH', el.rowH);
    m.set('style', el.style);
    m.set('header', el.header);
    const rows = new Y.Array<Y.Array<Y.Map<unknown>>>();
    rows.push(
      el.cells.map((r) => {
        const row = new Y.Array<Y.Map<unknown>>();
        row.push(
          r.map((c) => {
            const cell = new Y.Map<unknown>();
            cell.set('text', new Y.Text(c.text));
            if (c.bold) cell.set('bold', true);
            if (c.align) cell.set('align', c.align);
            return cell;
          }),
        );
        return row;
      }),
    );
    m.set('cells', rows);
    return m;
  }
  if (el.type === 'image') {
    m.set('src', el.src);
    m.set('fit', el.fit);
    return m;
  }
  if (el.ph) m.set('ph', el.ph);
  if (el.valign) m.set('valign', el.valign);
  if (el.style) m.set('style', el.style);
  if (el.type === 'shape') {
    m.set('shape', 'rect');
    if (el.fill) m.set('fill', el.fill);
    m.set('stroke', null);
  } else {
    m.set('autofit', 'none');
    if (el.fill) m.set('fill', el.fill);
    if (el.stroke) m.set('stroke', el.stroke);
  }
  m.set('text', fragmentFromPm(el.doc));
  return m;
}

/** 一页规划 → 新页（v2）的 Y.Map */
function plannedSlideMap(p: PlannedSlide, order: string): Y.Map<unknown> {
  const id = slideId();
  const m = new Y.Map<unknown>();
  m.set('id', id);
  m.set('order', order);
  m.set('v', 2);
  m.set('layout', p.layout);
  const zs = generateNKeysBetween(null, null, p.elements.length);
  const els = new Y.Map<Y.Map<unknown>>();
  p.elements.forEach((el, i) => {
    const eid = `${id}-${el.key}`;
    els.set(eid, elementMap(el, eid, zs[i]!));
  });
  m.set('elements', els);
  if (p.bg) m.set('bg', p.bg);
  const notes = new Y.Text();
  notes.insert(0, p.notes);
  m.set('notes', notes);
  return m;
}

/** SlideInput → 页规划（正文太长 / 表格太大时一份输入会拆成几页「（续）」） */
export function planInputs(
  inputs: SlideInput[],
  size = { w: DEFAULT_W, h: DEFAULT_H },
): PlannedSlide[] {
  return inputs.flatMap((input) =>
    planSlide(
      {
        title: input.title,
        body: input.body ?? '',
        notes: input.notes ?? '',
        layout: input.layout ?? 'content',
      },
      { width: size.w, height: size.h },
      // 直接传 SlideInput 的两栏页沿用旧写法：正文里的 `---` 也算分栏
      { legacyColumns: input.layout === 'two-column' },
    ),
  );
}

// ---------------------------------------------------------------- 读

export function slidesArray(doc: Y.Doc): Y.Array<Y.Map<unknown>> {
  return doc.getArray<Y.Map<unknown>>(YDOC_FIELD.slides);
}

function deckSize(doc: Y.Doc): { w: number; h: number } {
  const meta = doc.getMap<unknown>(SLIDES_META_FIELD);
  const w = Number(meta.get('w'));
  const h = Number(meta.get('h'));
  return { w: w > 0 ? w : DEFAULT_W, h: h > 0 ? h : DEFAULT_H };
}

function textOf(v: unknown): string {
  return v instanceof Y.Text ? v.toString() : typeof v === 'string' ? v : '';
}

const isKey = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 按 order 排好的页（与前端 readSlideRefs 规则相同：没有 order 的页跟在数组里前一页后面） */
export function orderedSlides(doc: Y.Doc): Y.Map<unknown>[] {
  const items: Array<{ m: Y.Map<unknown>; k: string; flag: number; id: string; idx: number }> = [];
  let lastKey = '';
  slidesArray(doc).forEach((m, idx) => {
    if (!(m instanceof Y.Map)) return;
    const order = m.get('order');
    const has = isKey(order);
    if (has) lastKey = order;
    items.push({
      m,
      k: has ? order : lastKey,
      flag: has ? 0 : 1,
      id: String(m.get('id') ?? `idx-${idx}`),
      idx,
    });
  });
  items.sort((a, b) => cmp(a.k, b.k) || a.flag - b.flag || cmp(a.id, b.id) || a.idx - b.idx);
  return items.map((i) => i.m);
}

interface ElementInfo {
  map: Y.Map<unknown>;
  type: string;
  ph: string | null;
  z: string;
  frag: Y.XmlFragment | null;
}

function elementsOf(m: Y.Map<unknown>): ElementInfo[] {
  const els = m.get('elements');
  if (!(els instanceof Y.Map)) return [];
  const out: ElementInfo[] = [];
  (els as Y.Map<unknown>).forEach((e, key) => {
    if (!(e instanceof Y.Map)) return;
    const t = e.get('text');
    out.push({
      map: e,
      type: String(e.get('type') ?? ''),
      ph: typeof e.get('ph') === 'string' ? (e.get('ph') as string) : null,
      z: `${String(e.get('z') ?? '')}\u0000${key}`,
      frag: t instanceof Y.XmlFragment ? t : null,
    });
  });
  return out.sort((a, b) => cmp(a.z, b.z));
}

const isV2 = (m: Y.Map<unknown>) => m.get('elements') instanceof Y.Map;

/** 一页的标题与正文 markdown（v1 / v2 都行） */
export function slideContent(m: Y.Map<unknown>): {
  title: string;
  body: string;
  notes: string;
  layout: string;
} {
  const notes = textOf(m.get('notes'));
  const layout = String(m.get('layout') ?? 'content');
  if (!isV2(m))
    return { title: textOf(m.get('title')), body: textOf(m.get('body')), notes, layout };
  const els = elementsOf(m);
  let titleEl = els.find((e) => e.ph === 'title' && e.frag);
  let title = titleEl?.frag ? fragmentPlainText(titleEl.frag).replace(/\s+/gu, ' ').trim() : '';
  if (!titleEl) {
    // 没有标题占位符（导入的 PPT 常见）：第一个有字的文本框的第一行当标题；它只有这一行时不再重复进正文
    const first = els.find((e) => e.frag && fragmentPlainText(e.frag).trim());
    if (first?.frag) {
      const lines = fragmentPlainText(first.frag)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      title = (lines[0] ?? '').slice(0, 80);
      if (lines.length === 1) titleEl = first;
    }
  }
  const parts: string[] = [];
  for (const e of els) {
    if (e === titleEl) continue;
    if (e.frag) {
      const md = fragmentToMarkdown(e.frag);
      if (md) parts.push(md);
    } else if (e.type === 'table') {
      const rows = e.map.get('cells');
      if (!(rows instanceof Y.Array)) continue;
      // 加粗的单元格写成 **…**（表头本来就加粗，不写）
      const grid = (rows.toArray() as unknown[]).map((r, ri) =>
        r instanceof Y.Array
          ? (r.toArray() as unknown[]).map((c) =>
              c instanceof Y.Map
                ? c.get('hidden')
                  ? ''
                  : ri > 0 && c.get('bold') === true && textOf(c.get('text')).trim()
                    ? `**${textOf(c.get('text')).trim()}**`
                    : textOf(c.get('text'))
                : textOf(c),
            )
          : [],
      );
      if (!grid.length || !grid[0]!.length) continue;
      const line = (r: string[]) =>
        `| ${r.map((c) => c.replace(/\|/gu, '\\|').replace(/\n/gu, ' ')).join(' | ')} |`;
      parts.push(
        [
          line(grid[0]!),
          `| ${grid[0]!.map(() => '---').join(' | ')} |`,
          ...grid.slice(1).map(line),
        ].join('\n'),
      );
    } else if (e.type === 'image') {
      const src = String(e.map.get('src') ?? '');
      if (src && !src.startsWith('data:'))
        parts.push(`![${String(e.map.get('name') ?? '') || '图片'}](${src})`);
    }
  }
  return { title, body: parts.join('\n\n'), notes, layout };
}

export function slidesToMarkdown(doc: Y.Doc): string {
  const slides = orderedSlides(doc);
  if (slides.length === 0) return '（空白幻灯片）';
  return slides
    .map((m, i) => {
      const s = slideContent(m);
      const parts = [`## ${s.title || `第 ${i + 1} 页`}`];
      if (['title', 'two-column', 'section'].includes(s.layout))
        parts.push(`<!-- layout: ${s.layout} -->`);
      const body = s.body.trim();
      if (body) parts.push(body);
      const notes = s.notes.trim();
      if (notes)
        parts.push(
          notes
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n'),
        );
      return parts.join('\n\n');
    })
    .join('\n\n');
}

export function slidesOutline(doc: Y.Doc): Array<{ heading: string; level: number }> {
  return orderedSlides(doc).map((m, i) => ({
    heading: slideContent(m).title || `第 ${i + 1} 页`,
    level: 1,
  }));
}

// ---------------------------------------------------------------- 写

function appendSlides(doc: Y.Doc, inputs: SlideInput[]) {
  const arr = slidesArray(doc);
  const ordered = orderedSlides(doc);
  let last: string | null = null;
  for (const m of ordered) {
    const k = m.get('order');
    if (isKey(k) && (last === null || k > last)) last = k;
  }
  const plans = planInputs(inputs, deckSize(doc));
  const keys = generateNKeysBetween(last, null, plans.length);
  arr.push(plans.map((p, i) => plannedSlideMap(p, keys[i]!)));
}

function replaceSlides(doc: Y.Doc, inputs: SlideInput[]) {
  const arr = slidesArray(doc);
  if (arr.length) arr.delete(0, arr.length);
  const plans = planInputs(inputs, deckSize(doc));
  const keys = generateNKeysBetween(null, null, plans.length);
  arr.push(plans.map((p, i) => plannedSlideMap(p, keys[i]!)));
}

/** 在一个 Y.Text / Y.XmlText 里查找替换（XmlText 按纯文字查找，替换后的文字沿用原位置的格式） */
function replaceIn(
  t: Y.Text,
  find: string,
  replace: string,
  all: boolean,
  already: number,
): number {
  let count = 0;
  let from = 0;
  for (;;) {
    if (already + count > 0 && !all) break;
    const delta = t.toDelta() as Delta;
    const plain = delta.map((d) => (typeof d.insert === 'string' ? d.insert : '\u{fffc}')).join('');
    const idx = plain.indexOf(find, from);
    if (idx < 0) break;
    // 原位置的格式
    let pos = 0;
    let attrs: Record<string, unknown> | undefined;
    for (const d of delta) {
      const len = typeof d.insert === 'string' ? d.insert.length : 1;
      if (idx < pos + len) {
        attrs = d.attributes;
        break;
      }
      pos += len;
    }
    t.delete(idx, find.length);
    if (replace) t.insert(idx, replace, attrs ? { ...attrs } : {});
    count += 1;
    from = idx + replace.length;
  }
  return count;
}

function eachXmlText(root: Y.XmlFragment | Y.XmlElement, fn: (t: Y.XmlText) => void) {
  for (const c of root.toArray()) {
    if (c instanceof Y.XmlText) fn(c);
    else if (c instanceof Y.XmlElement) eachXmlText(c, fn);
  }
}

function replaceText(doc: Y.Doc, find: string, replace: string, all: boolean) {
  let count = 0;
  const visit = (t: Y.Text) => {
    if (count > 0 && !all) return;
    count += replaceIn(t, find, replace, all, count);
  };
  for (const m of orderedSlides(doc)) {
    if (isV2(m)) {
      for (const e of elementsOf(m)) {
        if (e.frag) eachXmlText(e.frag, visit);
        const rows = e.map.get('cells');
        if (rows instanceof Y.Array) {
          for (const r of rows.toArray() as unknown[]) {
            if (!(r instanceof Y.Array)) continue;
            for (const c of r.toArray() as unknown[]) {
              const t = c instanceof Y.Map ? c.get('text') : null;
              if (t instanceof Y.Text) visit(t);
            }
          }
        }
      }
    } else {
      for (const key of ['title', 'body']) {
        const t = m.get(key);
        if (t instanceof Y.Text) visit(t);
      }
    }
    const notes = m.get('notes');
    if (notes instanceof Y.Text) visit(notes);
  }
  if (count === 0) throw new ApiError('not_found', `幻灯片里找不到「${find.slice(0, 40)}」`);
}

function unsupported(op: string): ApiError {
  return new ApiError('bad_request', `slides 类型的文档不支持 ${op} 操作`);
}

export function applySlidesEdit(doc: Y.Doc, edit: DocumentEdit): void {
  if (edit.op === 'append_slides') return appendSlides(doc, edit.slides);
  if (edit.op === 'replace_slides') return replaceSlides(doc, edit.slides);
  if (edit.op === 'append') return appendSlides(doc, parseSlidesMarkdown(edit.markdown));
  if (edit.op === 'replace_all') return replaceSlides(doc, parseSlidesMarkdown(edit.markdown));
  if (edit.op === 'replace_text')
    return replaceText(doc, edit.find, edit.replace, Boolean(edit.all));
  throw unsupported(edit.op);
}

export function initSlides(doc: Y.Doc, markdown: string | undefined, title: string) {
  const slides = markdown?.trim()
    ? parseSlidesMarkdown(markdown)
    : [{ title, body: '', notes: '', layout: 'title' as const }];
  replaceSlides(doc, slides);
}

/** 版本恢复：整体换成 source 的页与页面设置 */
export function replaceSlidesContent(target: Y.Doc, source: Y.Doc) {
  const t = slidesArray(target);
  if (t.length) t.delete(0, t.length);
  t.push(
    slidesArray(source)
      .toArray()
      .map((m) => m.clone()),
  );
  const tm = target.getMap<unknown>(SLIDES_META_FIELD);
  const sm = source.getMap<unknown>(SLIDES_META_FIELD);
  for (const key of [...tm.keys()]) if (!sm.has(key)) tm.delete(key);
  sm.forEach((v, key) => tm.set(key, v));
}
