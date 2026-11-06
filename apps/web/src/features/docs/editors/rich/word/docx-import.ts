import { parseAsync } from 'docx-preview';
import { CN_FONT_SIZES, normalizeColor, normalizeFontStack, toPt, DEFAULT_FONT_PT } from './format';
import { ptToMm, type PageSetup, type PaperSize, PAPER_SIZES } from './page';
import { tr } from '@/lib/i18n';

/**
 * .docx → 富文本（ProseMirror JSON）。
 *
 * 解析交给 docx-preview（Apache-2.0）：它把 OOXML 读成带 cssStyle 的文档模型（段落、run、表格、图片、
 * 编号、脚注、样式表、页面设置）。这里只做“模型 → 我们的节点 / 标记”的映射：
 * - 标题：样式名 Heading n / 标题 n / Title（或大纲级别）→ heading
 * - 文字：粗斜下划删除线、上下标、颜色、字体（拉丁 + 中文）、字号、高亮 / 底纹
 * - 段落：对齐、段前段后、行距、首行缩进 / 悬挂、左缩进、段前分页
 * - 编号：按 numbering.xml 的格式分成有序 / 无序列表，多级嵌套，起始编号
 * - 表格：横向合并（gridSpan）、纵向合并（vMerge）→ colspan / rowspan，列宽，单元格底色，标题行
 * - 图片：上传到项目文件（ctx.uploadFile），按原尺寸
 * - 脚注、尾注 → footnote；分页符 → pageBreak；TOC 域 → 目录块；超链接；简单的 OMML 公式 → LaTeX
 * 样式表里继承来的“全文默认字体 / 字号”不写到每个字上（那就是编辑器的默认样式），只保留和默认不同的部分。
 */

export interface ImportContext {
  projectId: string;
  uploadFile: (blob: Blob, name: string) => Promise<{ id: string; url: string }>;
}

