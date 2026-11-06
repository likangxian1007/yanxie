import { decodeEntities } from './text';
import { fetchApi, NetError } from './net';

/**
 * 学术检索：并发查 OpenAlex、Semantic Scholar、Crossref、arXiv，按 DOI / arXiv 号 / 标题去重合并，
 * 用倒数排名融合（RRF）排序，引用数做轻微加权。任何一个源失败都不影响其他源，状态写进 sources_status。
 */

export type PaperSource = 'openalex' | 'semantic_scholar' | 'crossref' | 'arxiv';
export const PAPER_SOURCES: PaperSource[] = ['openalex', 'semantic_scholar', 'crossref', 'arxiv'];

export interface Paper {
  title: string;
  authors: string[];
  year: number | null;
  date: string | null;
  venue: string | null;
  doi: string | null;
  arxiv_id: string | null;
  url: string | null;
  pdf_url: string | null;
  citations: number | null;
  abstract: string | null;
  sources: PaperSource[];
}

export interface PaperSearchOptions {
  max: number;
  yearFrom?: number;
  yearTo?: number;
  sources: PaperSource[];
  sort: 'relevance' | 'citations' | 'recent';
  mailto: string;
  semanticScholarKey: string;
}

const UA = (mailto: string) =>
  `SRH-ResearchAgent/0.2 (scientific research harness${mailto ? `; mailto:${mailto}` : ''})`;

const clean = (s: unknown) =>
  typeof s === 'string'
    ? decodeEntities(s.replace(/<[^>]+>/gu, ' '))
        .replace(/\s+/gu, ' ')
        .trim()
    : '';

const cut = (s: string | null, n = 600) => (s && s.length > n ? `${s.slice(0, n)}…` : s || null);

export const normDoi = (d: unknown): string | null => {
  if (typeof d !== 'string' || !d) return null;
  const m = /10\.\d{4,9}\/\S+/u.exec(d);
  return m ? m[0].replace(/[.,;]+$/u, '').toLowerCase() : null;
};

export const normArxiv = (s: unknown): string | null => {
  if (typeof s !== 'string') return null;
  const m = /(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/iu.exec(s);
  return m ? m[1]! : null;
};

const normTitle = (t: string) =>
  t
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '');

const authorList = (names: string[]) =>
  names.length > 8 ? [...names.slice(0, 8), `等 ${names.length} 人`] : names;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, o: PaperSearchOptions, extra: Record<string, string> = {}) {
  let res = await fetchApi(url, {
    timeoutMs: 15_000,
    headers: { 'user-agent': UA(o.mailto), ...extra },
  });
  // 学术 API 偶发 429：退避一次再试，仍限流才报错
  if (res.status === 429) {
    await sleep(1_500);
    res = await fetchApi(url, {
      timeoutMs: 15_000,
      headers: { 'user-agent': UA(o.mailto), ...extra },
    });
  }
  const { status, text } = res;
  if (status === 429) throw new NetError('被限流（HTTP 429），稍后再试', 'network');
  if (status !== 200) throw new NetError(`HTTP ${status}`, 'network');
  return JSON.parse(text) as Record<string, unknown>;
}

// ---------------------------------------------------------------- OpenAlex

/** OpenAlex 的摘要是倒排索引，还原成正文 */
export function invertedToText(idx: unknown): string | null {
  if (!idx || typeof idx !== 'object') return null;
  const words: string[] = [];
  for (const [w, pos] of Object.entries(idx as Record<string, number[]>)) {
    for (const p of pos) words[p] = w;
  }
  const s = words.filter((w) => w !== undefined).join(' ');
  return s || null;
}

