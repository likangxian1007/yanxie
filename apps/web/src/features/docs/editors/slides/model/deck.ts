import * as Y from 'yjs';
import { YDOC_FIELD } from '@srh/shared';
import { shortId } from '../../shared/dom';
import { splitColumns } from '../lib/markdown';
import { cmpKey, initialKeys, isKey, keyAt, keysAt } from './order';
import { emptyDoc, fragmentFromPm, pmPlainText, readPm, type PmNode } from './richtext';
import {
  DEFAULT_SIZE,
  DEFAULT_THEME,
  THEMES,
  isLayoutId,
  layoutElements,
  legacyContent,
  resolveToken,
  type PlaceholderContent,
} from './themes';
import type {
  ArrowKind,
  Background,
  DeckInfo,
  ElementType,
  Fill,
  ImageElement,
  LayoutId,
  LineElement,
  PlaceholderKind,
  ShapeElement,
  SlideElement,
  SlideModel,
  Stroke,
  TableCell,
  TableElement,
  TextElement,
  TextStyle,
  Theme,
} from './types';

/**
 * 幻灯片在 Y.Doc 里的结构（与服务端 documents/slides.ts 共用，改动需两边同步）：
 *
 * Y.Array `slides`：每页一个 Y.Map
 *   id: string                    页 id
 *   order: string                 排序键（fractional-indexing）；页面顺序 = 按 order 排序，不看数组下标
 *   v: 2                          新模型标记；没有 v 的是旧版固定版式页（title/body Y.Text），打开时迁移
 *   layout: LayoutId              母版版式（决定占位符位置）
 *   elements: Y.Map<id, Y.Map>    元素（见下）
 *   bg: Fill | undefined          背景；没有时用主题背景色
 *   notes: Y.Text                 演讲者备注
 *   （旧版字段 title / body：Y.Text，迁移后删除）
 *
 * 元素 Y.Map：id、type（text/shape/image/line/table）、x/y/w/h（pt）、rot（度）、z（层级键）、
 *   group（组合 id）、ph（占位符：title/subtitle/body）、name、flipH/flipV；
 *   text/shape：text = Y.XmlFragment（Tiptap 富文本）、style（默认文字样式）、valign、fill、stroke、pad、autofit；
 *   shape：shape（OOXML 预设名）、path/vb（自定义路径）；
 *   image：src、fileId、fit、crop、geom、stroke；line：stroke、start/end（箭头）；
 *   table：cells = Y.Array<Y.Array<Y.Map{ text: Y.Text, fill, color, bold, italic, align, fontSize, colSpan, rowSpan, hidden }>>、
 *          colW / rowH（pt 数组）、border、style、header。
 *
 * Y.Map `slidesMeta`：w、h（页面尺寸 pt）、theme（Theme 对象）。
 */

export const SLIDES_META_FIELD = 'slidesMeta';

export function getSlidesArray(doc: Y.Doc): Y.Array<Y.Map<unknown>> {
  return doc.getArray<Y.Map<unknown>>(YDOC_FIELD.slides);
}

export function getDeckMeta(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(SLIDES_META_FIELD);
}

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
function str(v: unknown, d: string): string {
  return typeof v === 'string' ? v : d;
}
function obj<T>(v: unknown): T | null {
  return v && typeof v === 'object' && !(v instanceof Y.AbstractType) ? (v as T) : null;
}

export function readTheme(v: unknown): Theme {
  const t = obj<Partial<Theme>>(v);
  if (!t) return DEFAULT_THEME;
  const base = THEMES.find((x) => x.id === t.id) ?? DEFAULT_THEME;
  return {
    ...base,
    ...t,
    colors: Array.isArray(t.colors) && t.colors.length ? t.colors : base.colors,
  } as Theme;
}

export function readDeckInfo(meta: Y.Map<unknown>): DeckInfo {
  return {
    width: num(meta.get('w'), DEFAULT_SIZE.width),
    height: num(meta.get('h'), DEFAULT_SIZE.height),
    theme: readTheme(meta.get('theme')),
  };
}

