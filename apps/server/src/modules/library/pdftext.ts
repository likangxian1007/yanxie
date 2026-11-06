import type { PaperChunk, PaperStructure, PdfBox } from '@srh/shared';

/**
 * 降级解析（GROBID 不可达 / 解析失败时）：用 pdf.js（unpdf）逐页取文字和位置，
 * 按行、按栏、按行距拼成段落，每段带页码与包围框——检索、引用和高亮照常可用，
 * 只是没有章节、公式、图表和参考文献的结构。
 */

interface Item {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Line {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

export interface PdfTextResult {
  pages: { width: number; height: number }[];
  chunks: PaperChunk[];
  /** pdf 自带的元数据标题 */
  title: string | null;
}

const MAX_PAGES = 300;

export async function pdfToText(pdf: Buffer): Promise<PdfTextResult> {
  const { getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  try {
    const pages: { width: number; height: number }[] = [];
    const chunks: PaperChunk[] = [];
    const n = Math.min(doc.numPages, MAX_PAGES);
    for (let p = 1; p <= n; p += 1) {
      const page = await doc.getPage(p);
      const [x0, y0, x1, y1] = page.view as [number, number, number, number];
      const width = x1 - x0;
      const height = y1 - y0;
      pages.push({ width, height });
      const content = await page.getTextContent();
      const items: Item[] = [];
      for (const raw of content.items as unknown[]) {
        const it = raw as { str?: string; transform?: number[]; width?: number; height?: number };
        if (!it.str || !it.transform) continue;
        const [, , c, d, e, f] = it.transform as [number, number, number, number, number, number];
        const h = it.height || Math.hypot(c, d) || 8;
        items.push({ str: it.str, x: e - x0, y: y1 - f - h, w: it.width ?? 0, h });
      }
      const paras = paragraphs(lines(items), width);
      let para = 0;
      for (const ps of paras) {
        const text = ps
          .map((l) => l.text)
          .join(' ')
          .replace(/(\w)- (\w)/gu, '$1$2')
          .replace(/\s+/gu, ' ')
          .trim();
        if (text.length < 2) continue;
        para += 1;
        chunks.push({
          id: '',
          seq: chunks.length,
          kind: 'paragraph',
          sectionIndex: null,
          sectionPath: `第 ${p} 页`,
          page: p,
          para,
          boxes: ps.map((l): PdfBox => ({
            page: p,
            x: round(l.x),
            y: round(l.y),
            w: round(l.w),
            h: round(l.h),
          })),
          text,
        });
      }
      page.cleanup();
    }
    let title: string | null = null;
    try {
      const meta = await doc.getMetadata();
      const t = (meta.info as { Title?: string } | undefined)?.Title?.trim();
      if (t && t.length > 3 && !/^(untitled|microsoft word)/iu.test(t)) title = t;
    } catch {
      // 没有元数据
    }
    return { pages, chunks, title };
  } finally {
    // 不同 pdf.js 版本：文档代理上有 destroy 或只有 cleanup
    const d = doc as unknown as { destroy?: () => Promise<void>; cleanup?: () => Promise<void> };
    await (d.destroy ?? d.cleanup)?.call(doc).catch(() => undefined);
  }
}

const round = (v: number) => Math.round(v * 100) / 100;

/** 同一基线的文字合成一行；水平间隔过大时断开（两栏排版的左右栏不粘在一起） */
function lines(items: Item[]): Line[] {
  const sorted = items
    .filter((i) => i.str.trim() || i.w > 0)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const out: Line[] = [];
  let cur: (Line & { right: number }) | null = null;
  for (const it of sorted) {
    if (!it.str.trim()) continue;
    const sameLine = cur && Math.abs(it.y - cur.y) < Math.max(2, cur.h * 0.5);
    const gap = cur ? it.x - cur.right : 0;
    if (cur && sameLine && gap < Math.max(12, cur.h * 2.5) && gap > -cur.h) {
      cur.text += gap > cur.h * 0.15 ? ` ${it.str}` : it.str;
      cur.right = Math.max(cur.right, it.x + it.w);
      cur.w = cur.right - cur.x;
      cur.h = Math.max(cur.h, it.h);
    } else {
      if (cur) out.push(cur);
      cur = { x: it.x, y: it.y, w: it.w, h: it.h, text: it.str, right: it.x + it.w };
    }
  }
  if (cur) out.push(cur);
  return out.map(({ x, y, w, h, text }) => ({ x, y, w, h, text: text.trim() }));
}

/** 先分栏（左栏整列在右栏之前），再按行距与缩进切段 */
function paragraphs(ls: Line[], pageWidth: number): Line[][] {
  const mid = pageWidth / 2;
  const isLeft = (l: Line) => l.x + l.w <= mid + 10 && l.w < pageWidth * 0.55;
  const isRight = (l: Line) => l.x >= mid - 10 && l.w < pageWidth * 0.55;
  const twoCol = ls.filter(isLeft).length > 8 && ls.filter(isRight).length > 8;
  const ordered = twoCol
    ? [
        ...ls.filter((l) => !isLeft(l) && !isRight(l) && l.y < Math.min(...ls.map((x) => x.y)) + 1),
        ...ls.filter(isLeft),
        ...ls.filter(isRight),
        ...ls.filter(
          (l) => !isLeft(l) && !isRight(l) && l.y >= Math.min(...ls.map((x) => x.y)) + 1,
        ),
      ]
    : ls;
  const out: Line[][] = [];
  let cur: Line[] = [];
  for (const l of ordered) {
    const prev = cur[cur.length - 1];
    if (prev) {
      const gap = l.y - (prev.y + prev.h);
      const indent = l.x - cur[0]!.x;
      const newCol = l.y < prev.y - prev.h;
      if (gap > prev.h * 0.9 || newCol || (indent > prev.h * 0.8 && indent < prev.h * 4)) {
        out.push(cur);
        cur = [];
      }
    }
    cur.push(l);
  }
  if (cur.length) out.push(cur);
  return out;
}

const HEADING = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+([A-Z][^.!?]{1,80})$/u;
const NAMED =
  /^(Abstract|Introduction|Related Work|Conclusions?|References|Acknowledg(?:e)?ments?|Appendix)$/iu;

/**
 * 纯文本降级结果 → 结构：形如 “3.2 Attention” 的短段落当作小节标题，
 * 其后的段落挂到这个小节下（没有公式、图表、参考文献）。
 */
export function textStructure(r: PdfTextResult): PaperStructure {
  const sections: PaperStructure['sections'] = [];
  const chunks: PaperChunk[] = [];
  const stack: { level: number; label: string }[] = [];
  let current: number | null = null;
  const paraCount = new Map<number, number>();
  for (const c of r.chunks) {
    const m = HEADING.exec(c.text);
    if ((m || NAMED.test(c.text)) && c.text.length <= 90) {
      const n = m ? m[1]! : null;
      const title = m ? m[2]!.trim() : c.text;
      const level = n ? Math.min(6, n.split('.').length) : 1;
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, label: n ? `${n} ${title}` : title });
      sections.push({ n, title, level, page: c.page, boxes: c.boxes, firstChunk: null });
      current = sections.length - 1;
      continue;
    }
    const para = (paraCount.get(c.page) ?? 0) + 1;
    paraCount.set(c.page, para);
    const seq = chunks.length;
    if (current !== null && sections[current]!.firstChunk === null) {
      sections[current]!.firstChunk = seq;
    }
    chunks.push({
      ...c,
      seq,
      para,
      sectionIndex: current,
      sectionPath: stack.length ? stack.map((s) => s.label).join(' › ') : c.sectionPath,
    });
  }
  return {
    pages: r.pages,
    sections,
    chunks,
    formulas: [],
    figures: [],
    references: [],
    macros: {},
  };
}