interface OpenAlexWork {
  title?: string;
  display_name?: string;
  doi?: string | null;
  publication_year?: number | null;
  publication_date?: string | null;
  authorships?: { author?: { display_name?: string } }[];
  primary_location?: { source?: { display_name?: string } | null; landing_page_url?: string };
  locations?: { landing_page_url?: string | null; pdf_url?: string | null }[];
  best_oa_location?: { pdf_url?: string | null; landing_page_url?: string | null } | null;
  open_access?: { oa_url?: string | null };
  cited_by_count?: number;
  abstract_inverted_index?: Record<string, number[]>;
  id?: string;
}

export function mapOpenAlex(w: OpenAlexWork): Paper {
  const arxiv =
    (w.locations ?? [])
      .map((l) => l.landing_page_url ?? l.pdf_url ?? '')
      .filter((u) => /arxiv\.org/u.test(u))
      .map(normArxiv)
      .find(Boolean) ?? null;
  const doi = normDoi(w.doi);
  return {
    title: clean(w.title ?? w.display_name),
    authors: authorList(
      (w.authorships ?? []).map((a) => a.author?.display_name ?? '').filter(Boolean),
    ),
    year: w.publication_year ?? null,
    date: w.publication_date ?? null,
    venue: clean(w.primary_location?.source?.display_name) || null,
    doi,
    arxiv_id: arxiv,
    url: doi ? `https://doi.org/${doi}` : (w.primary_location?.landing_page_url ?? w.id ?? null),
    pdf_url: w.best_oa_location?.pdf_url ?? w.open_access?.oa_url ?? null,
    citations: w.cited_by_count ?? null,
    abstract: cut(invertedToText(w.abstract_inverted_index)),
    sources: ['openalex'],
  };
}

async function searchOpenAlex(q: string, o: PaperSearchOptions): Promise<Paper[]> {
  const filters: string[] = [];
  if (o.yearFrom) filters.push(`from_publication_date:${o.yearFrom}-01-01`);
  if (o.yearTo) filters.push(`to_publication_date:${o.yearTo}-12-31`);
  const p = new URLSearchParams({ search: q, 'per-page': String(Math.min(o.max * 2, 50)) });
  if (filters.length) p.set('filter', filters.join(','));
  if (o.sort === 'citations') p.set('sort', 'cited_by_count:desc');
  if (o.sort === 'recent') p.set('sort', 'publication_date:desc');
  if (o.mailto) p.set('mailto', o.mailto);
  const json = await getJson(`https://api.openalex.org/works?${p}`, o);
  return ((json.results as OpenAlexWork[]) ?? []).map(mapOpenAlex).filter((x) => x.title);
}

// ---------------------------------------------------------------- Semantic Scholar

interface S2Paper {
  title?: string;
  year?: number | null;
  publicationDate?: string | null;
  venue?: string | null;
  authors?: { name?: string }[];
  externalIds?: { DOI?: string; ArXiv?: string } | null;
  url?: string;
  openAccessPdf?: { url?: string | null } | null;
  citationCount?: number;
  abstract?: string | null;
  tldr?: { text?: string } | null;
}

export function mapS2(p: S2Paper): Paper {
  const doi = normDoi(p.externalIds?.DOI);
  return {
    title: clean(p.title),
    authors: authorList((p.authors ?? []).map((a) => a.name ?? '').filter(Boolean)),
    year: p.year ?? null,
    date: p.publicationDate ?? null,
    venue: clean(p.venue) || null,
    doi,
    arxiv_id: normArxiv(p.externalIds?.ArXiv),
    url: p.url ?? (doi ? `https://doi.org/${doi}` : null),
    pdf_url: p.openAccessPdf?.url || null,
    citations: p.citationCount ?? null,
    abstract: cut(clean(p.abstract) || clean(p.tldr?.text) || null),
    sources: ['semantic_scholar'],
  };
}

