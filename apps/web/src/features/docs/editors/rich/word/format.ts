import { tr } from '@/lib/i18n';
/**
 * Word 式排版的常量：字体（含常用中文字体与回退）、字号（磅值 + 中文字号）、颜色、行距、段距。
 * 文档内容里的颜色是“文档数据”（导出到 Word 也是这个色值），不是界面配色，所以这里直接写色值。
 */

export interface FontOption {
  label: string;
  /** 写进 textStyle.fontFamily 的 CSS 字体栈；第一个名字也是导出到 Word 的字体名 */
  value: string;
  /** 中文字体（导出时写进 w:eastAsia） */
  cjk?: boolean;
}

export const FONT_FAMILIES: FontOption[] = [
  { label: tr('宋体'), value: '宋体, SimSun, "Songti SC", STSong, serif', cjk: true }, // i18n-ignore
  { label: tr('黑体'), value: '黑体, SimHei, "Heiti SC", STHeiti, sans-serif', cjk: true }, // i18n-ignore
  { label: tr('楷体'), value: '楷体, KaiTi, "Kaiti SC", STKaiti, serif', cjk: true }, // i18n-ignore
  { label: tr('仿宋'), value: '仿宋, FangSong, STFangsong, serif', cjk: true }, // i18n-ignore
  {
    label: tr('微软雅黑'),
    value: '微软雅黑, "Microsoft YaHei", "PingFang SC", sans-serif', // i18n-ignore
    cjk: true,
  },
  { label: tr('等线'), value: '等线, DengXian, "PingFang SC", sans-serif', cjk: true }, // i18n-ignore
  { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Calibri', value: 'Calibri, Carlito, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Courier New', value: '"Courier New", Courier, monospace' },
];

/** 中文字体名 ⇄ Windows 英文名（导入的文档两种写法都有） */
const CJK_ALIASES: Record<string, string> = {
  simsun: '宋体', // i18n-ignore
  宋体: '宋体', // i18n-ignore
  nsimsun: '宋体', // i18n-ignore
  新宋体: '宋体', // i18n-ignore
  simhei: '黑体', // i18n-ignore
  黑体: '黑体', // i18n-ignore
  kaiti: '楷体', // i18n-ignore
  楷体: '楷体', // i18n-ignore
  楷体_gb2312: '楷体', // i18n-ignore
  fangsong: '仿宋', // i18n-ignore
  仿宋: '仿宋', // i18n-ignore
  仿宋_gb2312: '仿宋', // i18n-ignore
  'microsoft yahei': '微软雅黑', // i18n-ignore
  微软雅黑: '微软雅黑', // i18n-ignore
  dengxian: '等线', // i18n-ignore
  等线: '等线', // i18n-ignore
};

/** CSS 字体栈拆成名字（去引号） */
export function fontNames(stack: string | null | undefined): string[] {
  if (!stack) return [];
  return stack
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/gu, ''))
    .filter(Boolean);
}

/** 字体名对应的中文字体标准名（宋体 / 黑体…），不是中文字体返回 null */
export function cjkFontName(name: string): string | null {
  return CJK_ALIASES[name.toLowerCase()] ?? null;
}

/** 按字体栈的第一个名字找预设（label 会随界面语言变，不能按 label 找） */
const known = (name: string) => FONT_FAMILIES.find((f) => fontNames(f.value)[0] === name);

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);

/**
 * 导入的字体（如 “Arial, 黑体”）规整成带回退的字体栈：已知字体换成我们的完整字体栈，
 * 拉丁字体在前、中文字体在后（浏览器对中文字符自动落到后面的中文字体，和 Word 的 ascii / eastAsia 一致）。
 */
