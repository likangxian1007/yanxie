import { L10N, Out, type Ctx, type LabelInfo } from './context';
import { renderMath } from './math';
import {
  ACCENTS,
  TEXT_SYMBOLS,
  alphaLabel,
  escapeHtml,
  formatToday,
  isCjk,
  latexToPlain,
  romanLabel,
  safeUrl,
} from './text';
import { parseColSpec, parseLength } from './tabular-spec';
import { tr } from '@/lib/i18n';

/**
 * LaTeX → HTML 的递归下降解析器。
 *
 * 思路：所有环境、花括号分组都先在源码上找到配对的结束位置，再对这段区间做“区间解析”
 * （parseRange / parseInto），所以位置一直是原始源码的下标，行号天然准确。
 * \ref、\cite、目录这些要等全文解析完才知道编号的内容，先输出占位符（\uE000…\uE001），
 * 由 renderLatex 在最后统一替换。
 */

export const PH_OPEN = '\uE000';
export const PH_CLOSE = '\uE001';
const AUTHOR_SEP = '\uE002';

const ph = (kind: 'R' | 'C' | 'T' | 'B', index: number) => `${PH_OPEN}${kind}${index}${PH_CLOSE}`;

// ---------------------------------------------------------------- 命令表

/** 带一个参数的包裹命令 */
const WRAP: Record<string, [string, string]> = {
  textbf: ['<strong>', '</strong>'],
  textit: ['<em>', '</em>'],
  textsl: ['<em>', '</em>'],
  emph: ['<em>', '</em>'],
  texttt: ['<code class="ltx-tt">', '</code>'],
  underline: ['<u>', '</u>'],
  uline: ['<u>', '</u>'],
  textsc: ['<span class="ltx-sc">', '</span>'],
  sout: ['<s>', '</s>'],
  st: ['<s>', '</s>'],
  textsuperscript: ['<sup>', '</sup>'],
  textsubscript: ['<sub>', '</sub>'],
  textrm: ['<span>', '</span>'],
  textsf: ['<span class="ltx-sf">', '</span>'],
  textnormal: ['<span>', '</span>'],
  textup: ['<span>', '</span>'],
  textmd: ['<span>', '</span>'],
  mbox: ['<span>', '</span>'],
  hbox: ['<span>', '</span>'],
  text: ['<span>', '</span>'],
  centerline: ['<span class="ltx-centerline">', '</span>'],
  fbox: ['<span class="ltx-fbox">', '</span>'],
  framebox: ['<span class="ltx-fbox">', '</span>'],
  hl: ['<mark class="ltx-mark">', '</mark>'],
  phantom: ['<span class="ltx-phantom">', '</span>'],
};

/** 声明式字体命令：在花括号分组里包裹“分组剩余部分” */
const DECLARATIONS: Record<string, [string, string]> = {
  bfseries: ['<strong>', '</strong>'],
  bf: ['<strong>', '</strong>'],
  itshape: ['<em>', '</em>'],
  it: ['<em>', '</em>'],
  em: ['<em>', '</em>'],
  slshape: ['<em>', '</em>'],
  sl: ['<em>', '</em>'],
  ttfamily: ['<code class="ltx-tt">', '</code>'],
  tt: ['<code class="ltx-tt">', '</code>'],
  scshape: ['<span class="ltx-sc">', '</span>'],
  sc: ['<span class="ltx-sc">', '</span>'],
};

/** 直接忽略的无参命令（排版、分页、字号……） */
const NOOP = new Set([
  'centering',
  'raggedright',
  'raggedleft',
  'noindent',
  'indent',
  'clearpage',
  'cleardoublepage',
  'newpage',
  'frenchspacing',
  'protect',
  'relax',
  'sloppy',
  'fussy',
  'null',
  'nobreak',
  'leavevmode',
  'strut',
  'FloatBarrier',
  'listoffigures',
  'listoftables',
  'smallskip',
  'medskip',
  'bigskip',
  'vfill',
  'hfil',
  'vfil',
  'break',
  'phantomsection',
  'makeatletter',
  'makeatother',
  'selectfont',
  'normalfont',
  'rmfamily',
  'sffamily',
  'upshape',
  'mdseries',
  'tiny',
  'scriptsize',
  'footnotesize',
  'small',
  'normalsize',
  'large',
  'Large',
  'LARGE',
  'huge',
  'Huge',
  'hline',
  'toprule',
  'midrule',
  'bottomrule',
  'IEEEpeerreviewmaketitle',
  'restoregeometry',
  'balance',
  'printindex',
  'makeindex',
  'onecolumn',
]);

/**
 * 直接跳过参数的命令：s = 可选星号，o = 可选 [..]，数字 = 必选参数个数。
 * 例如 'o1' = [可选]{必选}。
 */
const SKIP_ARGS: Record<string, string> = {
  documentclass: 'o1',
  usepackage: 'o1',
  RequirePackage: 'o1',
  pagestyle: '1',
  thispagestyle: '1',
  pagenumbering: '1',
  bibliographystyle: '1',
  setlength: '2',
  addtolength: '2',
  setcounter: '2',
  addtocounter: '2',
  stepcounter: '1',
  refstepcounter: '1',
  geometry: '1',
  newgeometry: '1',
  hypersetup: '1',
  graphicspath: '1',
  linespread: '1',
  vspace: 's1',
  hspace: 's1',
  addvspace: '1',
  captionsetup: 'o1',
  definecolor: '3',
  colorlet: '2',
  lstset: '1',
  newcounter: '1o',
  numberwithin: '2',
  ctexset: '1',
  index: '1',
  urlstyle: '1',
  setcitestyle: '1',
  setmainfont: 'o1',
  setsansfont: 'o1',
  setmonofont: 'o1',
  setCJKmainfont: 'o1',
  setCJKsansfont: 'o1',
  setCJKmonofont: 'o1',
  pagebreak: 'o',
  nopagebreak: 'o',
  addcontentsline: '3',
  fontsize: '2',
  color: '1',
  settowidth: '2',
  theoremstyle: '1',
  enlargethispage: '1',
  includeonly: '1',
  crefname: '3',
  Crefname: '3',
  newlength: '1',
  DeclareGraphicsExtensions: '1',
  sisetup: '1',
  tikzset: '1',
  usetikzlibrary: '1',
  pgfplotsset: '1',
  twocolumn: 'o',
  allowdisplaybreaks: 'o',
  tnotetext: 'o1',
  markboth: '2',
  markright: '1',
};

const SECTION_LEVEL: Record<string, number> = {
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
};

const REF_COMMANDS = new Set([
  'ref',
  'eqref',
  'pageref',
  'autoref',
  'cref',
  'Cref',
  'nameref',
  'vref',
  'subref',
]);

const CITE_COMMANDS = new Set([
  'cite',
  'citep',
  'citet',
  'citealp',
  'citealt',
  'citeauthor',
  'citeyear',
  'citeyearpar',
  'parencite',
  'textcite',
  'autocite',
  'footcite',
  'supercite',
  'Cite',
  'Citep',
  'Citet',
]);

const VERBATIM_ENVS = new Set([
  'verbatim',
  'verbatim*',
  'Verbatim',
  'lstlisting',
  'minted',
  'comment',
  'alltt',
]);

const MATH_ENVS = new Set([
  'equation',
  'equation*',
  'displaymath',
  'math',
  'align',
  'align*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'eqnarray',
  'eqnarray*',
  'flalign',
  'flalign*',
  'alignat',
  'alignat*',
]);

const PASSTHROUGH_ENVS = new Set([
  'titlepage',
  'spacing',
  'singlespace',
  'onehalfspace',
  'doublespace',
  'CJK',
  'CJK*',
  'landscape',
  'sloppypar',
  'small',
  'footnotesize',
  'scriptsize',
  'tiny',
  'normalsize',
  'large',
  'Large',
  'samepage',
  'adjustbox',
  'resizebox',
]);

const ITEM_TOKENS = new Set(['item']);
const BIBITEM_TOKENS = new Set(['bibitem']);
const ROW_TOKENS = new Set(['\\', 'tabularnewline']);
const RULE_COMMANDS = new Set([
  'hline',
  'toprule',
  'midrule',
  'bottomrule',
  'cline',
  'cmidrule',
  'specialrule',
  'addlinespace',
]);

/** lucide 的 image 图标（currentColor 描边），给图片占位框用 */
const IMAGE_ICON =
  '<svg class="ltx-graphic-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"></path></svg>';

const THANKS_MARKS = ['*', '†', '‡', '§', '¶', '‖'];

// 字符分类：在纯文本串里遇到这些字符就要停下来特殊处理
const SPECIAL = new Uint8Array(128);
for (const ch of "\\{}$%&~^_#\n-`'") SPECIAL[ch.charCodeAt(0)] = 1;

function isLetter(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 64;
}

export function anchorKey(key: string): string {
  return key.trim().replace(/[^\w:.-]/g, '_');
}

interface Range {
  start: number;
  end: number;
  after: number;
}

interface Token {
  pos: number;
  end: number;
  name: string;
}

export class Parser {
  pos = 0;
  limit: number;
  private inGroup = false;
  private lineStarts: number[] | null = null;

  constructor(
    readonly ctx: Ctx,
    readonly src: string,
    private readonly fixedLine: number | null = null,
  ) {
    this.limit = src.length;
  }

  // ---------------------------------------------------------------- 位置与警告

  lineAt(pos: number): number {
    if (this.fixedLine !== null) return this.fixedLine;
    if (!this.lineStarts) {
      const starts = [0];
      const s = this.src;
      for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) starts.push(i + 1);
      this.lineStarts = starts;
    }
    const starts = this.lineStarts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  warn(pos: number, message: string): void {
    this.ctx.warnings.push({ line: this.lineAt(pos), message });
  }

  private newAnchor(prefix: string): string {
    this.ctx.uid += 1;
    return `${prefix}-${this.ctx.uid}`;
  }

