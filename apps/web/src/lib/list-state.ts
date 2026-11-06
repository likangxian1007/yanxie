import { useLayoutEffect } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router';
import { useMeUser } from './session';

export interface ListState {
  scrollTop: number;
  focus: string | null;
}
export function createListStateStore(limit = 50) {
  const entries = new Map<string, ListState>();
  return {
    get(key: string): ListState | undefined {
      const value = entries.get(key);
      if (value) {
        entries.delete(key);
        entries.set(key, value);
      }
      return value;
    },
    set(key: string, value: ListState) {
      entries.delete(key);
      entries.set(key, { ...value });
      while (entries.size > limit) entries.delete(entries.keys().next().value!);
    },
    clear: () => entries.clear(),
    get size() {
      return entries.size;
    },
  };
}
export const listStateStore = createListStateStore();

/** 只更新指定参数，筛选、预览和其它页面状态互不覆盖。 */
export function updateListSearch(
  search: string | URLSearchParams,
  patch: Record<string, string | null | undefined>,
): URLSearchParams {
  const next = new URLSearchParams(search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === '') next.delete(key);
    else next.set(key, value);
  }
  return next;
}

export function listStateKey(
  accountId: string,
  projectId: string,
  pathname: string,
  scope: string,
): string {
  return JSON.stringify([accountId, projectId, pathname, scope]);
}

/** 列表页调用一次。返回时等待异步列表就绪，再恢复滚动和最后聚焦的条目。 */
export function useListStateScope(
  scope: string,
  options: { scrollElementId?: string; path?: string } = {},
): void {
  const me = useMeUser();
  const { projectId = '' } = useParams();
  const location = useLocation();
  const pathname = options.path ?? location.pathname;
  const scrollElementId = options.scrollElementId ?? 'app-scroll';
  const accountId = me?.id;
  useLayoutEffect(() => {
    if (!accountId) return;
    const root = document.getElementById(scrollElementId);
    if (!root) return;
    const key = listStateKey(accountId, projectId, pathname, scope);
    const saved = listStateStore.get(key);
    if (!saved) root.scrollTop = 0;
    let focus = saved?.focus ?? null;
    let restoring = Boolean(saved);
    const restore = () => {
      if (!saved || !restoring) return;
      root.scrollTop = saved.scrollTop;
      const item = Array.from(root.querySelectorAll<HTMLElement>('[data-list-item]')).find(
        (node) => node.dataset.listItem === saved.focus,
      );
      if (item) {
        const target = item.matches('a,button,[tabindex]')
          ? item
          : item.querySelector<HTMLElement>('a,button,[tabindex]');
        target?.focus({ preventScroll: true });
      }
      // Browser clamps scrollTop while the list is loading. Keep waiting until enough content arrives.
      if ((root.scrollTop >= saved.scrollTop || saved.scrollTop === 0) && (!saved.focus || item))
        restoring = false;
    };
    restore();
    const observer = new MutationObserver(restore);
    observer.observe(root, { childList: true, subtree: true });
    const save = () => {
      if (!restoring) listStateStore.set(key, { scrollTop: root.scrollTop, focus });
    };
    const onFocus = (event: FocusEvent) => {
      const item =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-list-item]')
          : null;
      if (item && root.contains(item)) {
        focus = item.dataset.listItem ?? null;
        save();
      }
    };
    const onInteraction = () => {
      restoring = false;
    };
    root.addEventListener('scroll', save, { passive: true });
    root.addEventListener('focusin', onFocus);
    root.addEventListener('pointerdown', onInteraction, { passive: true });
    root.addEventListener('wheel', onInteraction, { passive: true });
    root.addEventListener('keydown', onInteraction);
    return () => {
      save();
      observer.disconnect();
      root.removeEventListener('scroll', save);
      root.removeEventListener('focusin', onFocus);
      root.removeEventListener('pointerdown', onInteraction);
      root.removeEventListener('wheel', onInteraction);
      root.removeEventListener('keydown', onInteraction);
    };
  }, [accountId, projectId, pathname, scope, scrollElementId]);
}

// Multiple filter hooks may update in one event. React Router does not queue functional
// search updates, so all setters from the same location merge into one pending snapshot.
const pendingSearch = new WeakMap<object, URLSearchParams>();
export function useListQueryState(
  name: string,
  fallback: string,
): readonly [string, (value: string | null) => void] {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  return [
    params.get(name) ?? fallback,
    (value) => {
      const next = updateListSearch(pendingSearch.get(location) ?? params, { [name]: value });
      pendingSearch.set(location, next);
      setParams(next, { replace: true, state: location.state });
    },
  ] as const;
}
