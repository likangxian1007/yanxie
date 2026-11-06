import { afterEach, describe, expect, it, vi } from 'vitest';
import { domToText, extractHtml } from '../src/websearch/extract';
import { parseDuckDuckGoHtml, parseSearxng } from '../src/websearch/general';
import { assertPublicUrl, isBlockedAddress } from '../src/websearch/net';
import {
  arxivQuery,
  invertedToText,
  mapCrossref,
  mapOpenAlex,
  mapS2,
  mergeRanked,
  normArxiv,
  normDoi,
  type Paper,
} from '../src/websearch/scholarly';
import { clearWebCache, webEnabled, webTools } from '../src/agents/tools/web';
import { ToolError, type ToolContext } from '../src/agents/tools/types';
import { parseHTML } from 'linkedom';

describe('address guard', () => {
  it('blocks documentation, private and mapped ranges', () => {
    for (const ip of ['192.0.2.1', '198.51.100.7', '203.0.113.9', '2001:db8::1', '::ffff:10.0.0.1'])
      expect(isBlockedAddress(ip), ip).toBe(true);
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
  });

  it('rejects localhost-like names, credentials and non-http schemes before DNS', async () => {
    for (const u of [
      'http://localhost/',
      'http://foo.localhost/',
      'http://printer.local/',
      'http://metadata.google.internal/',
      'http://user:pw@example.com/',
      'gopher://example.com/',
    ]) {
      await expect(assertPublicUrl(u), u).rejects.toThrow(/拒绝|只能|不能带/u);
    }
  });
});

describe('general search parsers', () => {
  it('parses SearXNG JSON, dedupes and reports unresponsive engines', () => {
    const r = parseSearxng(
      {
        results: [
          {
            title: 'IJCAI 2027 &amp; CFP',
            url: 'https://2027.ijcai.org/cfp/',
            content: 'Abstract deadline  Jan 11',
            engines: ['brave', 'duckduckgo'],
            publishedDate: '2026-09-01T00:00:00',
          },
          { title: 'dup', url: 'https://2027.ijcai.org/cfp#x', content: '' },
          { title: 'bad', url: 'javascript:alert(1)' },
          { title: 'Other', url: 'https://example.org/a', engine: 'bing' },
        ],
        answers: ['42'],
        unresponsive_engines: [['google', 'Suspended: access denied']],
      },
      10,
    );
    expect(r.results.map((x) => x.url)).toEqual([
      'https://2027.ijcai.org/cfp/',
      'https://example.org/a',
    ]);
    expect(r.results[0]).toMatchObject({
      title: 'IJCAI 2027 & CFP',
      snippet: 'Abstract deadline Jan 11',
      published: '2026-09-01',
      engines: ['brave', 'duckduckgo'],
    });
    expect(r.results[1]!.engines).toEqual(['bing']);
    expect(r.answers).toEqual(['42']);
    expect(r.unresponsive[0]).toContain('google');
  });

  it('parses DuckDuckGo HTML and unwraps redirect links, skipping ads', () => {
    const html = `
      <div class="result results_links result--ad"><a class="result__a" href="https://ad.example/">Ad</a></div>
      <div class="result results_links"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fopenalex.org%2Fworks&amp;rut=1">OpenAlex <b>Works</b></a></h2>
      <a class="result__snippet" href="#">The <b>open</b> catalog</a></div>`;
    const r = parseDuckDuckGoHtml(html, 5);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      title: 'OpenAlex Works',
      url: 'https://openalex.org/works',
      snippet: 'The open catalog',
    });
  });
});