async function searchS2(q: string, o: PaperSearchOptions): Promise<Paper[]> {
  const p = new URLSearchParams({
    query: q,
    limit: String(Math.min(o.max * 2, 50)),
    fields:
      'title,year,publicationDate,venue,authors,externalIds,url,openAccessPdf,citationCount,abstract',
  });
  if (o.yearFrom || o.yearTo) p.set('year', `${o.yearFrom ?? ''}-${o.yearTo ?? ''}`);
  const headers: Record<string, string> = o.semanticScholarKey
    ? { 'x-api-key': o.semanticScholarKey }
    : {};
  const json = await getJson(
    `https://api.semanticscholar.org/graph/v1/paper/search?${p}`,
    o,
    headers,
  );
  return ((json.data as S2Paper[]) ?? []).map(mapS2).filter((x) => x.title);
}

// ---------------------------------------------------------------- Crossref

interface CrossrefItem {
  DOI?: string;
  title?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  issued?: { 'date-parts'?: number[][] };
  'container-title'?: string[];
  'is-referenced-by-count'?: number;
  abstract?: string;
  URL?: string;
  type?: string;
  link?: { URL?: string; 'content-type'?: string }[];
}

export function mapCrossref(it: CrossrefItem): Paper {
  const parts = it.issued?.['date-parts']?.[0] ?? [];
  const doi = normDoi(it.DOI);
  return {
    title: clean(it.title?.[0]),
    authors: authorList(
      (it.author ?? [])
        .map((a) => a.name ?? [a.given, a.family].filter(Boolean).join(' '))
        .filter(Boolean),
    ),
    year: parts[0] ?? null,
    date: parts.length ? parts.map((n) => String(n).padStart(2, '0')).join('-') : null,
    venue: clean(it['container-title']?.[0]) || null,
    doi,
    arxiv_id: null,
    url: doi ? `https://doi.org/${doi}` : (it.URL ?? null),
    pdf_url: it.link?.find((l) => l['content-type'] === 'application/pdf')?.URL ?? null,
    citations: it['is-referenced-by-count'] ?? null,
    abstract: cut(clean(it.abstract) || null),
    sources: ['crossref'],
  };
}

async function searchCrossref(q: string, o: PaperSearchOptions): Promise<Paper[]> {
  const filters: string[] = [];
  if (o.yearFrom) filters.push(`from-pub-date:${o.yearFrom}`);
  if (o.yearTo) filters.push(`until-pub-date:${o.yearTo}`);
  const p = new URLSearchParams({
    'query.bibliographic': q,
    rows: String(Math.min(o.max * 2, 40)),
    select: 'DOI,title,author,issued,container-title,is-referenced-by-count,abstract,URL,type,link',
  });
  if (filters.length) p.set('filter', filters.join(','));
  if (o.sort === 'citations') p.set('sort', 'is-referenced-by-count');
  if (o.sort === 'recent') p.set('sort', 'published');
  if (o.mailto) p.set('mailto', o.mailto);
  const json = await getJson(`https://api.crossref.org/works?${p}`, o);
  const items = ((json.message as { items?: CrossrefItem[] })?.items ?? []).filter(
    (it) => it.type !== 'component' && it.type !== 'peer-review',
  );
  return items.map(mapCrossref).filter((x) => x.title);
}

// ---------------------------------------------------------------- arXiv

const tag = (xml: string, name: string) =>
  decodeEntities(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'u').exec(xml)?.[1] ?? '')
    .replace(/\s+/gu, ' ')
    .trim();

export interface ArxivEntry {
  title: string;
  arxiv_id: string;
  url: string;
  pdf_url: string | null;
  published: string;
  updated: string;
  authors: string[];
  summary: string;
  doi: string | null;
  primary_category: string | null;
}

