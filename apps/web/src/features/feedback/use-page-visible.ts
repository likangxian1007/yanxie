import { useSyncExternalStore } from 'react';

function subscribe(cb: () => void) {
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
}

/** 页面是否可见：轮询只在可见时进行，切回来时 TanStack Query 会因 interval 恢复而重新拉取。 */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.visibilityState !== 'hidden',
    () => true,
  );
}
