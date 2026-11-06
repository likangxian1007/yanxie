import { isError, type CellValue } from '../engine/values';
import type { BorderSide, CellStyle } from '../model/schema';

/**
 * 单元格样式 → CSS（网格渲染和打印视图共用）。字号单位 pt（与 Excel 一致），默认 11pt。
 * 对齐缺省按值类型：数字靠右、布尔 / 错误居中、文本靠左；垂直缺省靠下（Excel 默认）。
 */

export const DEFAULT_FONT_PT = 11;
/**
 * 屏幕上的字号：1pt 显示为 1.2px（11pt → 13.2px，与 Google 表格显示 Excel 文件的比例一致）。
 * Excel 的列宽按 Calibri 的数字宽度定义，界面字体（Inter / 苹方 / 雅黑）更宽，按 4/3 换算会让导入的
 * 日期、金额列放不下。打印视图用同一比例（列宽同为像素，比例一致才不会截断）。
 */
export const FONT_SCALE = 1.2;
export const ptToCssPx = (pt: number) => Math.round(pt * FONT_SCALE * 100) / 100;

export interface CellCss {
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string;
  fontSize?: string;
  fontFamily?: string;
  color?: string;
  backgroundColor?: string;
  textAlign?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  whiteSpace?: string;
  borderTop?: string;
  borderRight?: string;
  borderBottom?: string;
  borderLeft?: string;
}

export function borderCss(b: BorderSide | undefined): string | undefined {
  if (!b) return undefined;
  switch (b.s) {
    case 'medium':
      return `2px solid ${b.c}`;
    case 'thick':
      return `3px solid ${b.c}`;
    case 'dashed':
      return `1px dashed ${b.c}`;
    case 'dotted':
      return `1px dotted ${b.c}`;
    case 'double':
      return `3px double ${b.c}`;
    default:
      return `1px solid ${b.c}`;
  }
}

/** 底色（#rgb / #rrggbb）上“自动”字色：亮底配近黑，暗底配白；认不出的颜色返回近黑（Excel 默认） */
export function autoTextColor(bg: string): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(bg.trim());
  if (!m) return '#1f1f1f';
  const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
  return lum > 0.18 ? '#1f1f1f' : '#ffffff';
}

export function defaultAlign(value: CellValue): 'left' | 'center' | 'right' {
  if (typeof value === 'number') return 'right';
  if (typeof value === 'boolean' || isError(value)) return 'center';
  return 'left';
}

export function cssOfStyle(
  st: CellStyle | undefined,
  value: CellValue,
  formatColor?: string,
): CellCss {
  const css: CellCss = {};
  const s = st ?? {};
  if (s.b) css.fontWeight = '700';
  if (s.i) css.fontStyle = 'italic';
  const deco = [s.u ? 'underline' : '', s.s ? 'line-through' : ''].filter(Boolean).join(' ');
  if (deco) css.textDecoration = deco;
  if (s.fs && s.fs !== DEFAULT_FONT_PT) css.fontSize = `${ptToCssPx(s.fs)}px`;
  if (s.ff) css.fontFamily = `"${s.ff.replace(/"/gu, '')}", var(--font-sans, sans-serif)`;
  const color = formatColor ?? s.fc;
  if (color) css.color = color;
  else if (isError(value)) css.color = '#e5484d';
  // 有底色、没设字色（Excel 的“自动”）：按底色取深 / 浅字，不跟界面主题走，
  // 否则深色模式下浅底色的格子（导入的隔行底色）会是浅字配浅底，看不清
  else if (s.bg) css.color = autoTextColor(s.bg);
  if (s.bg) css.backgroundColor = s.bg;
  css.textAlign = s.ha ?? defaultAlign(value);
  css.verticalAlign = s.va ?? 'bottom';
  css.whiteSpace = s.wrap ? 'pre-wrap' : 'pre';
  const bt = borderCss(s.bt);
  const br = borderCss(s.br);
  const bb = borderCss(s.bb);
  const bl = borderCss(s.bl);
  if (bt) css.borderTop = bt;
  if (br) css.borderRight = br;
  if (bb) css.borderBottom = bb;
  if (bl) css.borderLeft = bl;
  return css;
}
