import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { PageGeometry } from './page';

/**
 * 页面视图的分页：正文仍是一个连续的 contenteditable，按块（段落、标题、表格、列表项…）测量高度，
 * 放不下当前页的块前面插一个本地 widget（不进协同文档），画出上一页的页脚、页间灰色间隔和下一页的上边距，
 * 看起来就是一页一页的 A4 纸。分页符节点之后强制换页。
 * 比一页还高的块（大表格、大图）不拆，整块放到新的一页开头。
 */

/** 页与页之间的灰色间隔（像素） */
export const PAGE_GAP = 24;

export interface PageUnit {
  /** 在文档里的位置（widget 放在这里） */
  pos: number;
  /** 不考虑分页 widget 时，块顶 / 块底相对正文内容区顶部的位置 */
  top: number;
  bottom: number;
  /** 上一块的 margin-bottom、本块的 margin-top（分页处这两段空白不再折叠） */
  prevMarginBottom: number;
  marginTop: number;
  /** 上一块的底（自然位置）；第一块为 0 */
  prevBottom: number;
  /** 本块是分页符：下一块必须换页 */
  forceBreakAfter: boolean;
  /** widget 需要向左伸出多少才能盖住整页宽（列表项在列表的缩进里） */
  inset: number;
}

export interface PageBreakPlan {
  pos: number;
  /** widget 总高度 */
  height: number;
  /** widget 顶部到上一页内容区底部的白色高度（含下边距） */
  tail: number;
  /** 上一页的页码（1 起） */
  page: number;
  inset: number;
}

export interface PagePlan {
  breaks: PageBreakPlan[];
  /** 最后一页末尾补的白色高度 */
  fill: number;
  pageCount: number;
  /** 每块所在页码（1 起），与 units 一一对应 */
  pages: number[];
}

/**
 * 纯计算：给定每块的自然位置，算出在哪些块前分页、widget 多高。
 * 坐标：第 k 页（0 起）的内容区是 [k·P, k·P + H]，P = 页高 + 间隔，H = 页高 − 上下边距。
 */
export function planPages(units: PageUnit[], g: PageGeometry): PagePlan {
  const H = Math.max(40, g.height - g.top - g.bottom);
  const P = g.height + PAGE_GAP;
  const breaks: PageBreakPlan[] = [];
  const pages: number[] = [];
  let shift = 0;
  let forceNext = false;
  let lastBottom = 0;
  for (const u of units) {
    const t = u.top + shift;
    const b = u.bottom + shift;
    const k = Math.floor(t / P);
    const pageTop = k * P;
    const inGap = t > pageTop + H + 0.5;
    const overflow = b > pageTop + H + 0.5 && t > pageTop + 0.5;
    const atPageTop = t <= pageTop + 0.5;
    if (inGap || overflow || (forceNext && !atPageTop)) {
      const target = (k + 1) * P;
      const spacerTop = u.prevBottom + shift + u.prevMarginBottom;
      const height = Math.max(0, target - spacerTop - u.marginTop);
      const prevPage = Math.floor(Math.max(0, spacerTop - 0.5) / P);
      breaks.push({
        pos: u.pos,
        height,
        tail: Math.max(0, prevPage * P + H - spacerTop) + g.bottom,
        page: prevPage + 1,
        inset: u.inset,
      });
      shift += target - t;
    }
    forceNext = u.forceBreakAfter;
    const top = u.top + shift;
    pages.push(Math.floor(top / P) + 1);
    lastBottom = u.bottom + shift;
  }
  const lastPage = Math.floor(Math.max(0, lastBottom - 0.5) / P);
  const fill = Math.max(0, lastPage * P + H - lastBottom);
  return { breaks, fill, pageCount: lastPage + 1, pages };
}

// ---------------------------------------------------------------- 编辑器扩展

interface PaginationStorage {
  geometry: PageGeometry | null;
  /** 每块（位置升序）所在页码，给目录显示页码用 */
  pageIndex: { pos: number; page: number }[];
  pageCount: number;
}

