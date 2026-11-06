import { emptyDoc, markdownToPm, plainToPm, type PmNode } from './richtext';
import type {
  DeckInfo,
  LayoutId,
  PlaceholderKind,
  ShapeElement,
  TextElement,
  TextStyle,
  Theme,
} from './types';
import { tr } from '@/lib/i18n';

/**
 * 主题（配色 + 字体）与母版版式（生成占位符）。
 * 这些颜色是幻灯片内容数据（会写进 PPTX），不是界面样式。
 */

export const DEFAULT_SIZE = { width: 960, height: 540 } as const;

export const THEMES: readonly Theme[] = [
  {
    id: 'simple',
    name: tr('简约'),
    bg: '#FFFFFF',
    fg: '#1F2328',
    muted: '#5C6370',
    accent: '#4F46E5',
    colors: ['#4F46E5', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6'],
    titleFont: 'Microsoft YaHei',
    bodyFont: 'Microsoft YaHei',
  },
  {
    id: 'academic',
    name: tr('学术蓝'),
    bg: '#FFFFFF',
    fg: '#1E293B',
    muted: '#475569',
    accent: '#1D4ED8',
    colors: ['#1D4ED8', '#0F766E', '#B45309', '#7C3AED', '#BE123C', '#475569'],
    titleFont: 'Microsoft YaHei',
    bodyFont: 'Microsoft YaHei',
  },
  {
    id: 'dark',
    name: tr('深色'),
    bg: '#111827',
    fg: '#F3F4F6',
    muted: '#9CA3AF',
    accent: '#818CF8',
    colors: ['#818CF8', '#38BDF8', '#34D399', '#FBBF24', '#F87171', '#C084FC'],
    titleFont: 'Microsoft YaHei',
    bodyFont: 'Microsoft YaHei',
  },
  {
    id: 'warm',
    name: tr('暖色'),
    bg: '#FFFBF5',
    fg: '#3B2F2F',
    muted: '#7C6A5E',
    accent: '#C2410C',
    colors: ['#C2410C', '#B45309', '#15803D', '#0369A1', '#9D174D', '#57534E'],
    titleFont: 'SimSun',
    bodyFont: 'Microsoft YaHei',
  },
  {
    id: 'green',
    name: tr('清新'),
    bg: '#F7FBF8',
    fg: '#16302B',
    muted: '#4B635C',
    accent: '#059669',
    colors: ['#059669', '#0891B2', '#65A30D', '#D97706', '#DC2626', '#7C3AED'],
    titleFont: 'Microsoft YaHei',
    bodyFont: 'Microsoft YaHei',
  },
];

export const DEFAULT_THEME: Theme = THEMES[0]!;

export const FONT_OPTIONS = [
  'Microsoft YaHei',
  'SimHei',
  'SimSun',
  'KaiTi',
  'FangSong',
  'PingFang SC',
  'Noto Sans SC',
  'Arial',
  'Calibri',
  'Times New Roman',
  'Georgia',
  'Consolas',
] as const;

export const FONT_LABEL: Record<string, string> = {
  'Microsoft YaHei': tr('微软雅黑'),
  SimHei: tr('黑体'),
  SimSun: tr('宋体'),
  KaiTi: tr('楷体'),
  FangSong: tr('仿宋'),
  'PingFang SC': tr('苹方'),
  'Noto Sans SC': tr('思源黑体'),
};

export const FONT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 72, 96];