export function parseArxivAtom(xml: string): ArxivEntry[] {
  const out: ArxivEntry[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gu)) {
    const e = m[1]!;
    const idUrl = tag(e, 'id');
    if (!idUrl) continue;
    const summary = tag(e, 'summary');
    const authors = [
      ...e.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gu),
    ].map((a) => decodeEntities(a[1]!).replace(/\s+/gu, ' ').trim());
    const pdf =
      /<link[^>]*title="pdf"[^>]*href="([^"]+)"/u.exec(e)?.[1] ??
      /<link[^>]*href="([^"]+)"[^>]*title="pdf"/u.exec(e)?.[1];
    out.push({
      title: tag(e, 'title'),
      arxiv_id: idUrl.replace(/^https?:\/\/arxiv\.org\/abs\//u, ''),
      url: idUrl.replace(/^http:/u, 'https:'),
      pdf_url: pdf ? pdf.replace(/^http:/u, 'https:') : null,
      published: tag(e, 'published'),
      updated: tag(e, 'updated'),
      authors: authorList(authors),
      summary: summary.length > 600 ? `${summary.slice(0, 600)}…` : summary,
      doi: tag(e, 'arxiv:doi') || null,
      primary_category: /<arxiv:primary_category[^>]*term="([^"]+)"/u.exec(e)?.[1] ?? null,
    });
  }
  return out;
}

/** 自由文本 → arXiv search_query：用户已写字段前缀（ti: au: abs:…）或布尔运算时原样使用 */
export function arxivQuery(q: string): string {
  const s = q.trim();
  if (/\b(ti|au|abs|co|jr|cat|rn|id|all):|\b(AND|OR|ANDNOT)\b/u.test(s)) return s;
  const terms = s.match(/"[^"]+"|\S+/gu) ?? [];
  return terms.map((t) => `all:${t}`).join(' AND ');
}

// arXiv 要求同一来源的请求间隔约 3 秒，并发调用会被 429/503：全进程串行排队
const ARXIV_GAP_MS = 3_000;
let arxivChain: Promise<unknown> = Promise.resolve();
let arxivLast = 0;
function arxivSlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = arxivChain.then(async () => {
    const wait = arxivLast + ARXIV_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      arxivLast = Date.now();
    }
  });
  arxivChain = run.catch(() => undefined);
  return run;
}

async function searchArxiv(q: string, o: PaperSearchOptions): Promise<Paper[]> {
  const p = new URLSearchParams({
    search_query: arxivQuery(q),
    start: '0',
    max_results: String(Math.min(o.max * 2, 40)),
    sortBy: o.sort === 'recent' ? 'submittedDate' : 'relevance',
    sortOrder: 'descending',
  });
  const url = `https://export.arxiv.org/api/query?${p}`;
  const call = () =>
    arxivSlot(() =>
      fetchApi(url, {
        timeoutMs: 15_000,
        headers: { 'user-agent': UA(o.mailto), accept: 'application/atom+xml' },
      }),
    );
  let res = await call();
  if (res.status === 429 || res.status === 503) {
    await sleep(3_000);
    res = await call();
  }
  const { status, text } = res;
  if (status === 429 || status === 503) throw new NetError('arXiv 被限流，稍后再试', 'network');
  if (status !== 200) throw new NetError(`HTTP ${status}`, 'network');
  return parseArxivAtom(text)
    .map<Paper>((e) => ({
      title: e.title,
      authors: e.authors,
      year: Number(e.published.slice(0, 4)) || null,
      date: e.published.slice(0, 10) || null,
      venue: e.primary_category ? `arXiv (${e.primary_category})` : 'arXiv',
      doi: normDoi(e.doi),
      arxiv_id: normArxiv(e.arxiv_id),
      url: e.url,
      pdf_url: e.pdf_url,
      citations: null,
      abstract: e.summary || null,
      sources: ['arxiv'],
    }))
    .filter((x) => {
      if (!x.year) return true;
      if (o.yearFrom && x.year < o.yearFrom) return false;
      if (o.yearTo && x.year > o.yearTo) return false;
      return true;
    });
}

// ---------------------------------------------------------------- 合并

const SEARCHERS: Record<PaperSource, (q: string, o: PaperSearchOptions) => Promise<Paper[]>> = {
  openalex: searchOpenAlex,
  semantic_scholar: searchS2,
  crossref: searchCrossref,
  arxiv: searchArxiv,
};

