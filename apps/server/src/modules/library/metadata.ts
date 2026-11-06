import { arxivIdFromDoi, normalizeArxivId, normalizeDoi, type PaperAuthor } from '@srh/shared';
import type { PaperBibMeta } from '../../db/schema/library';
import { FetchError, fetchJson, fetchText } from './net';

/**
 * 元数据与开放获取 PDF：
 * - arXiv API（export.arxiv.org/api/query?id_list=）
 * - Crossref（api.crossref.org/works/<doi>）
 * - OpenAlex（best_oa_location / open_access.oa_url，也能把 DOI 映射到 arXiv）
 * - Semantic Scholar（openAccessPdf，OpenAlex 没给时再问）
 * 所有请求带联系邮箱（CROSSREF_MAILTO）。
 */

export interface PaperMeta {
  title: string | null;
  authors: PaperAuthor[];
  year: number | null;
  venue: string | null;
  abstract: string | null;
  doi: string | null;
  arxivId: string | null;
  url: string | null;
  pdfUrl: string | null;
  bib: PaperBibMeta;
}

export const emptyMeta = (): PaperMeta => ({
  title: null,
  authors: [],
  year: null,
  venue: null,
  abstract: null,
  doi: null,
  arxivId: null,
  url: null,
  pdfUrl: null,
  bib: {},
});

const decode = (s: string) =>
  s
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gu, '&');

const squash = (s: string) => decode(s).replace(/\s+/gu, ' ').trim();

export function splitName(full: string): PaperAuthor {
  const name = full.replace(/\s+/gu, ' ').trim();
  if (name.includes(',')) {
    const [family, given] = name.split(',', 2).map((x) => x.trim());
    return { name: `${given} ${family}`.trim(), given: given || null, family: family || null };
  }
  const parts = name.split(' ');
  if (parts.length === 1) return { name, given: null, family: name };
  // 带前缀的姓（van der、de la）
  let i = parts.length - 1;
  while (i > 1 && /^(van|von|der|de|del|della|da|di|le|la|du|dos|ten|ter)$/iu.test(parts[i - 1]!)) {
    i -= 1;
  }
  return { name, given: parts.slice(0, i).join(' '), family: parts.slice(i).join(' ') };
}

// ---------------------------------------------------------------- arXiv

export function parseArxivEntry(xml: string): PaperMeta | null {
  const entry = /<entry>([\s\S]*?)<\/entry>/u.exec(xml)?.[1];
  if (!entry) return null;
  const tag = (name: string) =>
    squash(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'u').exec(entry)?.[1] ?? '');
  const idUrl = tag('id');
  // 查不到的编号 arXiv 也返回一个 <entry>，id 是 api/errors
  if (!idUrl || /api\/errors/u.test(idUrl)) return null;
  const arxivId = normalizeArxivId(idUrl);
  const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/gu)].map((m) =>
    splitName(squash(m[1]!)),
  );
  const published = tag('published');
  const doi = normalizeDoi(tag('arxiv:doi'));
  const journal = tag('arxiv:journal_ref');
  const primary = /<arxiv:primary_category[^>]*term="([^"]+)"/u.exec(entry)?.[1];
  return {
    title: tag('title') || null,
    authors,
    year: /^(\d{4})/u.exec(published) ? Number(published.slice(0, 4)) : null,
    venue: journal || null,
    abstract: tag('summary') || null,
    doi,
    arxivId,
    url: arxivId ? `https://arxiv.org/abs/${arxivId}` : null,
    pdfUrl: arxivId ? `https://arxiv.org/pdf/${arxivId}` : null,
    bib: {
      entryType: 'misc',
      ...(primary ? { primaryClass: primary } : {}),
      metaSource: 'arxiv',
    },
  };
}

export async function arxivMeta(id: string, mailto: string): Promise<PaperMeta | null> {
  const xml = await fetchText(
    `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`,
    { mailto, timeoutMs: 30_000 },
  );
  return parseArxivEntry(xml);
}

// ---------------------------------------------------------------- Crossref

interface CrossrefWork {
  message?: {
    title?: string[];
    author?: { given?: string; family?: string; name?: string }[];
    issued?: { 'date-parts'?: number[][] };
    published?: { 'date-parts'?: number[][] };
    'container-title'?: string[];
    type?: string;
    volume?: string;
    issue?: string;
    page?: string;
    publisher?: string;
    abstract?: string;
    URL?: string;
    DOI?: string;
  };
}

const CROSSREF_TYPE: Record<string, string> = {
  'journal-article': 'article',
  'proceedings-article': 'inproceedings',
  'book-chapter': 'incollection',
  book: 'book',
  monograph: 'book',
  'edited-book': 'book',
  'posted-content': 'misc',
  dissertation: 'phdthesis',
  report: 'techreport',
};

