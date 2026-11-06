import { tr } from '@/lib/i18n';
/** 文本层的小工具：HTML 转义、文本符号命令、重音、纯文本提取。全部纯函数，不依赖 DOM。 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/** 无参数的文本符号命令 → HTML。 */
export const TEXT_SYMBOLS: Record<string, string> = {
  LaTeX:
    '<span class="ltx-logo">L<span class="ltx-logo-a">a</span>T<span class="ltx-logo-e">e</span>X</span>',
  LaTeXe:
    '<span class="ltx-logo">L<span class="ltx-logo-a">a</span>T<span class="ltx-logo-e">e</span>X&thinsp;2<sub>ε</sub></span>',
  TeX: '<span class="ltx-logo">T<span class="ltx-logo-e">e</span>X</span>',
  BibTeX:
    '<span class="ltx-logo">B<span class="ltx-sc">ib</span>T<span class="ltx-logo-e">e</span>X</span>',
  ldots: '…',
  dots: '…',
  textellipsis: '…',
  textendash: '–',
  textemdash: '—',
  S: '§',
  P: '¶',
  dag: '†',
  textdagger: '†',
  ddag: '‡',
  textdaggerdbl: '‡',
  copyright: '©',
  textcopyright: '©',
  textregistered: '®',
  texttrademark: '™',
  textbackslash: '\\',
  textasciitilde: '~',
  textasciicircum: '^',
  textbar: '|',
  textless: '&lt;',
  textgreater: '&gt;',
  textbullet: '•',
  textperiodcentered: '·',
  textdegree: '°',
  pounds: '£',
  textsterling: '£',
  euro: '€',
  texteuro: '€',
  textquoteleft: '‘',
  textquoteright: '’',
  textquotedblleft: '“',
  textquotedblright: '”',
  quad: '<span class="ltx-quad"></span>',
  qquad: '<span class="ltx-qquad"></span>',
  enspace: '&ensp;',
  thinspace: '&thinsp;',
  ',': '&thinsp;',
  ';': '&ensp;',
  ':': '&ensp;',
  '!': '',
  ' ': ' ',
  '/': '',
  '-': '',
  '@': '',
  '&': '&amp;',
  '%': '%',
  $: '$',
  '#': '#',
  _: '_',
  '{': '{',
  '}': '}',
  i: 'ı',
  j: 'ȷ',
  ss: 'ß',
  ae: 'æ',
  AE: 'Æ',
  oe: 'œ',
  OE: 'Œ',
  o: 'ø',
  O: 'Ø',
  aa: 'å',
  AA: 'Å',
  l: 'ł',
  L: 'Ł',
  hfill: '<span class="ltx-hfill"></span>',
};

/** 重音命令 → 组合附加符（\'e、\"{o}、\c{c} …）。 */
export const ACCENTS: Record<string, string> = {
  "'": '\u0301',
  '`': '\u0300',
  '^': '\u0302',
  '"': '\u0308',
  '~': '\u0303',
  '=': '\u0304',
  '.': '\u0307',
  u: '\u0306',
  v: '\u030C',
  H: '\u030B',
  c: '\u0327',
  k: '\u0328',
  r: '\u030A',
  d: '\u0323',
  b: '\u0331',
};

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

export function isCjk(ch: string | undefined): boolean {
  return ch !== undefined && CJK.test(ch);
}

export function containsCjk(text: string): boolean {
  return CJK.test(text);
}

/**
 * 把一小段 LaTeX（标题等）粗略转成纯文本：去掉注释、命令名和花括号，保留 $…$ 原样。
 * 只用于大纲、文件名这类展示，不追求精确。
 */
export function latexToPlain(raw: string): string {
  return raw
    .replace(/(^|[^\\])%[^\n]*/g, '$1')
    .replace(/\\(label|footnote|thanks|index|cite\w*|ref|eqref)\s*(\[[^\]]*\])?\s*\{[^{}]*\}/g, '')
    .replace(/\\(LaTeX|TeX)\b/g, '$1')
    .replace(/\\([&%$#_{}])/g, '$1')
    .replace(/\\\\/g, ' ')
    .replace(/~/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const EN_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function formatToday(date: Date, lang: 'zh' | 'en'): string {
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  return lang === 'zh'
    ? tr('{y}年{value}月{d}日', { y, value: m + 1, d })
    : `${EN_MONTHS[m] ?? ''} ${d}, ${y}`;
}

/** 1 → a，27 → aa（enumerate 第二层、子图编号用） */
export function alphaLabel(n: number, upper = false): string {
  let out = '';
  let k = n;
  while (k > 0) {
    const r = (k - 1) % 26;
    out = String.fromCharCode(97 + r) + out;
    k = Math.floor((k - 1) / 26);
  }
  return upper ? out.toUpperCase() : out;
}

const ROMAN: Array<[number, string]> = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];

export function romanLabel(n: number): string {
  let out = '';
  let k = n;
  for (const [value, sym] of ROMAN) {
    while (k >= value) {
      out += sym;
      k -= value;
    }
  }
  return out;
}

/** 安全的链接地址：只放行 http(s) 与 mailto */
export function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : null;
}
