import { useCallback, useEffect, useState } from 'react';

/**
 * 分栏比例与视图模式（源码 / 分栏 / 预览）的持久化。纯函数部分单独导出，方便测试。
 */

export const SPLIT_STORAGE_KEY = 'srh:latex:split-ratio';
export const VIEW_STORAGE_KEY = 'srh:latex:view-mode';
export const DEFAULT_SPLIT = 0.5;
export const MIN_SPLIT = 0.2;
export const MAX_SPLIT = 0.8;

export type LatexViewMode = 'source' | 'split' | 'preview';

export function clampSplit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPLIT;
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, value));
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadSplit(): number {
  const raw = storage()?.getItem(SPLIT_STORAGE_KEY);
  if (raw == null) return DEFAULT_SPLIT;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? clampSplit(n) : DEFAULT_SPLIT;
}

export function saveSplit(value: number): void {
  try {
    storage()?.setItem(SPLIT_STORAGE_KEY, clampSplit(value).toFixed(4));
  } catch {
    // 隐私模式等写不进去：忽略
  }
}

export function loadViewMode(): LatexViewMode {
  const raw = storage()?.getItem(VIEW_STORAGE_KEY);
  return raw === 'source' || raw === 'preview' || raw === 'split' ? raw : 'split';
}

export function saveViewMode(mode: LatexViewMode): void {
  try {
    storage()?.setItem(VIEW_STORAGE_KEY, mode);
  } catch {
    // 忽略
  }
}

/** 拖动分隔条时由指针位置算比例 */
export function ratioFromPointer(clientX: number, left: number, width: number): number {
  if (width <= 0) return DEFAULT_SPLIT;
  return clampSplit((clientX - left) / width);
}

/** 分栏比例：拖动时实时更新，松手时写入 localStorage */
export function useSplitRatio(): {
  ratio: number;
  setRatio: (v: number) => void;
  commit: (v?: number) => void;
} {
  const [ratio, setRatioState] = useState(loadSplit);
  const setRatio = useCallback((v: number) => setRatioState(clampSplit(v)), []);
  const commit = useCallback(
    (v?: number) => {
      const value = clampSplit(v ?? ratio);
      setRatioState(value);
      saveSplit(value);
    },
    [ratio],
  );
  return { ratio, setRatio, commit };
}

export function useViewMode(): [LatexViewMode, (m: LatexViewMode) => void] {
  const [mode, setMode] = useState(loadViewMode);
  const update = useCallback((m: LatexViewMode) => {
    setMode(m);
    saveViewMode(m);
  }, []);
  return [mode, update];
}

/** 是否为窄屏（< 1024px 时分栏改为 Tabs） */
export function useNarrow(query = '(max-width: 1023px)'): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [query]);
  return narrow;
}