describe('scholarly', () => {
  it('normalises DOI and arXiv ids', () => {
    expect(normDoi('https://doi.org/10.1145/3442381.3449802.')).toBe('10.1145/3442381.3449802');
    expect(normDoi('nope')).toBeNull();
    expect(normArxiv('https://arxiv.org/abs/2010.13902v3')).toBe('2010.13902');
    expect(normArxiv('arXiv:hep-th/9901001')).toBe('hep-th/9901001');
    expect(arxivQuery('graph "contrastive learning"')).toBe(
      'all:graph AND all:"contrastive learning"',
    );
    expect(arxivQuery('ti:GraphCL AND au:You')).toBe('ti:GraphCL AND au:You');
  });

  it('rebuilds OpenAlex inverted abstracts and maps works', () => {
    expect(invertedToText({ learning: [1], Graph: [0], works: [2] })).toBe('Graph learning works');
    const p = mapOpenAlex({
      title: 'Graph Contrastive Learning with Augmentations',
      doi: 'https://doi.org/10.48550/arxiv.2010.13902',
      publication_year: 2020,
      authorships: [{ author: { display_name: 'Yuning You' } }],
      locations: [{ landing_page_url: 'https://arxiv.org/abs/2010.13902' }],
      cited_by_count: 1297,
      abstract_inverted_index: { Hello: [0] },
    });
    expect(p).toMatchObject({
      doi: '10.48550/arxiv.2010.13902',
      arxiv_id: '2010.13902',
      year: 2020,
      citations: 1297,
      abstract: 'Hello',
      url: 'https://doi.org/10.48550/arxiv.2010.13902',
    });
  });

  it('maps Semantic Scholar and Crossref records', () => {
    const s = mapS2({
      title: 'GraphCL',
      year: 2020,
      externalIds: { DOI: '10.5555/ABC', ArXiv: '2010.13902' },
      openAccessPdf: { url: 'https://arxiv.org/pdf/2010.13902' },
      citationCount: 10,
      authors: [{ name: 'A' }],
    });
    expect(s).toMatchObject({
      doi: '10.5555/abc',
      arxiv_id: '2010.13902',
      pdf_url: 'https://arxiv.org/pdf/2010.13902',
    });
    const c = mapCrossref({
      DOI: '10.1145/3442381.3449802',
      title: ['Graph Contrastive Learning with Adaptive Augmentation'],
      author: [{ given: 'Yanqiao', family: 'Zhu' }],
      issued: { 'date-parts': [[2021, 4, 19]] },
      'container-title': ['WWW'],
      'is-referenced-by-count': 900,
      abstract: '<jats:p>We propose</jats:p>',
    });
    expect(c).toMatchObject({
      authors: ['Yanqiao Zhu'],
      year: 2021,
      date: '2021-04-19',
      venue: 'WWW',
      abstract: 'We propose',
    });
  });

  it('merges duplicates across sources by DOI / arXiv id / title and ranks by RRF', () => {
    const base = (over: Partial<Paper>): Paper => ({
      title: 'X',
      authors: [],
      year: null,
      date: null,
      venue: null,
      doi: null,
      arxiv_id: null,
      url: null,
      pdf_url: null,
      citations: null,
      abstract: null,
      sources: [],
      ...over,
    });
    const openalex = [
      base({ title: 'GraphCL', doi: '10.1/a', citations: 100, sources: ['openalex'] }),
      base({ title: 'Other paper', doi: '10.1/b', sources: ['openalex'] }),
    ];
    const arxiv = [
      base({
        title: 'GraphCL',
        arxiv_id: '2010.13902',
        pdf_url: 'https://arxiv.org/pdf/2010.13902',
        sources: ['arxiv'],
      }),
    ];
    const s2 = [
      base({
        title: 'GraphCL',
        doi: '10.1/a',
        arxiv_id: '2010.13902',
        citations: 120,
        sources: ['semantic_scholar'],
      }),
      base({ title: 'Third One', doi: '10.1/c', sources: ['semantic_scholar'] }),
    ];
    const merged = mergeRanked([openalex, arxiv, s2], 10);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({
      title: 'GraphCL',
      doi: '10.1/a',
      arxiv_id: '2010.13902',
      pdf_url: 'https://arxiv.org/pdf/2010.13902',
      citations: 120,
    });
    expect(merged[0]!.sources.sort()).toEqual(['arxiv', 'openalex', 'semantic_scholar']);
    expect(mergeRanked([openalex, s2], 10, 'citations')[0]!.citations).toBe(120);
  });
});

