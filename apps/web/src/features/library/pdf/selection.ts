import type { PdfBox } from '@srh/shared';
import { tr } from '@/lib/i18n';

/** 文件、账号与库的身份由阅读器外层 key 隔离；这里只记录当前 PDF 里的选区。 */
export interface PdfTextSelection {
  text: string;
  page: number;
  /** PDF 原始用户坐标，左上角原点；不随屏幕缩放或页面旋转变化。 */
  boxes: PdfBox[];
  warning: string | null;
  /** 本次选区结束时的屏幕位置，仅用于浮动菜单，不作为标注坐标保存。 */
  menuAnchor?: { x: number; y: number };
}
interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
interface Viewport {
  width: number;
  height: number;
  viewBox: number[];
  convertToPdfPoint: (x: number, y: number) => number[];
}

/** 浏览器选区 → 原始 PDF 坐标。使用 viewport 的逆变换，同时支持旋转、裁切和浏览器缩放。 */
export function selectionBoxes(
  rects: Rect[],
  pageRect: Rect,
  viewport: Viewport,
  page: number,
): PdfBox[] {
  const width = pageRect.right - pageRect.left;
  const height = pageRect.bottom - pageRect.top;
  if (width <= 0 || height <= 0) return [];
  const seen = new Set<string>();
  return rects.flatMap((rect) => {
    const l = Math.max(rect.left, pageRect.left),
      r = Math.min(rect.right, pageRect.right);
    const t = Math.max(rect.top, pageRect.top),
      b = Math.min(rect.bottom, pageRect.bottom);
    if (r - l < 0.5 || b - t < 0.5) return [];
    const point = (x: number, y: number) =>
      viewport.convertToPdfPoint(
        ((x - pageRect.left) * viewport.width) / width,
        ((y - pageRect.top) * viewport.height) / height,
      );
    const corners = [point(l, t), point(r, t), point(l, b), point(r, b)];
    const xs = corners.map((p) => p[0]!),
      ys = corners.map((p) => p[1]!);
    const x = Math.min(...xs) - viewport.viewBox[0]!;
    const y = viewport.viewBox[3]! - Math.max(...ys);
    const box = {
      page,
      x,
      y,
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
    const key = [x, y, box.w, box.h].map((n) => n.toFixed(2)).join(':');
    if (seen.has(key)) return [];
    seen.add(key);
    return [box];
  });
}

export function textLayerFor(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : node?.parentElement;
  return el?.closest<HTMLElement>('.lib-pdf-text') ?? null;
}

/** 保存坐标 → 当前页面坐标，恢复裁切原点并应用页面旋转与缩放。 */
export function projectSelectionBox(
  box: PdfBox,
  viewport: {
    viewBox: number[];
    convertToViewportPoint: (x: number, y: number) => number[];
  },
) {
  const left = viewport.viewBox[0]! + box.x;
  const top = viewport.viewBox[3]! - box.y;
  const corners = [
    viewport.convertToViewportPoint(left, top),
    viewport.convertToViewportPoint(left + box.w, top),
    viewport.convertToViewportPoint(left, top - box.h),
    viewport.convertToViewportPoint(left + box.w, top - box.h),
  ];
  const xs = corners.map((p) => p[0]!),
    ys = corners.map((p) => p[1]!);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/** 只提示潜在跨栏，不猜测或悄悄重排科研原文。 */
export function columnWarning(rects: Rect[], width: number): string | null {
  const ordered = [...rects]
    .filter((r) => r.right > r.left)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1]!,
      b = ordered[i]!;
    if (Math.abs(a.top - b.top) < 3 && b.left - a.right > width * 0.12)
      return tr('选区可能跨越两栏，请核对下面的原文；需要时在同一栏重新选择。');
  }
  return null;
}
