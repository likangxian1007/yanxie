import { generateJSON } from '@tiptap/core';
import type * as Y from 'yjs';
import type * as PJ from 'pptxtojson/dist/index.js';
import { slideTextExtensions } from '../editors/slides/canvas/textExtensions';
import {
  createSlideMap,
  getDeckMeta,
  getSlidesArray,
  type CellInit,
  type ElementInit,
  type NewSlide,
} from '../editors/slides/model/deck';
import { initialKeys } from '../editors/slides/model/order';
import { mapTextNodes, pmPlainText, type PmNode } from '../editors/slides/model/richtext';
import { DEFAULT_THEME } from '../editors/slides/model/themes';
import type { ArrowKind, DeckInfo, Fill, Stroke, Theme } from '../editors/slides/model/types';
import { isKnownShape } from '../editors/slides/render/shapes';
import { ImportError, type ImportContext } from './types';
import { tr } from '@/lib/i18n';

/**
 * PowerPoint（.pptx）导入：pptxtojson（MIT）把文件解析成 JSON（单位 pt），再转成幻灯片的元素模型
 * 写进空的本地 Y.Doc（`slides` 与 `slidesMeta`，见 API.md §2.7.1）。
 * 保留：页面尺寸、位置 / 大小 / 旋转 / 翻转、富文本（字体、字号、颜色、粗斜体下划线、对齐、行距、项目符号与编号）、
 * 形状（预设形状按名字，其他用解析出的路径）、线条与箭头、图片（经 ctx.uploadFile 上传，含裁剪）、表格（含合并单元格）、
 * 背景（纯色、渐变、图片）、母版 / 版式上的装饰元素、演讲者备注。图表转成数据表格；视频、音频跳过并提示。
 */

type ParseResult = Awaited<ReturnType<typeof PJ.parse>>;
type PEl = PJ.Element;

const MEDIA_LIMIT = 20 * 1024 * 1024;

function htmlToPm(html: string): PmNode {
  if (!html.trim()) return { type: 'doc', content: [{ type: 'paragraph' }] };
  const json = generateJSON(html, slideTextExtensions()) as PmNode;
  // pptxtojson 用 &nbsp; 表示空格
  return mapTextNodes(json, (n) => ({ ...n, text: (n.text ?? '').replace(/\u00a0/gu, ' ') }));
}

function htmlToText(html: string): string {
  if (!html) return '';
  if (typeof DOMParser === 'undefined') return html.replace(/<[^>]+>/gu, '');
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  const paras = body.querySelectorAll('p');
  const text = paras.length
    ? Array.from(paras)
        .map((p) => p.textContent ?? '')
        .join('\n')
    : (body.textContent ?? '');
  return text.replace(/\u00a0/gu, ' ').trim();
}

function dataUrlToBlob(dataUrl: string): Blob | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/su.exec(dataUrl);
  if (!m) return null;
  const mime = m[1] ?? 'application/octet-stream';
  if (!m[2]) return new Blob([decodeURIComponent(m[3] ?? '')], { type: mime });
  const bin = atob(m[3] ?? '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/x-emf': 'emf',
  'image/x-wmf': 'wmf',
};

class Media {
  private cache = new Map<string, Promise<{ src: string; fileId: string | null }>>();
  private n = 0;
  constructor(
    private readonly ctx: ImportContext | undefined,
    private readonly warnings: Set<string>,
  ) {}

  /** data URL → 上传后的地址（同一张图只传一次）；没有 ctx 时（测试、预览）原样保留 data URL */
  get(dataUrl: string, hint: string): Promise<{ src: string; fileId: string | null }> {
    const key = dataUrl.length > 200 ? `${dataUrl.length}:${dataUrl.slice(-120)}` : dataUrl;
    let p = this.cache.get(key);
    if (!p) {
      p = this.upload(dataUrl, hint);
      this.cache.set(key, p);
    }
    return p;
  }

  private async upload(dataUrl: string, hint: string) {
    if (!this.ctx) return { src: dataUrl, fileId: null };
    const blob = dataUrlToBlob(dataUrl);
    if (!blob) return { src: '', fileId: null };
    if (blob.size > MEDIA_LIMIT) {
      this.warnings.add(tr('有图片超过 20 MB，没有导入'));
      return { src: '', fileId: null };
    }
    this.n += 1;
    const ext = EXT[blob.type] ?? 'png';
    const base = (hint.split('/').pop() ?? '').replace(/\.[^.]+$/u, '') || `image-${this.n}`;
    try {
      const r = await this.ctx.uploadFile(blob, `${base}.${ext}`);
      return { src: r.url, fileId: r.id };
    } catch {
      this.warnings.add(tr('有图片上传失败，没有导入'));
      return { src: '', fileId: null };
    }
  }
}

