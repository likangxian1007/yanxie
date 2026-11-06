import { useSyncExternalStore } from 'react';

/** 手机布局（STYLE §5：< 768px） */
export const MOBILE_QUERY = '(max-width: 767.98px)';
/** 触屏为主（手指点，没有精确指针）：文案改讲「点」而不是快捷键 */
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

function mediaList(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(query);
}

/** 订阅一条媒体查询；不支持 matchMedia 的环境（测试、SSR）一律为 false */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = mediaList(query);
      if (!list) return () => {};
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => mediaList(query)?.matches ?? false,
    () => false,
  );
}

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

export function useCoarsePointer(): boolean {
  return useMediaQuery(COARSE_POINTER_QUERY);
}