  // ---------------------------------------------------------------- 区间解析

  /** 把 [start, end) 解析进一个新的 Out。 */
  parseRange(start: number, end: number, flow: boolean, group = false): Out {
    const out = new Out(flow);
    this.parseInto(start, end, out, group);
    return out.finish();
  }

  /** 把 [start, end) 解析进已有的 Out（不 finish）。 */
  parseInto(start: number, end: number, out: Out, group = false): void {
    const savedPos = this.pos;
    const savedLimit = this.limit;
    const savedGroup = this.inGroup;
    this.pos = start;
    this.limit = Math.min(end, this.src.length);
    this.inGroup = group;
    try {
      this.parse(out);
    } finally {
      this.pos = savedPos;
      this.limit = savedLimit;
      this.inGroup = savedGroup;
    }
  }

  /** 主循环：从 pos 解析到 limit。 */
  parse(out: Out): void {
    const s = this.src;
    while (this.pos < this.limit) {
      const ch = s[this.pos] as string;
      const code = ch.charCodeAt(0);
      if (code >= 128 || SPECIAL[code] === 0) {
        this.textRun(out);
        continue;
      }
      switch (ch) {
        case '\\':
          this.command(out);
          break;
        case '{':
          this.group(out);
          break;
        case '}':
          this.warn(this.pos, tr('多余的 }（前面没有对应的 {）'));
          this.pos += 1;
          break;
        case '$':
          this.dollarMath(out);
          break;
        case '%':
          this.skipComment(out);
          break;
        case '&':
          this.warn(this.pos, tr('& 只能用在表格或对齐环境里（正文里请写 \\&）'));
          out.text('&amp;', this.lineAt(this.pos));
          this.pos += 1;
          break;
        case '\n':
          this.newline(out);
          break;
        case '~':
          out.text('&nbsp;', this.lineAt(this.pos));
          this.pos += 1;
          break;
        case '^':
        case '_':
          this.warn(
            this.pos,
            tr('可能缺少 $：{ch} 只能在数学公式里使用（正文里请写 \\{ch2}）', { ch, ch2: ch }),
          );
          out.text(ch, this.lineAt(this.pos));
          this.pos += 1;
          break;
        case '#':
          out.text('#', this.lineAt(this.pos));
          this.pos += 1;
          break;
        case '-':
          this.dashes(out);
          break;
        case '`':
        case "'":
          this.quotes(out);
          break;
        default:
          this.textRun(out);
      }
    }
  }

  private textRun(out: Out): void {
    const s = this.src;
    const start = this.pos;
    let i = start;
    while (i < this.limit) {
      const code = s.charCodeAt(i);
      if (code < 128 && SPECIAL[code] === 1) break;
      i += 1;
    }
    if (i === start) i += 1;
    out.text(escapeHtml(s.slice(start, i)), this.lineAt(start));
    this.pos = i;
  }

  private dashes(out: Out): void {
    const s = this.src;
    let n = 0;
    while (this.pos + n < this.limit && s[this.pos + n] === '-') n += 1;
    const line = this.lineAt(this.pos);
    this.pos += n;
    let text = '';
    let k = n;
    while (k >= 3) {
      text += '—';
      k -= 3;
    }
    if (k === 2) text += '–';
    else if (k === 1) text += '-';
    out.text(text, line);
  }

  private quotes(out: Out): void {
    const s = this.src;
    const ch = s[this.pos];
    const line = this.lineAt(this.pos);
    if (s[this.pos + 1] === ch) {
      out.text(ch === '`' ? '“' : '”', line);
      this.pos += 2;
    } else {
      out.text(ch === '`' ? '‘' : '’', line);
      this.pos += 1;
    }
  }

  private skipComment(out: Out): void {
    const s = this.src;
    const nl = s.indexOf('\n', this.pos);
    if (nl === -1 || nl >= this.limit) {
      this.pos = this.limit;
      return;
    }
    // 注释吃掉行尾换行和下一行的行首空白；下一行若是空行，则仍然分段
    let i = nl + 1;
    while (i < this.limit && (s[i] === ' ' || s[i] === '\t' || s[i] === '\r')) i += 1;
    if (s[i] === '\n') {
      out.parbreak();
      i += 1;
    }
    this.pos = i;
  }

  private newline(out: Out): void {
    const s = this.src;
    const at = this.pos;
    let i = at + 1;
    let blank = false;
    for (;;) {
      let j = i;
      while (j < this.limit && (s[j] === ' ' || s[j] === '\t' || s[j] === '\r')) j += 1;
      if (j < this.limit && s[j] === '\n') {
        blank = true;
        i = j + 1;
        continue;
      }
      i = j;
      break;
    }
    this.pos = i;
    if (blank) {
      out.parbreak();
      return;
    }
    // 中文之间的单个换行不产生空格（ctex 的行为）
    let p = at - 1;
    while (p >= 0 && (s[p] === ' ' || s[p] === '\t')) p -= 1;
    if (isCjk(s[p]) && isCjk(s[i])) return;
    out.text(' ', this.lineAt(at));
  }

  private group(out: Out): void {
    const open = this.pos;
    const close = this.findGroupEnd(open, this.limit);
    if (close < 0) {
      this.warn(open, tr('花括号没有闭合（缺少 }）'));
      this.pos += 1;
      return;
    }
    const inner = this.parseRange(open + 1, close, false, true);
    out.text(inner.html(), this.lineAt(open));
    this.pos = close + 1;
  }

  // ---------------------------------------------------------------- 扫描工具

  /** open 处是 {，返回配对 } 的下标；找不到返回 -1。跳过转义、注释和 \verb。 */
  findGroupEnd(open: number, limit: number): number {
    const s = this.src;
    let depth = 0;
    for (let i = open; i < limit; i += 1) {
      const c = s[i];
      if (c === '\\') {
        if (s.startsWith('verb', i + 1) && !isLetter(s[i + 5])) {
          let j = i + 5;
          if (s[j] === '*') j += 1;
          const d = s[j];
          if (d !== undefined && d !== '{' && !/\s/.test(d)) {
            const e = s.indexOf(d, j + 1);
            if (e !== -1 && e < limit) {
              i = e;
              continue;
            }
          }
        }
        i += 1;
        continue;
      }
      if (c === '%') {
        const nl = s.indexOf('\n', i);
        if (nl === -1 || nl >= limit) return -1;
        i = nl;
        continue;
      }
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  private findBracketEnd(open: number): number {
    const s = this.src;
    let depth = 0;
    for (let i = open + 1; i < this.limit; i += 1) {
      const c = s[i];
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === ']' && depth <= 0) return i;
      else if (c === '\n' && s[i + 1] === '\n') return -1;
    }
    return -1;
  }

  /** 从 from 起找 \end{name}（考虑同名嵌套与注释），返回内容结束与 \end 之后的位置。 */
  findEnvEnd(
    name: string,
    from: number,
    limit: number,
  ): { contentEnd: number; after: number } | null {
    const re = /\\\\|\\%|%[^\n]*|\\(begin|end)\s*\{([^}]*)\}/g;
    re.lastIndex = from;
    let depth = 1;
    for (;;) {
      const m = re.exec(this.src);
      if (!m || m.index >= limit) return null;
      if (!m[1] || (m[2] ?? '').trim() !== name) continue;
      if (m[1] === 'begin') depth += 1;
      else {
        depth -= 1;
        if (depth === 0) {
          const after = m.index + m[0].length;
          if (after > limit) return null;
          return { contentEnd: m.index, after };
        }
      }
    }
  }

  private readNameEnd(i: number): number {
    const s = this.src;
    if (i >= s.length) return i;
    if (!isLetter(s[i])) return i + 1;
    let j = i;
    while (j < s.length && isLetter(s[j])) j += 1;
    return j;
  }

