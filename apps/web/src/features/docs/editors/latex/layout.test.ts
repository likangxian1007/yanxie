import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPLIT,
  MAX_SPLIT,
  MIN_SPLIT,
  SPLIT_STORAGE_KEY,
  VIEW_STORAGE_KEY,
  clampSplit,
  loadSplit,
  loadViewMode,
  ratioFromPointer,
  saveSplit,
  useSplitRatio,
  useViewMode,
} from './layout';
import { blockIndexForLine, lineToTop, topToLine } from './preview/scrollSync';

describe('分栏比例', () => {
  it('限制在 20%–80%，非法值回到默认', () => {
    expect(clampSplit(0.05)).toBe(MIN_SPLIT);
    expect(clampSplit(0.95)).toBe(MAX_SPLIT);
    expect(clampSplit(0.42)).toBe(0.42);
    expect(clampSplit(Number.NaN)).toBe(DEFAULT_SPLIT);
  });

  it('保存后能读回，坏数据回到默认', () => {
    expect(loadSplit()).toBe(DEFAULT_SPLIT);
    saveSplit(0.37);
    expect(localStorage.getItem(SPLIT_STORAGE_KEY)).toBe('0.3700');
    expect(loadSplit()).toBeCloseTo(0.37);
    saveSplit(2);
    expect(loadSplit()).toBe(MAX_SPLIT);
    localStorage.setItem(SPLIT_STORAGE_KEY, 'abc');
    expect(loadSplit()).toBe(DEFAULT_SPLIT);
  });

  it('由指针位置换算比例', () => {
    expect(ratioFromPointer(300, 100, 400)).toBe(0.5);
    expect(ratioFromPointer(0, 100, 400)).toBe(MIN_SPLIT);
    expect(ratioFromPointer(10, 0, 0)).toBe(DEFAULT_SPLIT);
  });

  it('useSplitRatio：拖动时不写入，松手 commit 才持久化', () => {
    const { result, unmount } = renderHook(() => useSplitRatio());
    expect(result.current.ratio).toBe(DEFAULT_SPLIT);
    act(() => result.current.setRatio(0.3));
    expect(result.current.ratio).toBe(0.3);
    expect(localStorage.getItem(SPLIT_STORAGE_KEY)).toBeNull();
    act(() => result.current.commit(0.3));
    expect(localStorage.getItem(SPLIT_STORAGE_KEY)).toBe('0.3000');
    unmount();
    const again = renderHook(() => useSplitRatio());
    expect(again.result.current.ratio).toBeCloseTo(0.3);
  });

  it('视图模式持久化', () => {
    expect(loadViewMode()).toBe('split');
    const { result } = renderHook(() => useViewMode());
    act(() => result.current[1]('preview'));
    expect(result.current[0]).toBe('preview');
    expect(localStorage.getItem(VIEW_STORAGE_KEY)).toBe('preview');
    localStorage.setItem(VIEW_STORAGE_KEY, 'weird');
    expect(loadViewMode()).toBe('split');
  });
});

describe('同步滚动插值', () => {
  const anchors = [
    { line: 1, top: 0 },
    { line: 11, top: 100 },
    { line: 21, top: 400 },
  ];

  it('源码行 → 预览位置', () => {
    expect(lineToTop(anchors, 1, 1000)).toBe(0);
    expect(lineToTop(anchors, 6, 1000)).toBe(50);
    expect(lineToTop(anchors, 16, 1000)).toBe(250);
    expect(lineToTop(anchors, 99, 1000)).toBe(400);
    expect(lineToTop(anchors, 16, 200)).toBe(200);
    expect(lineToTop([], 5, 100)).toBe(0);
  });

  it('预览位置 → 源码行', () => {
    expect(topToLine(anchors, 50)).toBe(6);
    expect(topToLine(anchors, 250)).toBe(16);
    expect(topToLine(anchors, 9999)).toBe(21);
    expect(topToLine([], 10)).toBe(1);
  });

  it('按行号找块', () => {
    expect(blockIndexForLine([1, 5, 9], 0)).toBe(-1);
    expect(blockIndexForLine([1, 5, 9], 6)).toBe(1);
    expect(blockIndexForLine([1, 5, 9], 9)).toBe(2);
  });
});