function mergeInto(a: Paper, b: Paper): Paper {
  const pick = <T>(x: T | null, y: T | null) => (x === null || x === '' ? y : x);
  return {
    title: a.title.length >= b.title.length * 0.6 ? a.title : b.title,
    authors: a.authors.length >= b.authors.length ? a.authors : b.authors,
    year: pick(a.year, b.year),
    date: pick(a.date, b.date),
    venue: a.venue && !/^arXiv/u.test(a.venue) ? a.venue : pick(b.venue, a.venue),
    doi: pick(a.doi, b.doi),
    arxiv_id: pick(a.arxiv_id, b.arxiv_id),
    url: pick(a.url, b.url),
    pdf_url: pick(a.pdf_url, b.pdf_url),
    citations:
      Math.max(a.citations ?? -1, b.citations ?? -1) >= 0
        ? Math.max(a.citations ?? 0, b.citations ?? 0)
        : null,
    abstract: (a.abstract?.length ?? 0) >= (b.abstract?.length ?? 0) ? a.abstract : b.abstract,
    sources: [...new Set([...a.sources, ...b.sources])],
  };
}

/** 多源结果去重合并 + RRF 排序（纯函数，便于测试） */
export function mergeRanked(
  lists: Paper[][],
  max: number,
  sort: PaperSearchOptions['sort'] = 'relevance',
): Paper[] {
  const merged: { paper: Paper; score: number; keys: Set<string> }[] = [];
  const index = new Map<string, number>();
  const keysOf = (p: Paper) =>
    [
      p.doi ? `doi:${p.doi}` : null,
      p.arxiv_id ? `arxiv:${p.arxiv_id}` : null,
      p.title ? `t:${normTitle(p.title)}` : null,
    ].filter((k): k is string => Boolean(k) && k!.length > 6);
  for (const list of lists) {
    list.forEach((p, rank) => {
      const keys = keysOf(p);
      const hit = keys.map((k) => index.get(k)).find((i) => i !== undefined);
      const rrf = 1 / (10 + rank);
      if (hit !== undefined) {
        const m = merged[hit]!;
        m.paper = mergeInto(m.paper, p);
        m.score += rrf;
        for (const k of keysOf(m.paper)) {
          m.keys.add(k);
          index.set(k, hit);
        }
      } else {
        const i = merged.length;
        merged.push({ paper: p, score: rrf, keys: new Set(keys) });
        for (const k of keys) index.set(k, i);
      }
    });
  }
  const scored = merged.map((m) => ({
    ...m,
    score: m.score + 0.01 * Math.log10(1 + (m.paper.citations ?? 0)),
  }));
  if (sort === 'citations')
    scored.sort((a, b) => (b.paper.citations ?? 0) - (a.paper.citations ?? 0));
  else if (sort === 'recent')
    scored.sort((a, b) =>
      (b.paper.date ?? `${b.paper.year ?? ''}`).localeCompare(
        a.paper.date ?? `${a.paper.year ?? ''}`,
      ),
    );
  else scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((m) => m.paper);
}

export async function paperSearch(
  q: string,
  o: PaperSearchOptions,
): Promise<{ results: Paper[]; status: Record<string, string> }> {
  const settled = await Promise.allSettled(o.sources.map((s) => SEARCHERS[s](q, o)));
  const status: Record<string, string> = {};
  const lists: Paper[][] = [];
  settled.forEach((r, i) => {
    const name = o.sources[i]!;
    if (r.status === 'fulfilled') {
      status[name] = `ok（${r.value.length}）`;
      lists.push(r.value);
    } else {
      status[name] = `失败：${(r.reason as Error).message}`;
    }
  });
  if (lists.length === 0) {
    throw new NetError(
      `所有学术源都失败了：${Object.entries(status)
        .map(([k, v]) => `${k} ${v}`)
        .join('；')}`,
      'network',
    );
  }
  return { results: mergeRanked(lists, o.max, o.sort), status };
}
