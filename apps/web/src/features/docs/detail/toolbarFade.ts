import { useEffect, type RefObject } from 'react';

/**
 * 编辑器工具栏的横向滚动提示：窄屏（如 360px）下工具栏放不下时，
 * 在还能滚动的一侧边缘加渐隐遮罩，让人看出“后面还有按钮”。
 *
 * 四类编辑器的工具栏都是 role="toolbar"，滚动容器是它自己或它的子元素（overflow-x: auto）。
 * 这里在详情页统一处理，不需要改各编辑器。遮罩只用 mask-image（不改布局、不做动画）。
 */
export const FADE_PX = 24;

export type FadeEdges = { start: boolean; end: boolean };

/** 根据滚动位置判断两侧是否还有被遮住的内容（1px 容差，避免小数像素误判） */
export function fadeEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): FadeEdges {
  if (scrollWidth - clientWidth <= 1) return { start: false, end: false };
  return {
    start: scrollLeft > 1,
    end: scrollLeft + clientWidth < scrollWidth - 1,
  };
}

export function fadeMask({ start, end }: FadeEdges): string {
  if (!start && !end) return '';
  const left = start ? `transparent, black ${FADE_PX}px` : 'black, black';
  const right = end ? `black calc(100% - ${FADE_PX}px), transparent` : 'black, black';
  return `linear-gradient(to right, ${left}, ${right})`;
}

function isScrollableX(el: HTMLElement): boolean {
  const o = getComputedStyle(el).overflowX;
  return o === 'auto' || o === 'scroll';
}

/** 工具栏里真正横向滚动的元素：自己，或第一层 / 第二层子元素 */
function findScroller(toolbar: HTMLElement): HTMLElement | null {
  if (isScrollableX(toolbar)) return toolbar;
  for (const child of Array.from(toolbar.children)) {
    if (child instanceof HTMLElement && isScrollableX(child)) return child;
  }
  for (const child of Array.from(toolbar.querySelectorAll<HTMLElement>(':scope > * > *'))) {
    if (isScrollableX(child)) return child;
  }
  return null;
}

export function useToolbarScrollFade(container: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = container.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const tracked = new Map<HTMLElement, () => void>();

    const attach = (scroller: HTMLElement) => {
      if (tracked.has(scroller)) return;
      const update = () => {
        const mask = fadeMask(
          fadeEdges(scroller.scrollLeft, scroller.clientWidth, scroller.scrollWidth),
        );
        scroller.style.maskImage = mask;
        scroller.style.setProperty('-webkit-mask-image', mask);
      };
      const ro = new ResizeObserver(update);
      ro.observe(scroller);
      for (const child of Array.from(scroller.children)) ro.observe(child);
      scroller.addEventListener('scroll', update, { passive: true });
      update();
      tracked.set(scroller, () => {
        ro.disconnect();
        scroller.removeEventListener('scroll', update);
      });
    };

    // 每个工具栏只查一次样式（编辑正文时 DOM 变化很频繁，不能每次都重新计算）
    const seen = new WeakSet<HTMLElement>();
    const scan = () => {
      for (const tb of Array.from(root.querySelectorAll<HTMLElement>('[role="toolbar"]'))) {
        if (seen.has(tb)) continue;
        seen.add(tb);
        const scroller = findScroller(tb);
        if (scroller) attach(scroller);
      }
      for (const [el, off] of tracked) {
        if (!root.contains(el)) {
          off();
          tracked.delete(el);
        }
      }
    };

    scan();
    // 编辑器是懒加载的，工具栏会晚一点出现；同一帧里的多次变化只扫一次
    let frame = 0;
    const mo = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        scan();
      });
    });
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      if (frame) cancelAnimationFrame(frame);
      for (const off of tracked.values()) off();
      tracked.clear();
    };
  }, [container]);
}
