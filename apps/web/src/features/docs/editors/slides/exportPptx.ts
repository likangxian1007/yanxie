import type PptxGenJS from 'pptxgenjs';
import { withBase } from '@/lib/base-path';
import type { PmMark, PmNode } from './model/richtext';
import type {
  DeckInfo,
  Fill,
  ImageElement,
  LineElement,
  ShapeElement,
  SlideElement,
  SlideModel,
  Stroke,
  TableElement,
  TextElement,
} from './model/types';
import { isKnownShape } from './render/shapes';
import { tr } from '@/lib/i18n';

/**
 * 导出 PPTX（pptxgenjs）：页面尺寸、元素位置 / 大小 / 旋转 / 翻转、富文本（字体、字号、颜色、
 * 粗斜体下划线、对齐、项目符号与编号、行距）、形状填充与边框、线条箭头、图片（含裁剪）、表格、背景、备注。
 * 单位：模型是 pt，pptxgenjs 位置用英寸（÷72），字号用 pt。
 */

type Pptx = InstanceType<typeof PptxGenJS>;
type Slide = ReturnType<Pptx['addSlide']>;
type TextRun = PptxGenJS.TextProps;

const IN = (pt: number) => Math.round((pt / 72) * 10000) / 10000;
const hex = (c: string | null | undefined): string | undefined => {
  if (!c) return undefined;
  const m = /^#?([0-9a-f]{6})/iu.exec(c.trim());
  if (m) return m[1]!.toUpperCase();
  const s = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/iu.exec(c.trim());
  return s ? `${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toUpperCase() : undefined;
};

function fillOpt(fill: Fill | null): PptxGenJS.ShapeFillProps | undefined {
  if (!fill) return undefined;
  if (fill.type === 'color') return { color: hex(fill.color) };
  if (fill.type === 'gradient') return { color: hex(fill.stops[0]?.color) };
  return undefined;
}

function lineOpt(stroke: Stroke | null): PptxGenJS.ShapeLineProps | undefined {
  if (!stroke || stroke.width <= 0) return undefined;
  return {
    color: hex(stroke.color),
    width: stroke.width,
    dashType: stroke.dash === 'dash' ? 'dash' : stroke.dash === 'dot' ? 'sysDot' : 'solid',
  };
}

function ptSize(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^([\d.]+)(pt|px)?$/u.exec(v.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] === 'px' ? Math.round(n * 0.75 * 10) / 10 : n;
}

function runOptions(marks: PmMark[] | undefined): PptxGenJS.TextPropsOptions {
  const o: PptxGenJS.TextPropsOptions = {};
  for (const m of marks ?? []) {
    if (m.type === 'bold') o.bold = true;
    else if (m.type === 'italic') o.italic = true;
    else if (m.type === 'underline') o.underline = { style: 'sng' };
    else if (m.type === 'strike') o.strike = 'sngStrike';
    else if (m.type === 'code') o.fontFace = 'Consolas';
    else if (m.type === 'link' && typeof m.attrs?.href === 'string')
      o.hyperlink = { url: m.attrs.href };
    else if (m.type === 'textStyle') {
      const a = m.attrs ?? {};
      if (typeof a.color === 'string') o.color = hex(a.color);
      const size = ptSize(a.fontSize);
      if (size) o.fontSize = size;
      if (typeof a.fontFamily === 'string' && a.fontFamily) o.fontFace = a.fontFamily;
      if (typeof a.backgroundColor === 'string') o.highlight = hex(a.backgroundColor);
    }
  }
  return o;
}

interface ParaCtx {
  bullet?: PptxGenJS.TextPropsOptions['bullet'];
  indentLevel?: number;
}

/** 文本框 PM JSON → pptxgenjs 文字段（每段最后一段 breakLine） */
export function pmToRuns(doc: PmNode, scale = 1): TextRun[] {
  const out: TextRun[] = [];
  const para = (p: PmNode, ctx: ParaCtx) => {
    const align = p.attrs?.textAlign as PptxGenJS.HAlign | undefined;
    const lh = Number(p.attrs?.lineHeight);
    const common: PptxGenJS.TextPropsOptions = {
      ...(align ? { align } : {}),
      ...(Number.isFinite(lh) && lh > 0 ? { lineSpacingMultiple: lh } : {}),
      ...(ctx.bullet ? { bullet: ctx.bullet } : {}),
      ...(ctx.indentLevel ? { indentLevel: ctx.indentLevel } : {}),
    };
    const runs: TextRun[] = [];
    for (const n of p.content ?? []) {
      if (n.type === 'hardBreak') {
        runs.push({ text: '', options: { ...common, softBreakBefore: true } });
        continue;
      }
      if (n.type !== 'text' || !n.text) continue;
      const o = runOptions(n.marks);
      if (o.fontSize && scale !== 1) o.fontSize = Math.round(o.fontSize * scale * 10) / 10;
      runs.push({ text: n.text, options: { ...common, ...o } });
    }
    if (runs.length === 0) runs.push({ text: '', options: { ...common } });
    runs[runs.length - 1]!.options = { ...runs[runs.length - 1]!.options, breakLine: true };
    out.push(...runs);
  };
  const list = (l: PmNode, level: number) => {
    const ordered = l.type === 'orderedList';
    const start = Number(l.attrs?.start ?? 1);
    let first = true;
    for (const item of l.content ?? []) {
      for (const c of item.content ?? []) {
        if (c.type === 'paragraph') {
          const bullet: PptxGenJS.TextPropsOptions['bullet'] = ordered
            ? { type: 'number', ...(first && start > 1 ? { numberStartAt: start } : {}) }
            : true;
          para(c, { bullet, indentLevel: level });
          first = false;
        } else if (c.type === 'bulletList' || c.type === 'orderedList') list(c, level + 1);
      }
    }
  };
  for (const n of doc.content ?? []) {
    if (n.type === 'paragraph') para(n, {});
    else if (n.type === 'bulletList' || n.type === 'orderedList') list(n, 0);
  }
  // 最后一段不需要换行
  const last = out[out.length - 1];
  if (last?.options) delete last.options.breakLine;
  return out;
}

function geom(el: SlideElement) {
  return {
    x: IN(el.x),
    y: IN(el.y),
    w: IN(Math.max(el.w, 0.5)),
    h: IN(Math.max(el.h, 0.5)),
    ...(el.rot ? { rotate: Math.round(el.rot) } : {}),
    ...(el.flipH ? { flipH: true } : {}),
    ...(el.flipV ? { flipV: true } : {}),
  };
}

function addTextLike(pptx: Pptx, s: Slide, el: TextElement | ShapeElement) {
  const st = el.style;
  const shapeName = el.type === 'shape' ? (isKnownShape(el.shape) ? el.shape : 'rect') : undefined;
  s.addText(pmToRuns(el.doc, el.fontScale || 1), {
    ...geom(el),
    ...(shapeName ? { shape: shapeName as PptxGenJS.ShapeType } : {}),
    fontFace: st.fontFamily,
    fontSize: Math.round(st.fontSize * (el.fontScale || 1) * 10) / 10,
    color: hex(st.color),
    bold: st.bold || undefined,
    align: st.align ?? 'left',
    valign: el.valign,
    ...(st.lineHeight ? { lineSpacingMultiple: st.lineHeight } : {}),
    margin: [el.pad[0], el.pad[2], el.pad[3], el.pad[1]],
    fill: fillOpt(el.fill),
    line: lineOpt(el.stroke),
    ...(el.vertical ? { vert: 'eaVert' as const } : {}),
    ...(el.type === 'text' && el.autofit === 'shrink' ? { fit: 'shrink' as const } : {}),
    objectName: el.name || undefined,
  });
  void pptx;
}

function addLine(pptx: Pptx, s: Slide, el: LineElement) {
  const arrow = (k: LineElement['start']) => (k === 'none' ? undefined : k);
  s.addShape(pptx.ShapeType.line, {
    ...geom({ ...el, h: el.h, w: el.w }),
    w: IN(el.w),
    h: IN(el.h),
    line: {
      ...lineOpt(el.stroke),
      ...(arrow(el.start) ? { beginArrowType: arrow(el.start) } : {}),
      ...(arrow(el.end) ? { endArrowType: arrow(el.end) } : {}),
    },
  });
}

async function addImage(s: Slide, el: ImageElement, load: (src: string) => Promise<string | null>) {
  let data = el.src ? await load(el.src) : null;
  if (!data) return;
  if (el.crop) data = (await cropDataUrl(data, el.crop)) ?? data;
  s.addImage({
    data: data.replace(/^data:/u, ''),
    ...geom(el),
    ...(el.geom === 'ellipse' ? { rounding: true } : {}),
    ...(el.fit === 'contain' || el.fit === 'cover'
      ? { sizing: { type: el.fit, w: IN(el.w), h: IN(el.h) } }
      : {}),
    altText: el.name || undefined,
  });
}

function addTable(s: Slide, el: TableElement, deck: DeckInfo) {
  const rows: PptxGenJS.TableRow[] = el.cells.map((row, r) =>
    row
      .filter((c) => !c.hidden)
      .map((cell) => {
        const head = el.header && r === 0;
        const fill = cell.fill ?? (head ? deck.theme.accent : null);
        return {
          text: cell.text,
          options: {
            ...(fill ? { fill: { color: hex(fill) } } : {}),
            color: hex(cell.color ?? (head ? '#FFFFFF' : el.style.color)),
            bold: cell.bold || head || undefined,
            italic: cell.italic || undefined,
            align: cell.align ?? 'left',
            valign: 'middle',
            ...(cell.fontSize ? { fontSize: cell.fontSize } : {}),
            ...(cell.colSpan > 1 ? { colspan: cell.colSpan } : {}),
            ...(cell.rowSpan > 1 ? { rowspan: cell.rowSpan } : {}),
          },
        } as PptxGenJS.TableCell;
      }),
  );
  const rowH = el.rowH.some((h) => h > 0)
    ? el.rowH.map((h) => IN(h || el.h / Math.max(1, el.rowH.length)))
    : undefined;
  s.addTable(rows, {
    x: IN(el.x),
    y: IN(el.y),
    w: IN(el.w),
    colW: el.colW.map(IN),
    ...(rowH ? { rowH } : {}),
    fontFace: el.style.fontFamily,
    fontSize: el.style.fontSize,
    color: hex(el.style.color),
    margin: [3.6, 5.4, 3.6, 5.4],
    ...(el.border
      ? { border: { type: 'solid', pt: el.border.width, color: hex(el.border.color) } }
      : { border: { type: 'none' } }),
  });
}

/** 图片地址 → data URL（项目文件走同源 fetch 带 Cookie） */
export async function loadAsDataUrl(src: string): Promise<string | null> {
  if (src.startsWith('data:')) return src;
  try {
    const res = await fetch(withBase(src), { credentials: 'include' });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function cropDataUrl(
  data: string,
  crop: NonNullable<ImageElement['crop']>,
): Promise<string | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  try {
    const img = new Image();
    img.src = data;
    await img.decode();
    const sx = img.naturalWidth * crop.l;
    const sy = img.naturalHeight * crop.t;
    const sw = img.naturalWidth * (1 - crop.l - crop.r);
    const sh = img.naturalHeight * (1 - crop.t - crop.b);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw));
    canvas.height = Math.max(1, Math.round(sh));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

export interface BuildOptions {
  title?: string;
  loadImage?: (src: string) => Promise<string | null>;
}

export async function buildPptx(
  slides: SlideModel[],
  deck: DeckInfo,
  opts: BuildOptions = {},
): Promise<Pptx> {
  const { default: Pptx } = await import('pptxgenjs');
  const pptx = new Pptx();
  pptx.defineLayout({ name: 'SRH', width: IN(deck.width), height: IN(deck.height) });
  pptx.layout = 'SRH';
  pptx.title = opts.title ?? tr('幻灯片');
  pptx.theme = { headFontFace: deck.theme.titleFont, bodyFontFace: deck.theme.bodyFont };
  const load = opts.loadImage ?? loadAsDataUrl;
  for (const slide of slides) {
    const s = pptx.addSlide();
    const bg = slide.bg;
    if (bg?.type === 'image') {
      const data = await load(bg.src);
      s.background = data ? { data: data.replace(/^data:/u, '') } : { color: hex(deck.theme.bg) };
    } else if (bg?.type === 'gradient') s.background = { color: hex(bg.stops[0]?.color) };
    else s.background = { color: hex(bg?.type === 'color' ? bg.color : deck.theme.bg) };
    for (const el of slide.elements) {
      if (el.type === 'text' || el.type === 'shape') addTextLike(pptx, s, el);
      else if (el.type === 'line') addLine(pptx, s, el);
      else if (el.type === 'image') await addImage(s, el, load);
      else if (el.type === 'table') addTable(s, el, deck);
    }
    if (slide.notes.trim()) s.addNotes(slide.notes);
  }
  return pptx;
}

export async function exportPptx(
  slides: SlideModel[],
  deck: DeckInfo,
  title: string,
  fileName: string,
): Promise<void> {
  const pptx = await buildPptx(slides, deck, { title });
  await pptx.writeFile({ fileName: `${fileName}.pptx` });
}