export function textOf(v: unknown): string {
  if (v instanceof Y.Text) return v.toString();
  if (typeof v === 'string') return v;
  return '';
}

// ---------------------------------------------------------------- 页顺序

export interface SlideRef {
  id: string;
  order: string;
  map: Y.Map<unknown>;
}

/**
 * 按 order 排好的页列表。没有 order 的页（旧数据 / 旧客户端写入）排在数组里它前一页的后面，
 * 各端得到相同的顺序；可编辑时 normalizeDeck 会给它们补上键。
 */
export function readSlideRefs(arr: Y.Array<Y.Map<unknown>>): SlideRef[] {
  const items: Array<{ ref: SlideRef; k: string; flag: number; idx: number }> = [];
  const seen = new Set<string>();
  let lastKey = '';
  arr.forEach((map, idx) => {
    if (!(map instanceof Y.Map)) return;
    let id = map.get('id');
    if (typeof id !== 'string' || !id || seen.has(id)) id = `idx-${idx}`;
    seen.add(id as string);
    const order = map.get('order');
    const has = isKey(order);
    if (has) lastKey = order;
    items.push({
      ref: { id: id as string, order: has ? order : '', map },
      k: has ? order : lastKey,
      flag: has ? 0 : 1,
      idx,
    });
  });
  items.sort(
    (a, b) => cmpKey(a.k, b.k) || a.flag - b.flag || cmpKey(a.ref.id, b.ref.id) || a.idx - b.idx,
  );
  return items.map((i) => i.ref);
}

/** 只在顺序 / 成员变化时返回新数组（给 React 用，避免每次按键都重渲染整个编辑器） */
export function sameRefs(a: SlideRef[], b: SlideRef[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.order !== y.order || x.map !== y.map) return false;
  }
  return true;
}

// ---------------------------------------------------------------- 元素读写

const ELEMENT_TYPES: readonly ElementType[] = ['text', 'shape', 'image', 'line', 'table'];
const PH: readonly PlaceholderKind[] = ['title', 'subtitle', 'body'];
const ARROWS: readonly ArrowKind[] = ['none', 'arrow', 'triangle', 'stealth', 'oval', 'diamond'];

function defaultTextStyle(theme: Theme, type: ElementType): TextStyle {
  if (type === 'shape')
    return { fontSize: 18, color: '#FFFFFF', fontFamily: theme.bodyFont, align: 'center' };
  if (type === 'table') return { fontSize: 14, color: theme.fg, fontFamily: theme.bodyFont };
  return { fontSize: 18, color: theme.fg, fontFamily: theme.bodyFont };
}

function readFill(v: unknown, theme: Theme = DEFAULT_THEME): Fill | null {
  const f = obj<Fill>(v);
  if (!f || typeof f.type !== 'string') return null;
  if (f.type === 'color') return { type: 'color', color: resolveToken(String(f.color), theme) };
  if (f.type === 'gradient')
    return {
      ...f,
      stops: (f.stops ?? []).map((s) => ({ ...s, color: resolveToken(String(s.color), theme) })),
    };
  return f;
}

function readStroke(v: unknown, theme: Theme = DEFAULT_THEME): Stroke | null {
  const s = obj<Stroke>(v);
  if (!s || typeof s.color !== 'string') return null;
  return { color: resolveToken(s.color, theme), width: num(s.width, 1), dash: s.dash ?? 'solid' };
}

function resolveStyle(s: TextStyle, theme: Theme): TextStyle {
  return {
    ...s,
    color: resolveToken(String(s.color), theme),
    fontFamily: resolveToken(String(s.fontFamily), theme),
  };
}

