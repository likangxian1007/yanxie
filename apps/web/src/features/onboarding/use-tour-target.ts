import { useEffect, useRef, useState } from 'react';
import {
  isElementVisible,
  rectOf,
  resolveTarget,
  sameRect,
  type Rect,
  type ResolvedKind,
} from './geometry';
import type { TourStep } from './tour-steps';

export interface TourTarget {
  /** 对应哪一步（步骤切换后旧结果作废） */
  key: string;
  kind: ResolvedKind;
  rect: Rect | null;
  /** step = 换了一步（高亮框要动画过去）；reflow = 同一步里窗口变化（直接跟上） */
  reason: 'step' | 'reflow';
}

/** 找不到原目标时继续等多久（页面懒加载、刚跳转） */
const WAIT_MS = 1200;
const POLL_MS = 150;

/**
 * 跟踪当前步骤的目标元素：先找原目标，找不到就用 fallback / 居中，同时在 WAIT_MS 内继续找原目标。
 * 窗口缩放、滚动、目标尺寸变化时重新量；目标变得不可见（例如窗口缩到手机宽度）时重新找。
 */
export function useTourTarget(
  step: TourStep | undefined,
  projectId: string,
  key: string,
): TourTarget | null {
  const [state, setState] = useState<TourTarget | null>(null);
  const elRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!step) return;
    let disposed = false;
    let pollTimer = 0;
    let frame = 0;
    const startedAt = Date.now();
    elRef.current = null;

    const remeasure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (disposed) return;
        const el = elRef.current;
        if (!el || !isElementVisible(el)) {
          // 目标被藏起来了（窗口变窄、侧栏收进抽屉）或之前没找到：重新找
          const res = resolveTarget(step, projectId);
          if (res.el !== el) commit(res.el, res.kind, 'step');
          return;
        }
        const rect = rectOf(el);
        setState((prev) =>
          prev && prev.key === key && sameRect(prev.rect, rect)
            ? prev
            : { key, kind: prev?.kind ?? 'target', rect, reason: 'reflow' },
        );
      });
    };

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(remeasure) : null;

    function commit(el: Element | null, kind: ResolvedKind, reason: TourTarget['reason']) {
      if (elRef.current && elRef.current !== el) ro?.unobserve(elRef.current);
      elRef.current = el;
      if (el) {
        ro?.observe(el);
        if (typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
      setState({ key, kind, rect: el ? rectOf(el) : null, reason });
    }

    const attempt = (first: boolean) => {
      if (disposed) return;
      const res = resolveTarget(step, projectId);
      if (res.kind === 'target') {
        commit(res.el, res.kind, 'step');
        return;
      }
      // 第一次没找到：先给出 fallback / 居中卡片，后台再等一会儿原目标
      if (first) commit(res.el, res.kind, 'step');
      if (Date.now() - startedAt < WAIT_MS) {
        pollTimer = window.setTimeout(() => attempt(false), POLL_MS);
      }
    };

    // 等一帧：页面切换、抽屉关闭后布局稳定了再量
    frame = window.requestAnimationFrame(() => attempt(true));

    window.addEventListener('resize', remeasure);
    window.addEventListener('scroll', remeasure, { capture: true, passive: true });
    return () => {
      disposed = true;
      window.clearTimeout(pollTimer);
      window.cancelAnimationFrame(frame);
      ro?.disconnect();
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure, { capture: true });
    };
  }, [step, projectId, key]);

  return state && state.key === key ? state : null;
}
