import type { LatexBlock, LatexSection, LatexWarning } from './types';
import { tr } from '@/lib/i18n';

/** 转换过程中的共享状态（计数器、标签、引用、宏……），所有 Parser 实例共用一份。 */

export type Lang = 'zh' | 'en';

export type LabelKind =
  'section' | 'equation' | 'figure' | 'table' | 'item' | 'theorem' | 'footnote' | 'other';

export interface LabelInfo {
  num: string;
  anchor: string | null;
  kind: LabelKind;
}

export interface TextMacro {
  nargs: number;
  defaultArg: string | null;
  body: string;
}

export interface EnvMacro {
  nargs: number;
  defaultArg: string | null;
  begin: string;
  end: string;
}

export interface PendingRef {
  kind: string;
  key: string;
  line: number;
}

export interface PendingCite {
  keys: string[];
  note: string | null;
  line: number;
}

export interface TheoremDef {
  title: string;
  counter: string;
  numbered: boolean;
  plain: boolean;
}

export interface Footnote {
  mark: string;
  html: string;
  anchor: string;
}

/** 推迟到 \maketitle 再解析的参数（记下所在解析器和源码区间） */
export interface ArgRef {
  parse: () => string;
  raw: string;
}

export interface FloatCtx {
  kind: 'figure' | 'table';
  anchors: string[];
  captioned: boolean;
  sub: number;
}

export interface Ctx {
  lang: Lang;
  today: Date;
  warnings: LatexWarning[];
  macros: Map<string, TextMacro>;
  envMacros: Map<string, EnvMacro>;
  mathMacros: Record<string, string>;
  mathMacrosKey: string | null;
  labels: Map<string, LabelInfo>;
  labelTarget: LabelInfo | null;
  refs: PendingRef[];
  cites: PendingCite[];
  nocite: string[];
  bib: Map<string, number>;
  bibCount: number;
  bibFiles: string[];
  /** [chapter, section, subsection, subsubsection] */
  sec: [number, number, number, number];
  hasChapters: boolean;
  appendix: boolean;
  eq: number;
  fig: number;
  tab: number;
  fn: number;
  thanks: number;
  theorems: Map<string, TheoremDef>;
  thmCounters: Map<string, number>;
  float: FloatCtx | null;
  subfloat: { letter: string; anchor: string } | null;
  footnotes: Footnote[];
  sections: LatexSection[];
  title: ArgRef | null;
  author: ArgRef | null;
  date: ArgRef | null;
  inAuthor: boolean;
  envStack: string[];
  enumDepth: number;
  itemizeDepth: number;
  expandDepth: number;
  uid: number;
  /** 正在解析导言区（不提示未知命令） */
  inPreamble: boolean;
  /** 已经提示过的未知命令 */
  unknownCmds: Set<string>;
}

export const L10N = {
  zh: {
    figure: tr('图'),
    table: tr('表'),
    abstract: tr('摘要'),
    references: tr('参考文献'),
    contents: tr('目录'),
    proof: tr('证明'),
    section: tr('节'),
    equation: tr('式'),
    item: tr('项'),
  },
  en: {
    figure: 'Figure',
    table: 'Table',
    abstract: 'Abstract',
    references: 'References',
    contents: 'Contents',
    proof: 'Proof',
    section: 'Section',
    equation: 'Eq.',
    item: 'Item',
  },
} as const;

const THEOREM_NAMES: Record<string, { zh: string; en: string; plain?: boolean }> = {
  theorem: { zh: tr('定理'), en: 'Theorem' },
  lemma: { zh: tr('引理'), en: 'Lemma' },
  proposition: { zh: tr('命题'), en: 'Proposition' },
  corollary: { zh: tr('推论'), en: 'Corollary' },
  conjecture: { zh: tr('猜想'), en: 'Conjecture' },
  claim: { zh: tr('断言'), en: 'Claim' },
  hypothesis: { zh: tr('假设'), en: 'Hypothesis' },
  assumption: { zh: tr('假设'), en: 'Assumption', plain: true },
  definition: { zh: tr('定义'), en: 'Definition', plain: true },
  remark: { zh: tr('注'), en: 'Remark', plain: true },
  example: { zh: tr('例'), en: 'Example', plain: true },
  problem: { zh: tr('问题'), en: 'Problem', plain: true },
  exercise: { zh: tr('习题'), en: 'Exercise', plain: true },
  note: { zh: tr('注记'), en: 'Note', plain: true },
};

export function createCtx(lang: Lang, today: Date): Ctx {
  const theorems = new Map<string, TheoremDef>();
  for (const [name, def] of Object.entries(THEOREM_NAMES)) {
    theorems.set(name, {
      title: def[lang],
      counter: name,
      numbered: true,
      plain: Boolean(def.plain),
    });
  }
  return {
    lang,
    today,
    warnings: [],
    macros: new Map(),
    envMacros: new Map(),
    mathMacros: {},
    mathMacrosKey: null,
    labels: new Map(),
    labelTarget: null,
    refs: [],
    cites: [],
    nocite: [],
    bib: new Map(),
    bibCount: 0,
    bibFiles: [],
    sec: [0, 0, 0, 0],
    hasChapters: false,
    appendix: false,
    eq: 0,
    fig: 0,
    tab: 0,
    fn: 0,
    thanks: 0,
    theorems,
    thmCounters: new Map(),
    float: null,
    subfloat: null,
    footnotes: [],
    sections: [],
    title: null,
    author: null,
    date: null,
    inAuthor: false,
    envStack: [],
    enumDepth: 0,
    itemizeDepth: 0,
    expandDepth: 0,
    uid: 0,
    inPreamble: false,
    unknownCmds: new Set(),
  };
}

/**
 * 段落收集器：flow 模式按空行分段、遇到块级内容（标题、公式、浮动体）就断段；
 * inline 模式（命令参数、花括号分组）把一切拼成一串行内 HTML。
 */
export class Out {
  readonly blocks: LatexBlock[] = [];
  private para = '';
  private paraLine = 0;
  private paraEnd = 0;
  private hasContent = false;
  private inline = '';

  constructor(readonly flow: boolean) {}

  text(html: string, line: number): void {
    if (!this.flow) {
      this.inline += html;
      return;
    }
    if (!this.hasContent) {
      if (html.trim() === '') return;
      this.hasContent = true;
      this.paraLine = line;
    }
    this.para += html;
    if (line > this.paraEnd) this.paraEnd = line;
  }

  parbreak(): void {
    if (!this.flow) {
      this.inline += ' ';
      return;
    }
    this.flushPara();
  }

  block(html: string, line: number, endLine = line): void {
    if (!this.flow) {
      this.inline += html;
      return;
    }
    this.flushPara();
    this.blocks.push({ line, endLine: Math.max(line, endLine), html });
  }

  finish(): this {
    if (this.flow) this.flushPara();
    return this;
  }

  html(): string {
    return this.flow ? this.blocks.map((b) => b.html).join('') : this.inline;
  }

  private flushPara(): void {
    if (this.hasContent) {
      this.blocks.push({
        line: this.paraLine,
        endLine: Math.max(this.paraLine, this.paraEnd),
        html: `<p>${this.para.trim()}</p>`,
      });
    }
    this.para = '';
    this.hasContent = false;
    this.paraEnd = 0;
  }
}
