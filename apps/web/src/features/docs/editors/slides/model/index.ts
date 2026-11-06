import type * as Y from 'yjs';
import { planSlide, type PlannedElement, type PlannedSlide } from '@srh/shared';
import type { SlideDraft } from '../lib/markdown';
import {
  getDeckMeta,
  getSlidesArray,
  insertSlides,
  readDeckInfo,
  readSlide,
  readSlideRefs,
  type ElementInit,
  type NewSlide,
} from './deck';
import { pmToMarkdown } from './richtext';
import { DEFAULT_SIZE, isLayoutId } from './themes';
import type { DeckInfo, SlideModel } from './types';
import { tr } from '@/lib/i18n';

export * from './deck';
export type * from './types';

/** 共享规划（@srh/shared slides-collab.ts，与服务端写入同一套）的元素 → 新建元素参数 */
function plannedToInit(el: PlannedElement): ElementInit {
  const base = { name: el.name, x: el.x, y: el.y, w: el.w, h: el.h };
  if (el.type === 'table')
    return {
      type: 'table',
      ...base,
      colW: el.colW,
      rowH: el.rowH,
      style: el.style,
      header: el.header,
      cells: el.cells.map((r) => r.map((c) => ({ text: c.text, bold: c.bold, align: c.align }))),
    };
  if (el.type === 'image') return { type: 'image', ...base, src: el.src, fit: el.fit };
  return {
    type: el.type,
    ...base,
    ph: el.ph,
    doc: el.doc,
    ...(el.style ? { style: el.style } : {}),
    ...(el.valign ? { valign: el.valign } : {}),
    ...(el.type === 'shape'
      ? { shape: 'rect', fill: el.fill ?? null, stroke: null }
      : {
          autofit: 'none' as const,
          ...(el.fill ? { fill: el.fill } : {}),
          ...(el.stroke ? { stroke: el.stroke } : {}),
        }),
  };
}

function plannedToSlide(p: PlannedSlide): NewSlide {
  return {
    layout: isLayoutId(p.layout) ? p.layout : 'content',
    elements: p.elements.map(plannedToInit),
    notes: p.notes,
    ...(p.bg ? { bg: p.bg } : {}),
  };
}

const sizeOf = (deck?: Pick<DeckInfo, 'width' | 'height'>) => ({
  width: deck?.width ?? DEFAULT_SIZE.width,
  height: deck?.height ?? DEFAULT_SIZE.height,
});

/**
 * AI / markdown 草稿 → 新页。版式、表格、字号、续页都由共享规划决定（服务端 create_document 走同一套），
 * 一份草稿可能排成几页（长表格 / 长正文拆出「（续）」页）。
 */
export function draftToSlides(
  d: SlideDraft,
  deck?: Pick<DeckInfo, 'width' | 'height'>,
): NewSlide[] {
  return planSlide(d, sizeOf(deck)).map(plannedToSlide);
}

export function draftsToSlides(
  drafts: SlideDraft[],
  deck?: Pick<DeckInfo, 'width' | 'height'>,
): NewSlide[] {
  return drafts.flatMap((d) => draftToSlides(d, deck));
}

/** 预览用：草稿的第一页 */
export function draftToSlide(d: SlideDraft, deck?: Pick<DeckInfo, 'width' | 'height'>): NewSlide {
  return draftToSlides(d, deck)[0]!;
}

export function replaceAllWithDrafts(doc: Y.Doc, drafts: SlideDraft[], origin: unknown): string[] {
  const arr = getSlidesArray(doc);
  const deck = readDeckInfo(getDeckMeta(doc));
  let ids: string[] = [];
  doc.transact(() => {
    if (arr.length) arr.delete(0, arr.length);
    ids = insertSlides(doc, 0, draftsToSlides(drafts, deck), origin);
  }, origin);
  return ids;
}

/** 页 → markdown 草稿（导出 Markdown、AI 上下文）：标题占位符 = 标题，其余文本框 / 表格 = 正文 */
export function slideToDraft(s: SlideModel): SlideDraft {
  const parts: string[] = [];
  let titleUsed = false;
  for (const e of s.elements) {
    if ((e.type === 'text' || e.type === 'shape') && !titleUsed && s.title && e.ph === 'title') {
      titleUsed = true;
      continue;
    }
    if (e.type === 'text' || e.type === 'shape') {
      const md = pmToMarkdown(e.doc);
      if (md) parts.push(md);
    } else if (e.type === 'table' && e.cells.length) {
      // 加粗的单元格写成 **…**（表头本来就加粗，不写），再解析回来仍是加粗单元格
      const rows = e.cells.map(
        (r, ri) =>
          `| ${r
            .map((c) => {
              const t = c.text.replace(/\|/gu, '\\|').replace(/\n/gu, ' ');
              return ri > 0 && c.bold && t.trim() ? `**${t.trim()}**` : t;
            })
            .join(' | ')} |`,
      );
      rows.splice(1, 0, `| ${e.cells[0]!.map(() => '---').join(' | ')} |`);
      parts.push(rows.join('\n'));
    } else if (e.type === 'image' && e.src && !e.src.startsWith('data:')) {
      parts.push(`![${e.name || tr('图片')}](${e.src})`);
    }
  }
  let body = parts.join('\n\n');
  let title = s.title;
  if (!titleUsed && title) {
    // 没有标题占位符：标题取自第一行，正文去掉它
    const lines = body.split('\n');
    if (
      lines[0]
        ?.replace(/^[-*\d.\s]+/u, '')
        .replace(/\*\*/gu, '')
        .trim() === title
    )
      body = lines.slice(1).join('\n').trim();
    else title = title.slice(0, 40);
  }
  // 标题页 / 章节页保留（导出 markdown 再导入版式不变）；两栏的两个文本框已拼成一段正文，按 content 处理
  const layout = s.layout === 'title' || s.layout === 'section' ? s.layout : 'content';
  return { title, body, notes: s.notes, layout };
}

export function readAllSlides(doc: Y.Doc, deck: DeckInfo): SlideModel[] {
  return readSlideRefs(getSlidesArray(doc)).map((r) => readSlide(r, deck));
}
