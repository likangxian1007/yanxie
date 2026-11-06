/**
 * 文献引用标记：模型回答与 agent 工具都用 `[p.5 ¶3]`（单篇问答）或
 * `[vaswani2017attention, p.5 ¶3]` / `(vaswani2017attention, p.5 ¶3)`（跨论文）。
 * 前端把它渲染成可点的引用 chip，点击跳到 PDF 对应页并高亮段落。
 */
export interface CitationMarker {
  /** 在原文里的起止下标 */
  start: number;
  end: number;
  raw: string;
  citekey: string | null;
  page: number;
  para: number | null;
}

const MARKER =
  /[[(（]\s*(?:([A-Za-z][\w:.-]*?)\s*[,，;；]?\s*)?(?:p\.?|pp\.?|页|第)\s*(\d{1,4})\s*页?\s*(?:[,，]?\s*(?:¶|para\.?|段|第)\s*(\d{1,3})\s*段?)?\s*[\])）]/gu;

/** 找出一段文字里的全部引用标记 */
export function parseCitationMarkers(text: string): CitationMarker[] {
  const out: CitationMarker[] = [];
  for (const m of text.matchAll(MARKER)) {
    const key = m[1] && !/^(p|pp)$/iu.test(m[1]) ? m[1] : null;
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      citekey: key,
      page: Number(m[2]),
      para: m[3] ? Number(m[3]) : null,
    });
  }
  return out;
}

/** 把一段文字切成普通文字与引用标记交替的片段（渲染用） */
export function splitByCitations(
  text: string,
): ({ kind: 'text'; text: string } | { kind: 'cite'; marker: CitationMarker })[] {
  const parts: ({ kind: 'text'; text: string } | { kind: 'cite'; marker: CitationMarker })[] = [];
  let last = 0;
  for (const marker of parseCitationMarkers(text)) {
    if (marker.start > last) parts.push({ kind: 'text', text: text.slice(last, marker.start) });
    parts.push({ kind: 'cite', marker });
    last = marker.end;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

/** 引用标记的规范写法 */
export function formatCitation(page: number, para: number | null, citekey?: string | null) {
  const loc = para ? `p.${page} ¶${para}` : `p.${page}`;
  return citekey ? `[${citekey}, ${loc}]` : `[${loc}]`;
}