export function parseCrossref(json: CrossrefWork): PaperMeta | null {
  const m = json.message;
  if (!m) return null;
  const year = m.issued?.['date-parts']?.[0]?.[0] ?? m.published?.['date-parts']?.[0]?.[0] ?? null;
  const abstract = m.abstract
    ? squash(m.abstract.replace(/<[^>]+>/gu, ' ')).replace(/^Abstract\s*/iu, '')
    : null;
  return {
    title: m.title?.[0] ? squash(m.title[0]) : null,
    authors: (m.author ?? [])
      .map((a) =>
        a.family
          ? {
              name: `${a.given ?? ''} ${a.family}`.trim(),
              given: a.given ?? null,
              family: a.family,
            }
          : a.name
            ? splitName(a.name)
            : null,
      )
      .filter((a): a is PaperAuthor => a !== null),
    year: typeof year === 'number' ? year : null,
    venue: m['container-title']?.[0] ? squash(m['container-title'][0]) : null,
    abstract,
    doi: m.DOI ? normalizeDoi(m.DOI) : null,
    arxivId: null,
    url: m.URL ?? null,
    pdfUrl: null,
    bib: {
      entryType: CROSSREF_TYPE[m.type ?? ''] ?? 'article',
      ...(m.publisher ? { publisher: m.publisher } : {}),
      ...(m.volume ? { volume: m.volume } : {}),
      ...(m.issue ? { issue: m.issue } : {}),
      ...(m.page ? { pages: m.page.replace(/-/u, '--') } : {}),
      metaSource: 'crossref',
    },
  };
}

export async function crossrefMeta(doi: string, mailto: string): Promise<PaperMeta | null> {
  const q = mailto ? `?mailto=${encodeURIComponent(mailto)}` : '';
  try {
    return parseCrossref(
      await fetchJson<CrossrefWork>(
        `https://api.crossref.org/works/${encodeURIComponent(doi)}${q}`,
        { mailto, timeoutMs: 20_000 },
      ),
    );
  } catch (err) {
    if (err instanceof FetchError && err.status === 404) return null;
    throw err;
  }
}

// ---------------------------------------------------------------- OpenAlex / Semantic Scholar

interface OpenAlexWork {
  title?: string;
  publication_year?: number;
  doi?: string;
  ids?: { doi?: string; arxiv?: string };
  best_oa_location?: { pdf_url?: string | null; landing_page_url?: string | null } | null;
  open_access?: { oa_url?: string | null };
  locations?: {
    pdf_url?: string | null;
    landing_page_url?: string | null;
    source?: { display_name?: string } | null;
  }[];
}

export interface OaInfo {
  pdfUrl: string | null;
  arxivId: string | null;
}

