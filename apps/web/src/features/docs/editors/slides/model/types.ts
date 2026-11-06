import type * as Y from 'yjs';
import type { PmNode } from './richtext';

/**
 * 自由版式幻灯片的数据模型（快照类型；Y 结构见 deck.ts 顶部注释）。
 * 单位一律是磅（pt）：默认页面 960 × 540 pt（PowerPoint 宽屏 13.333 × 7.5 英寸），
 * 字号也是 pt，所以和 PowerPoint / pptxgenjs / pptxtojson 之间换算只是 ÷72 或原样。
 */

export type ElementType = 'text' | 'shape' | 'image' | 'line' | 'table';

export type Fill =
  | { type: 'color'; color: string }
  | { type: 'gradient'; angle: number; stops: Array<{ pos: number; color: string }> }
  | { type: 'image'; src: string; fileId?: string };

export type DashKind = 'solid' | 'dash' | 'dot';

export interface Stroke {
  color: string;
  width: number;
  dash?: DashKind;
}

export type TextAlign = 'left' | 'center' | 'right' | 'justify';
export type VAlign = 'top' | 'middle' | 'bottom';

/** 文本框的默认文字样式（行内标记可以覆盖） */
export interface TextStyle {
  fontSize: number;
  color: string;
  fontFamily: string;
  bold?: boolean;
  align?: TextAlign;
  lineHeight?: number;
}

export type PlaceholderKind = 'title' | 'subtitle' | 'body';

export type ArrowKind = 'none' | 'arrow' | 'triangle' | 'stealth' | 'oval' | 'diamond';

export interface ElementBase {
  id: string;
  type: ElementType;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 顺时针角度 */
  rot: number;
  /** 层级（fractional-indexing 键，越大越靠上） */
  z: string;
  group: string | null;
  ph: PlaceholderKind | null;
  name: string;
  flipH: boolean;
  flipV: boolean;
  /** 对应的 Y.Map（只读快照里带着，写操作用它） */
  map: Y.Map<unknown> | null;
}

export interface TextProps {
  doc: PmNode;
  frag: Y.XmlFragment | null;
  style: TextStyle;
  valign: VAlign;
  fill: Fill | null;
  stroke: Stroke | null;
  /** 内边距 [左, 上, 右, 下] */
  pad: [number, number, number, number];
  /** grow：高度随文字增长；shrink：缩小字号放进框（fontScale）；none：固定 */
  autofit: 'none' | 'grow' | 'shrink';
  fontScale: number;
  vertical: boolean;
}

export interface TextElement extends ElementBase, TextProps {
  type: 'text';
}

export interface ShapeElement extends ElementBase, TextProps {
  type: 'shape';
  /** OOXML 预设形状名（rect、roundRect、ellipse、triangle、rightArrow…） */
  shape: string;
  /** 自定义 / 导入形状的 SVG 路径（坐标在 vb 里） */
  path: string | null;
  vb: [number, number] | null;
}

export interface ImageElement extends ElementBase {
  type: 'image';
  src: string;
  fileId: string | null;
  fit: 'fill' | 'contain' | 'cover';
  /** 裁掉的比例（0..1，相对原图） */
  crop: { l: number; t: number; r: number; b: number } | null;
  stroke: Stroke | null;
  /** 圆角 / 椭圆裁剪 */
  geom: 'rect' | 'roundRect' | 'ellipse';
}

export interface LineElement extends ElementBase {
  type: 'line';
  stroke: Stroke;
  start: ArrowKind;
  end: ArrowKind;
}

export interface TableCell {
  text: string;
  ytext: Y.Text | null;
  map: Y.Map<unknown> | null;
  fill: string | null;
  color: string | null;
  bold: boolean;
  italic: boolean;
  align: TextAlign | null;
  fontSize: number | null;
  colSpan: number;
  rowSpan: number;
  /** 被合并单元格覆盖 */
  hidden: boolean;
}

export interface TableElement extends ElementBase {
  type: 'table';
  cells: TableCell[][];
  colW: number[];
  rowH: number[];
  border: Stroke | null;
  style: TextStyle;
  /** 第一行作为表头（加粗 + 主题色底） */
  header: boolean;
}

export type SlideElement = TextElement | ShapeElement | ImageElement | LineElement | TableElement;

export type Background = Fill;

export interface Theme {
  id: string;
  name: string;
  bg: string;
  fg: string;
  muted: string;
  accent: string;
  /** 6 个强调色（表格表头、形状默认填充、图表） */
  colors: string[];
  titleFont: string;
  bodyFont: string;
}

export interface DeckInfo {
  width: number;
  height: number;
  theme: Theme;
}

export type LayoutId =
  'title' | 'content' | 'two-column' | 'section' | 'title-only' | 'blank' | 'image-text';

export interface SlideModel {
  id: string;
  /** 排序键 */
  order: string;
  map: Y.Map<unknown>;
  layout: LayoutId;
  /** 1 = 旧的固定版式数据（只读时现场转换，可编辑时迁移成 2） */
  version: 1 | 2;
  bg: Background | null;
  elements: SlideElement[];
  notes: string;
  /** 页标题：标题占位符的文字，没有时取第一个文本框的第一行 */
  title: string;
}