function readCell(m: unknown): TableCell {
  if (!(m instanceof Y.Map)) {
    return {
      text: typeof m === 'string' ? m : '',
      ytext: null,
      map: null,
      fill: null,
      color: null,
      bold: false,
      italic: false,
      align: null,
      fontSize: null,
      colSpan: 1,
      rowSpan: 1,
      hidden: false,
    };
  }
  const t = m.get('text');
  return {
    text: textOf(t),
    ytext: t instanceof Y.Text ? t : null,
    map: m,
    fill: typeof m.get('fill') === 'string' ? (m.get('fill') as string) : null,
    color: typeof m.get('color') === 'string' ? (m.get('color') as string) : null,
    bold: m.get('bold') === true,
    italic: m.get('italic') === true,
    align: (m.get('align') as TableCell['align']) ?? null,
    fontSize: typeof m.get('fontSize') === 'number' ? (m.get('fontSize') as number) : null,
    colSpan: Math.max(1, num(m.get('colSpan'), 1)),
    rowSpan: Math.max(1, num(m.get('rowSpan'), 1)),
    hidden: m.get('hidden') === true,
  };
}

export function readElement(map: Y.Map<unknown>, theme: Theme): SlideElement | null {
  const type = map.get('type') as ElementType;
  if (!ELEMENT_TYPES.includes(type)) return null;
  const ph = map.get('ph') as PlaceholderKind;
  const base = {
    id: str(map.get('id'), ''),
    type,
    x: num(map.get('x'), 0),
    y: num(map.get('y'), 0),
    w: Math.max(1, num(map.get('w'), 100)),
    h: Math.max(0, num(map.get('h'), 50)),
    rot: num(map.get('rot'), 0),
    z: str(map.get('z'), ''),
    group: typeof map.get('group') === 'string' ? (map.get('group') as string) : null,
    ph: PH.includes(ph) ? ph : null,
    name: str(map.get('name'), ''),
    flipH: map.get('flipH') === true,
    flipV: map.get('flipV') === true,
    map,
  };
  if (type === 'text' || type === 'shape') {
    const frag = map.get('text');
    const style = resolveStyle(
      { ...defaultTextStyle(theme, type), ...(obj<TextStyle>(map.get('style')) ?? {}) },
      theme,
    );
    const pad = map.get('pad');
    const textProps = {
      doc: frag instanceof Y.XmlFragment ? readPm(frag) : emptyDoc(),
      frag: frag instanceof Y.XmlFragment ? frag : null,
      style,
      valign: (['top', 'middle', 'bottom'] as const).includes(map.get('valign') as 'top')
        ? (map.get('valign') as TextElement['valign'])
        : type === 'shape'
          ? 'middle'
          : 'top',
      fill: readFill(map.get('fill'), theme),
      stroke: readStroke(map.get('stroke'), theme),
      pad: (Array.isArray(pad) && pad.length === 4 ? pad : [7.2, 3.6, 7.2, 3.6]) as [
        number,
        number,
        number,
        number,
      ],
      autofit: (['none', 'grow', 'shrink'] as const).includes(map.get('autofit') as 'none')
        ? (map.get('autofit') as TextElement['autofit'])
        : 'none',
      fontScale: num(map.get('fontScale'), 1),
      vertical: map.get('vertical') === true,
    };
    if (type === 'text') return { ...base, type, ...textProps } as TextElement;
    const vb = map.get('vb');
    return {
      ...base,
      type,
      ...textProps,
      shape: str(map.get('shape'), 'rect'),
      path: typeof map.get('path') === 'string' ? (map.get('path') as string) : null,
      vb: Array.isArray(vb) && vb.length === 2 ? (vb as [number, number]) : null,
    } as ShapeElement;
  }
  if (type === 'image') {
    const crop = obj<ImageElement['crop']>(map.get('crop'));
    const geom = map.get('geom');
    return {
      ...base,
      type,
      src: str(map.get('src'), ''),
      fileId: typeof map.get('fileId') === 'string' ? (map.get('fileId') as string) : null,
      fit: (['fill', 'contain', 'cover'] as const).includes(map.get('fit') as 'fill')
        ? (map.get('fit') as ImageElement['fit'])
        : 'fill',
      crop,
      stroke: readStroke(map.get('stroke')),
      geom: geom === 'roundRect' || geom === 'ellipse' ? geom : 'rect',
    } as ImageElement;
  }
  if (type === 'line') {
    const start = map.get('start') as ArrowKind;
    const end = map.get('end') as ArrowKind;
    return {
      ...base,
      type,
      stroke: readStroke(map.get('stroke'), theme) ?? { color: theme.fg, width: 2, dash: 'solid' },
      start: ARROWS.includes(start) ? start : 'none',
      end: ARROWS.includes(end) ? end : 'none',
    } as LineElement;
  }
  // table
  const rows = map.get('cells');
  const cells: TableCell[][] =
    rows instanceof Y.Array
      ? rows.toArray().map((r) => (r instanceof Y.Array ? r.toArray().map(readCell) : []))
      : [];
  const nCols = Math.max(1, ...cells.map((r) => r.length));
  const colW = Array.isArray(map.get('colW')) ? (map.get('colW') as number[]) : [];
  const rowH = Array.isArray(map.get('rowH')) ? (map.get('rowH') as number[]) : [];
  return {
    ...base,
    type: 'table',
    cells,
    colW: Array.from({ length: nCols }, (_, i) => num(colW[i], base.w / nCols)),
    rowH: Array.from({ length: cells.length }, (_, i) => num(rowH[i], 0)),
    border: map.has('border') ? readStroke(map.get('border')) : { color: '#BFC5CD', width: 1 },
    style: resolveStyle(
      { ...defaultTextStyle(theme, 'table'), ...(obj<TextStyle>(map.get('style')) ?? {}) },
      theme,
    ),
    header: map.get('header') !== false,
  } as TableElement;
}

