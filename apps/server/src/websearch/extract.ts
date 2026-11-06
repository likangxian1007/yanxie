import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { decodeEntities, htmlToText, tidy } from './text';

/**
 * 正文抽取：
 * - 网页：Mozilla Readability（Firefox 阅读模式同款）找出正文，再把正文 DOM 转成带标题层级、列表、表格的 Markdown 风格文本；
 *   Readability 认不出正文（目录页、搜索页）时退回整页纯文本。
 * - PDF：unpdf（pdf.js）逐页抽文本，带「第 N 页」标记，方便引用页码。
 */

export interface Extracted {
  title: string;
  byline: string | null;
  siteName: string | null;
  published: string | null;
  lang: string | null;
  /** 正文（Markdown 风格） */
  text: string;
  /** article = Readability 抽到了正文；page = 整页文本；pdf = PDF 文本 */
  mode: 'article' | 'page' | 'pdf';
  pages?: number;
}

type DomNode = {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
  getAttribute?: (n: string) => string | null;
};

const BLOCK = new Set([
  'P',
  'DIV',
  'SECTION',
  'ARTICLE',
  'MAIN',
  'HEADER',
  'FOOTER',
  'ASIDE',
  'FIGURE',
  'FIGCAPTION',
  'BLOCKQUOTE',
  'DL',
  'DD',
  'DT',
  'ADDRESS',
  'DETAILS',
  'SUMMARY',
]);

/** 正文 DOM → Markdown 风格文本（只保留结构，不保留链接地址，避免噪音） */
export function domToText(root: DomNode): string {
  const out: string[] = [];
  const walk = (node: DomNode, listDepth: number): string => {
    if (node.nodeType === 3) return (node.textContent ?? '').replace(/\s+/gu, ' ');
    if (node.nodeType !== 1) return '';
    const name = node.nodeName.toUpperCase();
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'BUTTON', 'FORM', 'NAV'].includes(name))
      return '';
    const kids = () =>
      Array.from(node.childNodes)
        .map((c) => walk(c, listDepth))
        .join('');
    if (/^H[1-6]$/u.test(name)) {
      const level = Number(name[1]);
      return `\n\n${'#'.repeat(level)} ${kids().trim()}\n\n`;
    }
    if (name === 'BR') return '\n';
    if (name === 'HR') return '\n\n---\n\n';
    if (name === 'PRE') return `\n\n\`\`\`\n${(node.textContent ?? '').trimEnd()}\n\`\`\`\n\n`;
    if (name === 'CODE') return `\`${(node.textContent ?? '').trim()}\``;
    if (name === 'IMG') {
      const alt = node.getAttribute?.('alt')?.trim();
      return alt ? `[图：${alt}]` : '';
    }
    if (name === 'UL' || name === 'OL') {
      let i = 0;
      const items = Array.from(node.childNodes)
        .filter((c) => c.nodeType === 1 && c.nodeName.toUpperCase() === 'LI')
        .map((li) => {
          i += 1;
          const body = Array.from(li.childNodes)
            .map((c) => walk(c, listDepth + 1))
            .join('')
            .trim()
            .replace(/\n{2,}/gu, '\n');
          const bullet = name === 'OL' ? `${i}.` : '-';
          return `${'  '.repeat(listDepth)}${bullet} ${body}`;
        });
      return `\n\n${items.join('\n')}\n\n`;
    }
    if (name === 'TABLE') {
      const rows: string[] = [];
      const collect = (n: DomNode) => {
        for (const c of Array.from(n.childNodes)) {
          if (c.nodeType !== 1) continue;
          const cn = c.nodeName.toUpperCase();
          if (cn === 'TR') {
            const cells = Array.from(c.childNodes)
              .filter((td) => td.nodeType === 1 && /^(TD|TH)$/u.test(td.nodeName.toUpperCase()))
              .map((td) => (td.textContent ?? '').replace(/\s+/gu, ' ').trim());
            if (cells.some(Boolean)) rows.push(`| ${cells.join(' | ')} |`);
          } else collect(c);
        }
      };
      collect(node);
      return rows.length ? `\n\n${rows.join('\n')}\n\n` : '';
    }
    if (name === 'BLOCKQUOTE') {
      const body = kids().trim().split('\n');
      return `\n\n${body.map((l) => `> ${l}`).join('\n')}\n\n`;
    }
    if (BLOCK.has(name) || name === 'LI') return `\n\n${kids()}\n\n`;
    return kids();
  };
  out.push(walk(root, 0));
  return tidy(decodeEntities(out.join('')));
}