function strokeOf(el: {
  borderColor?: string;
  borderWidth?: number;
  borderType?: string;
}): Stroke | null {
  if (!el.borderWidth || el.borderWidth <= 0 || !el.borderColor) return null;
  return {
    color: el.borderColor,
    width: Math.round(el.borderWidth * 100) / 100,
    dash: el.borderType === 'dashed' ? 'dash' : el.borderType === 'dotted' ? 'dot' : 'solid',
  };
}

async function fillOf(fill: PJ.Fill | null | undefined, media: Media): Promise<Fill | null> {
  if (!fill) return null;
  if (fill.type === 'color') return fill.value ? { type: 'color', color: fill.value } : null;
  if (fill.type === 'gradient') {
    const stops = fill.value.colors
      .map((c) => ({ pos: Math.max(0, Math.min(1, parseFloat(c.pos) / 100 || 0)), color: c.color }))
      .sort((a, b) => a.pos - b.pos);
    return stops.length ? { type: 'gradient', angle: fill.value.rot || 0, stops } : null;
  }
  if (fill.type === 'image') {
    const data = fill.value.base64;
    if (!data) return null;
    const up = await media.get(data, fill.value.ref);
    return up.src
      ? { type: 'image', src: up.src, ...(up.fileId ? { fileId: up.fileId } : {}) }
      : null;
  }
  if (fill.type === 'pattern') return { type: 'color', color: fill.value.foregroundColor };
  return null;
}

const VALIGN: Record<string, 'top' | 'middle' | 'bottom'> = {
  up: 'top',
  top: 'top',
  mid: 'middle',
  middle: 'middle',
  down: 'bottom',
  bottom: 'bottom',
};

const LINE_SHAPES = /^(line|straightConnector1|bentConnector\d|curvedConnector\d)$/u;

function placeholderOf(name: string): 'title' | 'subtitle' | 'body' | null {
  const n = name.trim().toLowerCase();
  if (/^(subtitle|副标题)/u.test(n)) return 'subtitle';
  if (/^(title|标题|center title|ctrtitle)/u.test(n)) return 'title';
  if (/^(content placeholder|text placeholder|body|内容占位符|文本占位符)/u.test(n)) return 'body';
  return null;
}

function firstFontSize(html: string): number | null {
  const m = /font-size:\s*([\d.]+)pt/u.exec(html);
  return m ? Number(m[1]) : null;
}

interface Conv {
  media: Media;
  warnings: Set<string>;
  defaultFont: string;
}