/** 新建元素时可传的字段（缺省按类型补默认值） */
export type CellInit = Partial<Omit<TableCell, 'ytext' | 'map'>>;
export type ElementInit = {
  type: ElementType;
  id?: string;
  doc?: PmNode;
  cells?: CellInit[][];
} & Partial<
  Omit<TextElement, 'type' | 'map' | 'frag' | 'doc' | 'style'> &
    Omit<ShapeElement, 'type' | 'map' | 'frag' | 'doc' | 'style'> &
    Omit<ImageElement, 'type' | 'map' | 'stroke'> &
    Omit<LineElement, 'type' | 'map' | 'stroke'> &
    Omit<TableElement, 'type' | 'map' | 'cells' | 'style'>
> & { stroke?: Stroke | null; style?: Partial<TextStyle> };

const SIMPLE_KEYS = [
  'x',
  'y',
  'w',
  'h',
  'rot',
  'z',
  'group',
  'ph',
  'name',
  'flipH',
  'flipV',
  'valign',
  'fill',
  'stroke',
  'pad',
  'autofit',
  'fontScale',
  'vertical',
  'shape',
  'path',
  'vb',
  'src',
  'fileId',
  'fit',
  'crop',
  'geom',
  'start',
  'end',
  'colW',
  'rowH',
  'border',
  'header',
] as const;

export function createCellMap(init: CellInit = {}): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set('text', new Y.Text(init.text ?? ''));
  for (const k of ['fill', 'color', 'bold', 'italic', 'align', 'fontSize'] as const) {
    const v = init[k];
    if (v !== null && v !== undefined && v !== false) m.set(k, v);
  }
  if (init.colSpan && init.colSpan > 1) m.set('colSpan', init.colSpan);
  if (init.rowSpan && init.rowSpan > 1) m.set('rowSpan', init.rowSpan);
  if (init.hidden) m.set('hidden', true);
  return m;
}