  /**
   * 在 [start, end) 里找“顶层”的记号（不在花括号、嵌套环境、注释里）：
   * names 里的命令（不含反斜杠，'\\' 表示换行命令）和可选的 &。
   */
  topLevelTokens(start: number, end: number, names: ReadonlySet<string>, amp: boolean): Token[] {
    const s = this.src;
    const out: Token[] = [];
    let i = start;
    while (i < end) {
      const c = s[i];
      if (c === '%') {
        const nl = s.indexOf('\n', i);
        i = nl === -1 || nl >= end ? end : nl + 1;
        continue;
      }
      if (c === '{') {
        const close = this.findGroupEnd(i, end);
        i = close < 0 ? i + 1 : close + 1;
        continue;
      }
      if (c === '&') {
        if (amp) out.push({ pos: i, end: i + 1, name: '&' });
        i += 1;
        continue;
      }
      if (c === '\\') {
        const nameEnd = this.readNameEnd(i + 1);
        const name = s.slice(i + 1, nameEnd);
        if (name === 'begin') {
          const m = /^\s*\{([^}]*)\}/.exec(s.slice(nameEnd, nameEnd + 80));
          if (m) {
            const envName = (m[1] ?? '').trim();
            const found = this.findEnvEnd(envName, nameEnd + m[0].length, end);
            i = found ? found.after : end;
            continue;
          }
        }
        if (name === 'verb') {
          let j = nameEnd;
          if (s[j] === '*') j += 1;
          const d = s[j];
          const e = d === undefined ? -1 : s.indexOf(d, j + 1);
          i = e === -1 || e >= end ? nameEnd : e + 1;
          continue;
        }
        if (names.has(name)) out.push({ pos: i, end: nameEnd, name });
        i = nameEnd;
        continue;
      }
      i += 1;
    }
    return out;
  }

  /** [a, b) 里去掉注释后是否还有非空白内容 */
  hasContent(a: number, b: number): boolean {
    const s = this.src;
    for (let i = a; i < b; i += 1) {
      const c = s[i];
      if (c === '%') {
        const nl = s.indexOf('\n', i);
        if (nl === -1 || nl >= b) return false;
        i = nl;
        continue;
      }
      if (c !== undefined && !/\s/.test(c)) return true;
    }
    return false;
  }

  private skipSpaces(): void {
    const s = this.src;
    while (this.pos < this.limit && (s[this.pos] === ' ' || s[this.pos] === '\t')) this.pos += 1;
  }

  /** 跳过空白、单个换行和注释，遇到空行（分段）返回 -1。 */
  private skipArgSpace(from: number): number {
    const s = this.src;
    let i = from;
    let newlines = 0;
    while (i < this.limit) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\r') i += 1;
      else if (c === '\n') {
        newlines += 1;
        if (newlines > 1) return -1;
        i += 1;
      } else if (c === '%') {
        const nl = s.indexOf('\n', i);
        if (nl === -1 || nl >= this.limit) return this.limit;
        i = nl + 1;
      } else break;
    }
    return i;
  }

  // ---------------------------------------------------------------- 参数读取

  private peekArgRange(): Range | null {
    const i = this.skipArgSpace(this.pos);
    if (i < 0 || i >= this.limit) return null;
    const c = this.src[i];
    if (c === '{') {
      const close = this.findGroupEnd(i, this.limit);
      if (close < 0) {
        this.warn(i, tr('花括号没有闭合（缺少 }）'));
        return { start: i + 1, end: this.limit, after: this.limit };
      }
      return { start: i + 1, end: close, after: close + 1 };
    }
    if (c === '}' || c === ']') return null;
    if (c === '\\') {
      const e = this.readNameEnd(i + 1);
      return { start: i, end: e, after: e };
    }
    return { start: i, end: i + 1, after: i + 1 };
  }

  readRawArg(): string | null {
    const r = this.peekArgRange();
    if (!r) return null;
    this.pos = r.after;
    return this.src.slice(r.start, r.end);
  }

  private readOptRange(): { start: number; end: number } | null {
    const s = this.src;
    let i = this.pos;
    while (i < this.limit && (s[i] === ' ' || s[i] === '\t')) i += 1;
    if (i >= this.limit || s[i] !== '[') return null;
    const close = this.findBracketEnd(i);
    if (close < 0) return null;
    this.pos = close + 1;
    return { start: i + 1, end: close };
  }

  readOptRaw(): string | null {
    const r = this.readOptRange();
    return r ? this.src.slice(r.start, r.end) : null;
  }

  private readStar(): boolean {
    if (this.src[this.pos] === '*') {
      this.pos += 1;
      return true;
    }
    return false;
  }

  /** 读一个命令名参数：{\foo} 或 \foo，返回 foo */
  private readCsArg(): string | null {
    const i = this.skipArgSpace(this.pos);
    if (i < 0 || i >= this.limit) return null;
    const s = this.src;
    if (s[i] === '{') {
      const close = this.findGroupEnd(i, this.limit);
      if (close < 0) return null;
      this.pos = close + 1;
      const inner = s.slice(i + 1, close).trim();
      return inner.startsWith('\\') ? inner.slice(1) : null;
    }
    if (s[i] === '\\') {
      const e = this.readNameEnd(i + 1);
      this.pos = e;
      return s.slice(i + 1, e);
    }
    return null;
  }

  /** 解析下一个参数为行内 HTML */
  parseArg(): string {
    const r = this.peekArgRange();
    if (!r) return '';
    this.pos = r.after;
    return this.parseRange(r.start, r.end, false, true).html();
  }

  private skipArgs(spec: string): void {
    for (const k of spec) {
      if (k === 's') this.readStar();
      else if (k === 'o' || k === 'O') this.readOptRaw();
      else {
        const n = Number(k);
        for (let j = 0; j < n; j += 1) this.readRawArg();
      }
    }
  }

  // ---------------------------------------------------------------- 命令

  private command(out: Out): void {
    const s = this.src;
    const start = this.pos;
    const first = s[start + 1];
    const line = this.lineAt(start);
    if (first === undefined || start + 1 >= this.limit) {
      out.text('\\', line);
      this.pos = start + 1;
      return;
    }
    let name: string;
    if (isLetter(first)) {
      const e = this.readNameEnd(start + 1);
      name = s.slice(start + 1, e);
      this.pos = e;
      this.skipSpaces();
    } else {
      name = first;
      this.pos = start + 2;
    }
    this.dispatch(name, start, line, out);
  }

  private dispatch(name: string, start: number, line: number, out: Out): void {
    const ctx = this.ctx;
    const macro = ctx.macros.get(name);
    if (macro && name !== 'begin' && name !== 'end') {
      this.expandMacro(name, macro.nargs, macro.defaultArg, macro.body, start, line, out);
      return;
    }

    const wrap = WRAP[name];
    if (wrap) {
      out.text(wrap[0] + this.parseArg() + wrap[1], line);
      return;
    }
    const decl = DECLARATIONS[name];
    if (decl) {
      if (this.inGroup && !out.flow) {
        const rest = this.parseRange(this.pos, this.limit, false, true).html();
        out.text(decl[0] + rest + decl[1], line);
        this.pos = this.limit;
      }
      return;
    }
    if (NOOP.has(name)) return;
    const skip = SKIP_ARGS[name];
    if (skip !== undefined) {
      this.skipArgs(skip);
      return;
    }
    const level = SECTION_LEVEL[name];
    if (level !== undefined) {
      this.section(name, level, start, line, out);
      return;
    }
    if (REF_COMMANDS.has(name)) {
      this.readStar();
      const keys = (this.readRawArg() ?? '').split(',');
      const parts = keys
        .map((k) => k.trim())
        .filter(Boolean)
        .map((key) => ph('R', ctx.refs.push({ kind: name, key, line }) - 1));
      out.text(parts.join(', '), line);
      return;
    }
    if (CITE_COMMANDS.has(name)) {
      this.readStar();
      const o1 = this.readOptRaw();
      const o2 = this.readOptRaw();
      const keys = (this.readRawArg() ?? '')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
      const note = o2 !== null ? o2 : o1;
      const index = ctx.cites.push({ keys, note: note?.trim() ? note : null, line }) - 1;
      out.text(ph('C', index), line);
      return;
    }
    const symbol = TEXT_SYMBOLS[name];
    if (symbol !== undefined) {
      out.text(symbol, line);
      return;
    }
    const accent = ACCENTS[name];
    if (accent !== undefined) {
      this.accent(accent, line, out);
      return;
    }

    switch (name) {
      case 'begin':
        this.environment(start, line, out);
        return;
      case 'end': {
        const arg = this.readRawArg() ?? '';
        this.warn(
          start,
          tr('多余的 \\end{{arg}}（前面没有对应的 \\begin{{arg2}}）', { arg, arg2: arg }),
        );
        return;
      }
      case '[':
        this.displayMath(start, '\\]', line, out);
        return;
      case '(':
        this.inlineMath(start, '\\)', line, out);
        return;
      case ']':
      case ')':
        this.warn(start, tr('多余的 \\{name}（前面没有对应的开头）', { name }));
        return;
      case '\\':
      case 'newline':
      case 'tabularnewline':
        this.readStar();
        this.readOptRaw();
        out.text('<br>', line);
        return;
      case 'linebreak':
        this.readOptRaw();
        out.text('<br>', line);
        return;
      case 'par':
        out.parbreak();
        return;
      case 'item':
        this.warn(start, tr('\\item 只能用在 itemize、enumerate 或 description 环境里'));
        this.readOptRaw();
        return;
      case 'newblock':
        out.text(' ', line);
        return;
      case 'title':
      case 'author':
      case 'date': {
        this.readOptRaw();
        const r = this.peekArgRange();
        if (!r) return;
        this.pos = r.after;
        const ref = {
          raw: this.src.slice(r.start, r.end),
          parse: () => this.parseRange(r.start, r.end, false, true).html(),
        };
        if (name === 'title') ctx.title = ref;
        else if (name === 'author') ctx.author = ref;
        else ctx.date = ref;
        return;
      }
      case 'maketitle':
        this.maketitle(start, line, out);
        return;
      case 'today':
        out.text(escapeHtml(formatToday(ctx.today, ctx.lang)), line);
        return;
      case 'and':
        out.text(ctx.inAuthor ? AUTHOR_SEP : ' ', line);
        return;
      case 'thanks': {
        const html = this.parseArg();
        const mark = THANKS_MARKS[ctx.thanks % THANKS_MARKS.length] ?? '*';
        ctx.thanks += 1;
        const anchor = this.newAnchor('fn');
        ctx.footnotes.push({ mark, html, anchor });
        out.text(
          `<sup class="ltx-fnref"><a class="ltx-ref" data-ref="${anchor}">${escapeHtml(mark)}</a></sup>`,
          line,
        );
        return;
      }
      case 'footnote': {
        this.readOptRaw();
        const html = this.parseArg();
        ctx.fn += 1;
        const anchor = `fn-${ctx.fn}`;
        ctx.footnotes.push({ mark: String(ctx.fn), html, anchor });
        out.text(
          `<sup class="ltx-fnref"><a class="ltx-ref" data-ref="${anchor}">${ctx.fn}</a></sup>`,
          line,
        );
        return;
      }
      case 'footnotemark':
        this.readOptRaw();
        ctx.fn += 1;
        out.text(`<sup class="ltx-fnref">${ctx.fn}</sup>`, line);
        return;
      case 'footnotetext': {
        this.readOptRaw();
        const html = this.parseArg();
        ctx.footnotes.push({ mark: String(ctx.fn), html, anchor: `fn-${ctx.fn}` });
        return;
      }
      case 'label':
        this.label(start, (this.readRawArg() ?? '').trim());
        return;
      case 'nocite':
        ctx.nocite.push(
          ...(this.readRawArg() ?? '')
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean),
        );
        return;
      case 'bibliography':
      case 'addbibresource':
      case 'printbibliography': {
        if (name !== 'bibliography') this.readOptRaw();
        const file = name === 'printbibliography' ? null : this.readRawArg();
        if (file) ctx.bibFiles.push(...file.split(',').map((f) => f.trim()));
        if (name === 'addbibresource') return;
        if (ctx.bibCount > 0) return;
        const index = ctx.sections.length;
        const anchor = `sec-${index}`;
        const title = L10N[ctx.lang].references;
        ctx.sections.push({ line, level: 1, heading: title, number: '', anchor });
        out.block(
          `<section class="ltx-bib"><h2 class="ltx-h ltx-h1" data-anchor="${anchor}" data-section="${index}">${title}</h2>${ph('B', 0)}</section>`,
          line,
        );
        return;
      }
      case 'tableofcontents':
        out.block(ph('T', 0), line);
        return;
      case 'appendix':
        ctx.appendix = true;
        if (ctx.hasChapters) ctx.sec = [0, 0, 0, 0];
        else ctx.sec[1] = 0;
        return;
      case 'caption':
      case 'captionof':
        this.caption(name, start, line, out);
        return;
      case 'includegraphics':
        this.includegraphics(line, out);
        return;
      case 'url':
      case 'path': {
        const raw = (this.readRawArg() ?? '').trim();
        const href = safeUrl(raw);
        out.text(
          href
            ? `<a class="ltx-url" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(raw)}</a>`
            : `<code class="ltx-tt">${escapeHtml(raw)}</code>`,
          line,
        );
        return;
      }
      case 'href': {
        const raw = (this.readRawArg() ?? '').trim();
        const html = this.parseArg();
        const href = safeUrl(raw);
        out.text(
          href
            ? `<a class="ltx-url" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${html}</a>`
            : html,
          line,
        );
        return;
      }
      case 'verb':
      case 'lstinline':
        this.verb(name, start, line, out);
        return;
      case 'bibitem':
        this.warn(start, tr('\\bibitem 只能用在 thebibliography 环境里'));
        this.readOptRaw();
        this.readRawArg();
        return;
      case 'input':
      case 'include':
      case 'subfile':
      case 'import': {
        if (name === 'import') this.readRawArg();
        const file = (this.readRawArg() ?? '').trim();
        out.text(
          tr('<span class="ltx-note">（预览不展开外部文件 {value}）</span>', {
            value: escapeHtml(file),
          }),
          line,
        );
        return;
      }
      case 'newcommand':
      case 'renewcommand':
      case 'providecommand':
      case 'DeclareRobustCommand': {
        this.readStar();
        const cs = this.readCsArg();
        if (!cs) {
          this.warn(start, tr('\\{name} 后面缺少命令名', { name }));
          return;
        }
        const nargs = Number.parseInt(this.readOptRaw() ?? '0', 10) || 0;
        const def = nargs > 0 ? this.readOptRaw() : null;
        const body = this.readRawArg() ?? '';
        if (name === 'providecommand' && ctx.macros.has(cs)) return;
        this.defineMacro(cs, Math.min(9, nargs), def, body);
        return;
      }
      case 'def':
      case 'gdef':
      case 'edef':
      case 'xdef': {
        if (this.src[this.pos] !== '\\') return;
        const csEnd = this.readNameEnd(this.pos + 1);
        const cs = this.src.slice(this.pos + 1, csEnd);
        this.pos = csEnd;
        const brace = this.src.indexOf('{', this.pos);
        if (brace === -1 || brace >= this.limit) return;
        const params = this.src.slice(this.pos, brace);
        const nargs = (params.match(/#\d/g) ?? []).length;
        this.pos = brace;
        const body = this.readRawArg() ?? '';
        this.defineMacro(cs, nargs, null, body);
        return;
      }
      case 'let': {
        const a = this.readCsArg();
        if (this.src[this.pos] === '=') this.pos += 1;
        const b = this.readCsArg();
        if (a && b) {
          const m = ctx.macros.get(b);
          if (m) this.defineMacro(a, m.nargs, m.defaultArg, m.body);
        }
        return;
      }
      case 'DeclareMathOperator': {
        const star = this.readStar();
        const cs = this.readCsArg();
        const text = this.readRawArg() ?? '';
        if (cs) {
          ctx.mathMacros[`\\${cs}`] = `\\operatorname${star ? '*' : ''}{${text}}`;
          ctx.mathMacrosKey = null;
        }
        return;
      }
      case 'newenvironment':
      case 'renewenvironment': {
        this.readStar();
        const env = (this.readRawArg() ?? '').trim();
        const nargs = Number.parseInt(this.readOptRaw() ?? '0', 10) || 0;
        const def = nargs > 0 ? this.readOptRaw() : null;
        const begin = this.readRawArg() ?? '';
        const end = this.readRawArg() ?? '';
        if (env) ctx.envMacros.set(env, { nargs, defaultArg: def, begin, end });
        return;
      }
      case 'newtheorem': {
        const star = this.readStar();
        const env = (this.readRawArg() ?? '').trim();
        const shared = this.readOptRaw();
        const title = this.readRawArg() ?? env;
        this.readOptRaw();
        if (env) {
          ctx.theorems.set(env, {
            title: latexToPlain(title),
            counter: shared?.trim() || env,
            numbered: !star,
            plain: false,
          });
        }
        return;
      }
      case 'multicolumn':
        this.readRawArg();
        this.readRawArg();
        out.text(this.parseArg(), line);
        return;
      case 'multirow':
        this.readOptRaw();
        this.readRawArg();
        this.readOptRaw();
        this.readRawArg();
        out.text(this.parseArg(), line);
        return;
      case 'textcolor':
      case 'colorbox':
        this.readOptRaw();
        this.readRawArg();
        out.text(`<span>${this.parseArg()}</span>`, line);
        return;
      case 'resizebox':
        this.readRawArg();
        this.readRawArg();
        out.text(`<span>${this.parseArg()}</span>`, line);
        return;
      case 'parbox':
      case 'raisebox':
      case 'scalebox':
        this.readOptRaw();
        this.readRawArg();
        this.readOptRaw();
        out.text(`<span>${this.parseArg()}</span>`, line);
        return;
      case 'makebox':
        this.readOptRaw();
        this.readOptRaw();
        out.text(`<span>${this.parseArg()}</span>`, line);
        return;
      case 'cline':
      case 'cmidrule':
      case 'specialrule':
        this.readOptRaw();
        this.readRawArg();
        return;
      case 'keywords':
      case 'IEEEkeywords':
        out.text(this.parseArg(), line);
        return;
      default:
        break;
    }

    const star = this.readStar();
    // 正文里预览不认识的命令：每个命令只提示一次（导言区的设置命令不提示）
    if (!ctx.inPreamble && !ctx.unknownCmds.has(name)) {
      ctx.unknownCmds.add(name);
      ctx.warnings.push({
        line: this.lineAt(start),
        message: tr(
          '未定义的命令 \\{name}？预览不认识它；如果它不来自宏包或导言区的定义，编译会报 Undefined control sequence',
          { name },
        ),
        severity: 'warning',
        fixable: true,
      });
    }
    out.text(
      tr('<span class="ltx-unknown" title="预览暂不支持这个命令">\\{value}{value2}</span>', {
        value: escapeHtml(name),
        value2: star ? '*' : '',
      }),
      line,
    );
  }

  private accent(mark: string, line: number, out: Out): void {
    const s = this.src;
    let base = '';
    if (s[this.pos] === '{') {
      const close = this.findGroupEnd(this.pos, this.limit);
      if (close > 0) {
        base = s.slice(this.pos + 1, close).trim();
        this.pos = close + 1;
      }
    } else if (s[this.pos] === '\\') {
      const e = this.readNameEnd(this.pos + 1);
      base = s.slice(this.pos, e);
      this.pos = e;
    } else if (this.pos < this.limit && s[this.pos] !== '\n') {
      base = s[this.pos] ?? '';
      this.pos += 1;
    }
    if (base === '\\i') base = 'i';
    if (base === '\\j') base = 'j';
    out.text(escapeHtml(`${base}${mark}`.normalize('NFC')), line);
  }

  private verb(name: string, start: number, line: number, out: Out): void {
    const s = this.src;
    if (name === 'verb') this.readStar();
    else this.readOptRaw();
    const d = s[this.pos];
    if (d === undefined || this.pos >= this.limit) {
      this.warn(start, tr('\\{name} 缺少内容', { name }));
      return;
    }
    let close: number;
    if (d === '{') close = this.findGroupEnd(this.pos, this.limit);
    else {
      close = s.indexOf(d, this.pos + 1);
      const nl = s.indexOf('\n', this.pos + 1);
      if (nl !== -1 && nl < close) close = -1;
    }
    if (close < 0 || close >= this.limit) {
      this.warn(start, tr('\\{name} 没有闭合（缺少结尾的 {d}）', { name, d }));
      const nl = s.indexOf('\n', this.pos);
      this.pos = nl === -1 || nl > this.limit ? this.limit : nl;
      return;
    }
    out.text(`<code class="ltx-tt">${escapeHtml(s.slice(this.pos + 1, close))}</code>`, line);
    this.pos = close + 1;
  }

  private defineMacro(cs: string, nargs: number, def: string | null, body: string): void {
    const ctx = this.ctx;
    ctx.macros.set(cs, { nargs, defaultArg: def, body });
    if (/^[a-zA-Z@]+$/.test(cs)) {
      ctx.mathMacros[`\\${cs}`] = body;
      ctx.mathMacrosKey = null;
    }
  }

  private expandMacro(
    name: string,
    nargs: number,
    defaultArg: string | null,
    body: string,
    start: number,
    line: number,
    out: Out,
  ): void {
    const ctx = this.ctx;
    if (ctx.expandDepth > 24) {
      this.warn(start, tr('宏 \\{name} 展开层数过深（可能定义成了递归）', { name }));
      return;
    }
    const args: string[] = [];
    for (let k = 0; k < nargs; k += 1) {
      if (k === 0 && defaultArg !== null) {
        args.push(this.readOptRaw() ?? defaultArg);
        continue;
      }
      args.push(this.readRawArg() ?? '');
    }
    const text = body.replace(/#(\d)/g, (_m, d: string) => args[Number(d) - 1] ?? '');
    const child = new Parser(ctx, text, line);
    child.inGroup = this.inGroup;
    ctx.expandDepth += 1;
    try {
      child.parse(out);
    } finally {
      ctx.expandDepth -= 1;
    }
  }

  // ---------------------------------------------------------------- 标签

  private label(start: number, key: string): void {
    const ctx = this.ctx;
    if (!key) {
      this.warn(start, tr('\\label 缺少名字'));
      return;
    }
    if (ctx.labels.has(key)) {
      this.warn(start, tr('标签 {key} 重复定义了', { key }));
      return;
    }
    if (ctx.float && !ctx.float.captioned && !ctx.subfloat) {
      this.warn(
        start,
        tr('\\label{{key}} 要写在 \\caption 之后，否则引用到的不是图表编号', { key }),
      );
    }
    const target = ctx.labelTarget;
    ctx.labels.set(key, target ? { ...target } : { num: '', anchor: null, kind: 'other' });
  }

  private registerLabel(key: string, info: LabelInfo, pos: number): void {
    if (this.ctx.labels.has(key)) {
      this.warn(pos, tr('标签 {key} 重复定义了', { key }));
      return;
    }
    this.ctx.labels.set(key, info);
  }

  // ---------------------------------------------------------------- 标题、章节

  private sectionNumber(level: number): string {
    const ctx = this.ctx;
    const from = ctx.hasChapters ? 0 : 1;
    const parts: string[] = [];
    for (let k = from; k <= level; k += 1) {
      const v = ctx.sec[k] ?? 0;
      parts.push(k === from && ctx.appendix ? alphaLabel(v, true) : String(v));
    }
    return parts.join('.');
  }

  private section(name: string, level: number, start: number, line: number, out: Out): void {
    const ctx = this.ctx;
    const star = this.readStar();
    this.readOptRaw();
    const r = this.peekArgRange();
    if (!r) {
      this.warn(start, tr('\\{name} 缺少标题', { name }));
      return;
    }
    this.pos = r.after;
    const html = this.parseRange(r.start, r.end, false, true).html().trim();
    if (level >= 4) {
      out.parbreak();
      // 标题和正文之间的空格由 CSS 的 margin 提供，避免和源码里的空格叠成两个
      out.text(`<strong class="ltx-runin">${html}</strong>`, line);
      this.skipSpaces();
      return;
    }
    if (level === 0) ctx.hasChapters = true;
    let num = '';
    if (!star) {
      ctx.sec[level] = (ctx.sec[level] ?? 0) + 1;
      for (let k = level + 1; k < 4; k += 1) ctx.sec[k] = 0;
      num = this.sectionNumber(level);
    }
    const outlineLevel = ctx.hasChapters ? level + 1 : Math.max(1, level);
    const index = ctx.sections.length;
    const anchor = `sec-${index}`;
    ctx.sections.push({
      line,
      level: outlineLevel,
      heading: latexToPlain(this.src.slice(r.start, r.end)),
      number: num,
      anchor,
    });
    if (num) ctx.labelTarget = { num, anchor, kind: 'section' };
    const tag = `h${Math.min(6, outlineLevel + 1)}`;
    const numHtml = num ? `<span class="ltx-secnum">${num}</span>` : '';
    out.block(
      `<${tag} class="ltx-h ltx-h${outlineLevel}" data-anchor="${anchor}" data-section="${index}">${numHtml}${html}</${tag}>`,
      line,
    );
  }

  private maketitle(start: number, line: number, out: Out): void {
    const ctx = this.ctx;
    if (!ctx.title) this.warn(start, tr('\\maketitle 之前没有 \\title{…}'));
    const parts: string[] = [];
    if (ctx.title) parts.push(`<h1 class="ltx-title">${ctx.title.parse().trim()}</h1>`);
    if (ctx.author) {
      ctx.inAuthor = true;
      let html: string;
      try {
        html = ctx.author.parse();
      } finally {
        ctx.inAuthor = false;
      }
      const authors = html
        .split(AUTHOR_SEP)
        .map((a) => a.trim())
        .filter(Boolean)
        .map((a) => `<div class="ltx-author">${a}</div>`)
        .join('');
      if (authors) parts.push(`<div class="ltx-authors">${authors}</div>`);
    }
    const date = ctx.date ? ctx.date.parse().trim() : escapeHtml(formatToday(ctx.today, ctx.lang));
    if (date) parts.push(`<div class="ltx-date">${date}</div>`);
    out.block(`<header class="ltx-titleblock">${parts.join('')}</header>`, line);
  }

  // ---------------------------------------------------------------- 数学

  private mathMacrosKey(): string {
    const ctx = this.ctx;
    if (ctx.mathMacrosKey === null) ctx.mathMacrosKey = JSON.stringify(ctx.mathMacros);
    return ctx.mathMacrosKey;
  }

  private math(tex: string, display: boolean, contentPos: number): string {
    const res = renderMath(tex, display, this.ctx.mathMacros, this.mathMacrosKey());
    if (res.error) {
      const before = tex.slice(0, Math.max(0, res.error.offset));
      const extra = (before.match(/\n/g) ?? []).length;
      const line = this.fixedLine ?? this.lineAt(contentPos) + extra;
      this.ctx.warnings.push({ line, message: res.error.message });
    }
    return res.html;
  }

  /** 找数学模式的结束符，跨过空行（分段）视为没闭合。返回结束符下标或 -1。 */
  private findMathClose(from: number, close: string): number {
    const s = this.src;
    for (let i = from; i < this.limit; i += 1) {
      const c = s[i];
      if (c === '\\') {
        if (close.startsWith('\\') && s.startsWith(close, i)) return i;
        i += 1;
        continue;
      }
      if (c === '$' && close.startsWith('$') && s.startsWith(close, i)) return i;
      if (c === '%') {
        const nl = s.indexOf('\n', i);
        if (nl === -1) return -1;
        i = nl - 1;
        continue;
      }
      if (c === '\n') {
        let j = i + 1;
        while (j < this.limit && (s[j] === ' ' || s[j] === '\t' || s[j] === '\r')) j += 1;
        if (s[j] === '\n') return -1;
      }
    }
    return -1;
  }

  /** 公式没闭合：报警告，把到段落结束的内容以错误样式原样显示 */
  private unclosedMath(start: number, contentStart: number, close: string, out: Out): void {
    this.warn(start, tr('数学公式没有闭合（缺少 {close}）', { close }));
    const s = this.src;
    let end = contentStart;
    while (end < this.limit) {
      if (s[end] === '\n') {
        let j = end + 1;
        while (j < this.limit && (s[j] === ' ' || s[j] === '\t' || s[j] === '\r')) j += 1;
        if (s[j] === '\n' || j >= this.limit) break;
      }
      end += 1;
    }
    out.text(
      `<span class="ltx-math-error">${escapeHtml(s.slice(start, end))}</span>`,
      this.lineAt(start),
    );
    this.pos = end;
  }

  private dollarMath(out: Out): void {
    const start = this.pos;
    if (this.src[start + 1] === '$') {
      this.pos = start + 2;
      this.displayMath(start, '$$', this.lineAt(start), out);
    } else {
      this.pos = start + 1;
      this.inlineMath(start, '$', this.lineAt(start), out);
    }
  }

  private inlineMath(start: number, close: string, line: number, out: Out): void {
    const contentStart = this.pos;
    const end = this.findMathClose(contentStart, close);
    if (end < 0) {
      this.unclosedMath(start, contentStart, close, out);
      return;
    }
    const tex = stripMathComments(this.src.slice(contentStart, end));
    this.pos = end + close.length;
    if (!tex.trim()) return;
    out.text(this.math(tex, false, contentStart), line);
  }

  private displayMath(start: number, close: string, line: number, out: Out): void {
    const contentStart = this.pos;
    const end = this.findMathClose(contentStart, close);
    if (end < 0) {
      this.unclosedMath(start, contentStart, close, out);
      return;
    }
    this.pos = end + close.length;
    const anchors: string[] = [];
    const tex = this.mathRow(
      stripMathComments(this.src.slice(contentStart, end)),
      false,
      anchors,
      start,
    );
    out.block(
      this.displayHtml(this.math(tex, true, contentStart), anchors),
      line,
      this.lineAt(end),
    );
  }

  private displayHtml(html: string, anchors: string[]): string {
    const attr = anchors.length ? ` data-anchor="${anchors.join(' ')}"` : '';
    return `<div class="ltx-display"${attr}>${html}</div>`;
  }

  /**
   * 处理一行公式：去掉 \label（登记到公式编号）、\nonumber；需要编号时追加 \tag{n}。
   */
  private mathRow(tex: string, numbered: boolean, anchors: string[], pos: number): string {
    const ctx = this.ctx;
    const keys: string[] = [];
    let body = tex.replace(/\\label\s*\{([^}]*)\}/g, (_m, key: string) => {
      keys.push(key.trim());
      return '';
    });
    let suppressed = false;
    body = body.replace(/\\(nonumber|notag)\b/g, () => {
      suppressed = true;
      return '';
    });
    const userTag = /\\tag\*?\s*\{([^}]*)\}/.exec(body);
    let info: LabelInfo | null = null;
    if (userTag) {
      const anchor = this.newAnchor('eq');
      anchors.push(anchor);
      info = { num: latexToPlain(userTag[1] ?? ''), anchor, kind: 'equation' };
    } else if (numbered && !suppressed && body.trim()) {
      ctx.eq += 1;
      const anchor = `eq-${ctx.eq}`;
      anchors.push(anchor);
      info = { num: String(ctx.eq), anchor, kind: 'equation' };
      body = `${body.replace(/\s+$/, '')} \\tag{${ctx.eq}}`;
    }
    for (const key of keys) {
      if (!key) continue;
      if (info) this.registerLabel(key, info, pos);
      else {
        this.warn(pos, tr('\\label{{key}} 放在了不编号的公式里，引用不到公式编号', { key }));
        this.registerLabel(key, ctx.labelTarget ?? { num: '', anchor: null, kind: 'other' }, pos);
      }
    }
    return body;
  }

  private mathEnv(
    name: string,
    start: number,
    end: number,
    beginPos: number,
    line: number,
    endLine: number,
    out: Out,
  ): void {
    const base = name.replace(/\*$/, '');
    const starred = name.endsWith('*');
    let raw = stripMathComments(this.src.slice(start, end));
    if (base === 'math') {
      if (raw.trim()) out.text(this.math(raw, false, start), line);
      return;
    }
    const anchors: string[] = [];
    if (base === 'equation' || base === 'displaymath') {
      const tex = this.mathRow(raw, base === 'equation' && !starred, anchors, beginPos);
      out.block(this.displayHtml(this.math(tex, true, start), anchors), line, endLine);
      return;
    }
    let cols = '';
    if (base === 'alignat') {
      const m = /^\s*\{(\d+)\}/.exec(raw);
      if (m) {
        cols = m[1] ?? '';
        raw = raw.slice(m[0].length);
      }
    }
    const rows = splitMathRows(raw);
    while (rows.length > 1 && !(rows[rows.length - 1] ?? '').trim()) rows.pop();
    const processed = rows.map((row, i) => {
      let r = row;
      if (base === 'eqnarray') r = r.replace(/&([^&]*)&/, '&$1');
      const rowNumbered = !starred && (base !== 'multline' || i === rows.length - 1);
      return this.mathRow(r, rowNumbered, anchors, beginPos);
    });
    let open: string;
    let close: string;
    if (base === 'gather' || base === 'multline') {
      open = '\\begin{gather*}';
      close = '\\end{gather*}';
    } else if (base === 'alignat') {
      open = `\\begin{alignat*}{${cols || '1'}}`;
      close = '\\end{alignat*}';
    } else {
      open = '\\begin{align*}';
      close = '\\end{align*}';
    }
    const tex = `${open}${processed.join('\\\\')}${close}`;
    out.block(this.displayHtml(this.math(tex, true, start), anchors), line, endLine);
  }

  // ---------------------------------------------------------------- 环境

  private environment(start: number, line: number, out: Out): void {
    const nameRaw = this.readRawArg();
    if (nameRaw === null) {
      this.warn(start, tr('\\begin 后面缺少环境名'));
      return;
    }
    const name = nameRaw.trim();
    if (VERBATIM_ENVS.has(name)) {
      this.verbatimEnv(name, start, line, out);
      return;
    }
    const contentStart = this.pos;
    const found = this.findEnvEnd(name, contentStart, this.limit);
    let contentEnd = this.limit;
    let after = this.limit;
    if (found) {
      contentEnd = found.contentEnd;
      after = found.after;
    } else {
      this.warn(start, tr('环境 {name} 没有闭合（缺少 \\end{{name2}}）', { name, name2: name }));
    }
    const endLine = this.lineAt(Math.max(contentStart, contentEnd - 1));
    const ctx = this.ctx;
    const savedTarget = ctx.labelTarget;
    ctx.envStack.push(name);
    try {
      this.renderEnvironment(name, contentStart, contentEnd, start, line, endLine, out);
    } finally {
      ctx.envStack.pop();
      if (!SECTION_SAFE_ENVS.has(name)) ctx.labelTarget = savedTarget;
    }
    this.pos = after;
  }

  private renderEnvironment(
    name: string,
    start: number,
    end: number,
    beginPos: number,
    line: number,
    endLine: number,
    out: Out,
  ): void {
    const ctx = this.ctx;
    const t = L10N[ctx.lang];
    if (MATH_ENVS.has(name)) {
      this.mathEnv(name, start, end, beginPos, line, endLine, out);
      return;
    }
    const envMacro = ctx.envMacros.get(name);
    if (envMacro) {
      this.pos = start;
      const args: string[] = [];
      for (let k = 0; k < envMacro.nargs; k += 1) {
        if (k === 0 && envMacro.defaultArg !== null) {
          args.push(this.readOptRaw() ?? envMacro.defaultArg);
        } else args.push(this.readRawArg() ?? '');
      }
      const fill = (text: string) =>
        text.replace(/#(\d)/g, (_m, d: string) => args[Number(d) - 1] ?? '');
      const inner = new Out(true);
      new Parser(ctx, fill(envMacro.begin), line).parse(inner);
      this.parseInto(this.pos, end, inner);
      new Parser(ctx, fill(envMacro.end), endLine).parse(inner);
      inner.finish();
      out.block(`<div class="ltx-env-custom">${inner.html()}</div>`, line, endLine);
      return;
    }
    const thm = ctx.theorems.get(name);
    if (thm) {
      this.theorem(
        name,
        thm.title,
        thm.counter,
        thm.numbered,
        thm.plain,
        start,
        end,
        line,
        endLine,
        out,
      );
      return;
    }
    switch (name) {
      case 'document':
        this.parseInto(start, end, out);
        return;
      case 'abstract': {
        const inner = this.parseRange(start, end, true).html();
        out.block(
          `<div class="ltx-abstract"><div class="ltx-abstract-title">${t.abstract}</div>${inner}</div>`,
          line,
          endLine,
        );
        return;
      }
      case 'itemize':
      case 'compactitem':
        this.list('itemize', start, end, line, endLine, out);
        return;
      case 'enumerate':
      case 'compactenum':
      case 'inparaenum':
        this.list('enumerate', start, end, line, endLine, out);
        return;
      case 'description':
        this.list('description', start, end, line, endLine, out);
        return;
      case 'figure':
      case 'figure*':
      case 'wrapfigure':
      case 'SCfigure':
        this.float('figure', name, start, end, line, endLine, out);
        return;
      case 'table':
      case 'table*':
      case 'wraptable':
        this.float('table', name, start, end, line, endLine, out);
        return;
      case 'subfigure':
      case 'subtable':
      case 'minipage':
        this.minipage(name, start, end, line, endLine, out);
        return;
      case 'tabular':
      case 'tabular*':
      case 'tabularx':
      case 'tabulary':
      case 'longtable':
      case 'tabu':
        out.block(this.tabular(name, start, end), line, endLine);
        return;
      case 'center':
      case 'flushleft':
      case 'flushright': {
        const inner = this.parseRange(start, end, true).html();
        out.block(`<div class="ltx-${name}">${inner}</div>`, line, endLine);
        return;
      }
      case 'quote':
      case 'quotation':
      case 'verse': {
        const inner = this.parseRange(start, end, true).html();
        out.block(`<blockquote class="ltx-quote">${inner}</blockquote>`, line, endLine);
        return;
      }
      case 'thebibliography':
        this.bibliography(start, end, line, endLine, out);
        return;
      case 'proof':
        this.theorem(name, t.proof, '', false, true, start, end, line, endLine, out);
        return;
      case 'appendices':
        ctx.appendix = true;
        ctx.sec[ctx.hasChapters ? 0 : 1] = 0;
        this.parseInto(start, end, out);
        return;
      default:
        break;
    }
    if (PASSTHROUGH_ENVS.has(name)) {
      if (name === 'CJK' || name === 'CJK*') {
        this.pos = start;
        this.readRawArg();
        this.readRawArg();
        this.parseInto(this.pos, end, out);
        return;
      }
      this.parseInto(start, end, out);
      return;
    }
    const inner = this.parseRange(start, end, true).html();
    out.block(
      tr(
        '<div class="ltx-env"><span class="ltx-unknown ltx-env-tag" title="预览暂不支持这个环境">\\begin{{value}}</span>{inner}</div>',
        { value: escapeHtml(name), inner },
      ),
      line,
      endLine,
    );
  }

  private verbatimEnv(name: string, start: number, line: number, out: Out): void {
    const s = this.src;
    let lang = '';
    if (name === 'lstlisting' || name === 'Verbatim') {
      const opt = this.readOptRaw();
      const m = opt ? /language\s*=\s*\{?([\w+#-]+)/i.exec(opt) : null;
      if (m) lang = m[1] ?? '';
    } else if (name === 'minted') {
      this.readOptRaw();
      lang = (this.readRawArg() ?? '').trim();
    }
    const endTag = `\\end{${name}}`;
    const contentStart = this.pos;
    let idx = s.indexOf(endTag, contentStart);
    let after: number;
    if (idx === -1 || idx >= this.limit) {
      this.warn(start, tr('环境 {name} 没有闭合（缺少 {endTag}）', { name, endTag }));
      idx = this.limit;
      after = this.limit;
    } else after = idx + endTag.length;
    this.pos = after;
    if (name === 'comment') return;
    const text = s
      .slice(contentStart, idx)
      .replace(/^[ \t]*\r?\n/, '')
      .replace(/\s+$/, '');
    const langHtml = lang ? `<span class="ltx-code-lang">${escapeHtml(lang)}</span>` : '';
    out.block(
      `<pre class="ltx-code">${langHtml}<code>${escapeHtml(text)}</code></pre>`,
      line,
      this.lineAt(Math.max(contentStart, idx - 1)),
    );
  }

  private list(
    kind: 'itemize' | 'enumerate' | 'description',
    start: number,
    end: number,
    line: number,
    endLine: number,
    out: Out,
  ): void {
    const ctx = this.ctx;
    this.pos = start;
    if (kind === 'enumerate') this.readOptRaw();
    const bodyStart = this.pos;
    const items = this.topLevelTokens(bodyStart, end, ITEM_TOKENS, false);
    const firstPos = items[0]?.pos ?? end;
    if (this.hasContent(bodyStart, firstPos)) {
      this.warn(bodyStart, tr('{kind} 环境里的内容要写在 \\item 后面', { kind }));
    }
    if (kind === 'enumerate') ctx.enumDepth += 1;
    if (kind === 'itemize') ctx.itemizeDepth += 1;
    const depthE = ctx.enumDepth;
    const depthI = ctx.itemizeDepth;
    const parts: string[] = [];
    let n = 0;
    try {
      items.forEach((tok, idx) => {
        const itemEnd = items[idx + 1]?.pos ?? end;
        this.pos = tok.end;
        const savedLimit = this.limit;
        this.limit = itemEnd;
        const custom = this.readOptRange();
        const bodyFrom = this.pos;
        this.limit = savedLimit;
        const savedTarget = ctx.labelTarget;
        let labelHtml = '';
        let anchorAttr = '';
        if (custom) labelHtml = this.parseRange(custom.start, custom.end, false, true).html();
        else if (kind === 'enumerate') {
          n += 1;
          labelHtml = enumLabel(n, depthE);
          const anchor = this.newAnchor('item');
          anchorAttr = ` data-anchor="${anchor}"`;
          ctx.labelTarget = { num: enumRef(n, depthE), anchor, kind: 'item' };
        } else if (kind === 'itemize') labelHtml = BULLETS[(depthI - 1) % BULLETS.length] ?? '•';
        const body = this.parseRange(bodyFrom, itemEnd, true).html();
        ctx.labelTarget = savedTarget;
        if (kind === 'description') parts.push(`<dt>${labelHtml}</dt><dd>${body}</dd>`);
        else {
          parts.push(
            `<li${anchorAttr}><span class="ltx-item-label">${labelHtml}</span><div class="ltx-item-body">${body}</div></li>`,
          );
        }
      });
    } finally {
      if (kind === 'enumerate') ctx.enumDepth -= 1;
      if (kind === 'itemize') ctx.itemizeDepth -= 1;
    }
    const html =
      kind === 'description'
        ? `<dl class="ltx-desc">${parts.join('')}</dl>`
        : kind === 'enumerate'
          ? `<ol class="ltx-list ltx-enumerate">${parts.join('')}</ol>`
          : `<ul class="ltx-list ltx-itemize">${parts.join('')}</ul>`;
    out.block(html, line, endLine);
  }

  private theorem(
    env: string,
    title: string,
    counter: string,
    numbered: boolean,
    plain: boolean,
    start: number,
    end: number,
    line: number,
    endLine: number,
    out: Out,
  ): void {
    const ctx = this.ctx;
    this.pos = start;
    const opt = this.readOptRange();
    const optHtml = opt ? this.parseRange(opt.start, opt.end, false, true).html() : '';
    let num = '';
    if (numbered) {
      const n = (ctx.thmCounters.get(counter) ?? 0) + 1;
      ctx.thmCounters.set(counter, n);
      num = String(n);
    }
    const anchor = this.newAnchor('thm');
    if (num) ctx.labelTarget = { num, anchor, kind: 'theorem' };
    const isProof = env === 'proof';
    const titleHtml = isProof && optHtml ? optHtml : escapeHtml(title);
    const optPart = optHtml && !isProof ? ` (${optHtml})` : '';
    const head = `<span class="ltx-thm-head">${titleHtml}${num ? ` ${num}` : ''}${optPart}.</span> `;
    const inner = new Out(true);
    inner.text(head, line);
    this.parseInto(this.pos, end, inner);
    inner.finish();
    let html = inner.html();
    if (isProof) {
      const qed = '<span class="ltx-qed">∎</span>';
      html = html.endsWith('</p>') ? `${html.slice(0, -4)}${qed}</p>` : html + qed;
    }
    const cls = isProof ? 'ltx-proof' : plain ? 'ltx-thm ltx-thm-plain' : 'ltx-thm';
    out.block(`<div class="${cls}" data-anchor="${anchor}">${html}</div>`, line, endLine);
  }

  private float(
    kind: 'figure' | 'table',
    name: string,
    start: number,
    end: number,
    line: number,
    endLine: number,
    out: Out,
  ): void {
    const ctx = this.ctx;
    this.pos = start;
    if (name === 'wrapfigure' || name === 'wraptable') {
      this.readOptRaw();
      this.readRawArg();
      this.readOptRaw();
      this.readRawArg();
    } else this.readOptRaw();
    const saved = ctx.float;
    const current = { kind, anchors: [] as string[], captioned: false, sub: 0 };
    ctx.float = current;
    let inner: string;
    try {
      inner = this.parseRange(this.pos, end, true).html();
    } finally {
      ctx.float = saved;
    }
    const attr = current.anchors.length ? ` data-anchor="${current.anchors.join(' ')}"` : '';
    out.block(`<figure class="ltx-float ltx-${kind}"${attr}>${inner}</figure>`, line, endLine);
  }

  private minipage(
    name: string,
    start: number,
    end: number,
    line: number,
    endLine: number,
    out: Out,
  ): void {
    const ctx = this.ctx;
    this.pos = start;
    this.readOptRaw();
    if (name === 'minipage') {
      this.readOptRaw();
      this.readOptRaw();
    }
    const width = parseLength(this.readRawArg() ?? '');
    const style = width ? ` style="width:${width}"` : '';
    if (name === 'minipage') {
      const inner = this.parseRange(this.pos, end, true).html();
      out.block(`<div class="ltx-minipage"${style}>${inner}</div>`, line, endLine);
      return;
    }
    let index = 1;
    if (ctx.float) {
      ctx.float.sub += 1;
      index = ctx.float.sub;
    }
    const savedSub = ctx.subfloat;
    ctx.subfloat = { letter: alphaLabel(index), anchor: this.newAnchor('sub') };
    let inner: string;
    try {
      inner = this.parseRange(this.pos, end, true).html();
    } finally {
      ctx.subfloat = savedSub;
    }
    out.block(`<div class="ltx-subfloat"${style}>${inner}</div>`, line, endLine);
  }

  private caption(name: string, start: number, line: number, out: Out): void {
    const ctx = this.ctx;
    const t = L10N[ctx.lang];
    let kind: 'figure' | 'table' | null = ctx.float?.kind ?? null;
    if (name === 'captionof') {
      const k = (this.readRawArg() ?? '').trim();
      kind = k === 'table' ? 'table' : 'figure';
    }
    this.readOptRaw();
    const html = this.parseArg();
    if (ctx.subfloat) {
      const sub = ctx.subfloat;
      ctx.labelTarget = { num: sub.letter, anchor: sub.anchor, kind: kind ?? 'figure' };
      out.block(
        `<div class="ltx-caption ltx-subcaption" data-anchor="${sub.anchor}"><span class="ltx-caption-label">(${sub.letter})</span>${html}</div>`,
        line,
      );
      return;
    }
    if (!kind) {
      this.warn(start, tr('\\caption 只能用在 figure 或 table 环境里'));
      out.block(`<div class="ltx-caption">${html}</div>`, line);
      return;
    }
    const n = kind === 'figure' ? (ctx.fig += 1) : (ctx.tab += 1);
    const anchor = `${kind === 'figure' ? 'fig' : 'tab'}-${n}`;
    if (ctx.float) {
      ctx.float.anchors.push(anchor);
      ctx.float.captioned = true;
    }
    ctx.labelTarget = { num: String(n), anchor, kind };
    const label = kind === 'figure' ? t.figure : t.table;
    const anchorAttr = ctx.float ? '' : ` data-anchor="${anchor}"`;
    out.block(
      `<div class="ltx-caption"${anchorAttr}><span class="ltx-caption-label">${label} ${n}</span>${html}</div>`,
      line,
    );
  }

  private includegraphics(line: number, out: Out): void {
    this.readStar();
    const opts = this.readOptRaw() ?? '';
    const file = (this.readRawArg() ?? '').trim();
    const width = graphicWidth(opts);
    const style = width ? ` style="width:${width}"` : '';
    out.text(
      `<span class="ltx-graphic"${style}>${IMAGE_ICON}<span class="ltx-graphic-name">${escapeHtml(file || tr('未指定文件'))}</span></span>`,
      line,
    );
  }

  private bibliography(start: number, end: number, line: number, endLine: number, out: Out): void {
    const ctx = this.ctx;
    this.pos = start;
    this.readRawArg();
    const items = this.topLevelTokens(this.pos, end, BIBITEM_TOKENS, false);
    const parts: string[] = [];
    items.forEach((tok, idx) => {
      const itemEnd = items[idx + 1]?.pos ?? end;
      this.pos = tok.end;
      const savedLimit = this.limit;
      this.limit = itemEnd;
      this.readOptRaw();
      const key = (this.readRawArg() ?? '').trim();
      const bodyFrom = this.pos;
      this.limit = savedLimit;
      ctx.bibCount += 1;
      const n = ctx.bibCount;
      if (!key) this.warn(tok.pos, tr('\\bibitem 缺少 key'));
      else if (ctx.bib.has(key)) this.warn(tok.pos, tr('参考文献 {key} 重复了', { key }));
      else ctx.bib.set(key, n);
      const body = this.parseRange(bodyFrom, itemEnd, false).html().trim();
      parts.push(
        `<li data-anchor="bib-${escapeHtml(anchorKey(key))}"><span class="ltx-bib-label">[${n}]</span><div class="ltx-bib-body">${body}</div></li>`,
      );
    });
    const index = ctx.sections.length;
    const anchor = `sec-${index}`;
    const title = L10N[ctx.lang].references;
    ctx.sections.push({ line, level: 1, heading: title, number: '', anchor });
    out.block(
      `<section class="ltx-bib"><h2 class="ltx-h ltx-h1" data-anchor="${anchor}" data-section="${index}">${title}</h2><ol class="ltx-bib-list">${parts.join('')}</ol></section>`,
      line,
      endLine,
    );
  }

  // ---------------------------------------------------------------- 表格

  private tabular(name: string, start: number, end: number): string {
    const s = this.src;
    this.pos = start;
    if (name === 'tabular*' || name === 'tabularx' || name === 'tabulary') this.readRawArg();
    if (name === 'tabu') this.readOptRaw();
    this.readOptRaw();
    const spec = parseColSpec(this.readRawArg() ?? '');
    const bodyStart = this.pos;
    const seps = this.topLevelTokens(bodyStart, end, ROW_TOKENS, true);

    interface Cell {
      start: number;
      end: number;
    }
    const rows: Cell[][] = [];
    let cur: Cell[] = [];
    let cellStart = bodyStart;
    for (const tok of seps) {
      cur.push({ start: cellStart, end: tok.pos });
      if (tok.name === '&') {
        cellStart = tok.end;
        continue;
      }
      this.pos = tok.end;
      const savedLimit = this.limit;
      this.limit = end;
      this.readStar();
      this.readOptRaw();
      this.limit = savedLimit;
      cellStart = this.pos;
      rows.push(cur);
      cur = [];
    }
    cur.push({ start: cellStart, end });
    rows.push(cur);

    interface Rule {
      cls: string;
      from: number;
      to: number;
    }
    const rendered: { cells: string[]; top: Rule[] }[] = [];
    let leading: Rule[] = [];
    let bottom: Rule[] = [];

    for (const cells of rows) {
      const first = cells[0];
      if (!first) continue;
      // 行首的横线命令
      const rules: Rule[] = [];
      let p = first.start;
      for (;;) {
        while (p < first.end && /\s/.test(s[p] ?? '')) p += 1;
        if (s[p] === '%') {
          const nl = s.indexOf('\n', p);
          p = nl === -1 || nl > first.end ? first.end : nl + 1;
          continue;
        }
        if (p >= first.end || s[p] !== '\\') break;
        const nameEnd = this.readNameEnd(p + 1);
        const cmd = s.slice(p + 1, nameEnd);
        if (!RULE_COMMANDS.has(cmd)) break;
        this.pos = nameEnd;
        const savedLimit = this.limit;
        this.limit = first.end;
        let from = 0;
        let to = Number.MAX_SAFE_INTEGER;
        if (cmd === 'cline' || cmd === 'cmidrule') {
          if (cmd === 'cmidrule') {
            this.readOptRaw();
            if (s[this.pos] === '(') {
              const close = s.indexOf(')', this.pos);
              if (close !== -1 && close < this.limit) this.pos = close + 1;
            }
          }
          const m = /(\d+)\s*-\s*(\d+)/.exec(this.readRawArg() ?? '');
          if (m) {
            from = Number(m[1]) - 1;
            to = Number(m[2]) - 1;
          }
        } else if (cmd === 'specialrule') {
          this.readRawArg();
          this.readRawArg();
          this.readRawArg();
        } else if (cmd === 'addlinespace') {
          this.readOptRaw();
        }
        p = this.pos;
        this.limit = savedLimit;
        if (cmd === 'addlinespace') continue;
        const thick = cmd === 'toprule' || cmd === 'bottomrule' || cmd === 'specialrule';
        const prev = rules[rules.length - 1];
        if (cmd === 'hline' && prev && prev.cls === 'ltx-bt') prev.cls = 'ltx-bt2';
        else rules.push({ cls: thick ? 'ltx-btk' : 'ltx-bt', from, to });
      }
      first.start = p;
      const onlyRules = cells.length === 1 && !this.hasContent(first.start, first.end);
      if (onlyRules) {
        if (rendered.length > 0) bottom = rules;
        else leading = leading.concat(rules);
        continue;
      }
      const cellsHtml: string[] = [];
      let col = 0;
      for (const cell of cells) {
        let q = cell.start;
        while (q < cell.end && /\s/.test(s[q] ?? '')) q += 1;
        let span = 1;
        let align: string = spec.aligns[col] ?? 'l';
        let lb = col === 0 && Boolean(spec.borders[0]);
        let rb = Boolean(spec.borders[col + 1]);
        let cStart = cell.start;
        let cEnd = cell.end;
        if (s.startsWith('\\multicolumn', q)) {
          this.pos = q + '\\multicolumn'.length;
          const savedLimit = this.limit;
          this.limit = cell.end;
          span = Math.max(1, Number.parseInt(this.readRawArg() ?? '1', 10) || 1);
          const mc = parseColSpec(this.readRawArg() ?? '');
          align = mc.aligns[0] ?? 'c';
          lb = col === 0 ? Boolean(mc.borders[0]) : false;
          rb = Boolean(mc.borders[1]);
          const r = this.peekArgRange();
          this.limit = savedLimit;
          if (r) {
            cStart = r.start;
            cEnd = r.end;
          } else {
            cStart = cell.end;
            cEnd = cell.end;
          }
        }
        const html = this.parseRange(cStart, cEnd, false).html().trim();
        cellsHtml.push(cellTag(html, align, span, lb, rb, col));
        col += span;
      }
      if (spec.count > 0 && col > spec.count) {
        this.warn(
          first.start,
          tr('表格这一行有 {col} 列，比列格式（{count} 列）多，多出的 & 会让 LaTeX 报错', {
            col,
            count: spec.count,
          }),
        );
      }
      while (col < spec.count) {
        cellsHtml.push(
          cellTag(
            '',
            spec.aligns[col] ?? 'l',
            1,
            col === 0 && Boolean(spec.borders[0]),
            Boolean(spec.borders[col + 1]),
            col,
          ),
        );
        col += 1;
      }
      rendered.push({ cells: cellsHtml, top: leading.concat(rules) });
      leading = [];
    }

    const applyRules = (cell: string, col: number, rules: Rule[], bottomSide: boolean): string => {
      const classes: string[] = [];
      for (const r of rules) {
        if (col < r.from || col > r.to) continue;
        classes.push(bottomSide ? r.cls.replace('ltx-bt', 'ltx-bb') : r.cls);
      }
      return classes.length ? cell.replace('class="', `class="${classes.join(' ')} `) : cell;
    };

    const body = rendered
      .map((row, idx) => {
        const isLast = idx === rendered.length - 1;
        let colIdx = 0;
        const cells = row.cells.map((cell) => {
          const span = Number(/colspan="(\d+)"/.exec(cell)?.[1] ?? 1);
          let html = applyRules(cell, colIdx, row.top, false);
          if (isLast) html = applyRules(html, colIdx, bottom, true);
          colIdx += span;
          return html;
        });
        return `<tr>${cells.join('')}</tr>`;
      })
      .join('');
    return `<div class="ltx-tabular-wrap"><table class="ltx-tabular"><tbody>${body}</tbody></table></div>`;
  }
}

/** 这些环境结束后不恢复 \label 目标（内容里可能有 \section） */
const SECTION_SAFE_ENVS = new Set(['document', 'appendices']);

const BULLETS = ['•', '–', '∗', '·'];

function enumLabel(n: number, depth: number): string {
  switch ((depth - 1) % 4) {
    case 1:
      return `(${alphaLabel(n)})`;
    case 2:
      return `${romanLabel(n)}.`;
    case 3:
      return `${alphaLabel(n, true)}.`;
    default:
      return `${n}.`;
  }
}

function enumRef(n: number, depth: number): string {
  switch ((depth - 1) % 4) {
    case 1:
      return alphaLabel(n);
    case 2:
      return romanLabel(n);
    case 3:
      return alphaLabel(n, true);
    default:
      return String(n);
  }
}

function cellTag(
  html: string,
  align: string,
  span: number,
  lb: boolean,
  rb: boolean,
  col: number,
): string {
  const cls = [`ltx-al-${align}`];
  if (lb) cls.push('ltx-bl');
  if (rb) cls.push('ltx-br');
  if (col === 0) cls.push('ltx-first');
  const spanAttr = span > 1 ? ` colspan="${span}"` : '';
  return `<td class="${cls.join(' ')}"${spanAttr}>${html}</td>`;
}

/** \includegraphics 的 width= / scale= → CSS 宽度 */
function graphicWidth(opts: string): string | null {
  const w = /(?:^|,)\s*width\s*=\s*([^,]+)/.exec(opts);
  if (w) return parseLength(w[1] ?? '');
  const sc = /(?:^|,)\s*scale\s*=\s*([\d.]+)/.exec(opts);
  if (sc) {
    const v = Number(sc[1]);
    if (Number.isFinite(v) && v > 0) return `${Math.min(100, Math.round(v * 100))}%`;
  }
  return null;
}

/** 去掉公式里的 % 注释（保留 \%） */
export function stripMathComments(tex: string): string {
  if (!tex.includes('%')) return tex;
  return tex.replace(/(^|[^\\])((?:\\\\)*)%[^\n]*/g, '$1$2');
}

/** 按顶层的 \\ 拆分对齐环境的行（不拆嵌套的 cases、matrix 等环境和花括号里的） */
export function splitMathRows(tex: string): string[] {
  const rows: string[] = [];
  let depth = 0;
  let env = 0;
  let startIdx = 0;
  let i = 0;
  while (i < tex.length) {
    const c = tex[i];
    if (c === '\\') {
      const next = tex[i + 1];
      if (next === '\\' && depth === 0 && env === 0) {
        rows.push(tex.slice(startIdx, i));
        i += 2;
        if (tex[i] === '*') i += 1;
        const m = /^\s*\[[^\]]*\]/.exec(tex.slice(i, i + 40));
        if (m) i += m[0].length;
        startIdx = i;
        continue;
      }
      if (tex.startsWith('begin', i + 1) && !isLetter(tex[i + 6])) env += 1;
      else if (tex.startsWith('end', i + 1) && !isLetter(tex[i + 4])) env = Math.max(0, env - 1);
      i += 2;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth = Math.max(0, depth - 1);
    i += 1;
  }
  rows.push(tex.slice(startIdx));
  return rows;
}