const key = new PluginKey<DecorationSet>('richPagination');
const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pagination: {
      /** 打开（传页面几何）/ 关闭（null）页面视图 */
      setPageGeometry: (geometry: PageGeometry | null) => ReturnType;
    };
  }
  interface Storage {
    pagination: PaginationStorage;
  }
}

/** 文档位置所在页码；不在页面视图时为 null */
export function pageNumberAt(editor: Editor, pos: number): number | null {
  const storage = (editor.storage as unknown as { pagination?: PaginationStorage }).pagination;
  if (!storage?.geometry || storage.pageIndex.length === 0) return null;
  let page = 1;
  for (const entry of storage.pageIndex) {
    if (entry.pos > pos) break;
    page = entry.page;
  }
  return page;
}

function px(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function collectUnits(view: EditorView): PageUnit[] {
  const root = view.dom;
  const rootRect = root.getBoundingClientRect();
  const rootStyle = getComputedStyle(root);
  const originTop = rootRect.top + px(rootStyle.paddingTop) + px(rootStyle.borderTopWidth);
  const units: PageUnit[] = [];
  // 已有 widget 造成的位移：按 DOM 顺序累计
  let displacement = 0;
  let prevBottom = 0;
  let prevEl: HTMLElement | null = null;

  const add = (el: HTMLElement, pos: number, forceBreakAfter: boolean) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const marginTop = px(style.marginTop);
    const prevMarginBottom = prevEl ? px(getComputedStyle(prevEl).marginBottom) : 0;
    const before = el.previousElementSibling;
    if (before instanceof HTMLElement && before.classList.contains('rich-page-gap')) {
      displacement += before.offsetHeight + Math.min(prevMarginBottom, marginTop);
    }
    const top = rect.top - originTop - displacement;
    const bottom = top + rect.height;
    units.push({
      pos,
      top,
      bottom,
      prevMarginBottom,
      marginTop,
      prevBottom,
      forceBreakAfter,
      inset: rect.left - rootRect.left,
    });
    prevBottom = bottom;
    prevEl = el;
  };

  view.state.doc.forEach((node, offset) => {
    const dom = view.nodeDOM(offset);
    if (!(dom instanceof HTMLElement)) return;
    if (LIST_TYPES.has(node.type.name) && node.childCount > 1) {
      // 列表：第一项跟着列表走，之后每一项都可以换页
      let first = true;
      node.forEach((child, childOffset) => {
        const pos = offset + 1 + childOffset;
        const el = first ? dom : view.nodeDOM(pos);
        first = false;
        if (el instanceof HTMLElement) add(el, el === dom ? offset : pos, false);
      });
      return;
    }
    add(dom, offset, node.type.name === 'pageBreak');
  });
  return units;
}

function gapWidget(plan: PageBreakPlan, g: PageGeometry): HTMLElement {
  const el = document.createElement('div');
  el.className = 'rich-page-gap';
  el.contentEditable = 'false';
  el.setAttribute('aria-hidden', 'true');
  el.style.height = `${plan.height}px`;
  el.style.width = `${g.width}px`;
  // 从纸张左边缘画起：inset = 块左缘到纸张左缘（正文的 padding 就是左页边距，列表项再加列表缩进）
  el.style.marginLeft = `${-plan.inset}px`;
  el.style.setProperty('--gap-tail', `${plan.tail}px`);
  el.style.setProperty('--gap-size', `${PAGE_GAP}px`);
  const num = document.createElement('span');
  num.className = 'rich-page-number';
  num.textContent = String(plan.page);
  num.style.top = `${Math.max(0, plan.tail - g.bottom / 2 - 8)}px`;
  el.appendChild(num);
  return el;
}

