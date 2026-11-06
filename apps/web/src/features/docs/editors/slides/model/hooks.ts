import { useMemo, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import {
  getDeckMeta,
  getSlidesArray,
  readDeckInfo,
  readSlide,
  readSlideRefs,
  sameRefs,
  type SlideRef,
} from './deck';
import type { DeckInfo, SlideModel } from './types';

/**
 * React 订阅：
 * - useDeck：页列表（只在顺序 / 增删变化时更新）+ 页面尺寸与主题；
 * - useSlide：单页快照（只订阅这一页的 Y.Map，别的页打字不会让它重渲染）。
 */

function store<T>(
  subscribeY: (cb: () => void) => () => void,
  read: () => T,
  same: (a: T, b: T) => boolean,
) {
  let snap: T | undefined;
  let dirty = true;
  return {
    subscribe(cb: () => void) {
      dirty = true;
      const off = subscribeY(() => {
        dirty = true;
        cb();
      });
      return off;
    },
    getSnapshot(): T {
      if (dirty || snap === undefined) {
        const next = read();
        if (snap === undefined || !same(snap, next)) snap = next;
        dirty = false;
      }
      return snap;
    },
  };
}

function sameDeck(a: DeckInfo, b: DeckInfo) {
  return a.width === b.width && a.height === b.height && a.theme === b.theme;
}

function createDeckStore(meta: Y.Map<unknown>) {
  let lastTheme: unknown;
  let lastInfo: DeckInfo | null = null;
  return store(
    (cb) => {
      meta.observe(cb);
      return () => meta.unobserve(cb);
    },
    () => {
      const info = readDeckInfo(meta);
      // theme 是普通对象：值没变时沿用旧引用
      const raw = meta.get('theme');
      if (lastInfo && raw === lastTheme) info.theme = lastInfo.theme;
      lastTheme = raw;
      lastInfo = info;
      return info;
    },
    sameDeck,
  );
}

export function useDeck(doc: Y.Doc) {
  const arr = useMemo(() => getSlidesArray(doc), [doc]);
  const meta = useMemo(() => getDeckMeta(doc), [doc]);
  const refsStore = useMemo(
    () =>
      store(
        (cb) => {
          arr.observeDeep(cb);
          return () => arr.unobserveDeep(cb);
        },
        () => readSlideRefs(arr),
        sameRefs,
      ),
    [arr],
  );
  const deckStore = useMemo(() => createDeckStore(meta), [meta]);
  const refs = useSyncExternalStore(
    refsStore.subscribe,
    refsStore.getSnapshot,
    refsStore.getSnapshot,
  );
  const deck = useSyncExternalStore(
    deckStore.subscribe,
    deckStore.getSnapshot,
    deckStore.getSnapshot,
  );
  return { arr, meta, refs, deck };
}

export function useSlide(ref: SlideRef | undefined, deck: DeckInfo): SlideModel | null {
  const s = useMemo(() => {
    if (!ref) return null;
    return store(
      (cb) => {
        ref.map.observeDeep(cb);
        return () => ref.map.unobserveDeep(cb);
      },
      () => readSlide(ref, deck),
      () => false,
    );
  }, [ref, deck]);
  const noop = useMemo(
    () => ({ subscribe: () => () => {}, getSnapshot: () => null as SlideModel | null }),
    [],
  );
  const active = s ?? noop;
  return useSyncExternalStore(active.subscribe, active.getSnapshot, active.getSnapshot);
}
