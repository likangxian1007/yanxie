import { useEffect, useRef, type RefObject } from 'react';

/**
 * 模态浮层（移动端导航抽屉等）的焦点管理，规则与 components/ui/Dialog 一致：
 * 打开时把焦点移进容器，Tab / Shift+Tab 在容器内循环，Esc 关闭，关闭后把焦点还回去。
 */

export const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 有没有布局引擎（浏览器有；jsdom 没有，所有元素都没有盒子） */
function hasLayout(): boolean {
  return document.documentElement.getClientRects().length > 0;
}

function isVisible(el: HTMLElement): boolean {
  if (el.closest('[hidden], [inert]')) return false;
  // display:none（例如 md:hidden 的按钮）没有盒子，Tab 走不到，跳过
  return !hasLayout() || el.getClientRects().length > 0;
}

/** 容器里当前可以用 Tab 走到的元素（按文档顺序）。 */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isVisible);
}

/** 处理一次 Tab：焦点到边界时绕回另一端；焦点在容器外时拉回容器。 */
export function trapTab(e: KeyboardEvent, root: HTMLElement): void {
  if (e.key !== 'Tab') return;
  const items = focusableIn(root);
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) {
    e.preventDefault();
    root.focus();
    return;
  }
  const active = document.activeElement;
  const inside = active instanceof Node && root.contains(active);
  if (e.shiftKey) {
    if (!inside || active === first || active === root) {
      e.preventDefault();
      last.focus();
    }
  } else if (!inside || active === last) {
    e.preventDefault();
    first.focus();
  }
}

export interface FocusTrapOptions {
  /** 关闭时把焦点还给谁；默认是打开前的焦点元素 */
  restoreFocus?: () => HTMLElement | null | undefined;
}

/**
 * `active` 为 true 期间：下一帧把焦点放到容器里第一个可聚焦元素（没有就放容器自己，需要 tabIndex=-1），
 * 拦截 Tab 不让焦点跑到被遮住的内容上，Esc 调 `onEscape`；变为 false 或卸载时还原焦点。
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape: () => void,
  options: FocusTrapOptions = {},
): void {
  const onEscapeRef = useRef(onEscape);
  const restoreRef = useRef(options.restoreFocus);
  useEffect(() => {
    onEscapeRef.current = onEscape;
    restoreRef.current = options.restoreFocus;
  });

  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const t = window.setTimeout(() => {
      const root = ref.current;
      if (!root) return;
      const current = document.activeElement;
      if (current instanceof Node && root.contains(current)) return;
      (focusableIn(root)[0] ?? root).focus();
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      const root = ref.current;
      if (!root) return;
      // 焦点在另一个叠在上面的模态层里（例如从抽屉里打开的对话框）：交给那一层处理
      const owner = e.target instanceof Element ? e.target.closest('[aria-modal="true"]') : null;
      if (owner && owner !== root && !root.contains(owner)) return;
      if (e.key === 'Escape') {
        if (e.defaultPrevented || e.isComposing) return;
        e.preventDefault();
        onEscapeRef.current();
        return;
      }
      trapTab(e, root);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      const target = restoreRef.current?.() ?? previous;
      if (target?.isConnected) target.focus();
    };
  }, [active, ref]);
}
