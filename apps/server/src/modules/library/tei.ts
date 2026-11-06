import { DOMParser, type Element } from '@xmldom/xmldom';
import type {
  PaperAuthor,
  PaperChunk,
  PaperFigure,
  PaperFormula,
  PaperReference,
  PaperSection,
  PaperStructure,
  PdfBox,
} from '@srh/shared';
import { normalizeArxivId, normalizeDoi } from '@srh/shared';

/**
 * GROBID TEI → 论文结构（章节、段落、公式、图表、参考文献，每项带页码与坐标）。
 * 只依赖 TEI 本身，单测用真实 GROBID 输出的片段做夹具（test/fixtures/library）。
 *
 * 坐标：TEI 的 coords="页,x,y,w,h;…"（pt，左上角原点），与 PdfBox 一致。
 */

type El = Element;

export interface TeiHeader {
  title: string | null;
  authors: PaperAuthor[];
  year: number | null;
  doi: string | null;
  arxivId: string | null;
  abstract: string | null;
}

export interface TeiResult {
  header: TeiHeader;
  structure: PaperStructure;
}

const MAX_BOXES = 60;

export function parseCoords(raw: string | null | undefined): PdfBox[] {
  if (!raw) return [];
  const out: PdfBox[] = [];
  for (const part of raw.split(';')) {
    const n = part.split(',').map(Number);
    if (n.length < 5 || n.some((v) => !Number.isFinite(v))) continue;
    const [page, x, y, w, h] = n as [number, number, number, number, number];
    if (page < 1 || w <= 0 || h <= 0) continue;
    out.push({ page: Math.round(page), x: r2(x), y: r2(y), w: r2(w), h: r2(h) });
    if (out.length >= MAX_BOXES) break;
  }
  return out;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** 空白归一（GROBID 的 xml:space=preserve 会带很多换行与缩进） */
export function clean(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/\s+/gu, ' ')
    .replace(/\s+([,.;:)\]])/gu, '$1')
    .replace(/([([])\s+/gu, '$1')
    .trim();
}

function children(el: El, name?: string): El[] {
  const out: El[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!name || (n as El).localName === name)) out.push(n as El);
  }
  return out;
}

function first(el: El | null | undefined, name: string): El | null {
  if (!el) return null;
  const list = el.getElementsByTagName(name);
  return list.length ? (list[0] as El) : null;
}

function all(el: El | null | undefined, name: string): El[] {
  if (!el) return [];
  return Array.from(el.getElementsByTagName(name)) as El[];
}

/** 元素文字，跳过 <label>（公式编号单独取） */
function textOf(el: El, skip: Set<string> = new Set()): string {
  let s = '';
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3) s += n.nodeValue ?? '';
    else if (n.nodeType === 1) {
      const name = (n as El).localName ?? '';
      if (skip.has(name)) continue;
      s += textOf(n as El, skip);
      // 句子之间补一个空格，避免 GROBID 把相邻 <s> 粘在一起
      if (name === 's' || name === 'p' || name === 'cell') s += ' ';
    }
  }
  return s;
}

function personName(p: El | null): PaperAuthor | null {
  if (!p) return null;
  const given = all(p, 'forename')
    .map((f) => clean(f.textContent))
    .filter(Boolean)
    .join(' ');
  const family = clean(first(p, 'surname')?.textContent);
  const name = clean([given, family].filter(Boolean).join(' '));
  if (!name) return null;
  return { name, given: given || null, family: family || null };
}

function yearOf(el: El | null): number | null {
  if (!el) return null;
  const dates = all(el, 'date');
  for (const d of dates) {
    const when = d.getAttribute('when') ?? d.textContent ?? '';
    const m = /(1[89]\d\d|20\d\d)/u.exec(when);
    if (m) return Number(m[1]);
  }
  return null;
}

function idnos(el: El | null): { doi: string | null; arxivId: string | null } {
  let doi: string | null = null;
  let arxivId: string | null = null;
  for (const i of all(el, 'idno')) {
    const type = (i.getAttribute('type') ?? '').toLowerCase();
    const v = clean(i.textContent);
    if (type === 'doi' && !doi) doi = normalizeDoi(v);
    if (type === 'arxiv' && !arxivId)
      arxivId = normalizeArxivId(v.replace(/\[[^\]]*\]$/u, '').replace(/^arxiv:/iu, ''));
    if (!type && !arxivId) {
      const m = /arxiv[:\s]*([\d.]{9,10})/iu.exec(v);
      if (m) arxivId = normalizeArxivId(m[1]!);
    }
  }
  return { doi, arxivId };
}

