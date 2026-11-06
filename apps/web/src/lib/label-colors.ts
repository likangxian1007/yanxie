import { paletteFromString } from './palette';

/**
 * 线程标签 → 色板颜色（STYLE §1.2 的 8 色色板）。与 Badge、LabelFilter 同一套映射：
 * `paletteFromString(label)`，所以同一个标签在任何列表里都是同一个颜色。
 * 只返回语义 token 的类名（bg-palette-n 等），类名写成字面量，Tailwind 才扫得到。
 */
export interface LabelColor {
  /** 色板序号 0–7（Badge 的 color 属性可以直接用）；没有标签为 null */
  index: number | null;
  /** 实心小圆点 / 色块 */
  dot: string;
  /** 卡片顶部 2px 色条（配合 border-t-2 使用） */
  borderTop: string;
  /** 左侧色条（配合 border-l-2 使用） */
  borderLeft: string;
  /** 14% 柔和底色 */
  soft: string;
}

const COLORS: readonly LabelColor[] = [
  {
    index: 0,
    dot: 'bg-palette-0',
    borderTop: 'border-t-palette-0',
    borderLeft: 'border-l-palette-0',
    soft: 'bg-palette-0/14',
  },
  {
    index: 1,
    dot: 'bg-palette-1',
    borderTop: 'border-t-palette-1',
    borderLeft: 'border-l-palette-1',
    soft: 'bg-palette-1/14',
  },
  {
    index: 2,
    dot: 'bg-palette-2',
    borderTop: 'border-t-palette-2',
    borderLeft: 'border-l-palette-2',
    soft: 'bg-palette-2/14',
  },
  {
    index: 3,
    dot: 'bg-palette-3',
    borderTop: 'border-t-palette-3',
    borderLeft: 'border-l-palette-3',
    soft: 'bg-palette-3/14',
  },
  {
    index: 4,
    dot: 'bg-palette-4',
    borderTop: 'border-t-palette-4',
    borderLeft: 'border-l-palette-4',
    soft: 'bg-palette-4/14',
  },
  {
    index: 5,
    dot: 'bg-palette-5',
    borderTop: 'border-t-palette-5',
    borderLeft: 'border-l-palette-5',
    soft: 'bg-palette-5/14',
  },
  {
    index: 6,
    dot: 'bg-palette-6',
    borderTop: 'border-t-palette-6',
    borderLeft: 'border-l-palette-6',
    soft: 'bg-palette-6/14',
  },
  {
    index: 7,
    dot: 'bg-palette-7',
    borderTop: 'border-t-palette-7',
    borderLeft: 'border-l-palette-7',
    soft: 'bg-palette-7/14',
  },
];

/** 没有标签：中性色 */
export const UNLABELED_COLOR: LabelColor = {
  index: null,
  dot: 'bg-fg-subtle',
  borderTop: 'border-t-line-strong',
  borderLeft: 'border-l-line-strong',
  soft: 'bg-muted',
};

/** 标签的色板序号；空标签为 null。 */
export function labelColorIndex(label: string | null | undefined): number | null {
  if (!label?.trim()) return null;
  return paletteFromString(label);
}

/** 标签的颜色类名。 */
export function labelColor(label: string | null | undefined): LabelColor {
  const i = labelColorIndex(label);
  return i === null ? UNLABELED_COLOR : (COLORS[i] ?? UNLABELED_COLOR);
}
