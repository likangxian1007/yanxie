import { decodeEntities } from './text';
import { BROWSER_UA, fetchApi, fetchPublic, readCapped, NetError } from './net';

/**
 * 通用网页搜索。首选自托管 SearXNG（聚合 Google / Bing / DuckDuckGo / Brave / Wikipedia 等，JSON 接口）；
 * SearXNG 没配置或挂了时退回 DuckDuckGo HTML 版（无需 key，服务器 IP 偶尔会被要求验证）。
 */

export type TimeRange = 'day' | 'week' | 'month' | 'year';

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
  published: string | null;
  engines: string[];
}

export interface WebSearchResponse {
  provider: 'searxng' | 'duckduckgo';
  results: WebResult[];
  answers: string[];
  suggestions: string[];
  /** 没有返回结果的上游引擎（被限流、超时等），给模型判断结果是否完整 */
  unresponsive: string[];
}

export interface GeneralSearchOptions {
  searxngUrl: string;
  fallback: 'duckduckgo' | 'none';
  max: number;
  timeRange?: TimeRange;
  language?: string;
  /** SearXNG 分类：general / news / science / it */
  category?: 'general' | 'news' | 'science' | 'it';
}

const clean = (s: unknown) =>
  typeof s === 'string' ? decodeEntities(s).replace(/\s+/gu, ' ').trim() : '';

interface SearxngJson {
  results?: {
    title?: string;
    url?: string;
    content?: string;
    engine?: string;
    engines?: string[];
    publishedDate?: string | null;
    score?: number;
  }[];
  answers?: (string | { answer?: string })[];
  suggestions?: string[];
  unresponsive_engines?: [string, string][];
}

export function parseSearxng(json: SearxngJson, max: number): Omit<WebSearchResponse, 'provider'> {
  const seen = new Set<string>();
  const results: WebResult[] = [];
  for (const r of json.results ?? []) {
    if (!r.url || !/^https?:\/\//u.test(r.url)) continue;
    const key = r.url.replace(/[#?].*$/u, '').replace(/\/$/u, '');
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      title: clean(r.title) || r.url,
      url: r.url,
      snippet: clean(r.content).slice(0, 400),
      published: r.publishedDate ? String(r.publishedDate).slice(0, 10) : null,
      engines: r.engines ?? (r.engine ? [r.engine] : []),
    });
    if (results.length >= max) break;
  }
  return {
    results,
    answers: (json.answers ?? [])
      .map((a) => (typeof a === 'string' ? a : (a.answer ?? '')))
      .map(clean)
      .filter(Boolean)
      .slice(0, 3),
    suggestions: (json.suggestions ?? []).slice(0, 5),
    unresponsive: (json.unresponsive_engines ?? []).map(([name, why]) => `${name}（${why}）`),
  };
}

async function searchSearxng(q: string, o: GeneralSearchOptions): Promise<WebSearchResponse> {
  const params = new URLSearchParams({
    q,
    format: 'json',
    categories: o.category ?? 'general',
    safesearch: '0',
    pageno: '1',
  });
  if (o.timeRange) params.set('time_range', o.timeRange);
  if (o.language && o.language !== 'auto') params.set('language', o.language);
  const base = o.searxngUrl.replace(/\/$/u, '');
  const { status, text } = await fetchApi(`${base}/search?${params}`, { timeoutMs: 12_000 });
  if (status !== 200) throw new NetError(`SearXNG 返回 HTTP ${status}`, 'network');
  let json: SearxngJson;
  try {
    json = JSON.parse(text) as SearxngJson;
  } catch {
    throw new NetError(
      'SearXNG 没有返回 JSON（settings.yml 的 search.formats 需要包含 json）',
      'network',
    );
  }
  return { provider: 'searxng', ...parseSearxng(json, o.max) };
}

/** DuckDuckGo HTML 版结果页 → 结果列表 */
export function parseDuckDuckGoHtml(html: string, max: number): WebResult[] {
  const out: WebResult[] = [];
  // 按结果块切开，保留每块的 class 以便跳过广告
  const parts = html.split(/<div[^>]+class="([^"]*\bresult\b[^"]*)"/u);
  const blocks: { cls: string; body: string }[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2)
    blocks.push({ cls: parts[i]!, body: parts[i + 1]! });
  for (const { cls, body: b } of blocks) {
    if (/result--ad\b/u.test(cls)) continue;
    const a = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/u.exec(b);
    if (!a) continue;
    let href = decodeEntities(a[1]!);
    const uddg = /[?&]uddg=([^&]+)/u.exec(href);
    if (uddg) href = decodeURIComponent(uddg[1]!);
    if (href.startsWith('//')) href = `https:${href}`;
    if (!/^https?:\/\//u.test(href) || /duckduckgo\.com\/y\.js/u.test(href)) continue;
    const snip = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/u.exec(b)?.[1] ?? '';
    out.push({
      title: clean(a[2]!.replace(/<[^>]+>/gu, '')),
      url: href,
      snippet: clean(snip.replace(/<[^>]+>/gu, '')).slice(0, 400),
      published: null,
      engines: ['duckduckgo'],
    });
    if (out.length >= max) break;
  }
  return out;
}

const DDG_TIME: Record<TimeRange, string> = { day: 'd', week: 'w', month: 'm', year: 'y' };

async function searchDuckDuckGo(q: string, o: GeneralSearchOptions): Promise<WebSearchResponse> {
  const form = new URLSearchParams({ q, kl: o.language?.startsWith('zh') ? 'cn-zh' : 'wt-wt' });
  if (o.timeRange) form.set('df', DDG_TIME[o.timeRange]);
  const { res } = await fetchPublic('https://html.duckduckgo.com/html/', {
    method: 'POST',
    body: form.toString(),
    timeoutMs: 12_000,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': BROWSER_UA },
  });
  const { bytes } = await readCapped(res, 2 * 1024 * 1024);
  const html = new TextDecoder('utf-8').decode(bytes);
  if (res.status !== 200 || /anomaly-modal|captcha/iu.test(html)) {
    throw new NetError(
      `DuckDuckGo 拒绝了这次查询（HTTP ${res.status}，可能要求人机验证）`,
      'network',
    );
  }
  return {
    provider: 'duckduckgo',
    results: parseDuckDuckGoHtml(html, o.max),
    answers: [],
    suggestions: [],
    unresponsive: [],
  };
}

/** 通用搜索：SearXNG → DuckDuckGo。两者都失败时抛出包含双方原因的错误 */
export async function generalSearch(
  q: string,
  o: GeneralSearchOptions,
): Promise<WebSearchResponse> {
  const errors: string[] = [];
  if (o.searxngUrl) {
    try {
      const r = await searchSearxng(q, o);
      if (r.results.length > 0 || o.fallback === 'none') return r;
      errors.push(
        `SearXNG 没有结果${r.unresponsive.length ? `（无响应：${r.unresponsive.join('、')}）` : ''}`,
      );
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  if (o.fallback === 'duckduckgo') {
    try {
      return await searchDuckDuckGo(q, o);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  if (errors.length === 0) errors.push('没有配置搜索后端（SEARXNG_URL 为空且关闭了回退）');
  throw new NetError(`网页搜索失败：${errors.join('；')}`, 'network');
}