/** CSS 字体栈：指定字体 + 中文 / 拉丁后备 */
export function cssFont(name: string | undefined | null): string {
  const n = (name ?? '').replace(/["']/gu, '').trim();
  const fallback =
    "'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans SC', 'Inter', sans-serif";
  if (!n) return fallback;
  if (/song|宋|serif|times|georgia|kai|楷|fang|仿/iu.test(n))
    return `'${n}', 'Songti SC', 'Noto Serif SC', serif`;
  return `'${n}', ${fallback}`;
}

export const LAYOUTS: ReadonlyArray<{ id: LayoutId; label: string }> = [
  { id: 'title', label: tr('标题页') },
  { id: 'content', label: tr('标题和正文') },
  { id: 'two-column', label: tr('两栏') },
  { id: 'section', label: tr('章节页') },
  { id: 'title-only', label: tr('仅标题') },
  { id: 'image-text', label: tr('图文') },
  { id: 'blank', label: tr('空白') },
];

export const PLACEHOLDER_PROMPT: Record<PlaceholderKind, string> = {
  title: tr('单击此处添加标题'),
  subtitle: tr('单击此处添加副标题'),
  body: tr('单击此处添加文本'),
};

export function isLayoutId(v: unknown): v is LayoutId {
  return typeof v === 'string' && LAYOUTS.some((l) => l.id === v);
}

export type TextInit = Partial<Omit<TextElement, 'map' | 'frag'>> & { type: 'text' };
export type ShapeInit = Partial<Omit<ShapeElement, 'map' | 'frag'>> & { type: 'shape' };

/** 占位符的样式用主题令牌（theme:fg / theme:muted / theme:title…），读出时按当前主题解析，换主题自动跟着变 */
function textStyle(_theme: Theme, size: number, opts: Partial<TextStyle> = {}): TextStyle {
  return {
    fontSize: size,
    color: 'theme:fg',
    fontFamily: 'theme:body',
    ...opts,
  };
}

export function resolveToken(v: string, theme: Theme): string {
  if (!v.startsWith('theme:')) return v;
  const key = v.slice(6);
  if (key === 'fg') return theme.fg;
  if (key === 'muted') return theme.muted;
  if (key === 'accent') return theme.accent;
  if (key === 'bg') return theme.bg;
  if (key === 'title') return theme.titleFont;
  if (key === 'body') return theme.bodyFont;
  const m = /^c(\d)$/u.exec(key);
  if (m) return theme.colors[Number(m[1])] ?? theme.accent;
  return theme.fg;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function box(deck: DeckInfo, fx: number, fy: number, fw: number, fh: number): Box {
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    x: r(deck.width * fx),
    y: r(deck.height * fy),
    w: r(deck.width * fw),
    h: r(deck.height * fh),
  };
}

function textBox(
  id: string,
  ph: PlaceholderKind,
  b: Box,
  style: TextStyle,
  doc: PmNode,
  valign: TextElement['valign'],
): TextInit {
  return {
    type: 'text',
    id,
    ph,
    ...b,
    style,
    doc,
    valign,
    autofit: 'none',
    name: ph === 'title' ? tr('标题') : ph === 'subtitle' ? tr('副标题') : tr('正文'),
  };
}

/** 占位符内容：PM JSON，或字符串（标题按纯文本、其余按 markdown 解析） */
export interface PlaceholderContent {
  title?: PmNode | string;
  subtitle?: PmNode | string;
  body?: PmNode | string;
  body2?: PmNode | string;
}

/**
 * 版式 → 占位符元素。id 由前缀 + 角色确定（同一页重复生成得到相同 id：两个人同时迁移同一页不会多出元素）。
 */
export function layoutElements(
  layout: LayoutId,
  deck: DeckInfo,
  idPrefix: string,
  content: PlaceholderContent = {},
): Array<TextInit | ShapeInit> {
  const t = deck.theme;
  const titleStyle = (size: number, align: TextStyle['align'] = 'left') =>
    textStyle(t, size, { fontFamily: 'theme:title', bold: true, align });
  const out: Array<TextInit | ShapeInit> = [];
  const doc = (d: PmNode | string | undefined, plain = false) =>
    typeof d === 'string' ? (plain ? plainToPm(d) : markdownToPm(d)) : (d ?? emptyDoc());
  switch (layout) {
    case 'title':
      out.push(
        textBox(
          `${idPrefix}title`,
          'title',
          box(deck, 0.08, 0.28, 0.84, 0.22),
          titleStyle(44, 'center'),
          doc(content.title, true),
          'bottom',
        ),
        textBox(
          `${idPrefix}subtitle`,
          'subtitle',
          box(deck, 0.14, 0.54, 0.72, 0.16),
          textStyle(t, 22, { color: 'theme:muted', align: 'center' }),
          doc(content.subtitle ?? content.body),
          'top',
        ),
      );
      break;
    case 'section':
      out.push(
        {
          type: 'shape',
          id: `${idPrefix}bar`,
          shape: 'rect',
          ...box(deck, 0.08, 0.4, 0.07, 0.012),
          fill: { type: 'color', color: 'theme:accent' },
          stroke: null,
          name: tr('装饰条'),
        },
        textBox(
          `${idPrefix}title`,
          'title',
          box(deck, 0.08, 0.43, 0.84, 0.17),
          titleStyle(40),
          doc(content.title, true),
          'top',
        ),
        textBox(
          `${idPrefix}subtitle`,
          'subtitle',
          box(deck, 0.08, 0.61, 0.84, 0.15),
          textStyle(t, 20, { color: 'theme:muted' }),
          doc(content.subtitle ?? content.body),
          'top',
        ),
      );
      break;
    case 'two-column':
      out.push(
        textBox(
          `${idPrefix}title`,
          'title',
          box(deck, 0.06, 0.06, 0.88, 0.15),
          titleStyle(32),
          doc(content.title, true),
          'middle',
        ),
        textBox(
          `${idPrefix}body`,
          'body',
          box(deck, 0.06, 0.25, 0.425, 0.66),
          textStyle(t, 20),
          doc(content.body),
          'top',
        ),
        textBox(
          `${idPrefix}body2`,
          'body',
          box(deck, 0.515, 0.25, 0.425, 0.66),
          textStyle(t, 20),
          doc(content.body2),
          'top',
        ),
      );
      break;
    case 'title-only':
      out.push(
        textBox(
          `${idPrefix}title`,
          'title',
          box(deck, 0.06, 0.06, 0.88, 0.15),
          titleStyle(32),
          doc(content.title, true),
          'middle',
        ),
      );
      break;
    case 'image-text':
      out.push(
        textBox(
          `${idPrefix}title`,
          'title',
          box(deck, 0.06, 0.06, 0.88, 0.15),
          titleStyle(32),
          doc(content.title, true),
          'middle',
        ),
        textBox(
          `${idPrefix}body`,
          'body',
          box(deck, 0.06, 0.25, 0.42, 0.66),
          textStyle(t, 20),
          doc(content.body),
          'top',
        ),
      );
      break;
    case 'blank':
      break;
    default:
      out.push(
        textBox(
          `${idPrefix}title`,
          'title',
          box(deck, 0.06, 0.06, 0.88, 0.15),
          titleStyle(32),
          doc(content.title, true),
          'middle',
        ),
        textBox(
          `${idPrefix}body`,
          'body',
          box(deck, 0.06, 0.25, 0.88, 0.66),
          textStyle(t, 22),
          doc(content.body),
          'top',
        ),
      );
      break;
  }
  return out;
}

/** 旧版固定版式（title / body markdown）→ 占位符内容 */
export function legacyContent(
  layout: string,
  title: string,
  body: string,
  splitColumns: (body: string) => [string, string],
): PlaceholderContent {
  const titleDoc = plainToPm(title.replace(/\n+/gu, ' '));
  if (layout === 'title' || layout === 'section') {
    return { title: titleDoc, subtitle: markdownToPm(body) };
  }
  if (layout === 'two-column') {
    const [l, r] = splitColumns(body);
    return { title: titleDoc, body: markdownToPm(l), body2: markdownToPm(r) };
  }
  return { title: titleDoc, body: markdownToPm(body) };
}

/** 幻灯片内容用的常用色（会写进 PPTX，属于数据而不是界面配色） */
export const WHITE = '#FFFFFF';
export const BLACK = '#000000';
export const SWATCHES = [
  BLACK,
  '#404040',
  '#7F7F7F',
  '#BFBFBF',
  WHITE,
  '#C00000',
  '#FF0000',
  '#FFC000',
  '#FFFF00',
  '#92D050',
  '#00B050',
  '#00B0F0',
  '#0070C0',
  '#002060',
  '#7030A0',
];
