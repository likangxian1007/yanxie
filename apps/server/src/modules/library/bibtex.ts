import type { PaperAuthor } from '@srh/shared';
import type { PaperBibMeta } from '../../db/schema/library';

/**
 * 引用键与 BibTeX。
 *
 * 引用键：第一作者姓（ASCII 化、小写）+ 年份 + 标题第一个实词，如 vaswani2017attention。
 * 项目内重复时依次加 b、c、d…（vaswani2017attentionb）。键在论文元数据第一次确定时生成，
 * 之后不再变化（已经写进 .bib 和 \cite 的键不能悄悄改掉）。
 */

const STOP = new Set(
  'a an the of on in for to and or with from by at as is are be via towards toward into using its we our how what why when do does can new'.split(
    ' ',
  ),
);

const FOLD: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  Æ: 'ae',
  ø: 'o',
  Ø: 'o',
  ł: 'l',
  Ł: 'l',
  đ: 'd',
  Đ: 'd',
  œ: 'oe',
  Œ: 'oe',
  þ: 'th',
};

/** 去掉重音、只留 a-z0-9 */
export function asciiFold(s: string): string {
  return s
    .replace(/[ßæÆøØłŁđĐœŒþ]/gu, (c) => FOLD[c] ?? c)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '');
}

export function baseCitekey(input: {
  authors: PaperAuthor[];
  year: number | null;
  title: string;
}): string {
  const first = input.authors[0];
  const family = asciiFold(first?.family ?? first?.name.split(' ').pop() ?? '');
  const word =
    input.title
      .split(/[\s\-–—:,.;!?()[\]{}"'/]+/u)
      .map(asciiFold)
      .find((w) => w.length > 1 && !STOP.has(w)) ?? '';
  const key = `${family || 'anon'}${input.year ?? ''}${word}`;
  return key.slice(0, 60) || 'paper';
}

/** 加后缀去重：base、baseb、basec … basez、base27 … */
export function uniqueCitekey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 1; i < 26; i += 1) {
    const k = `${base}${String.fromCharCode(97 + i)}`;
    if (!taken.has(k)) return k;
  }
  for (let i = 27; ; i += 1) {
    const k = `${base}${i}`;
    if (!taken.has(k)) return k;
  }
}

// ---------------------------------------------------------------- BibTeX

export interface BibPaper {
  citekey: string;
  title: string;
  authors: PaperAuthor[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  url: string | null;
  abstract?: string | null;
  meta: PaperBibMeta;
}

const LATEX_SPECIAL: Record<string, string> = {
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

/** 字段值转义：特殊字符加反斜杠，去掉不配对的花括号 */
export function bibEscape(s: string): string {
  let out = s.replace(/\\/gu, '\\textbackslash{}').replace(/[&%$#_~^]/gu, (c) => LATEX_SPECIAL[c]!);
  // 花括号必须配对，否则整个 .bib 解析失败
  let depth = 0;
  let ok = true;
  for (const c of out) {
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    if (depth < 0) ok = false;
  }
  if (!ok || depth !== 0) out = out.replace(/[{}]/gu, '');
  return out.replace(/\s+/gu, ' ').trim();
}

function bibAuthor(a: PaperAuthor): string {
  if (a.family && a.given) return `${bibEscape(a.family)}, ${bibEscape(a.given)}`;
  if (a.family) return bibEscape(a.family);
  return bibEscape(a.name);
}

export function toBibtex(p: BibPaper): string {
  const isArxivOnly = Boolean(p.arxivId) && (!p.meta.entryType || p.meta.entryType === 'misc');
  const type = p.meta.entryType ?? (p.arxivId ? 'misc' : 'article');
  const fields: [string, string][] = [];
  fields.push(['title', `{${bibEscape(p.title || '（无标题）')}}`]);
  if (p.authors.length) fields.push(['author', p.authors.map(bibAuthor).join(' and ')]);
  if (p.year) fields.push(['year', String(p.year)]);
  if (p.venue && !isArxivOnly) {
    const venueField =
      type === 'inproceedings' || type === 'incollection'
        ? 'booktitle'
        : type === 'article'
          ? 'journal'
          : 'howpublished';
    fields.push([venueField, bibEscape(p.venue)]);
  }
  if (p.meta.volume) fields.push(['volume', bibEscape(p.meta.volume)]);
  if (p.meta.issue) fields.push(['number', bibEscape(p.meta.issue)]);
  if (p.meta.pages) fields.push(['pages', bibEscape(p.meta.pages)]);
  if (p.meta.publisher) fields.push(['publisher', bibEscape(p.meta.publisher)]);
  if (p.doi) fields.push(['doi', p.doi]);
  if (p.arxivId) {
    fields.push(['eprint', p.arxivId]);
    fields.push(['archivePrefix', 'arXiv']);
    if (p.meta.primaryClass) fields.push(['primaryClass', p.meta.primaryClass]);
  }
  const url = p.url ?? (p.arxivId ? `https://arxiv.org/abs/${p.arxivId}` : null);
  if (url) fields.push(['url', url.replace(/[{}\s]/gu, '')]);
  const width = Math.max(...fields.map(([k]) => k.length));
  const body = fields.map(([k, v]) => `  ${k.padEnd(width)} = {${v}}`).join(',\n');
  return `@${type}{${p.citekey},\n${body}\n}\n`;
}

/** .bib 文本里已有的键 */
export function bibKeysIn(bib: string): Set<string> {
  const keys = new Set<string>();
  for (const m of bib.matchAll(/@([A-Za-z]+)\s*[{(]\s*([^,\s{}()]+)\s*,/gu)) {
    const t = m[1]!.toLowerCase();
    if (t !== 'comment' && t !== 'string' && t !== 'preamble') keys.add(m[2]!);
  }
  return keys;
}