/** 元素 → 新的 Y.Map（还没挂进文档） */
export function createElementMap(init: ElementInit): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set('id', init.id ?? shortId('e'));
  m.set('type', init.type);
  if (init.rot === undefined) m.set('rot', 0);
  for (const k of SIMPLE_KEYS) {
    const v = (init as Record<string, unknown>)[k];
    if (v !== undefined) m.set(k, v);
  }
  if (init.style) m.set('style', init.style);
  if (init.type === 'text' || init.type === 'shape') {
    m.set('text', fragmentFromPm(init.doc ?? emptyDoc()));
  }
  if (init.type === 'table') {
    const rows = new Y.Array<Y.Array<Y.Map<unknown>>>();
    rows.push(
      (init.cells ?? []).map((r) => {
        const row = new Y.Array<Y.Map<unknown>>();
        row.push(r.map(createCellMap));
        return row;
      }),
    );
    m.set('cells', rows);
  }
  return m;
}

export function getElementsMap(slide: Y.Map<unknown>): Y.Map<Y.Map<unknown>> | null {
  const v = slide.get('elements');
  return v instanceof Y.Map ? (v as Y.Map<Y.Map<unknown>>) : null;
}

export function sortElements<T extends { z: string; id: string }>(els: T[]): T[] {
  return els.sort((a, b) => cmpKey(a.z, b.z) || cmpKey(a.id, b.id));
}

// ---------------------------------------------------------------- 页快照

/** 旧版页（v1）现场转换出的元素（只读渲染用；迁移时写进文档的是同样的东西） */
function legacyInits(map: Y.Map<unknown>, id: string, deck: DeckInfo) {
  const layout = str(map.get('layout'), 'content');
  const content: PlaceholderContent = legacyContent(
    layout,
    textOf(map.get('title')),
    textOf(map.get('body')),
    splitColumns,
  );
  const lid: LayoutId = isLayoutId(layout) ? layout : 'content';
  const inits = layoutElements(lid, deck, `${id}-`, content);
  const keys = initialKeys(inits.length);
  return { layout: lid, inits: inits.map((e, i) => ({ ...e, z: keys[i] })) };
}

function initToElement(init: ElementInit, theme: Theme): SlideElement | null {
  // 用临时文档挂一下，复用 readElement 的默认值逻辑
  const tmp = new Y.Doc();
  const holder = tmp.getMap<Y.Map<unknown>>('t');
  holder.set('e', createElementMap(init));
  const el = readElement(holder.get('e')!, theme);
  return el
    ? ({
        ...el,
        map: null,
        ...(el.type === 'text' || el.type === 'shape' ? { frag: null } : {}),
      } as SlideElement)
    : null;
}

export function readSlide(ref: SlideRef, deck: DeckInfo): SlideModel {
  const { map } = ref;
  const notes = textOf(map.get('notes'));
  const bg = readFill(map.get('bg'), deck.theme);
  const els = getElementsMap(map);
  let elements: SlideElement[];
  let layout: LayoutId;
  let version: 1 | 2;
  if (map.get('v') === 2 || els) {
    version = 2;
    layout = isLayoutId(map.get('layout')) ? (map.get('layout') as LayoutId) : 'blank';
    elements = [];
    els?.forEach((m) => {
      if (!(m instanceof Y.Map)) return;
      const el = readElement(m, deck.theme);
      if (el) elements.push(el);
    });
    sortElements(elements);
  } else {
    version = 1;
    const legacy = legacyInits(map, ref.id, deck);
    layout = legacy.layout;
    elements = legacy.inits
      .map((i) => initToElement(i as ElementInit, deck.theme))
      .filter((e): e is SlideElement => e !== null);
  }
  return {
    id: ref.id,
    order: ref.order,
    map,
    layout,
    version,
    bg: bg as Background | null,
    elements,
    notes,
    title: slideTitle(elements),
  };
}

