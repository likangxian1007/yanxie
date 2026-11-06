/**
 * 联网搜索冒烟测试（真联网，不进 CI）：
 *   pnpm --filter @srh/server exec tsx scripts/websearch-smoke.ts "查询词"
 * 可用 SEARXNG_URL 指定 SearXNG；不设则走 DuckDuckGo 回退。
 */
import { generalSearch } from '../src/websearch/general';
import { paperSearch, PAPER_SOURCES } from '../src/websearch/scholarly';
import { fetchPublic, readCapped } from '../src/websearch/net';
import { extractHtml, extractPdf } from '../src/websearch/extract';
import { decodeBody } from '../src/websearch/text';

const q = process.argv[2] ?? 'graph contrastive learning';
const searxngUrl = process.env.SEARXNG_URL ?? '';

async function main() {
  console.log('== web', q, searxngUrl ? `(searxng ${searxngUrl})` : '(duckduckgo)');
  try {
    const r = await generalSearch(q, { searxngUrl, fallback: 'duckduckgo', max: 5 });
    console.log(r.provider, r.results.map((x) => `${x.title} | ${x.url}`).join('\n'));
  } catch (e) {
    console.log('web failed:', (e as Error).message);
  }
  console.log('== papers');
  const p = await paperSearch(q, {
    max: 5,
    sources: PAPER_SOURCES,
    sort: 'relevance',
    mailto: '',
    semanticScholarKey: '',
  });
  console.log(p.status);
  for (const x of p.results)
    console.log(
      `${x.year} ${x.title} | doi=${x.doi} arxiv=${x.arxiv_id} cites=${x.citations} [${x.sources}]`,
    );
  for (const u of process.argv.slice(3)) {
    console.log('== fetch', u);
    const { res, url } = await fetchPublic(u);
    const type = res.headers.get('content-type') ?? '';
    const { bytes } = await readCapped(res, 25 * 1024 * 1024);
    const doc = type.includes('pdf')
      ? await extractPdf(bytes)
      : extractHtml(decodeBody(bytes, type), url.href);
    console.log(doc.mode, doc.title, doc.published, doc.text.length);
    console.log(doc.text.slice(0, 1200));
  }
}

void main();
