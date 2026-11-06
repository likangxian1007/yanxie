import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react';

/**
 * 浮层定位（Menu / Popover 共用）：按触发元素放在下方或上方，左对齐或右对齐；
 * 空间不够时翻到另一侧，并且始终留在视口里。transform-origin 跟随触发点（STYLE §4.1 scaleIn）。
 */
export type FloatingSide = 'bottom' | 'top';
export type FloatingAlign = 'start' | 'end' | 'center';

const GAP = 6;
const EDGE = 8;

/** display: contents 的包裹层没有盒子：往下找第一个真正有盒子的元素。 */
export function boxElement(el: Element | null): Element | null {
  let cur: Element | null = el;
  for (let i = 0; cur && i < 6; i += 1) {
    if (getComputedStyle(cur).display !== 'contents') return cur;
    cur = cur.firstElementChild;
  }
  return cur;
}

export interface FloatingPosition {
  top: number;
  left: number;
  origin: string;
  maxHeight: number;
}

export function computePosition(
  anchor: DOMRect,
  panel: { width: number; height: number },
  side: FloatingSide,
  align: FloatingAlign,
): FloatingPosition {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const below = vh - anchor.bottom - GAP - EDGE;
  const above = anchor.top - GAP - EDGE;
  let actual: FloatingSide = side;
  if (side === 'bottom' && panel.height > below && above > below) actual = 'top';
  if (side === 'top' && panel.height > above && below > above) actual = 'bottom';

  let left =
    align === 'start'
      ? anchor.left
      : align === 'end'
        ? anchor.right - panel.width
        : anchor.left + anchor.width / 2 - panel.width / 2;
  left = Math.max(EDGE, Math.min(left, vw - panel.width - EDGE));
  const maxHeight = Math.max(120, actual === 'bottom' ? below : above);
  const h = Math.min(panel.height, maxHeight);
  const top = actual === 'bottom' ? anchor.bottom + GAP : anchor.top - GAP - h;

  const ox = align === 'start' ? 'left' : align === 'end' ? 'right' : 'center';
  const oy = actual === 'bottom' ? 'top' : 'bottom';
  return { top: Math.round(top), left: Math.round(left), origin: `${oy} ${ox}`, maxHeight };
}

/** 打开时测量并定位；滚动/缩放时重新计算。返回给面板用的 ref 回调和样式。 */
export function useFloating(
  anchorRef: RefObject<Element | null>,
  open: boolean,
  side: FloatingSide,
  align: FloatingAlign,
) {
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<FloatingPosition | null>(null);

  const update = useCallback(() => {
    const anchor = boxElement(anchorRef.current);
    if (!anchor || !panel) return;
    const next = computePosition(
      anchor.getBoundingClientRect(),
      { width: panel.offsetWidth, height: panel.scrollHeight },
      side,
      align,
    );
    setPos((prev) =>
      prev &&
      prev.top === next.top &&
      prev.left === next.left &&
      prev.origin === next.origin &&
      prev.maxHeight === next.maxHeight
        ? prev
        : next,
    );
  }, [anchorRef, panel, side, align]);

  useLayoutEffect(() => {
    if (open) update();
  }, [open, update]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    // 面板内容换页、筛选时高度会变：跟着重新定位。否则向上弹出的面板会往下长出视口、盖住触发按钮，
    // 或者变矮后和触发按钮之间空出一截。
    const observeChildren = (observer: ResizeObserver | null) => {
      if (!panel || !observer) return;
      for (const child of Array.from(panel.children)) observer.observe(child);
    };
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (panel) sizes?.observe(panel);
    observeChildren(sizes);
    const mutations =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            observeChildren(sizes);
            update();
          });
    if (panel) mutations?.observe(panel, { childList: true, subtree: true, characterData: true });
    // 触发按钮自己挪了位置（比如手机上底部标签栏收起、输入区变高）时没有任何事件：逐帧比一下锚点位置。
    let frame = 0;
    let last = '';
    const watchAnchor = () => {
      const rect = boxElement(anchorRef.current)?.getBoundingClientRect();
      const key = rect ? `${rect.top},${rect.left},${rect.width},${rect.height}` : '';
      if (last && key !== last) update();
      last = key;
      frame = window.requestAnimationFrame(watchAnchor);
    };
    frame = window.requestAnimationFrame(watchAnchor);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      sizes?.disconnect();
      mutations?.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [open, update, panel, anchorRef]);

  return { setPanel, pos };
}