export function slideTitle(elements: SlideElement[]): string {
  const title = elements.find((e) => e.ph === 'title' && (e.type === 'text' || e.type === 'shape'));
  if (title && (title.type === 'text' || title.type === 'shape')) {
    const t = pmPlainText(title.doc).replace(/\s+/gu, ' ').trim();
    if (t) return t;
  }
  for (const e of elements) {
    if (e.type !== 'text' && e.type !== 'shape') continue;
    const line = pmPlainText(e.doc)
      .split('\n')
      .find((l) => l.trim());
    if (line) return line.trim().slice(0, 80);
  }
  return '';
}

// ---------------------------------------------------------------- 迁移 / 规整

/**
 * 打开时（可编辑、已同步）调用：给旧版页迁移成元素、补 order 键、补 notes Y.Text。
 * 用独立 origin，不进撤销栈。迁移结果确定（元素 id 由页 id 推出），两人同时迁移也不会多出元素。
 */
export function normalizeDeck(doc: Y.Doc, origin: unknown = 'slides-migrate'): boolean {
  const arr = getSlidesArray(doc);
  const deck = readDeckInfo(getDeckMeta(doc));
  const refs = readSlideRefs(arr);
  const needsOrder = refs.some((r) => !r.order);
  const needs = refs.filter(
    (r) =>
      !(r.map.get('v') === 2 && getElementsMap(r.map)) ||
      !(r.map.get('notes') instanceof Y.Text) ||
      typeof r.map.get('id') !== 'string',
  );
  if (!needsOrder && needs.length === 0) return false;
  doc.transact(() => {
    if (needsOrder) {
      // 旧数据全部没有键：按当前顺序一次性生成（确定性的）；部分缺失：插到前后键之间
      if (refs.every((r) => !r.order)) {
        const keys = initialKeys(refs.length);
        refs.forEach((r, i) => r.map.set('order', keys[i]!));
      } else {
        const keys = refs.map((r) => r.order);
        refs.forEach((r, i) => {
          if (r.order) return;
          const k = keyAt(keys, i);
          keys[i] = k;
          r.map.set('order', k);
        });
      }
    }
    for (const r of needs) {
      const m = r.map;
      if (typeof m.get('id') !== 'string') m.set('id', r.id);
      if (!(m.get('v') === 2 && getElementsMap(m))) migrateSlide(m, r.id, deck);
      if (!(m.get('notes') instanceof Y.Text)) m.set('notes', new Y.Text(textOf(m.get('notes'))));
    }
  }, origin);
  return true;
}

function migrateSlide(map: Y.Map<unknown>, id: string, deck: DeckInfo) {
  const existing = getElementsMap(map);
  if (existing) {
    map.set('v', 2);
    return;
  }
  const { layout, inits } = legacyInits(map, id, deck);
  const els = new Y.Map<Y.Map<unknown>>();
  for (const init of inits) els.set(init.id as string, createElementMap(init as ElementInit));
  map.set('elements', els);
  map.set('layout', layout);
  map.set('v', 2);
  map.delete('title');
  map.delete('body');
}

// ---------------------------------------------------------------- 页操作

export interface NewSlide {
  layout?: LayoutId;
  content?: PlaceholderContent;
  notes?: string;
  elements?: ElementInit[];
  bg?: Background | null;
}

export function createSlideMap(
  slide: NewSlide,
  deck: DeckInfo,
  order: string,
  id = shortId('sl_'),
) {
  const m = new Y.Map<unknown>();
  m.set('id', id);
  m.set('order', order);
  m.set('v', 2);
  const layout = slide.layout ?? 'blank';
  m.set('layout', layout);
  const inits: ElementInit[] = [
    ...(slide.elements ? [] : layoutElements(layout, deck, `${id}-`, slide.content)),
    ...(slide.elements ?? []),
  ];
  const zs = initialKeys(inits.length);
  const els = new Y.Map<Y.Map<unknown>>();
  inits.forEach((init, i) => {
    // 注意：未挂进文档的 Y.Map 读不到自己的字段，id 要先算好
    const eid = init.id ?? shortId('e');
    els.set(eid, createElementMap({ ...init, id: eid, z: init.z ?? zs[i] }));
  });
  m.set('elements', els);
  if (slide.bg) m.set('bg', slide.bg);
  m.set('notes', new Y.Text(slide.notes ?? ''));
  return m;
}

