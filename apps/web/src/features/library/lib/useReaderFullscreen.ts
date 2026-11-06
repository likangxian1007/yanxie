import { useCallback, useEffect, useRef, useState } from 'react';

/** 全屏作用于整个页面，让已有浮层仍可见；阅读器 DOM 不重建。 */
export function useReaderFullscreen() {
  const [active, setActive] = useState(false);
  const owned = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const generation = useRef(0);
  const activeRef = useRef(false);
  const invalidate = useCallback(() => ++generation.current, []);
  const exit = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    generation.current++;
    setActive(false);
    if (owned.current && document.fullscreenElement)
      void document.exitFullscreen?.().catch(() => undefined);
    owned.current = false;
    trigger.current?.focus();
  }, []);
  useEffect(() => {
    const change = () => {
      if (owned.current && !document.fullscreenElement) {
        owned.current = false;
        activeRef.current = false;
        setActive(false);
        trigger.current?.focus();
      }
    };
    const key = (e: KeyboardEvent) => {
      if (!activeRef.current || e.defaultPrevented || document.querySelector('[role="dialog"]'))
        return;
      if (e.key === 'Escape') exit();
      if (e.key === 'Tab') {
        const root = document.querySelector('[data-reader-fullscreen="true"]');
        const controls = Array.from(
          root?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"], [contenteditable="true"]',
          ) ?? [],
        ).filter((el) => el.getClientRects().length);
        const first = controls[0],
          last = controls.at(-1);
        if (
          !root?.contains(document.activeElement) ||
          (e.shiftKey ? document.activeElement === first : document.activeElement === last)
        ) {
          e.preventDefault();
          (e.shiftKey ? last : first)?.focus();
        }
      }
    };
    document.addEventListener('fullscreenchange', change);
    document.addEventListener('keydown', key);
    return () => {
      invalidate();
      document.removeEventListener('fullscreenchange', change);
      document.removeEventListener('keydown', key);
      if (owned.current && document.fullscreenElement)
        void document.exitFullscreen?.().catch(() => undefined);
      owned.current = false;
      activeRef.current = false;
    };
  }, [exit, invalidate]);
  return {
    active,
    toggle: async () => {
      if (active) {
        exit();
        return;
      }
      trigger.current = document.activeElement as HTMLElement;
      activeRef.current = true;
      setActive(true);
      const mine = ++generation.current;
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        try {
          await document.documentElement.requestFullscreen();
          if (generation.current !== mine) {
            void document.exitFullscreen?.().catch(() => undefined);
            return;
          }
          owned.current = true;
        } catch {
          /* 浏览器拒绝原生全屏时，保留应用内全屏。 */
        }
      }
    },
  };
}