async function convertElement(
  el: PEl,
  dx: number,
  dy: number,
  conv: Conv,
  group: string | null,
): Promise<ElementInit[]> {
  const base = {
    x: Math.round((el.left + dx) * 100) / 100,
    y: Math.round((el.top + dy) * 100) / 100,
    w: Math.max(1, Math.round(el.width * 100) / 100),
    h: Math.max(0, Math.round(el.height * 100) / 100),
    group,
  };
  switch (el.type) {
    case 'group':
    case 'diagram': {
      const gid = `g${Math.random().toString(36).slice(2, 9)}`;
      const out: ElementInit[] = [];
      const children = [...el.elements].sort((a, b) => a.order - b.order);
      for (const c of children)
        out.push(...(await convertElement(c, el.left + dx, el.top + dy, conv, group ?? gid)));
      return out;
    }
    case 'text':
    case 'shape': {
      const rot = el.rotate || 0;
      const common = { ...base, rot, flipH: el.isFlipH, flipV: el.isFlipV, name: el.name ?? '' };
      if (el.type === 'shape' && LINE_SHAPES.test(el.shapType)) {
        const stroke = strokeOf(el) ?? { color: '#000000', width: 1, dash: 'solid' as const };
        return [
          {
            type: 'line',
            ...common,
            stroke,
            start: (el.headEnd?.type ?? 'none') as ArrowKind,
            end: (el.tailEnd?.type ?? 'none') as ArrowKind,
          },
        ];
      }
      const fill = await fillOf(el.fill, conv.media);
      const stroke = strokeOf(el);
      const doc = htmlToPm(el.content);
      const inset = el.textInset;
      const textProps = {
        doc,
        style: {
          fontSize: firstFontSize(el.content) ?? 18,
          color: '#000000',
          fontFamily: conv.defaultFont,
        },
        valign: VALIGN[el.vAlign] ?? 'top',
        pad: (inset ? [inset.l, inset.t, inset.r, inset.b] : [7.2, 3.6, 7.2, 3.6]) as [
          number,
          number,
          number,
          number,
        ],
        autofit: el.autoFit?.type === 'text' ? ('shrink' as const) : ('none' as const),
        fontScale: el.autoFit?.type === 'text' ? (el.autoFit.fontScale ?? 1) : 1,
        vertical: el.type === 'text' ? el.isVertical : false,
        ph: placeholderOf(el.name ?? ''),
      };
      const plainBox = el.type === 'text' || (el.shapType === 'rect' && !fill && !stroke);
      if (plainBox) return [{ type: 'text', ...common, ...textProps, fill, stroke }];
      const known = isKnownShape(el.shapType);
      const custom = !known && el.path && el.pathViewBox && el.pathViewBox.width > 0;
      return [
        {
          type: 'shape',
          ...common,
          ...textProps,
          shape: known ? el.shapType : 'rect',
          path: custom ? el.path! : null,
          vb: custom ? [el.pathViewBox!.width, el.pathViewBox!.height || el.height] : null,
          fill: el.strokeOnly ? null : fill,
          stroke,
        },
      ];
    }
    case 'image': {
      const data = el.base64;
      if (!data) return [];
      const up = await conv.media.get(data, el.ref);
      if (!up.src) return [];
      const r = el.rect;
      const crop =
        r && (r.l || r.t || r.r || r.b)
          ? { l: (r.l ?? 0) / 100, t: (r.t ?? 0) / 100, r: (r.r ?? 0) / 100, b: (r.b ?? 0) / 100 }
          : null;
      return [
        {
          type: 'image',
          ...base,
          rot: el.rotate || 0,
          flipH: el.isFlipH,
          flipV: el.isFlipV,
          src: up.src,
          fileId: up.fileId,
          fit: 'fill',
          crop,
          stroke: strokeOf(el),
          geom: el.geom === 'ellipse' ? 'ellipse' : el.geom === 'roundRect' ? 'roundRect' : 'rect',
          name: tr('图片'),
        },
      ];
    }
    case 'math': {
      if (el.picBase64) {
        const up = await conv.media.get(el.picBase64, el.picRef);
        if (up.src)
          return [
            {
              type: 'image',
              ...base,
              src: up.src,
              fileId: up.fileId,
              fit: 'contain',
              name: tr('公式'),
            },
          ];
      }
      const text = el.latex ? `$${el.latex}$` : (el.text ?? '');
      return text
        ? [
            {
              type: 'text',
              ...base,
              doc: {
                type: 'doc',
                content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
              },
            },
          ]
        : [];
    }
    case 'table': {
      const cells: CellInit[][] = el.data.map((row) =>
        row.map((c) => ({
          text: htmlToText(c.text),
          fill: c.fillColor ?? null,
          // 单元格文字的颜色、粗体、斜体、对齐、字号多半写在段落 / 文字的内联样式里
          color:
            c.fontColor ?? /[^-]color:\s*(#[0-9a-f]{6})/iu.exec(c.text)?.[1]?.toUpperCase() ?? null,
          bold: Boolean(c.fontBold) || /font-weight:\s*(bold|[6-9]00)/u.test(c.text),
          italic: /font-style:\s*italic/u.test(c.text),
          align:
            (/text-align:\s*(center|right)/u.exec(c.text)?.[1] as 'center' | 'right' | undefined) ??
            null,
          fontSize: firstFontSize(c.text),
          colSpan: c.colSpan ?? 1,
          rowSpan: c.rowSpan ?? 1,
          hidden: Boolean(c.hMerge || c.vMerge),
        })),
      );
      const firstCell = el.data[0]?.[0];
      const border =
        [el.borders?.top, firstCell?.borders?.top, firstCell?.borders?.left].find(
          (b) => b && b.borderWidth > 0,
        ) ?? null;
      const nCols = Math.max(1, ...cells.map((r) => r.length));
      const colW =
        el.colWidths.length === nCols
          ? el.colWidths
          : Array.from({ length: nCols }, () => base.w / nCols);
      return [
        {
          type: 'table',
          ...base,
          cells,
          colW,
          rowH: el.rowHeights.map((h) => h || 0),
          header: false,
          border: border ? strokeOf(border) : null,
          style: {
            fontSize: firstFontSize(firstCell?.text ?? '') ?? 14,
            color: '#000000',
            fontFamily: conv.defaultFont,
          },
          name: tr('表格'),
        },
      ];
    }
    case 'chart': {
      conv.warnings.add(tr('图表转成了数据表格'));
      if (el.chartType === 'scatterChart' || el.chartType === 'bubbleChart') {
        const rows = (el.data as number[][]).map((r) => r.map((v) => ({ text: String(v) })));
        return rows.length
          ? [{ type: 'table', ...base, cells: rows, header: false, name: tr('图表数据') }]
          : [];
      }
      const items = el.data as PJ.ChartItem[];
      const cats = items[0]?.values.map((v) => v.x) ?? [];
      const cells: CellInit[][] = [
        [{ text: '' }, ...cats.map((c) => ({ text: c }))],
        ...items.map((it) => [{ text: it.key }, ...it.values.map((v) => ({ text: String(v.y) }))]),
      ];
      return [{ type: 'table', ...base, cells, header: true, name: tr('图表数据') }];
    }
    case 'video':
    case 'audio':
      conv.warnings.add(tr('视频和音频没有导入'));
      return [];
    default:
      return [];
  }
}

function slideTitle(inits: ElementInit[]): string {
  const title = inits.find((e) => e.ph === 'title' && e.doc);
  const pick =
    title ??
    inits.find(
      (e) => (e.type === 'text' || e.type === 'shape') && e.doc && pmPlainText(e.doc).trim(),
    );
  return pick?.doc ? pmPlainText(pick.doc).replace(/\s+/gu, ' ').trim() : '';
}

/** 解析结果 → 页（导出给测试） */
export async function convertParsed(
  json: ParseResult,
  ctx?: ImportContext,
): Promise<{ deck: DeckInfo; slides: NewSlide[]; warnings: string[]; firstTitle: string }> {
  const warnings = new Set<string>();
  const media = new Media(ctx, warnings);
  const theme: Theme = {
    ...DEFAULT_THEME,
    id: 'imported',
    name: tr('导入'),
    colors: json.themeColors?.length ? json.themeColors.slice(0, 6) : DEFAULT_THEME.colors,
    accent: json.themeColors?.[0] ?? DEFAULT_THEME.accent,
  };
  const deck: DeckInfo = {
    width: Math.round(json.size?.width || 960),
    height: Math.round(json.size?.height || 540),
    theme,
  };
  const conv: Conv = { media, warnings, defaultFont: json.usedFonts?.[0] ?? 'Microsoft YaHei' };
  const slides: NewSlide[] = [];
  let firstTitle = '';
  for (const s of json.slides) {
    const inits: ElementInit[] = [];
    const layoutEls = [...(s.layoutElements ?? [])].sort((a, b) => a.order - b.order);
    for (const el of layoutEls) {
      for (const i of await convertElement(el, 0, 0, conv, null)) inits.push({ ...i, ph: null });
    }
    const els = [...s.elements].sort((a, b) => a.order - b.order);
    for (const el of els) inits.push(...(await convertElement(el, 0, 0, conv, null)));
    if (!firstTitle) firstTitle = slideTitle(inits);
    slides.push({
      layout: 'blank',
      elements: inits,
      bg: await fillOf(s.fill, media),
      notes: htmlToText(s.note ?? ''),
    });
  }
  return { deck, slides, warnings: [...warnings], firstTitle };
}

/** 写进（空的）Y.Doc */
export function writeDeck(ydoc: Y.Doc, deck: DeckInfo, slides: NewSlide[]): void {
  const arr = getSlidesArray(ydoc);
  const meta = getDeckMeta(ydoc);
  const keys = initialKeys(slides.length);
  ydoc.transact(() => {
    meta.set('w', deck.width);
    meta.set('h', deck.height);
    meta.set('theme', deck.theme);
    arr.push(slides.map((s, i) => createSlideMap(s, deck, keys[i]!)));
  });
}

export async function parsePptx(buf: ArrayBuffer): Promise<ParseResult> {
  const { parse } = await import('pptxtojson/dist/index.js');
  return parse(buf, { imageMode: 'base64', videoMode: 'none', audioMode: 'none' });
}

export async function importPptx(
  file: File,
  ydoc: Y.Doc,
  ctx?: ImportContext,
): Promise<{ title: string; warnings?: string[] }> {
  let json: ParseResult;
  try {
    json = await parsePptx(await file.arrayBuffer());
  } catch {
    throw new ImportError(
      tr('没能读出这个 PPT 文件，确认它是 .pptx 格式（旧的 .ppt 需要先另存为 .pptx）'),
    );
  }
  if (!json.slides?.length) throw new ImportError(tr('这个 PPT 里没有幻灯片'));
  const { deck, slides, warnings, firstTitle } = await convertParsed(json, ctx);
  writeDeck(ydoc, deck, slides);
  const fallback = file.name.replace(/\.pptx?$/iu, '').trim();
  return {
    title: (firstTitle || fallback || tr('导入的幻灯片')).slice(0, 80),
    ...(warnings.length ? { warnings } : {}),
  };
}