export interface PmJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmJSON[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export interface DocxImportResult {
  doc: PmJSON;
  title: string;
  page: Partial<PageSetup>;
  /** 导入时被跳过 / 降级的内容（给用户看的提示） */
  warnings: string[];
}

// ---------------------------------------------------------------- docx-preview 模型（只声明用到的字段）

type Css = Record<string, string | undefined>;

interface DxElement {
  type: string;
  children?: DxElement[];
  cssStyle?: Css;
  styleName?: string;
  text?: string;
  id?: string;
  anchor?: string;
  break?: string;
  char?: string | number;
  font?: string;
  numbering?: { id?: string; level?: number };
  lineSpacing?: { before?: string; after?: string; line?: number | null; lineRule?: string | null };
  pageBreakBefore?: boolean;
  outlineLevel?: number;
  verticalAlign?: string;
  span?: number;
  verticalMerge?: string;
  isHeader?: boolean | null;
  columns?: { width?: string }[];
  src?: string;
  props?: Record<string, unknown> & { char?: string; beginChar?: string; endChar?: string };
  charType?: string;
  instruction?: string;
  fieldRun?: boolean;
}

interface DxStyle {
  id: string | null;
  name: string | null;
  basedOn: string | null;
  target: string | null;
  isDefault?: boolean | null;
  styles?: { target: string; values: Css }[];
  paragraphProps?: {
    numbering?: { id?: string; level?: number };
    outlineLevel?: number;
    pageBreakBefore?: boolean;
  };
}

interface DxNumberingLevel {
  level: number;
  start?: string;
  format?: string;
  text?: string;
}

interface DxDocument {
  documentPart: {
    body: DxElement & {
      props?: {
        pageSize?: { width?: string; height?: string; orientation?: string };
        pageMargins?: Record<string, string | undefined>;
      };
    };
    rels?: { id: string; target: string; targetMode?: string; type?: string }[];
    path: string;
  };
  stylesPart?: { styles?: DxStyle[] };
  numberingPart?: {
    numberings?: {
      id: string;
      abstractId: string;
      overrides?: { level: number; start?: number }[];
    }[];
    abstractNumberings?: { id: string; levels?: DxNumberingLevel[] }[];
  };
  footnotesPart?: { notes?: DxElement[] };
  endnotesPart?: { notes?: DxElement[] };
  corePropsPart?: { props?: { title?: string } };
  getPathById: (part: unknown, id: string) => string | null;
  _package: { load: (path: string, type: 'blob') => Promise<Blob | null> };
  contentTypes?: { partName?: string; extension?: string; contentType: string }[];
}

// ---------------------------------------------------------------- 工具

type Mark = NonNullable<PmJSON['marks']>[number];

const ptOf = (v: string | undefined): number | null => {
  if (!v) return null;
  const m = /^(-?[\d.]+)(pt|px)?$/u.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'px' ? n * 0.75 : n;
};

const round = (n: number, step = 0.5) => Math.round(n / step) * step;

function textOf(el: DxElement | undefined): string {
  if (!el) return '';
  if (el.type === 'text') return el.text ?? '';
  if (el.type === 'tab') return '\t';
  if (el.type === 'break' && el.break === 'textWrapping') return '\n';
  return (el.children ?? []).map(textOf).join('');
}

/** 样式名 → 标题级别 */
export function headingLevelOf(styleName: string | null | undefined): number | null {
  if (!styleName) return null;
  const s = styleName.trim().toLowerCase();
  if (s === 'title' || s === '标题') return 1;
  const m = /^(?:heading|标题)\s*(\d)$/u.exec(s);
  if (m) return Math.min(6, Math.max(1, Number(m[1])));
  return null;
}

/** Word 编号格式 → 我们的列表样式 */
function listStyleOf(format: string | undefined): { ordered: boolean; style: string | null } {
  switch (format) {
    case 'bullet':
      return { ordered: false, style: null };
    case 'lowerLetter':
      return { ordered: true, style: 'lower-alpha' };
    case 'upperLetter':
      return { ordered: true, style: 'upper-alpha' };
    case 'lowerRoman':
      return { ordered: true, style: 'lower-roman' };
    case 'upperRoman':
      return { ordered: true, style: 'upper-roman' };
    case 'decimalZero':
      return { ordered: true, style: 'decimal-leading-zero' };
    case 'chineseCounting':
    case 'chineseCountingThousand':
    case 'ideographTraditional':
    case 'ideographDigital':
    case 'japaneseCounting':
    case 'taiwaneseCounting':
      return { ordered: true, style: 'cjk-ideographic' };
    case 'none':
      return { ordered: false, style: null };
    default:
      return { ordered: true, style: null };
  }
}

// ---------------------------------------------------------------- OMML → LaTeX（常见结构）

const MATH_CHARS: Record<string, string> = {
  '∑': '\\sum',
  '∏': '\\prod',
  '∫': '\\int',
  '∬': '\\iint',
  '∮': '\\oint',
  α: '\\alpha',
  β: '\\beta',
  γ: '\\gamma',
  δ: '\\delta',
  ε: '\\epsilon',
  θ: '\\theta',
  λ: '\\lambda',
  μ: '\\mu',
  π: '\\pi',
  σ: '\\sigma',
  φ: '\\phi',
  ω: '\\omega',
  Δ: '\\Delta',
  Σ: '\\Sigma',
  Ω: '\\Omega',
  '×': '\\times',
  '·': '\\cdot',
  '≤': '\\le',
  '≥': '\\ge',
  '≠': '\\ne',
  '≈': '\\approx',
  '∞': '\\infty',
  '→': '\\to',
  '±': '\\pm',
  '∈': '\\in',
  '∂': '\\partial',
  '∇': '\\nabla',
};

function mathText(s: string): string {
  return [...s]
    .map((c) => (MATH_CHARS[c] ? `${MATH_CHARS[c]} ` : c))
    .join('')
    .trim();
}

export function ommlToLatex(el: DxElement): string {
  const kids = el.children ?? [];
  const all = () => kids.map(ommlToLatex).join('');
  const part = (type: string) => {
    const k = kids.find((c) => c.type === type);
    return k ? ommlToLatex(k) : '';
  };
  switch (el.type) {
    case 'mmlRun':
      return mathText(textOf(el));
    case 'mmlFraction':
      return `\\frac{${part('mmlNumerator')}}{${part('mmlDenominator')}}`;
    case 'mmlSuperscript':
      return `{${part('mmlBase')}}^{${part('mmlSuperArgument')}}`;
    case 'mmlSubscript':
      return `{${part('mmlBase')}}_{${part('mmlSubArgument')}}`;
    case 'mmlPreSubSuper':
      return `{}_{${part('mmlSubArgument')}}^{${part('mmlSuperArgument')}}${part('mmlBase')}`;
    case 'mmlRadical': {
      const deg = part('mmlDegree');
      return deg ? `\\sqrt[${deg}]{${part('mmlBase')}}` : `\\sqrt{${part('mmlBase')}}`;
    }
    case 'mmlNary': {
      const op = MATH_CHARS[el.props?.char ?? '∫'] ?? el.props?.char ?? '\\int';
      const sub = part('mmlSubArgument');
      const sup = part('mmlSuperArgument');
      return `${op}${sub ? `_{${sub}}` : ''}${sup ? `^{${sup}}` : ''} ${part('mmlBase')}`;
    }
    case 'mmlDelimiter': {
      const open = el.props?.beginChar ?? '(';
      const close = el.props?.endChar ?? ')';
      const inner = kids
        .filter((c) => c.type === 'mmlBase')
        .map(ommlToLatex)
        .join(',');
      const esc = (c: string) => (c === '{' ? '\\{' : c === '}' ? '\\}' : c || '.');
      return `\\left${esc(open)}${inner}\\right${esc(close)}`;
    }
    case 'mmlFunction':
      return `\\operatorname{${part('mmlFunctionName')}}{${part('mmlBase')}}`;
    case 'mmlLimitLower':
      return `${part('mmlBase')}_{${part('mmlLimit')}}`;
    case 'mmlMatrix':
      return `\\begin{matrix}${kids
        .filter((c) => c.type === 'mmlMatrixRow')
        .map((r) => (r.children ?? []).map(ommlToLatex).join(' & '))
        .join(' \\\\ ')}\\end{matrix}`;
    case 'mmlEquationArray':
      return `\\begin{aligned}${kids.map(ommlToLatex).join(' \\\\ ')}\\end{aligned}`;
    case 'mmlBar':
      return `\\overline{${part('mmlBase')}}`;
    default:
      return all();
  }
}

// ---------------------------------------------------------------- 映射

interface StyleInfo {
  p: Css;
  span: Css;
  td: Css;
  name: string | null;
  numbering?: { id?: string; level?: number };
  outlineLevel?: number;
  pageBreakBefore?: boolean;
}

class Mapper {
  private styles = new Map<string, DxStyle>();
  private resolved = new Map<string, StyleInfo>();
  private defaultPara: string | null = null;
  /** 全文默认的字体 / 字号（Normal 样式 + docDefaults），不写到每个字上 */
  private baseFont: string | null = null;
  private basePt: number | null = null;
  private footnotes = new Map<string, string>();
  private endnotes = new Map<string, string>();
  private uploads: Promise<void>[] = [];
  private imageCount = 0;
  /** 跨段落的复合域（TOC、HYPERLINK） */
  private fields: {
    instr: string;
    phase: 'instr' | 'result';
    toc: boolean;
    href: string | null;
  }[] = [];
  private tocEmitted = false;
  warnings: string[] = [];

  constructor(
    private readonly wd: DxDocument,
    private readonly ctx: ImportContext | undefined,
  ) {
    for (const s of wd.stylesPart?.styles ?? []) {
      if (s.id) this.styles.set(s.id, s);
      if (s.isDefault && s.target === 'p' && s.id) this.defaultPara = s.id;
    }
    const normal = this.style(this.defaultPara);
    const docDefault = (wd.stylesPart?.styles ?? []).find((s) => !s.id);
    const span = { ...cssFor(docDefault, 'span'), ...normal.span };
    this.baseFont = normalizeFontStack(span['font-family']);
    this.basePt = toPt(span['font-size']);
    for (const n of wd.footnotesPart?.notes ?? []) if (n.id) this.footnotes.set(n.id, noteText(n));
    for (const n of wd.endnotesPart?.notes ?? []) if (n.id) this.endnotes.set(n.id, noteText(n));
  }

  /** 样式（沿 basedOn 链合并） */
  style(id: string | null | undefined): StyleInfo {
    const key = id ?? '';
    const cached = this.resolved.get(key);
    if (cached) return cached;
    const chain: DxStyle[] = [];
    const seen = new Set<string>();
    for (let s = id ? this.styles.get(id) : undefined; s && !seen.has(s.id ?? '');) {
      seen.add(s.id ?? '');
      chain.unshift(s);
      s = s.basedOn ? this.styles.get(s.basedOn) : undefined;
    }
    const info: StyleInfo = { p: {}, span: {}, td: {}, name: chain.at(-1)?.name ?? id ?? null };
    for (const s of chain) {
      Object.assign(info.p, cssFor(s, 'p'));
      Object.assign(info.span, cssFor(s, 'span'));
      Object.assign(info.td, cssFor(s, 'td'));
      const pp = s.paragraphProps;
      if (pp?.numbering) info.numbering = pp.numbering;
      if (pp?.outlineLevel !== undefined) info.outlineLevel = pp.outlineLevel;
      if (pp?.pageBreakBefore) info.pageBreakBefore = true;
    }
    this.resolved.set(key, info);
    return info;
  }

  async run(): Promise<PmJSON> {
    const blocks = this.blocks(this.wd.documentPart.body.children ?? []);
    await Promise.all(this.uploads);
    const content = blocks.length ? blocks : [{ type: 'paragraph' }];
    return { type: 'doc', content };
  }

  // ------------------------------------------------------------ 块

  private blocks(elements: DxElement[]): PmJSON[] {
    const out: PmJSON[] = [];
    /** 列表栈：level → 列表节点 */
    let lists: { list: PmJSON; numId: string; level: number }[] = [];
    const closeLists = () => {
      lists = [];
    };
    for (const el of elements) {
      if (el.type === 'paragraph') {
        const para = this.paragraph(el);
        if (para.skip) continue;
        if (para.list && para.blocks.length) {
          const { numId, level, ordered, listStyle, start } = para.list;
          // 弹出比当前更深的层
          while (lists.length && lists[lists.length - 1]!.level > level) lists.pop();
          let top = lists[lists.length - 1];
          const type = ordered ? 'orderedList' : 'bulletList';
          if (top && top.level === level && (top.numId !== numId || top.list.type !== type)) {
            lists.pop();
            top = lists[lists.length - 1];
          }
          if (!top || top.level < level) {
            const list: PmJSON = {
              type,
              attrs: { ...(ordered ? { start } : {}), listStyle },
              content: [],
            };
            if (top) {
              // 嵌套列表放进上一层的最后一项；上一层还没有项时补一个空项
              const items = top.list.content!;
              if (items.length === 0)
                items.push({ type: 'listItem', content: [{ type: 'paragraph' }] });
              items[items.length - 1]!.content!.push(list);
            } else {
              out.push(list);
            }
            lists.push({ list, numId, level });
            top = lists[lists.length - 1]!;
          }
          const [first, ...rest] = para.blocks;
          const item: PmJSON = {
            type: 'listItem',
            content:
              first?.type === 'paragraph'
                ? [first]
                : [{ type: 'paragraph' }, ...(first ? [first] : [])],
          };
          item.content!.push(...rest.filter((b) => b.type !== 'pageBreak'));
          top.list.content!.push(item);
          continue;
        }
        closeLists();
        out.push(...para.blocks);
      } else if (el.type === 'table') {
        closeLists();
        out.push(this.table(el));
      } else if (el.type === 'inserted' || el.type === 'smartTag') {
        out.push(...this.blocks(el.children ?? []));
      } else if (el.type === 'deleted') {
        // 修订里删除的内容不导入
      } else if (el.children?.length) {
        closeLists();
        out.push(...this.blocks(el.children));
      }
    }
    return out;
  }

  private paragraph(el: DxElement): {
    blocks: PmJSON[];
    skip?: boolean;
    list?: {
      numId: string;
      level: number;
      ordered: boolean;
      listStyle: string | null;
      start: number;
    };
  } {
    const style = this.style(el.styleName ?? this.defaultPara);
    const styleName = style.name ?? el.styleName ?? '';
    // TOC 域的结果段落（目录条目）：整体换成一个目录块
    const inToc = this.fields.some((f) => f.toc);
    const tocStyle = /^toc\s*\d/iu.test(styleName) || /^目录\s*\d/u.test(styleName);
    if ((inToc || tocStyle) && !this.containsFieldEnd(el)) {
      this.scanFields(el);
      if (this.tocEmitted) return { blocks: [], skip: true };
      this.tocEmitted = true;
      return { blocks: [{ type: 'tableOfContents', attrs: { maxLevel: 3 } }] };
    }
    if (inToc || tocStyle) {
      this.scanFields(el);
      if (!this.tocEmitted) {
        this.tocEmitted = true;
        return { blocks: [{ type: 'tableOfContents', attrs: { maxLevel: 3 } }] };
      }
      return { blocks: [], skip: true };
    }

    const level =
      headingLevelOf(styleName) ??
      headingLevelOf(el.styleName) ??
      (el.outlineLevel !== undefined && el.outlineLevel < 6 ? el.outlineLevel + 1 : null) ??
      (style.outlineLevel !== undefined && style.outlineLevel < 6 ? style.outlineLevel + 1 : null);
    const css: Css = { ...style.p, ...el.cssStyle };
    const fontPt = toPt(style.span['font-size']) ?? this.basePt ?? DEFAULT_FONT_PT;
    const attrs = this.paragraphAttrs(css, el, fontPt);
    const inline = this.inlines(el.children ?? [], style, level !== null);
    // 只有一个公式的段落 = 块公式（Word 里的“显示”公式）
    const visible = inline.filter((n) => !(n.type === 'text' && !(n.text ?? '').trim()));
    if (level === null && visible.length === 1 && visible[0]!.type === 'inlineMath') {
      return { blocks: [{ type: 'blockMath', attrs: { latex: visible[0]!.attrs?.latex ?? '' } }] };
    }

    // 行内的图片、分页符、块公式把段落切开
    const blocks: PmJSON[] = [];
    let run: PmJSON[] = [];
    const type = level !== null ? 'heading' : 'paragraph';
    const nodeAttrs = level !== null ? { ...attrs, level } : attrs;
    const flush = (force = false) => {
      const trimmed = trimHardBreaks(run);
      if (trimmed.length || force) {
        blocks.push({
          type,
          ...(Object.keys(nodeAttrs).length ? { attrs: { ...nodeAttrs } } : {}),
          ...(trimmed.length ? { content: trimmed } : {}),
        });
      }
      run = [];
    };
    if (el.pageBreakBefore || style.pageBreakBefore) blocks.push({ type: 'pageBreak' });
    let hadBlock = false;
    for (const n of inline) {
      if (n.type === 'image' || n.type === 'pageBreak' || n.type === 'blockMath') {
        flush();
        blocks.push(n);
        hadBlock = true;
      } else run.push(n);
    }
    // 空段落也保留（Word 里的空行）
    flush(!hadBlock && blocks.every((b) => b.type === 'pageBreak'));

    const numbering = el.numbering?.id
      ? el.numbering
      : level === null
        ? style.numbering
        : undefined;
    if (numbering?.id && numbering.id !== '0' && level === null) {
      const lvl = Math.max(0, Math.min(8, numbering.level ?? 0));
      const def = this.numberingLevel(numbering.id, lvl);
      if (def && def.format !== 'none') {
        const { ordered, style: listStyle } = listStyleOf(def.format);
        // 列表段落的缩进由列表负责
        for (const b of blocks) {
          if (b.attrs) {
            delete b.attrs.indent;
            delete b.attrs.textIndent;
          }
        }
        return {
          blocks,
          list: { numId: numbering.id, level: lvl, ordered, listStyle, start: def.startAt },
        };
      }
    }
    return { blocks };
  }

  private numberingLevel(
    numId: string,
    level: number,
  ): { format?: string; startAt: number } | null {
    const part = this.wd.numberingPart;
    const num = part?.numberings?.find((n) => n.id === numId);
    if (!num) return null;
    const abs = part?.abstractNumberings?.find((a) => a.id === num.abstractId);
    const lvl = abs?.levels?.find((l) => l.level === level);
    const override = num.overrides?.find((o) => o.level === level)?.start;
    const startAt = Number(override ?? lvl?.start ?? 1) || 1;
    return { format: lvl?.format, startAt };
  }

  private paragraphAttrs(css: Css, el: DxElement, fontPt: number): Record<string, unknown> {
    const attrs: Record<string, unknown> = {};
    const align = css['text-align'];
    if (align === 'center' || align === 'right' || align === 'justify') attrs.textAlign = align;
    else if (align === 'end') attrs.textAlign = 'right';
    const before = ptOf(css['margin-top']);
    const after = ptOf(css['margin-bottom']);
    if (before !== null && before > 0) attrs.spaceBefore = round(before);
    if (after !== null && after > 0) attrs.spaceAfter = round(after);
    const ls = el.lineSpacing;
    if (ls?.line && (!ls.lineRule || ls.lineRule === 'auto')) {
      const ratio = Math.round((ls.line / 240) * 100) / 100;
      if (ratio > 0 && Math.abs(ratio - 1) > 0.01) attrs.lineHeight = String(ratio);
    } else if (ls?.line && (ls.lineRule === 'exact' || ls.lineRule === 'atLeast')) {
      const ratio = Math.round((ls.line / 20 / (fontPt * 1.2)) * 100) / 100;
      if (ratio > 0 && Math.abs(ratio - 1) > 0.05) attrs.lineHeight = String(Math.min(5, ratio));
    }
    const indent = ptOf(css['text-indent']);
    if (indent !== null && Math.abs(indent) >= 1) attrs.textIndent = round(indent / fontPt, 0.25);
    const left = ptOf(css['margin-left'] ?? css['margin-inline-start']);
    if (left !== null && left > 1) {
      const levels = Math.round(left / (fontPt * 2));
      if (levels > 0) attrs.indent = Math.min(10, levels);
    }
    return attrs;
  }

  // ------------------------------------------------------------ 行内

  private inlines(
    elements: DxElement[],
    pStyle: StyleInfo,
    heading: boolean,
    link: string | null = null,
  ): PmJSON[] {
    const out: PmJSON[] = [];
    for (const el of elements) {
      switch (el.type) {
        case 'run':
          out.push(...this.runNodes(el, pStyle, heading, link ?? this.fieldHref()));
          break;
        case 'hyperlink': {
          const href = this.hyperlinkHref(el);
          out.push(...this.inlines(el.children ?? [], pStyle, heading, href));
          break;
        }
        case 'smartTag':
        case 'inserted':
          out.push(...this.inlines(el.children ?? [], pStyle, heading, link));
          break;
        case 'mmlMath':
          out.push({ type: 'inlineMath', attrs: { latex: ommlToLatex(el) } });
          break;
        case 'mmlMathParagraph':
          for (const m of el.children ?? [])
            out.push({ type: 'blockMath', attrs: { latex: ommlToLatex(m) } });
          break;
        case 'simpleField':
          break;
        case 'deleted':
          break;
        default:
          if (el.children?.length) out.push(...this.inlines(el.children, pStyle, heading, link));
      }
    }
    return mergeText(out);
  }

  private hyperlinkHref(el: DxElement): string | null {
    if (el.id) {
      const rel = this.wd.documentPart.rels?.find((r) => r.id === el.id);
      if (rel?.target) return rel.target;
    }
    if (el.anchor) return `#${el.anchor}`;
    return null;
  }

  private fieldHref(): string | null {
    for (let i = this.fields.length - 1; i >= 0; i -= 1) {
      const f = this.fields[i]!;
      if (f.phase === 'result' && f.href) return f.href;
    }
    return null;
  }

  private inFieldInstr(): boolean {
    return this.fields.some((f) => f.phase === 'instr');
  }

  /** 处理 run 里的复合域标记 */
  private fieldChar(el: DxElement) {
    if (el.type === 'complexField') {
      if (el.charType === 'begin')
        this.fields.push({ instr: '', phase: 'instr', toc: false, href: null });
      else if (el.charType === 'separate') {
        const f = this.fields[this.fields.length - 1];
        if (f) {
          f.phase = 'result';
          const instr = f.instr.trim();
          f.toc = /^TOC\b/u.test(instr);
          const m = /^HYPERLINK\s+(?:\\l\s+)?"([^"]+)"/u.exec(instr);
          if (m) f.href = /^\\l/u.test(instr.slice(9).trim()) ? `#${m[1]}` : m[1]!;
        }
      } else if (el.charType === 'end') this.fields.pop();
    } else if (el.type === 'instruction') {
      const f = this.fields[this.fields.length - 1];
      if (f && f.phase === 'instr') f.instr += el.text ?? '';
    }
  }

  private scanFields(el: DxElement) {
    const walk = (e: DxElement) => {
      if (e.type === 'complexField' || e.type === 'instruction') this.fieldChar(e);
      for (const c of e.children ?? []) walk(c);
    };
    walk(el);
  }

  private containsFieldEnd(el: DxElement): boolean {
    let found = false;
    const walk = (e: DxElement) => {
      if (e.type === 'complexField' && e.charType === 'end') found = true;
      for (const c of e.children ?? []) walk(c);
    };
    walk(el);
    return found;
  }

  private runNodes(
    el: DxElement,
    pStyle: StyleInfo,
    heading: boolean,
    href: string | null,
  ): PmJSON[] {
    const rStyle = el.styleName ? this.style(el.styleName) : null;
    const css: Css = { ...pStyle.span, ...(rStyle?.span ?? {}), ...el.cssStyle };
    const direct = el.cssStyle ?? {};
    const marks = this.marksFor(css, direct, el.verticalAlign, heading, href);
    const out: PmJSON[] = [];
    const pushText = (text: string) => {
      if (!text) return;
      out.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text });
    };
    for (const c of el.children ?? []) {
      if (c.type === 'complexField' || c.type === 'instruction') {
        this.fieldChar(c);
        continue;
      }
      if (this.inFieldInstr()) continue;
      switch (c.type) {
        case 'text':
          pushText(c.text ?? '');
          break;
        case 'tab':
          pushText('\t');
          break;
        case 'noBreakHyphen':
          pushText('\u2011');
          break;
        case 'symbol': {
          const code = typeof c.char === 'number' ? c.char : parseInt(String(c.char ?? ''), 16);
          if (Number.isFinite(code) && code > 0) {
            // Symbol / Wingdings 私有区字符换成常见对应
            const ch =
              code >= 0xf000 ? String.fromCharCode(code - 0xf000) : String.fromCharCode(code);
            pushText(ch);
          }
          break;
        }
        case 'break':
          if (c.break === 'page') out.push({ type: 'pageBreak' });
          else if (c.break === 'textWrapping') out.push({ type: 'hardBreak' });
          break;
        case 'footnoteReference':
        case 'endnoteReference': {
          const content =
            (c.type === 'footnoteReference' ? this.footnotes : this.endnotes).get(c.id ?? '') ?? '';
          out.push({
            type: 'footnote',
            attrs: { id: `${c.type === 'footnoteReference' ? 'fn' : 'en'}-${c.id ?? ''}`, content },
          });
          break;
        }
        case 'drawing':
        case 'vmlPicture':
          out.push(...this.images(c));
          break;
        case 'deletedText':
          break;
        default:
          if (c.children?.length)
            out.push(...this.runNodes({ ...el, children: c.children }, pStyle, heading, href));
      }
    }
    return out;
  }

  private marksFor(
    css: Css,
    direct: Css,
    vertical: string | undefined,
    heading: boolean,
    href: string | null,
  ): Mark[] {
    const marks: Mark[] = [];
    if (href) marks.push({ type: 'link', attrs: { href } });
    const weight = css['font-weight'];
    if ((weight === 'bold' || Number(weight) >= 600) && !(heading && !direct['font-weight']))
      marks.push({ type: 'bold' });
    if (css['font-style'] === 'italic') marks.push({ type: 'italic' });
    const deco = `${css['text-decoration'] ?? ''} ${css['text-decoration-line'] ?? ''}`;
    // 链接自带下划线和链接色（Word 的 Hyperlink 样式），不再重复成标记
    const linkStyled = !!href && !direct.color && !direct['text-decoration'];
    if (/underline/u.test(deco) && !linkStyled) marks.push({ type: 'underline' });
    if (/line-through/u.test(deco)) marks.push({ type: 'strike' });
    const va = vertical ?? css['vertical-align'];
    if (va === 'sup' || va === 'super' || va === 'superscript') marks.push({ type: 'superscript' });
    else if (va === 'sub' || va === 'subscript') marks.push({ type: 'subscript' });
    const bg = normalizeColor(css['background-color']);
    if (bg && bg !== '#ffffff') marks.push({ type: 'highlight', attrs: { color: bg } });

    const style: Record<string, string | null> = { color: null, fontFamily: null, fontSize: null };
    const color = normalizeColor(css.color);
    if (color && color !== '#000000' && !linkStyled) style.color = color;
    const font = normalizeFontStack(css['font-family']);
    if (font && (direct['font-family'] || font !== this.baseFont)) style.fontFamily = font;
    const pt = toPt(css['font-size']);
    // 标题的字号交给标题样式；正文只写与全文默认不同的字号（或直接设置的字号）
    if (pt !== null && !(heading && !direct['font-size'])) {
      if (direct['font-size'] || pt !== this.basePt) style.fontSize = `${pt}pt`;
    }
    if (style.color || style.fontFamily || style.fontSize)
      marks.push({ type: 'textStyle', attrs: style });
    return marks;
  }

  private images(drawing: DxElement): PmJSON[] {
    const out: PmJSON[] = [];
    const visit = (e: DxElement) => {
      if (e.type === 'image' && e.src) {
        const node: PmJSON = {
          type: 'image',
          attrs: { src: '', alt: '', caption: '', fileId: null, width: null, align: 'center' },
        };
        const widthPt = ptOf(e.cssStyle?.width) ?? ptOf(drawing.cssStyle?.width);
        if (widthPt && widthPt > 0) node.attrs!.width = Math.round(widthPt * (4 / 3));
        out.push(node);
        this.uploads.push(this.loadImage(e.src, node));
        return;
      }
      for (const c of e.children ?? []) visit(c);
    };
    visit(drawing);
    return out;
  }

  private async loadImage(relId: string, node: PmJSON) {
    try {
      const path = this.wd.getPathById(this.wd.documentPart, relId);
      if (!path) throw new Error('missing image');
      const raw = await this.wd._package.load(path, 'blob');
      if (!raw) throw new Error('missing image');
      const ext = path.split('.').pop()?.toLowerCase() ?? 'png';
      const mime =
        this.wd.contentTypes?.find((c) => c.partName === path || c.extension === ext)
          ?.contentType ?? (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`);
      const blob = new Blob([raw], { type: mime });
      this.imageCount += 1;
      const name = `docx-image-${this.imageCount}.${ext}`;
      node.attrs!.alt = name;
      if (this.ctx) {
        const up = await this.ctx.uploadFile(blob, name);
        node.attrs!.src = up.url;
        node.attrs!.fileId = up.id;
      } else {
        node.attrs!.src = await blobToDataUrl(blob);
      }
    } catch {
      this.warnings.push(tr('有图片没有导入成功'));
      node.type = 'paragraph';
      delete node.attrs;
      node.content = [{ type: 'text', text: tr('［图片未能导入］') }];
    }
  }

  // ------------------------------------------------------------ 表格

  private table(el: DxElement): PmJSON {
    const widths = (el.columns ?? []).map((c) => {
      const pt = ptOf(c.width);
      return pt && pt > 0 ? Math.round(pt * (4 / 3)) : null;
    });
    const rows = (el.children ?? []).filter((r) => r.type === 'row');
    // 先按网格列定位每个单元格，再算纵向合并
    interface Cell {
      el: DxElement;
      col: number;
      span: number;
      rowspan: number;
      merged: boolean;
    }
    const grid: Cell[][] = rows.map((row) => {
      let col = 0;
      return (row.children ?? [])
        .filter((c) => c.type === 'cell')
        .map((c) => {
          const span = Math.max(1, c.span ?? 1);
          const cell: Cell = {
            el: c,
            col,
            span,
            rowspan: 1,
            merged: c.verticalMerge === 'continue',
          };
          col += span;
          return cell;
        });
    });
    grid.forEach((row, r) => {
      for (const cell of row) {
        if (cell.merged) continue;
        if (cell.el.verticalMerge !== 'restart') continue;
        for (let rr = r + 1; rr < grid.length; rr += 1) {
          const below = grid[rr]!.find((c) => c.col === cell.col);
          if (!below || !below.merged) break;
          cell.rowspan += 1;
        }
      }
    });
    const headerRows = new Set<number>();
    rows.forEach((row, i) => {
      // <w:tblHeader/> 不带 val 时 docx-preview 读成 null（= 是），没有这个元素时是 undefined
      const header = row.isHeader !== undefined && row.isHeader !== false;
      if (header && (i === 0 || headerRows.has(i - 1))) headerRows.add(i);
    });
    const tableStyle = this.style(el.styleName);
    const content: PmJSON[] = grid
      .map((row, r) => ({
        type: 'tableRow',
        content: row
          .filter((c) => !c.merged)
          .map((c) => {
            const colwidth = widths.slice(c.col, c.col + c.span);
            const bg = normalizeColor(
              c.el.cssStyle?.['background-color'] ?? tableStyle.td['background-color'],
            );
            const blocks = this.blocks(c.el.children ?? []).filter((b) => b.type !== 'pageBreak');
            return {
              type: headerRows.has(r) ? 'tableHeader' : 'tableCell',
              attrs: {
                colspan: c.span,
                rowspan: c.rowspan,
                colwidth: colwidth.length === c.span && colwidth.every((w) => w) ? colwidth : null,
                backgroundColor: bg && bg !== '#ffffff' ? bg : null,
              },
              content: blocks.length ? blocks : [{ type: 'paragraph' }],
            };
          }),
      }))
      .filter((r) => r.content.length > 0);
    return { type: 'table', content };
  }
}

function cssFor(style: DxStyle | undefined, target: string): Css {
  const out: Css = {};
  for (const s of style?.styles ?? []) {
    if (s.target === target) Object.assign(out, s.values);
  }
  return out;
}

function noteText(note: DxElement): string {
  return (note.children ?? [])
    .map((p) => textOf(p).trim())
    .filter(Boolean)
    .join('\n');
}

function trimHardBreaks(nodes: PmJSON[]): PmJSON[] {
  let start = 0;
  let end = nodes.length;
  while (start < end && nodes[start]!.type === 'hardBreak') start += 1;
  while (end > start && nodes[end - 1]!.type === 'hardBreak') end -= 1;
  return nodes.slice(start, end);
}

function mergeText(nodes: PmJSON[]): PmJSON[] {
  const out: PmJSON[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.type === 'text' &&
      n.type === 'text' &&
      JSON.stringify(prev.marks ?? []) === JSON.stringify(n.marks ?? [])
    ) {
      prev.text = (prev.text ?? '') + (n.text ?? '');
    } else out.push({ ...n });
  }
  return out;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function pageFromProps(props: DxDocument['documentPart']['body']['props']): Partial<PageSetup> {
  const page: Partial<PageSetup> = {};
  const w = ptOf(props?.pageSize?.width);
  const h = ptOf(props?.pageSize?.height);
  if (w && h) {
    const wmm = ptToMm(Math.min(w, h));
    const hmm = ptToMm(Math.max(w, h));
    const size = (Object.keys(PAPER_SIZES) as PaperSize[]).find(
      (k) => Math.abs(PAPER_SIZES[k].width - wmm) < 3 && Math.abs(PAPER_SIZES[k].height - hmm) < 3,
    );
    if (size) page.size = size;
    page.orientation = w > h ? 'landscape' : 'portrait';
  }
  const m = props?.pageMargins;
  const mm = (v: string | undefined) => {
    const pt = ptOf(v);
    return pt !== null && pt >= 0 ? ptToMm(pt) : undefined;
  };
  if (m) {
    const top = mm(m.top);
    const right = mm(m.right);
    const bottom = mm(m.bottom);
    const left = mm(m.left);
    if (top !== undefined) page.marginTop = top;
    if (right !== undefined) page.marginRight = right;
    if (bottom !== undefined) page.marginBottom = bottom;
    if (left !== undefined) page.marginLeft = left;
  }
  return page;
}

function firstHeading(doc: PmJSON): string {
  const walk = (n: PmJSON): string | null => {
    if (n.type === 'heading') {
      const t = (n.content ?? [])
        .map((c) => c.text ?? '')
        .join('')
        .trim();
      if (t) return t;
    }
    for (const c of n.content ?? []) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  };
  return walk(doc) ?? '';
}

/** 解析 .docx 文件 */
export async function docxToPm(
  file: Blob,
  ctx?: ImportContext,
  name = '',
): Promise<DocxImportResult> {
  let wd: DxDocument;
  try {
    wd = (await parseAsync(file, {
      ignoreLastRenderedPageBreak: true,
      renderFootnotes: true,
      renderEndnotes: true,
      experimental: true,
    })) as DxDocument;
  } catch {
    throw new Error(tr('这个文件不是有效的 Word（.docx）文档，或者已经损坏'));
  }
  if (!wd?.documentPart?.body) throw new Error(tr('这个 Word 文档里没有正文'));
  const mapper = new Mapper(wd, ctx);
  const doc = await mapper.run();
  const fromName = name.replace(/\.docx$/iu, '').trim();
  const coreTitle = wd.corePropsPart?.props?.title?.trim() ?? '';
  const title = (coreTitle || firstHeading(doc) || fromName || tr('导入的 Word 文档')).slice(
    0,
    200,
  );
  return { doc, title, page: pageFromProps(wd.documentPart.body.props), warnings: mapper.warnings };
}

/** 中文字号名（给导入报告 / 测试看） */
export function cnSizeName(pt: number): string | null {
  return CN_FONT_SIZES.find((s) => s.pt === pt)?.label ?? null;
}