export function normalizeFontStack(input: string | null | undefined): string | null {
  const names = fontNames(input).filter((n) => !GENERIC.has(n.toLowerCase()));
  if (names.length === 0) return null;
  const latin: string[] = [];
  let cjk: string | null = null;
  for (const n of names) {
    const c = cjkFontName(n);
    if (c) cjk ??= c;
    else if (!latin.includes(n)) latin.push(n);
  }
  const known = (label: string) => FONT_FAMILIES.find((f) => f.label === label);
  if (latin.length === 0 && cjk) return known(cjk)?.value ?? null;
  const first = known(latin[0]!);
  if (!cjk && first && latin.length === 1) return first.value;
  const quote = (n: string) => (/[\s"]/u.test(n) ? `"${n.replace(/"/gu, '')}"` : n);
  const parts = latin.map(quote);
  if (cjk) parts.push(...fontNames(known(cjk)?.value).map(quote));
  return parts.join(', ');
}

/** 导出用：拉丁字体名与中文字体名 */
export function splitFontStack(stack: string | null | undefined): {
  ascii: string | null;
  eastAsia: string | null;
} {
  const names = fontNames(stack).filter((n) => !GENERIC.has(n.toLowerCase()));
  let ascii: string | null = null;
  let eastAsia: string | null = null;
  for (const n of names) {
    const c = cjkFontName(n);
    if (c) eastAsia ??= c;
    else ascii ??= n;
  }
  return { ascii, eastAsia };
}

/** 当前字体栈在下拉框里显示的名字 */
export function fontLabel(stack: string | null | undefined): string {
  if (!stack) return tr('默认字体');
  const exact = FONT_FAMILIES.find((f) => f.value === stack);
  if (exact) return exact.label;
  const { ascii, eastAsia } = splitFontStack(stack);
  return eastAsia && ascii
    ? `${ascii} / ${known(eastAsia)?.label ?? eastAsia}`
    : (ascii ?? (eastAsia && (known(eastAsia)?.label ?? eastAsia)) ?? tr('默认字体'));
}

export interface SizeOption {
  label: string;
  pt: number;
}

/** 中文字号（GB/T 148 常用对照） */
export const CN_FONT_SIZES: SizeOption[] = [
  { label: tr('初号'), pt: 42 },
  { label: tr('小初'), pt: 36 },
  { label: tr('一号'), pt: 26 },
  { label: tr('小一'), pt: 24 },
  { label: tr('二号'), pt: 22 },
  { label: tr('小二'), pt: 18 },
  { label: tr('三号'), pt: 16 },
  { label: tr('小三'), pt: 15 },
  { label: tr('四号'), pt: 14 },
  { label: tr('小四'), pt: 12 },
  { label: tr('五号'), pt: 10.5 },
  { label: tr('小五'), pt: 9 },
  { label: tr('六号'), pt: 7.5 },
];

/** Word 默认字号表（磅） */
export const PT_FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

/** 没设字号时正文的实际大小（编辑器正文 15px ≈ 11pt），导出到 Word 也按这个 */
export const DEFAULT_FONT_PT = 11;

/** 颜色选择器里“自动”文字颜色的初始值 */
export const DEFAULT_TEXT_COLOR = '#000000';

/** "12pt" / "16px" / "1.2em" → 磅值；认不出返回 null */
export function toPt(size: string | null | undefined): number | null {
  if (!size) return null;
  const m = /^\s*([\d.]+)\s*(pt|px|em|rem)?\s*$/iu.exec(size);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? 'px').toLowerCase();
  const pt = unit === 'pt' ? n : unit === 'px' ? n * 0.75 : n * 11.25;
  return Math.round(pt * 2) / 2;
}

export function ptValue(pt: number): string {
  return `${Math.round(pt * 2) / 2}pt`;
}

/** 字号下拉显示：中文字号优先（如 “小四”），否则磅值 */
export function sizeLabel(size: string | null | undefined): string {
  const pt = toPt(size);
  if (pt === null) return tr('字号');
  const cn = CN_FONT_SIZES.find((s) => s.pt === pt);
  return cn ? cn.label : String(pt);
}

/** 增大 / 减小字号：沿 Word 的字号表走一步 */
export function stepFontSize(size: string | null | undefined, dir: 1 | -1): string {
  const cur = toPt(size) ?? DEFAULT_FONT_PT;
  const list = PT_FONT_SIZES;
  if (dir > 0) return ptValue(list.find((s) => s > cur) ?? Math.min(cur + 10, 400));
  const smaller = [...list].reverse().find((s) => s < cur);
  return ptValue(smaller ?? Math.max(1, cur - 1));
}

/** 文字颜色（Word 标准色 + 灰阶） */
export const TEXT_COLORS: { label: string; value: string }[] = [
  { label: tr('黑色'), value: '#000000' },
  { label: tr('深灰'), value: '#404040' },
  { label: tr('灰色'), value: '#7f7f7f' },
  { label: tr('浅灰'), value: '#bfbfbf' },
  { label: tr('深红'), value: '#c00000' },
  { label: tr('红色'), value: '#ff0000' },
  { label: tr('橙色'), value: '#ffc000' },
  { label: tr('黄色'), value: '#ffff00' },
  { label: tr('浅绿'), value: '#92d050' },
  { label: tr('绿色'), value: '#00b050' },
  { label: tr('浅蓝'), value: '#00b0f0' },
  { label: tr('蓝色'), value: '#0070c0' },
  { label: tr('深蓝'), value: '#002060' },
  { label: tr('紫色'), value: '#7030a0' },
];

/** 高亮 / 单元格底色（浅色，深色文字上可读） */
export const HIGHLIGHT_COLORS: { label: string; value: string }[] = [
  { label: tr('黄色'), value: '#fff3a3' },
  { label: tr('橙色'), value: '#ffd8a8' },
  { label: tr('红色'), value: '#ffccc7' },
  { label: tr('粉色'), value: '#ffd6e7' },
  { label: tr('绿色'), value: '#d9f7be' },
  { label: tr('青色'), value: '#c3f4f0' },
  { label: tr('蓝色'), value: '#bae0ff' },
  { label: tr('紫色'), value: '#e5d9ff' },
  { label: tr('灰色'), value: '#e5e5e5' },
];

/** Word 的 16 种高亮名 → 色值（导入 w:highlight） */
export const WORD_HIGHLIGHT: Record<string, string> = {
  yellow: '#ffff00',
  green: '#00ff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  blue: '#0000ff',
  red: '#ff0000',
  darkblue: '#000080',
  darkcyan: '#008080',
  darkgreen: '#008000',
  darkmagenta: '#800080',
  darkred: '#800000',
  darkyellow: '#808000',
  darkgray: '#808080',
  lightgray: '#c0c0c0',
  black: '#000000',
  white: '#ffffff',
};

export const LINE_HEIGHTS = ['1', '1.15', '1.5', '1.75', '2', '2.5', '3'];

/** 段前 / 段后（磅） */
export const PARAGRAPH_SPACINGS = [0, 3, 6, 8, 10, 12, 18, 24];

/** 规整颜色：#rgb / #rrggbb / rgb() → #rrggbb；transparent / auto / 认不出 → null */
export function normalizeColor(input: string | null | undefined): string | null {
  if (!input) return null;
  const v = input.trim().toLowerCase();
  if (!v || v === 'auto' || v === 'transparent' || v === 'inherit' || v === 'none') return null;
  if (/^#?[0-9a-f]{6}$/u.test(v)) return v.startsWith('#') ? v : `#${v}`;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/u.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/u.exec(v);
  if (rgb) {
    if (rgb[4] !== undefined && parseFloat(rgb[4]) === 0) return null;
    return `#${[rgb[1], rgb[2], rgb[3]]
      .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0'))
      .join('')}`;
  }
  if (WORD_HIGHLIGHT[v]) return WORD_HIGHLIGHT[v];
  return null;
}