function fillWidget(height: number, page: number, g: PageGeometry): HTMLElement {
  const el = document.createElement('div');
  el.className = 'rich-page-fill';
  el.contentEditable = 'false';
  el.setAttribute('aria-hidden', 'true');
  el.style.height = `${height}px`;
  const num = document.createElement('span');
  num.className = 'rich-page-number';
  num.textContent = String(page);
  num.style.top = `${height + g.bottom / 2 - 8}px`;
  el.appendChild(num);
  return el;
}

function sameBreaks(a: PageBreakPlan[], b: PageBreakPlan[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i]!;
    return x.pos === y.pos && Math.abs(x.height - y.height) < 1 && x.page === y.page;
  });
}

export const Pagination = Extension.create<Record<string, never>, PaginationStorage>({
  name: 'pagination',
  addStorage() {
    return { geometry: null, pageIndex: [], pageCount: 0 };
  },
  addCommands() {
    return {
      setPageGeometry:
        (geometry) =>
        ({ tr, dispatch }) => {
          this.storage.geometry = geometry;
          if (!geometry) {
            this.storage.pageIndex = [];
            this.storage.pageCount = 0;
          }
          if (dispatch) tr.setMeta(key, { decorations: DecorationSet.empty, remeasure: true });
          return true;
        },
    };
  },
  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const meta = tr.getMeta(key) as { decorations?: DecorationSet } | undefined;
            if (meta?.decorations) return meta.decorations;
            return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
          },
        },
        props: {
          decorations(state) {
            return key.getState(state);
          },
        },
        view(view) {
          let frame = 0;
          let lastPlan: PagePlan | null = null;
          let lastFill = -1;
          let streak = 0;
          const measure = () => {
            frame = 0;
            const g = storage.geometry;
            if (view.isDestroyed) return;
            if (!g) {
              if (lastPlan) {
                lastPlan = null;
                view.dispatch(view.state.tr.setMeta(key, { decorations: DecorationSet.empty }));
              }
              return;
            }
            const units = collectUnits(view);
            const plan = planPages(units, g);
            storage.pageIndex = units.map((u, i) => ({ pos: u.pos, page: plan.pages[i] ?? 1 }));
            storage.pageCount = plan.pageCount;
            if (
              lastPlan &&
              sameBreaks(lastPlan.breaks, plan.breaks) &&
              Math.abs(lastFill - plan.fill) < 1
            ) {
              streak = 0;
              return;
            }
            // 防止测量 → 插 widget → 再测量来回抖动
            streak += 1;
            if (streak > 6) return;
            lastPlan = plan;
            lastFill = plan.fill;
            const decos = plan.breaks.map((b) =>
              Decoration.widget(b.pos, () => gapWidget(b, g), {
                side: -1,
                ignoreSelection: true,
                key: `gap:${b.pos}:${Math.round(b.height)}:${b.page}:${Math.round(b.inset)}`,
              }),
            );
            const end = view.state.doc.content.size;
            decos.push(
              Decoration.widget(end, () => fillWidget(plan.fill, plan.pageCount, g), {
                side: 1,
                ignoreSelection: true,
                key: `fill:${Math.round(plan.fill)}:${plan.pageCount}`,
              }),
            );
            view.dispatch(
              view.state.tr.setMeta(key, {
                decorations: DecorationSet.create(view.state.doc, decos),
              }),
            );
          };
          const schedule = () => {
            if (frame) return;
            frame = requestAnimationFrame(measure);
          };
          const ro =
            typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null;
          ro?.observe(view.dom);
          schedule();
          return {
            update(v, prev) {
              if (prev.doc !== v.state.doc) streak = 0;
              if (prev.doc !== v.state.doc || key.getState(prev) !== key.getState(v.state)) {
                if (!storage.geometry && !lastPlan) return;
                if (key.getState(v.state) === DecorationSet.empty && storage.geometry) {
                  lastPlan = null;
                  streak = 0;
                }
                schedule();
              }
            },
            destroy() {
              if (frame) cancelAnimationFrame(frame);
              ro?.disconnect();
            },
          };
        },
      }),
    ];
  },
});
