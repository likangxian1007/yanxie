/** 文本小工具：HTML 实体、字符集、简单的 HTML → 纯文本（正文抽取失败时的兜底） */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  times: '×',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** 按 Content-Type 或 <meta charset> 解码 */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
  let charset = /charset=["']?([\w-]+)/iu.exec(contentType)?.[1];
  if (!charset) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
    charset = /<meta[^>]+charset=["']?([\w-]+)/iu.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** HTML → 纯文本：去掉脚本 / 样式 / 注释与标签，块级元素换行，压缩空白 */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1] ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
  let s = html
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(
      /<\/(p|div|section|article|li|ul|ol|tr|table|h[1-6]|blockquote|pre|header|footer|figure|figcaption|dd|dt)\s*>/giu,
      '\n',
    )
    .replace(/<(h[1-6]|li|tr)\b[^>]*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ');
  s = decodeEntities(s);
  return { title, text: tidy(s) };
}

/** 逐行压缩空白，最多保留一个空行 */
export function tidy(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v\u00a0]+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}
