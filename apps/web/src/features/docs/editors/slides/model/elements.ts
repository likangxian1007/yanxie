import * as Y from 'yjs';
import { shortId } from '../../shared/dom';
import { createElementMap, getElementsMap, sortElements, type ElementInit } from './deck';
import { keyAt, keysAt } from './order';
import { readPm, writePm, type PmNode } from './richtext';
import type { SlideElement, TextAlign } from './types';

/**
 * 元素操作（都在 doc.transact(fn, origin) 里，origin 是编辑器的本地 origin，进撤销栈）。
 */

export type Patch = Record<string, unknown>;

export function ensureElementsMap(slide: Y.Map<unknown>): Y.Map<Y.Map<unknown>> {
  let els = getElementsMap(slide);
  if (!els) {
    els = new Y.Map<Y.Map<unknown>>();
    slide.set('elements', els);
    slide.set('v', 2);
  }
  return els;
}

/** 加到最上层，返回新元素 id */
export function addElements(
  doc: Y.Doc,
  slide: Y.Map<unknown>,
  current: SlideElement[],
  inits: ElementInit[],
  origin: unknown,
): string[] {
  const zs = keysAt(
    sortElements([...current]).map((e) => e.z),
    current.length,
    inits.length,
  );
  const ids: string[] = [];
  doc.transact(() => {
    const els = ensureElementsMap(slide);
    inits.forEach((init, i) => {
      const id = init.id && !els.has(init.id) ? init.id : shortId('e');
      const m = createElementMap({ ...init, id, z: zs[i] });
      els.set(id, m);
      ids.push(id);
    });
  }, origin);
  return ids;
}

export function patchElements(
  doc: Y.Doc,
  patches: Array<{ map: Y.Map<unknown> | null; patch: Patch }>,
  origin: unknown,
): void {
  if (patches.length === 0) return;
  doc.transact(() => {
    for (const { map, patch } of patches) {
      if (!map) continue;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === null) map.delete(k);
        else if (map.get(k) !== v) map.set(k, v);
      }
    }
  }, origin);
}

export function deleteElements(
  doc: Y.Doc,
  slide: Y.Map<unknown>,
  ids: string[],
  origin: unknown,
): void {
  const els = getElementsMap(slide);
  if (!els || ids.length === 0) return;
  doc.transact(() => {
    for (const id of ids) els.delete(id);
  }, origin);
}

// ---------------------------------------------------------------- 层级

export type ZMove = 'front' | 'back' | 'forward' | 'backward';

/** 计算选中元素的新 z 键（纯函数，返回 id → z） */
export function zOrderPatches(
  all: SlideElement[],
  ids: string[],
  move: ZMove,
): Map<string, string> {
  const sorted = sortElements([...all]);
  const sel = new Set(ids);
  const out = new Map<string, string>();
  const chosen = sorted.filter((e) => sel.has(e.id));
  if (chosen.length === 0) return out;
  const others = sorted.filter((e) => !sel.has(e.id));
  const keys = others.map((e) => e.z);
  let index: number;
  if (move === 'front') index = others.length;
  else if (move === 'back') index = 0;
  else if (move === 'forward') {
    // 放到选中最上面那个元素之上的第一个非选中元素后面
    const top = sorted.indexOf(chosen[chosen.length - 1]!);
    const above = sorted.slice(top + 1).find((e) => !sel.has(e.id));
    index = above ? others.indexOf(above) + 1 : others.length;
  } else {
    const bottom = sorted.indexOf(chosen[0]!);
    const below = [...sorted.slice(0, bottom)].reverse().find((e) => !sel.has(e.id));
    index = below ? others.indexOf(below) : 0;
  }
  const nk = keysAt(keys, index, chosen.length);
  chosen.forEach((e, i) => out.set(e.id, nk[i]!));
  return out;
}

export function nextZ(all: SlideElement[]): string {
  const keys = sortElements([...all]).map((e) => e.z);
  return keyAt(keys, keys.length);
}