/** 在排好序的第 index 位插入若干页（index = refs.length 为末尾），返回新页 id */
export function insertSlides(
  doc: Y.Doc,
  index: number,
  slides: NewSlide[],
  origin: unknown,
): string[] {
  const arr = getSlidesArray(doc);
  const deck = readDeckInfo(getDeckMeta(doc));
  const refs = readSlideRefs(arr);
  const at = Math.max(0, Math.min(refs.length, index));
  const keys = keysAt(
    refs.map((r) => r.order || ''),
    at,
    slides.length,
  );
  const maps = slides.map((s, i) => createSlideMap(s, deck, keys[i]!));
  doc.transact(() => arr.push(maps), origin);
  return maps.map((m) => m.get('id') as string);
}

/** 插入现成的页 Y.Map（复制、粘贴、导入），会重新分配 id 与 order */
export function insertSlideMaps(
  doc: Y.Doc,
  index: number,
  maps: Y.Map<unknown>[],
  origin: unknown,
): string[] {
  const arr = getSlidesArray(doc);
  const refs = readSlideRefs(arr);
  const at = Math.max(0, Math.min(refs.length, index));
  const keys = keysAt(
    refs.map((r) => r.order || ''),
    at,
    maps.length,
  );
  const ids: string[] = [];
  maps.forEach((m, i) => {
    const id = shortId('sl_');
    m.set('id', id);
    m.set('order', keys[i]!);
    ids.push(id);
  });
  doc.transact(() => arr.push(maps), origin);
  return ids;
}

export function deleteSlide(doc: Y.Doc, map: Y.Map<unknown>, origin: unknown): void {
  const arr = getSlidesArray(doc);
  doc.transact(() => {
    let i = -1;
    arr.forEach((m, idx) => {
      if (m === map) i = idx;
    });
    if (i >= 0) arr.delete(i, 1);
  }, origin);
}

export function duplicateSlide(doc: Y.Doc, ref: SlideRef, origin: unknown): string | null {
  const refs = readSlideRefs(getSlidesArray(doc));
  const i = refs.findIndex((r) => r.map === ref.map);
  if (i < 0) return null;
  const copy = ref.map.clone() as Y.Map<unknown>;
  // 旧版页的 title / body 也一起复制了；迁移逻辑会处理
  return insertSlideMaps(doc, i + 1, [copy], origin)[0] ?? null;
}

/**
 * 真正的移动：只改这一页的 order 键。页里的元素、正在编辑的文字都还是原来那个 Y.Map，
 * 别人同时做的修改不会丢；两人同时把同一页拖到不同位置时，最后写入的那个生效。
 */
export function moveSlide(doc: Y.Doc, from: number, to: number, origin: unknown): void {
  const refs = readSlideRefs(getSlidesArray(doc));
  if (from === to || from < 0 || from >= refs.length || to < 0 || to >= refs.length) return;
  const moving = refs[from]!;
  const rest = refs.filter((_, i) => i !== from);
  const keys = rest.map((r) => r.order || '');
  const key = keyAt(keys, to);
  doc.transact(() => moving.map.set('order', key), origin);
}

export function setSlideBackground(
  doc: Y.Doc,
  map: Y.Map<unknown>,
  bg: Background | null,
  origin: unknown,
) {
  doc.transact(() => {
    if (bg) map.set('bg', bg);
    else map.delete('bg');
  }, origin);
}

export function setDeckMeta(
  doc: Y.Doc,
  patch: { w?: number; h?: number; theme?: Theme },
  origin: unknown,
) {
  const meta = getDeckMeta(doc);
  doc.transact(() => {
    if (patch.w) meta.set('w', patch.w);
    if (patch.h) meta.set('h', patch.h);
    if (patch.theme) meta.set('theme', patch.theme);
  }, origin);
}