function meta(doc: { querySelector: (s: string) => unknown }, ...selectors: string[]) {
  for (const s of selectors) {
    const el = doc.querySelector(s) as { getAttribute: (n: string) => string | null } | null;
    const v = el?.getAttribute('content')?.trim();
    if (v) return v;
  }
  return null;
}

export function extractHtml(html: string, url: string): Extracted {
  // 超大页面先砍掉脚本和样式，Readability 的耗时与 DOM 大小成正比
  const slim = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/giu, '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/giu, '');
  try {
    const { document } = parseHTML(slim);
    const published = meta(
      document,
      'meta[property="article:published_time"]',
      'meta[name="citation_publication_date"]',
      'meta[name="dc.date"]',
      'meta[name="date"]',
      'meta[itemprop="datePublished"]',
    );
    const siteName = meta(document, 'meta[property="og:site_name"]');
    const lang = document.documentElement?.getAttribute('lang') ?? null;
    // Readability 会改动 DOM，在一份拷贝上跑
    const { document: copy } = parseHTML(slim);
    try {
      Object.defineProperty(copy, 'baseURI', { value: url });
    } catch {
      /* linkedom 某些版本 baseURI 只读，不影响正文 */
    }
    type ReadabilityDoc = ConstructorParameters<typeof Readability>[0];
    const article = new Readability(copy as unknown as ReadabilityDoc, {
      charThreshold: 300,
    }).parse();
    if (article?.content && (article.textContent ?? '').trim().length >= 300) {
      const { document: body } = parseHTML(`<html><body>${article.content}</body></html>`);
      const text = domToText(body.body as unknown as DomNode);
      return {
        title: (article.title ?? '').trim() || htmlToText(html).title,
        byline: article.byline?.trim() || null,
        siteName: article.siteName?.trim() || siteName,
        published: article.publishedTime?.trim() || published,
        lang: article.lang ?? lang,
        text,
        mode: 'article',
      };
    }
    const fallback = domToText(document.body as unknown as DomNode);
    return {
      title: htmlToText(html).title,
      byline: null,
      siteName,
      published,
      lang,
      text: fallback,
      mode: 'page',
    };
  } catch {
    const { title, text } = htmlToText(html);
    return {
      title,
      byline: null,
      siteName: null,
      published: null,
      lang: null,
      text,
      mode: 'page',
    };
  }
}

export async function extractPdf(bytes: Uint8Array): Promise<Extracted> {
  const { extractText, getDocumentProxy, getMeta } = await import('unpdf');
  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  let title = '';
  try {
    const m = await getMeta(pdf);
    title = String((m.info as Record<string, unknown>)?.Title ?? '').trim();
  } catch {
    /* 没有元数据 */
  }
  const pages = (text as string[]).map(
    (p, i) =>
      `[第 ${i + 1} 页]\n${tidy(p.replace(/-\n(?=[a-z])/gu, '').replace(/[ \t]*\n[ \t]*/gu, '\n'))}`,
  );
  if (!title)
    title =
      (text as string[])[0]
        ?.split('\n')
        .find((l) => l.trim().length > 8)
        ?.trim() ?? '';
  return {
    title,
    byline: null,
    siteName: null,
    published: null,
    lang: null,
    text: pages.join('\n\n'),
    mode: 'pdf',
    pages: totalPages,
  };
}