/** 小节层级：编号 “3.2.1” → 3；无编号 → 1 */
function levelOf(n: string | null): number {
  if (!n) return 1;
  const parts = n.replace(/\.$/u, '').split('.').filter(Boolean);
  return Math.min(6, Math.max(1, parts.length));
}

interface Draft {
  kind: PaperChunk['kind'];
  sectionIndex: number | null;
  sectionPath: string;
  boxes: PdfBox[];
  text: string;
  /** 指向公式/图表，用来回填 chunkSeq */
  formula?: PaperFormula;
  figure?: PaperFigure;
}

export function parseTei(xml: string): TeiResult {
  const doc = new DOMParser({
    onError: () => undefined,
  }).parseFromString(xml, 'text/xml');
  const root = doc.documentElement as El | null;
  if (!root || root.localName !== 'TEI') throw new Error('不是 GROBID TEI 文档');

  // ------------------------------------------------------------ 头部
  const teiHeader = first(root, 'teiHeader');
  const titleStmt = first(teiHeader, 'titleStmt');
  const sourceBibl = first(first(teiHeader, 'sourceDesc'), 'biblStruct');
  const analytic = first(sourceBibl, 'analytic');
  const authors: PaperAuthor[] = [];
  for (const a of children(analytic ?? (sourceBibl as El), 'author')) {
    const p = personName(first(a, 'persName'));
    if (p) authors.push(p);
  }
  const ids = idnos(sourceBibl);
  const header: TeiHeader = {
    title: clean(first(titleStmt, 'title')?.textContent) || null,
    authors,
    year: yearOf(first(teiHeader, 'publicationStmt')) ?? yearOf(first(sourceBibl, 'imprint')),
    doi: ids.doi,
    arxivId: ids.arxivId,
    abstract: null,
  };

  // 页面尺寸
  const pages = all(first(root, 'facsimile'), 'surface').map((s) => ({
    width: Number(s.getAttribute('lrx')) - Number(s.getAttribute('ulx') || 0) || 612,
    height: Number(s.getAttribute('lry')) - Number(s.getAttribute('uly') || 0) || 792,
  }));

  const sections: PaperSection[] = [];
  const formulas: PaperFormula[] = [];
  const figures: PaperFigure[] = [];
  const drafts: Draft[] = [];
  const floatDrafts: Draft[] = [];

  // ------------------------------------------------------------ 摘要
  const abstractEl = first(first(teiHeader, 'profileDesc'), 'abstract');
  const abstractTexts: string[] = [];
  for (const p of all(abstractEl, 'p')) {
    const text = clean(textOf(p));
    if (!text) continue;
    abstractTexts.push(text);
    drafts.push({
      kind: 'abstract',
      sectionIndex: null,
      sectionPath: 'Abstract',
      boxes: parseCoords(p.getAttribute('coords')),
      text,
    });
  }
  header.abstract = abstractTexts.join('\n\n') || null;

  // ------------------------------------------------------------ 正文
  const text = first(root, 'text');
  const body = first(text, 'body');
  const back = first(text, 'back');
  const pathStack: { level: number; label: string }[] = [];
  let currentSection: number | null = null;

  const pathString = () => pathStack.map((s) => s.label).join(' › ');

  const startSection = (head: El) => {
    const n = head.getAttribute('n');
    const title = clean(textOf(head));
    if (!title) return;
    const level = levelOf(n);
    while (pathStack.length && pathStack[pathStack.length - 1]!.level >= level) pathStack.pop();
    pathStack.push({ level, label: n ? `${n} ${title}` : title });
    const boxes = parseCoords(head.getAttribute('coords'));
    sections.push({
      n: n || null,
      title,
      level,
      page: boxes[0]?.page ?? null,
      boxes,
      firstChunk: null,
    });
    currentSection = sections.length - 1;
  };

  const addFormula = (f: El) => {
    const label = clean(first(f, 'label')?.textContent) || null;
    const ftext = clean(textOf(f, new Set(['label'])));
    if (!ftext) return;
    const boxes = parseCoords(f.getAttribute('coords'));
    const formula: PaperFormula = {
      id: f.getAttribute('xml:id') ?? `formula_${formulas.length}`,
      label,
      text: ftext,
      latex: null,
      page: boxes[0]?.page ?? null,
      boxes,
      chunkSeq: null,
    };
    formulas.push(formula);
    drafts.push({
      kind: 'formula',
      sectionIndex: currentSection,
      sectionPath: pathString(),
      boxes,
      text: label ? `${ftext} ${label}` : ftext,
      formula,
    });
  };

  const addParagraph = (p: El, kind: PaperChunk['kind'] = 'paragraph') => {
    const t = clean(textOf(p));
    if (!t) return;
    drafts.push({
      kind,
      sectionIndex: currentSection,
      sectionPath: pathString(),
      boxes: parseCoords(p.getAttribute('coords')),
      text: t,
    });
  };

  const walkDiv = (div: El) => {
    for (const c of children(div)) {
      switch (c.localName) {
        case 'head':
          startSection(c);
          break;
        case 'p':
          addParagraph(c);
          break;
        case 'formula':
          addFormula(c);
          break;
        case 'div':
          walkDiv(c);
          break;
        case 'list':
          for (const item of children(c, 'item')) addParagraph(item);
          break;
        default:
          break;
      }
    }
  };

  for (const c of body ? children(body) : []) {
    if (c.localName === 'div') walkDiv(c);
    else if (c.localName === 'formula') addFormula(c);
    else if (c.localName === 'p') addParagraph(c);
  }

  // 图表（GROBID 放在 body 末尾），脚注
  for (const fig of body ? all(body, 'figure') : []) {
    const isTable = fig.getAttribute('type') === 'table';
    const head = clean(first(fig, 'head')?.textContent).replace(/\s*[:：.]$/u, '');
    const labelNum = clean(first(fig, 'label')?.textContent);
    const label = labelNum
      ? `${isTable ? 'Table' : 'Figure'} ${labelNum}`
      : /^(fig(?:ure)?|table)\b/iu.test(head)
        ? head
        : null;
    const desc = first(fig, 'figDesc');
    let caption = clean(desc ? textOf(desc) : '');
    // 图注开头常重复 “Figure 1:”，去掉
    caption = caption.replace(/^(fig(?:ure)?\.?|table)\s*\d+[a-z]?\s*[:：.]\s*/iu, '');
    const boxes = parseCoords(fig.getAttribute('coords'));
    const graphicEl = first(fig, 'graphic');
    const tableEl = first(fig, 'table');
    const graphic =
      parseCoords(graphicEl?.getAttribute('coords'))[0] ??
      parseCoords(tableEl?.getAttribute('coords'))[0] ??
      null;
    let rows: string[][] | null = null;
    if (tableEl) {
      rows = all(tableEl, 'row')
        .map((r) => children(r, 'cell').map((c) => clean(textOf(c))))
        .filter((r) => r.some(Boolean));
      if (rows.length === 0) rows = null;
    }
    if (!caption && !rows && !graphic) continue;
    const figure: PaperFigure = {
      id: fig.getAttribute('xml:id') ?? `fig_${figures.length}`,
      kind: isTable ? 'table' : 'figure',
      label,
      caption,
      page: (graphic ?? boxes[0])?.page ?? null,
      boxes,
      graphic,
      rows,
      chunkSeq: null,
    };
    figures.push(figure);
    const tableText = rows ? `\n${rows.map((r) => r.join(' | ')).join('\n')}` : '';
    floatDrafts.push({
      kind: isTable ? 'table' : 'caption',
      sectionIndex: null,
      sectionPath: label ?? (isTable ? 'Table' : 'Figure'),
      boxes: boxes.length ? boxes : graphic ? [graphic] : [],
      text: `${label ? `${label}: ` : ''}${caption}${tableText}`.trim(),
      figure,
    });
  }
  for (const note of body ? all(body, 'note') : []) {
    if (note.getAttribute('place') !== 'foot') continue;
    const t = clean(textOf(note));
    if (!t) continue;
    floatDrafts.push({
      kind: 'note',
      sectionIndex: null,
      sectionPath: `脚注${note.getAttribute('n') ? ` ${note.getAttribute('n')}` : ''}`,
      boxes: parseCoords(note.getAttribute('coords')),
      text: t,
    });
  }

  // 附录、致谢
  for (const div of back ? children(back, 'div') : []) {
    const type = div.getAttribute('type');
    if (type === 'references') continue;
    if (type === 'acknowledgement' || type === 'annex' || type === 'funding' || !type) {
      for (const inner of children(div, 'div')) walkDiv(inner);
      // 有的版本直接把 head/p 放在外层 div 里
      if (children(div, 'div').length === 0) walkDiv(div);
    }
  }

  // ------------------------------------------------------------ 合并、编号
  const merged = interleaveFloats(drafts, floatDrafts);
  const chunks: PaperChunk[] = [];
  const paraCount = new Map<number, number>();
  merged.forEach((d, seq) => {
    const page = d.boxes[0]?.page ?? lastPage(chunks) ?? 1;
    const para = (paraCount.get(page) ?? 0) + 1;
    paraCount.set(page, para);
    chunks.push({
      id: '',
      seq,
      kind: d.kind,
      sectionIndex: d.sectionIndex,
      sectionPath: d.sectionPath,
      page,
      para,
      boxes: d.boxes,
      text: d.text,
    });
    if (d.formula) d.formula.chunkSeq = seq;
    if (d.figure) d.figure.chunkSeq = seq;
    if (d.sectionIndex !== null && sections[d.sectionIndex]?.firstChunk === null) {
      sections[d.sectionIndex]!.firstChunk = seq;
    }
  });

  // ------------------------------------------------------------ 参考文献
  const references: PaperReference[] = [];
  const listBibl = back ? first(back, 'listBibl') : null;
  for (const b of listBibl ? children(listBibl, 'biblStruct') : []) {
    references.push(parseBiblStruct(b, references.length + 1));
  }

  return {
    header,
    structure: {
      pages,
      sections,
      chunks,
      formulas,
      figures,
      references,
      macros: {},
    },
  };
}