export function parseOpenAlex(w: OpenAlexWork): OaInfo {
  let arxivId: string | null = null;
  for (const loc of w.locations ?? []) {
    const u = loc.landing_page_url ?? loc.pdf_url ?? '';
    const m = /arxiv\.org\/(?:abs|pdf)\/([^\s?#]+)/iu.exec(u);
    if (m) {
      arxivId = normalizeArxivId(m[1]!);
      if (arxivId) break;
    }
  }
  const pdf =
    w.best_oa_location?.pdf_url ??
    (w.locations ?? []).find((l) => l.pdf_url)?.pdf_url ??
    (w.open_access?.oa_url && /\.pdf($|\?)/iu.test(w.open_access.oa_url)
      ? w.open_access.oa_url
      : null);
  return { pdfUrl: pdf ?? null, arxivId };
}

export async function openAlexOa(doi: string, mailto: string): Promise<OaInfo> {
  const q = mailto ? `?mailto=${encodeURIComponent(mailto)}` : '';
  try {
    const w = await fetchJson<OpenAlexWork>(
      `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}${q}`,
      { mailto, timeoutMs: 20_000 },
    );
    return parseOpenAlex(w);
  } catch (err) {
    if (err instanceof FetchError && !err.transient) return { pdfUrl: null, arxivId: null };
    throw err;
  }
}

interface S2Paper {
  openAccessPdf?: { url?: string | null } | null;
  externalIds?: { ArXiv?: string; DOI?: string };
}

export async function semanticScholarOa(doi: string, mailto: string): Promise<OaInfo> {
  try {
    const p = await fetchJson<S2Paper>(
      `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=openAccessPdf,externalIds`,
      { mailto, timeoutMs: 20_000 },
    );
    return {
      pdfUrl: p.openAccessPdf?.url || null,
      arxivId: p.externalIds?.ArXiv ? normalizeArxivId(p.externalIds.ArXiv) : null,
    };
  } catch {
    // S2 免费接口经常 429，只是补充来源，失败就算了
    return { pdfUrl: null, arxivId: null };
  }
}

// ---------------------------------------------------------------- 全部开放获取 PDF 候选

interface UnpaywallLoc {
  url_for_pdf?: string | null;
  url_for_landing_page?: string | null;
}
interface UnpaywallWork {
  is_oa?: boolean;
  best_oa_location?: UnpaywallLoc | null;
  oa_locations?: UnpaywallLoc[];
}

export interface PdfCandidates {
  /** 按优先级排好、去重后的 PDF 地址 */
  urls: string[];
  /** 开放获取版本所在网页（下载不了时给成员手动打开） */
  landing: string | null;
  /** true = 有开放获取版本；false = 各来源都说是订阅论文；null = 查不到 */
  isOa: boolean | null;
}

/** 仓储网页能直接推出 PDF 地址的（HAL 的 /document） */
function pdfFromLanding(u: string): string | null {
  if (/^https?:\/\/(?:[\w-]+\.)?hal\.science\/[\w-]+(?:v\d+)?\/?$/iu.test(u)) {
    return `${u.replace(/\/$/u, '')}/document`;
  }
  return null;
}

/**
 * 一个 DOI 所有能合法拿到的 PDF：OpenAlex 全部 location、Unpaywall 全部 oa_location、
 * Semantic Scholar。任一来源失败都不影响别的。
 */
export async function findPdfCandidates(doi: string, mailto: string): Promise<PdfCandidates> {
  const urls: string[] = [];
  const landings: string[] = [];
  let isOa: boolean | null = null;
  const add = (u: string | null | undefined) => {
    if (u && /^https?:\/\//iu.test(u) && !urls.includes(u)) urls.push(u);
  };
  const enc = encodeURIComponent(doi);
  const q = mailto ? `?mailto=${encodeURIComponent(mailto)}` : '';
  const [oa, up, s2] = await Promise.all([
    fetchJson<OpenAlexWork & { open_access?: { is_oa?: boolean } }>(
      `https://api.openalex.org/works/doi:${enc}${q}`,
      { mailto, timeoutMs: 20_000 },
    ).catch(() => null),
    mailto
      ? fetchJson<UnpaywallWork>(
          `https://api.unpaywall.org/v2/${enc}?email=${encodeURIComponent(mailto)}`,
          { mailto, timeoutMs: 20_000 },
        ).catch(() => null)
      : Promise.resolve(null),
    semanticScholarOa(doi, mailto),
  ]);
  if (oa) {
    add(oa.best_oa_location?.pdf_url);
    for (const l of oa.locations ?? []) add(l.pdf_url);
    if (oa.best_oa_location?.landing_page_url) landings.push(oa.best_oa_location.landing_page_url);
    for (const l of oa.locations ?? []) if (l.landing_page_url) landings.push(l.landing_page_url);
    if (typeof oa.open_access?.is_oa === 'boolean') isOa = oa.open_access.is_oa;
    if (oa.open_access?.oa_url) landings.unshift(oa.open_access.oa_url);
  }
  if (up) {
    add(up.best_oa_location?.url_for_pdf);
    for (const l of up.oa_locations ?? []) add(l.url_for_pdf);
    for (const l of up.oa_locations ?? [])
      if (l.url_for_landing_page) landings.push(l.url_for_landing_page);
    if (typeof up.is_oa === 'boolean') isOa = isOa === true ? true : up.is_oa;
  }
  add(s2.pdfUrl);
  if (s2.pdfUrl) isOa = true;
  for (const l of landings) add(pdfFromLanding(l));
  // 开放获取网页：不是 doi.org 跳转、也不是已经在 PDF 列表里的
  const landing = isOa
    ? (landings.find((l) => !/doi\.org\//iu.test(l) && !urls.includes(l)) ?? landings[0] ?? null)
    : null;
  if (s2.arxivId) urls.unshift(`https://arxiv.org/pdf/${s2.arxivId}`);
  return { urls, landing, isOa };
}

/** DOI → 元数据 + 开放获取 PDF（DOI 指向 arXiv 时直接走 arXiv） */
export async function resolveDoi(doi: string, mailto: string): Promise<PaperMeta | null> {
  const fromArxivDoi = arxivIdFromDoi(doi);
  if (fromArxivDoi) {
    const m = await arxivMeta(fromArxivDoi, mailto);
    if (m) return { ...m, doi: m.doi ?? doi };
  }
  const meta = await crossrefMeta(doi, mailto);
  const oa = await openAlexOa(doi, mailto).catch(() => ({ pdfUrl: null, arxivId: null }));
  let pdfUrl = oa.pdfUrl;
  let arxivId = oa.arxivId;
  if (!pdfUrl && !arxivId) {
    const s2 = await semanticScholarOa(doi, mailto);
    pdfUrl = s2.pdfUrl;
    arxivId = s2.arxivId;
  }
  if (!meta && !pdfUrl && !arxivId) return null;
  const base = meta ?? { ...emptyMeta(), doi };
  return {
    ...base,
    doi,
    arxivId,
    // 有 arXiv 版本时优先 arXiv 的 PDF（稳定、可下载、还有 LaTeX 源码）
    pdfUrl: arxivId ? `https://arxiv.org/pdf/${arxivId}` : pdfUrl,
  };
}