// ---------------------------------------------------------------- 对齐 / 分布

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function boundsOf(rects: Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 一个元素：对齐到页面；多个：对齐到选区外框 */
export function alignRects<T extends Rect & { id: string }>(
  items: T[],
  mode: AlignMode,
  page: { width: number; height: number },
): Map<string, { x: number; y: number }> {
  const ref = items.length === 1 ? { x: 0, y: 0, w: page.width, h: page.height } : boundsOf(items);
  const out = new Map<string, { x: number; y: number }>();
  for (const it of items) {
    let { x, y } = it;
    if (mode === 'left') x = ref.x;
    else if (mode === 'hcenter') x = ref.x + (ref.w - it.w) / 2;
    else if (mode === 'right') x = ref.x + ref.w - it.w;
    else if (mode === 'top') y = ref.y;
    else if (mode === 'vcenter') y = ref.y + (ref.h - it.h) / 2;
    else y = ref.y + ref.h - it.h;
    out.set(it.id, { x: round(x), y: round(y) });
  }
  return out;
}

/** 等间距分布（至少 3 个） */
export function distributeRects<T extends Rect & { id: string }>(
  items: T[],
  axis: 'h' | 'v',
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (items.length < 3) return out;
  const sorted = [...items].sort((a, b) => (axis === 'h' ? a.x - b.x : a.y - b.y));
  const b = boundsOf(sorted);
  const total = sorted.reduce((s, r) => s + (axis === 'h' ? r.w : r.h), 0);
  const gap = ((axis === 'h' ? b.w : b.h) - total) / (sorted.length - 1);
  let cur = axis === 'h' ? b.x : b.y;
  for (const r of sorted) {
    out.set(r.id, axis === 'h' ? { x: round(cur), y: r.y } : { x: r.x, y: round(cur) });
    cur += (axis === 'h' ? r.w : r.h) + gap;
  }
  return out;
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------- 组合

/** 选中一个组合成员时，整组一起选中 */
export function expandGroups(all: SlideElement[], ids: string[]): string[] {
  const groups = new Set(
    all.filter((e) => ids.includes(e.id) && e.group).map((e) => e.group as string),
  );
  if (groups.size === 0) return ids;
  const out = new Set(ids);
  for (const e of all) if (e.group && groups.has(e.group)) out.add(e.id);
  return [...out];
}

// ---------------------------------------------------------------- 文字格式（整个文本框）

type Delta = Array<{ insert: unknown; attributes?: Record<string, unknown> }>;

function eachXmlText(root: Y.XmlFragment | Y.XmlElement, fn: (t: Y.XmlText) => void) {
  for (const c of root.toArray()) {
    if (c instanceof Y.XmlText) fn(c);
    else if (c instanceof Y.XmlElement) eachXmlText(c, fn);
  }
}

function eachElement(root: Y.XmlFragment | Y.XmlElement, fn: (e: Y.XmlElement) => void) {
  for (const c of root.toArray()) {
    if (c instanceof Y.XmlElement) {
      fn(c);
      eachElement(c, fn);
    }
  }
}

/**
 * 对整个文本框的文字加 / 去一个标记（bold 等），或合并 textStyle 属性（color、fontSize、fontFamily）。
 * 直接对 Y.XmlText 做 format，和别人同时打字可以合并。
 */
export function formatFragment(
  frag: Y.XmlFragment,
  mark: string,
  value: Record<string, unknown> | null,
): void {
  eachXmlText(frag, (t) => {
    const delta = t.toDelta() as Delta;
    let pos = 0;
    for (const d of delta) {
      const len = typeof d.insert === 'string' ? d.insert.length : 1;
      if (mark === 'textStyle') {
        const attrs = d.attributes ?? {};
        const merged: Record<string, unknown> = {};
        const clear: Record<string, null> = {};
        for (const [k, v] of Object.entries(attrs)) {
          if (k === 'textStyle' || k.startsWith('textStyle--')) {
            Object.assign(merged, v as object);
            if (k !== 'textStyle') clear[k] = null;
          }
        }
        for (const [k, v] of Object.entries(value ?? {})) {
          if (v === null || v === undefined) delete merged[k];
          else merged[k] = v;
        }
        t.format(pos, len, {
          ...clear,
          textStyle: Object.keys(merged).length ? merged : null,
        });
      } else {
        t.format(pos, len, { [mark]: value });
      }
      pos += len;
    }
  });
}

/** 整个文本框是否都带某个标记 */
export function fragmentHasMark(doc: PmNode, mark: string): boolean {
  let any = false;
  let all = true;
  const visit = (n: PmNode) => {
    if (n.type === 'text' && n.text) {
      any = true;
      if (!n.marks?.some((m) => m.type === mark)) all = false;
    }
    n.content?.forEach(visit);
  };
  visit(doc);
  return any && all;
}

export function setParagraphAttr(frag: Y.XmlFragment, key: string, value: unknown): void {
  eachElement(frag, (el) => {
    if (el.nodeName !== 'paragraph') return;
    if (value === null || value === undefined) el.removeAttribute(key);
    else el.setAttribute(key, value as string);
  });
}

/** 段落 ↔ 项目符号 / 编号列表（整个文本框） */
export function toggleListPm(doc: PmNode, kind: 'bulletList' | 'orderedList'): PmNode {
  const top = doc.content ?? [];
  const allList = top.length > 0 && top.every((n) => n.type === kind);
  const paragraphs: PmNode[] = [];
  const collect = (n: PmNode) => {
    if (n.type === 'paragraph') paragraphs.push(n);
    else n.content?.forEach(collect);
  };
  top.forEach(collect);
  if (allList)
    return { type: 'doc', content: paragraphs.length ? paragraphs : [{ type: 'paragraph' }] };
  return {
    type: 'doc',
    content: [
      {
        type: kind,
        content: (paragraphs.length ? paragraphs : [{ type: 'paragraph' }]).map((p) => ({
          type: 'listItem',
          content: [p],
        })),
      },
    ],
  };
}

export function toggleListFragment(frag: Y.XmlFragment, kind: 'bulletList' | 'orderedList') {
  writePm(frag, toggleListPm(readPm(frag), kind));
}

export function alignValue(v: unknown): TextAlign | null {
  return v === 'left' || v === 'center' || v === 'right' || v === 'justify' ? v : null;
}

// ---------------------------------------------------------------- 复制粘贴

export const CLIPBOARD_PREFIX = 'srh-slides-elements:';

export function elementToInit(el: SlideElement): ElementInit {
  const { map: _map, ...rest } = el as SlideElement & { frag?: unknown };
  const init = { ...rest } as Record<string, unknown>;
  delete init.frag;
  if (el.type === 'table') {
    init.cells = el.cells.map((r) => r.map(({ ytext: _y, map: _m, ...c }) => ({ ...c })));
  }
  return init as unknown as ElementInit;
}

export function serializeElements(els: SlideElement[]): string {
  return CLIPBOARD_PREFIX + JSON.stringify(els.map(elementToInit));
}

export function parseClipboard(text: string): ElementInit[] | null {
  if (!text.startsWith(CLIPBOARD_PREFIX)) return null;
  try {
    const list = JSON.parse(text.slice(CLIPBOARD_PREFIX.length)) as ElementInit[];
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/** 粘贴 / 复制一份：新 id、组合 id 重新分配、错开一点位置 */
export function cloneInits(inits: ElementInit[], offset: number): ElementInit[] {
  const groups = new Map<string, string>();
  return inits.map((i) => {
    const g = i.group ? (groups.get(i.group) ?? shortId('g')) : null;
    if (i.group && g) groups.set(i.group, g);
    return {
      ...i,
      id: shortId('e'),
      z: undefined,
      group: g,
      ph: null,
      x: (i.x ?? 0) + offset,
      y: (i.y ?? 0) + offset,
    };
  });
}
