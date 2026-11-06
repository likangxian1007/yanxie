import type { Rect } from '../model/elements';

/**
 * 画布几何（纯函数，单位 pt）：缩放手柄、旋转、吸附对齐线。
 */

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export interface Box extends Rect {
  rot: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

function rotate(x: number, y: number, deg: number): [number, number] {
  const a = rad(deg);
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

/** 手柄在元素局部坐标（以中心为原点）里的方向：-1 / 0 / 1 */
export function handleDir(h: Handle): [number, number] {
  return [
    h.includes('w') ? -1 : h.includes('e') ? 1 : 0,
    h.includes('n') ? -1 : h.includes('s') ? 1 : 0,
  ];
}

/**
 * 拖动缩放手柄：对边 / 对角保持不动（考虑旋转）。p 是指针在页面坐标里的位置。
 * keepRatio：等比（Shift，或图片拖角）。
 */
export function resizeBox(
  box: Box,
  handle: Handle,
  p: { x: number; y: number },
  opts: { keepRatio?: boolean; min?: number } = {},
): Rect {
  const min = opts.min ?? 4;
  const [dx, dy] = handleDir(handle);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  // 指针转到局部坐标
  const [lx, ly] = rotate(p.x - cx, p.y - cy, -box.rot);
  // 固定点（对边 / 对角）局部坐标
  const ax = (-dx * box.w) / 2;
  const ay = (-dy * box.h) / 2;
  let w = dx === 0 ? box.w : Math.max(min, (lx - ax) * dx);
  let h = dy === 0 ? box.h : Math.max(min, (ly - ay) * dy);
  if (opts.keepRatio && box.w > 0 && box.h > 0) {
    const ratio = box.w / box.h;
    if (dx !== 0 && dy !== 0) {
      if (w / h > ratio) h = w / ratio;
      else w = h * ratio;
    } else if (dx !== 0) h = w / ratio;
    else w = h * ratio;
  }
  // 新框里固定点的局部坐标（以新中心为原点）
  const nax = dx === 0 ? 0 : (-dx * w) / 2;
  const nay = dy === 0 ? 0 : (-dy * h) / 2;
  // 固定点的世界坐标不变：新中心 = 固定点世界坐标 - R * 新局部坐标
  const [wax, way] = rotate(dx === 0 ? 0 : ax, dy === 0 ? 0 : ay, box.rot);
  const [nwx, nwy] = rotate(nax, nay, box.rot);
  const ncx = cx + wax - nwx;
  const ncy = cy + way - nwy;
  return { x: ncx - w / 2, y: ncy - h / 2, w, h };
}

/** 选区外框缩放：每个元素按比例缩放位置与大小 */
export function scaleRects<T extends Rect>(items: T[], from: Rect, to: Rect): Rect[] {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  return items.map((r) => ({
    x: to.x + (r.x - from.x) * sx,
    y: to.y + (r.y - from.y) * sy,
    w: r.w * sx,
    h: r.h * sy,
  }));
}

/** 旋转手柄：返回角度（0..360），Shift 时按 15° 吸附，接近 0/90/180/270 时自动吸附 */
export function rotateAngle(box: Rect, p: { x: number; y: number }, snap15: boolean): number {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  let deg = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90;
  deg = ((deg % 360) + 360) % 360;
  if (snap15) deg = Math.round(deg / 15) * 15;
  else {
    for (const a of [0, 90, 180, 270, 360]) if (Math.abs(deg - a) < 3) deg = a;
  }
  return deg % 360;
}

/** 线段端点 → 外框 + 翻转 */
export function lineFromPoints(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
): Rect & { flipH: boolean; flipV: boolean } {
  return {
    x: Math.min(p1.x, p2.x),
    y: Math.min(p1.y, p2.y),
    w: Math.abs(p2.x - p1.x),
    h: Math.abs(p2.y - p1.y),
    flipH: p2.x < p1.x,
    flipV: p2.y < p1.y,
  };
}

// ---------------------------------------------------------------- 吸附

export interface Guide {
  axis: 'x' | 'y';
  /** 线所在的坐标 */
  pos: number;
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

/**
 * 移动吸附：把被拖动的外框（已加上原始位移）的左 / 中 / 右、上 / 中 / 下
 * 对齐到其他元素与页面的同类线上（阈值 tol pt），返回修正后的位移和要画的参考线。
 */
export function snapMove(
  moving: Rect,
  others: Rect[],
  page: { width: number; height: number },
  tol: number,
): SnapResult {
  const targets = [{ x: 0, y: 0, w: page.width, h: page.height }, ...others];
  const xs = (r: Rect) => [r.x, r.x + r.w / 2, r.x + r.w];
  const ys = (r: Rect) => [r.y, r.y + r.h / 2, r.y + r.h];
  let best = { d: tol + 1, dx: 0, pos: 0 };
  let bestY = { d: tol + 1, dy: 0, pos: 0 };
  for (const t of targets) {
    for (const a of xs(moving))
      for (const b of xs(t)) {
        const d = Math.abs(a - b);
        if (d < best.d) best = { d, dx: b - a, pos: b };
      }
    for (const a of ys(moving))
      for (const b of ys(t)) {
        const d = Math.abs(a - b);
        if (d < bestY.d) bestY = { d, dy: b - a, pos: b };
      }
  }
  const dx = best.d <= tol ? best.dx : 0;
  const dy = bestY.d <= tol ? bestY.dy : 0;
  const m = { ...moving, x: moving.x + dx, y: moving.y + dy };
  const guides: Guide[] = [];
  if (best.d <= tol) {
    const span = [m, ...targets.filter((t) => xs(t).some((v) => Math.abs(v - best.pos) < 0.01))];
    guides.push({
      axis: 'x',
      pos: best.pos,
      from: Math.min(...span.map((r) => r.y)),
      to: Math.max(...span.map((r) => r.y + r.h)),
    });
  }
  if (bestY.d <= tol) {
    const span = [m, ...targets.filter((t) => ys(t).some((v) => Math.abs(v - bestY.pos) < 0.01))];
    guides.push({
      axis: 'y',
      pos: bestY.pos,
      from: Math.min(...span.map((r) => r.x)),
      to: Math.max(...span.map((r) => r.x + r.w)),
    });
  }
  return { dx, dy, guides };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}