function lastPage(chunks: PaperChunk[]): number | null {
  return chunks.length ? chunks[chunks.length - 1]!.page : null;
}

/** 把图注、表格、脚注插到正文里所在页的最后一段之后（大致保持阅读顺序） */
function interleaveFloats(text: Draft[], floats: Draft[]): Draft[] {
  if (floats.length === 0) return text;
  const pageOf = (d: Draft) => d.boxes[0]?.page ?? 0;
  const sorted = [...floats].sort((a, b) => pageOf(a) - pageOf(b));
  const out: Draft[] = [];
  let fi = 0;
  for (let i = 0; i < text.length; i += 1) {
    const d = text[i]!;
    // 进入新的一页之前，把前面页的浮动体放下
    while (fi < sorted.length && pageOf(sorted[fi]!) < pageOf(d) && d.kind !== 'abstract') {
      out.push(sorted[fi]!);
      fi += 1;
    }
    out.push(d);
  }
  while (fi < sorted.length) out.push(sorted[fi++]!);
  return out;
}

export function parseBiblStruct(b: El, index: number): PaperReference {
  const analytic = first(b, 'analytic');
  const monogr = first(b, 'monogr');
  const titleA = clean(first(analytic, 'title')?.textContent);
  const titleM = clean(first(monogr, 'title')?.textContent);
  const title = titleA || titleM || null;
  const venue = titleA && titleM ? titleM : null;
  const authorHost = analytic ?? monogr;
  const authors = (authorHost ? children(authorHost, 'author') : [])
    .map((a) => personName(first(a, 'persName'))?.name)
    .filter((x): x is string => Boolean(x));
  const ids = idnos(b);
  const raw = all(b, 'note')
    .filter((n) => n.getAttribute('type') === 'raw_reference')
    .map((n) => clean(n.textContent))[0];
  const boxes = parseCoords(b.getAttribute('coords'));
  // raw 里常有 DOI / arXiv，idno 没给时再找一次
  let doi = ids.doi;
  let arxivId = ids.arxivId;
  if (!doi && raw) {
    const m = /\b(10\.\d{4,9}\/[^\s,;]+[^\s,;.])/u.exec(raw);
    if (m) doi = normalizeDoi(m[1]!);
  }
  if (!arxivId && raw) {
    const m =
      /arxiv[:\s]*(?:abs\/)?(\d{4}\.\d{4,5})/iu.exec(raw) ??
      /\bCoRR,?\s*abs\/(\d{4}\.\d{4,5})/iu.exec(raw);
    if (m) arxivId = normalizeArxivId(m[1]!);
  }
  return {
    id: b.getAttribute('xml:id') ?? `b${index - 1}`,
    index,
    title,
    authors,
    year: yearOf(monogr ?? b),
    venue,
    doi,
    arxivId,
    raw: raw ?? null,
    page: boxes[0]?.page ?? null,
    boxes,
  };
}