describe('main-text extraction', () => {
  const para = (n: number) =>
    `<p>This is paragraph ${n} of the article body. It talks about graph contrastive learning, augmentations, and benchmarks in enough detail to count as real content for the readability heuristics.</p>`;

  it('keeps the article and drops nav, scripts and footers', () => {
    const html = `<!doctype html><html lang="en"><head><title>GCL Survey | Blog</title>
      <meta property="article:published_time" content="2026-10-01T08:00:00Z"><script>var x=1</script></head>
      <body><nav><a href="/">Home</a><a href="/about">About</a></nav>
      <article><h1>GCL Survey</h1>${para(1)}${para(2)}<h2>Methods</h2>${para(3)}
      <ul><li>GraphCL</li><li>GRACE</li></ul>
      <table><tr><th>Model</th><th>Acc</th></tr><tr><td>GraphCL</td><td>75.1</td></tr></table>${para(4)}</article>
      <footer>Copyright 2026 cookie banner subscribe</footer></body></html>`;
    const doc = extractHtml(html, 'https://blog.example/gcl');
    expect(doc.mode).toBe('article');
    expect(doc.published).toBe('2026-10-01T08:00:00Z');
    expect(doc.text).toContain('paragraph 1');
    expect(doc.text).toContain('## Methods');
    expect(doc.text).toContain('- GraphCL');
    expect(doc.text).toContain('| GraphCL | 75.1 |');
    expect(doc.text).not.toContain('var x');
    expect(doc.text).not.toContain('cookie banner');
  });

  it('falls back to whole-page text for short pages', () => {
    const doc = extractHtml(
      '<html><head><title>T</title></head><body><p>short</p></body></html>',
      'https://x.example/',
    );
    expect(doc.mode).toBe('page');
    expect(doc.title).toBe('T');
    expect(doc.text).toContain('short');
  });

  it('domToText renders ordered lists, quotes and code', () => {
    const { document } = parseHTML(
      '<html><body><ol><li>one</li><li>two</li></ol><blockquote>quoted</blockquote><pre>a = 1</pre></body></html>',
    );
    const t = domToText(document.body as never);
    expect(t).toContain('1. one');
    expect(t).toContain('2. two');
    expect(t).toContain('> quoted');
    expect(t).toContain('```\na = 1\n```');
  });
});

describe('web tools', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearWebCache();
  });

  it('are enabled by AGENT_WEB or the legacy AGENT_FETCH_URL', () => {
    expect(webEnabled({ config: { AGENT_WEB: true, AGENT_FETCH_URL: false } })).toBe(true);
    expect(webEnabled({ config: { AGENT_WEB: false, AGENT_FETCH_URL: true } })).toBe(true);
    expect(webEnabled({ config: { AGENT_WEB: false, AGENT_FETCH_URL: false } })).toBe(false);
    expect(webTools.map((t) => t.name).sort()).toEqual(['fetch_url', 'paper_search', 'web_search']);
  });

  it('web_search reports a clear error when no backend is configured', async () => {
    const tool = webTools.find((t) => t.name === 'web_search')!;
    const tc = {
      ctx: { config: { SEARXNG_URL: '', WEB_SEARCH_FALLBACK: 'none' } },
    } as unknown as ToolContext;
    await expect(tool.run(tc, tool.schema.parse({ query: 'x' }))).rejects.toBeInstanceOf(ToolError);
    await expect(tool.run(tc, tool.schema.parse({ query: 'x' }))).rejects.toThrow(
      /没有配置搜索后端/u,
    );
  });

  it('fetch_url refuses private targets with a ToolError', async () => {
    const tool = webTools.find((t) => t.name === 'fetch_url')!;
    const tc = {} as ToolContext;
    await expect(tool.run(tc, tool.schema.parse({ url: 'http://10.0.0.5/' }))).rejects.toThrow(
      /拒绝/u,
    );
    await expect(tool.run(tc, tool.schema.parse({ url: 'http://[fd00::1]/' }))).rejects.toThrow(
      /拒绝/u,
    );
  });
});
