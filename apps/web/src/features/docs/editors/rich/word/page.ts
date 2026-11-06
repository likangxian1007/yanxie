import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { tr } from '@/lib/i18n';

/**
 * 页面设置（纸张、方向、页边距）：存在同一个 Y.Doc 的 Y.Map `page` 里，所有人共享，导出 Word / PDF 用。
 * 没有这个 Map 的旧文档按默认值（A4 纵向，Word 中文默认页边距 上下 2.54cm、左右 3.17cm）。
 * 键与服务端 `documents/pm-word.ts` 的 DOC_PAGE_FIELD 一致（版本恢复时一起恢复）。
 */
export const DOC_PAGE_FIELD = 'page';

export type PaperSize = 'A4' | 'A3' | 'A5' | 'B5' | 'Letter';
export type Orientation = 'portrait' | 'landscape';

export interface PageSetup {
  size: PaperSize;
  orientation: Orientation;
  /** 页边距（毫米） */
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
}

/** 纸张尺寸（毫米，纵向） */
export const PAPER_SIZES: Record<PaperSize, { label: string; width: number; height: number }> = {
  A4: { label: tr('A4（21 × 29.7 厘米）'), width: 210, height: 297 },
  A3: { label: tr('A3（29.7 × 42 厘米）'), width: 297, height: 420 },
  A5: { label: tr('A5（14.8 × 21 厘米）'), width: 148, height: 210 },
  B5: { label: tr('B5（17.6 × 25 厘米）'), width: 176, height: 250 },
  Letter: { label: tr('Letter（8.5 × 11 英寸）'), width: 215.9, height: 279.4 },
};

export const DEFAULT_PAGE: PageSetup = {
  size: 'A4',
  orientation: 'portrait',
  marginTop: 25.4,
  marginRight: 31.8,
  marginBottom: 25.4,
  marginLeft: 31.8,
};

export const MARGIN_PRESETS: {
  label: string;
  value: Pick<PageSetup, 'marginTop' | 'marginRight' | 'marginBottom' | 'marginLeft'>;
}[] = [
  {
    label: tr('常规（上下 2.54、左右 3.18 厘米）'),
    value: { marginTop: 25.4, marginRight: 31.8, marginBottom: 25.4, marginLeft: 31.8 },
  },
  {
    label: tr('窄（四边 1.27 厘米）'),
    value: { marginTop: 12.7, marginRight: 12.7, marginBottom: 12.7, marginLeft: 12.7 },
  },
  {
    label: tr('适中（上下 2.54、左右 1.91 厘米）'),
    value: { marginTop: 25.4, marginRight: 19.1, marginBottom: 25.4, marginLeft: 19.1 },
  },
  {
    label: tr('宽（上下 2.54、左右 5.08 厘米）'),
    value: { marginTop: 25.4, marginRight: 50.8, marginBottom: 25.4, marginLeft: 50.8 },
  },
];

const MM_PX = 96 / 25.4;
export const mmToPx = (mm: number) => mm * MM_PX;
/** 毫米 → Word 的 twip（1/1440 英寸） */
export const mmToTwip = (mm: number) => Math.round((mm / 25.4) * 1440);
export const twipToMm = (twip: number) => Math.round((twip / 1440) * 25.4 * 10) / 10;
export const ptToMm = (pt: number) => Math.round((pt / 72) * 25.4 * 10) / 10;

const clampMargin = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
};

/** 读出页面设置（缺的键用默认值） */
export function readPageSetup(map: Y.Map<unknown> | Record<string, unknown>): PageSetup {
  const get = (k: string) => (map instanceof Y.Map ? map.get(k) : map[k]);
  const size = String(get('size') ?? '') as PaperSize;
  const orientation = get('orientation') === 'landscape' ? 'landscape' : 'portrait';
  return {
    size: size in PAPER_SIZES ? size : DEFAULT_PAGE.size,
    orientation,
    marginTop: clampMargin(get('marginTop'), DEFAULT_PAGE.marginTop),
    marginRight: clampMargin(get('marginRight'), DEFAULT_PAGE.marginRight),
    marginBottom: clampMargin(get('marginBottom'), DEFAULT_PAGE.marginBottom),
    marginLeft: clampMargin(get('marginLeft'), DEFAULT_PAGE.marginLeft),
  };
}

export function pageMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(DOC_PAGE_FIELD);
}

export function writePageSetup(doc: Y.Doc, patch: Partial<PageSetup>) {
  const map = pageMap(doc);
  doc.transact(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) map.set(k, v);
    }
  });
}

/** 纸张实际宽高（毫米，已按方向交换） */
export function paperMm(setup: PageSetup): { width: number; height: number } {
  const p = PAPER_SIZES[setup.size];
  return setup.orientation === 'landscape'
    ? { width: p.height, height: p.width }
    : { width: p.width, height: p.height };
}

/** 页面几何（像素，96dpi） */
export interface PageGeometry {
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function pageGeometry(setup: PageSetup): PageGeometry {
  const { width, height } = paperMm(setup);
  return {
    width: mmToPx(width),
    height: mmToPx(height),
    top: mmToPx(setup.marginTop),
    right: mmToPx(setup.marginRight),
    bottom: mmToPx(setup.marginBottom),
    left: mmToPx(setup.marginLeft),
  };
}

/** 订阅页面设置（协同：别人改了页边距，自己这边同步刷新） */
export function usePageSetup(doc: Y.Doc): PageSetup {
  const [setup, setSetup] = useState(() => readPageSetup(pageMap(doc)));
  useEffect(() => {
    const map = pageMap(doc);
    const update = () => setSetup(readPageSetup(map));
    update();
    map.observe(update);
    return () => map.unobserve(update);
  }, [doc]);
  return setup;
}

const VIEW_KEY = 'srh.rich.pageView';

/** 页面视图 / 连续视图：个人偏好，存本机 */
export function readPageViewPref(): boolean {
  try {
    return window.localStorage.getItem(VIEW_KEY) === '1';
  } catch {
    return false;
  }
}

export function writePageViewPref(on: boolean) {
  try {
    window.localStorage.setItem(VIEW_KEY, on ? '1' : '0');
  } catch {
    // 隐私模式等写不进去：只在本次会话生效
  }
}
