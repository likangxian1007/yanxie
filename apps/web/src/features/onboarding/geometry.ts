import type { TargetSpec, TourStep } from './tour-steps';

/** 引导的定位计算：找目标元素、算高亮框和卡片位置。纯函数为主，方便测试。 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

export type ResolvedKind = 'target' | 'fallback' | 'none';

export interface ResolvedTarget {
  el: Element | null;
  kind: ResolvedKind;
}

export type VisibilityCheck = (el: Element) => boolean;

/** 真浏览器里的可见性：有盒子、没被 inert / aria-hidden 藏起来、不是 visibility:hidden */
export function isElementVisible(el: Element): boolean {
  if (el.closest('[inert], [aria-hidden="true"], [hidden]')) return false;
  const rect = el.getBoundingClientRect();
  if (el.getClientRects().length === 0 || rect.width < 1 || rect.height < 1) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

function find(spec: TargetSpec, projectId: string, root: ParentNode, visible: VisibilityCheck) {
  const selector = spec.selector.replaceAll('{pid}', projectId);
  let nodes: Element[];
  try {
    nodes = Array.from(root.querySelectorAll(selector));
  } catch {
    return null;
  }
  for (const node of nodes) {
    const el = spec.closest ? (node.closest(spec.closest) ?? node) : node;
    if (visible(el)) return el;
  }
  return null;
}

/** 按 targets → fallbacks 的顺序找第一个可见元素；都没有时返回 kind: 'none'（居中卡片）。 */
export function resolveTarget(
  step: TourStep,
  projectId: string,
  options: { root?: ParentNode; isVisible?: VisibilityCheck } = {},
): ResolvedTarget {
  const root = options.root ?? document;
  const visible = options.isVisible ?? isElementVisible;
  for (const spec of step.targets) {
    const el = find(spec, projectId, root, visible);
    if (el) return { el, kind: 'target' };
  }
  for (const spec of step.fallbacks ?? []) {
    const el = find(spec, projectId, root, visible);
    if (el) return { el, kind: 'fallback' };
  }
  return { el: null, kind: 'none' };
}

/** 高亮框：目标外扩 `pad`，并夹在视口内（贴边的侧栏项不会被切掉一半的圆角） */
export function spotlightRect(target: Rect, viewport: Size, pad = 6, inset = 4): Rect {
  const x0 = Math.max(inset, target.x - pad);
  const y0 = Math.max(inset, target.y - pad);
  const x1 = Math.min(viewport.w - inset, target.x + target.w + pad);
  const y1 = Math.min(viewport.h - inset, target.y + target.h + pad);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

export type Side = 'right' | 'bottom' | 'top' | 'left' | 'center';

export interface CardPlacement {
  x: number;
  y: number;
  side: Side;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * 卡片放在高亮框旁边：优先右侧（侧栏项），其次下方、上方、左侧；都放不下时居中。
 * 结果夹在视口内，留 `margin` 边距。
 */
export function placeCard(
  hole: Rect | null,
  card: Size,
  viewport: Size,
  { gap = 14, margin = 12 }: { gap?: number; margin?: number } = {},
): CardPlacement {
  const center: CardPlacement = {
    x: Math.max(margin, (viewport.w - card.w) / 2),
    y: Math.max(margin, (viewport.h - card.h) / 2),
    side: 'center',
  };
  if (!hole) return center;

  const fitsX = (x: number) => x >= margin && x + card.w <= viewport.w - margin;
  const fitsY = (y: number) => y >= margin && y + card.h <= viewport.h - margin;
  const midX = hole.x + hole.w / 2 - card.w / 2;
  const midY = hole.y + hole.h / 2 - card.h / 2;
  const maxX = viewport.w - margin - card.w;
  const maxY = viewport.h - margin - card.h;

  const right = hole.x + hole.w + gap;
  if (fitsX(right) && card.h <= viewport.h - margin * 2) {
    return { x: right, y: clamp(midY, margin, maxY), side: 'right' };
  }
  const below = hole.y + hole.h + gap;
  if (fitsY(below)) return { x: clamp(midX, margin, maxX), y: below, side: 'bottom' };
  const above = hole.y - gap - card.h;
  if (fitsY(above)) return { x: clamp(midX, margin, maxX), y: above, side: 'top' };
  const left = hole.x - gap - card.w;
  if (fitsX(left) && card.h <= viewport.h - margin * 2) {
    return { x: left, y: clamp(midY, margin, maxY), side: 'left' };
  }
  return center;
}

/** 手机上的底部卡片：目标在屏幕下半部分（例如吸底输入框）时改为贴顶，免得挡住它 */
export function sheetDock(hole: Rect | null, viewport: Size): 'top' | 'bottom' {
  if (!hole) return 'bottom';
  return hole.y + hole.h / 2 > viewport.h * 0.55 ? 'top' : 'bottom';
}

export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

export function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.w - b.w) < 0.5 &&
    Math.abs(a.h - b.h) < 0.5
  );
}
