/**
 * 把 PDF 某一页（或页上的一块区域）渲染成 PNG：矢量绘制的图表（matplotlib / TikZ / Origin 导出的 PDF）
 * 没有内嵌位图，extractImages 拿不到，只能整页光栅化后交给视觉模型 / OCR。
 * 渲染用 pdf.js（unpdf 封装）+ @napi-rs/canvas（预编译二进制，Alpine musl 也有）。
 */

/** 区域：相对页面的比例坐标 [x0, y0, x1, y1]，0–1，原点在左上角 */
export type PageRegion = [number, number, number, number];

export interface RenderedPage {
  png: Buffer;
  width: number;
  height: number;
  pages: number;
  region: PageRegion | null;
}

/** 渲染长边上限（像素）：够 OCR / 视觉模型看清刻度，又不至于太大 */
const MAX_EDGE = 2400;
/** 只渲染一块区域时允许放得更大，小图也看得清 */
const MAX_SCALE = 12;

export class PdfRenderError extends Error {}

export function normalizeRegion(r: readonly number[] | null | undefined): PageRegion | null {
  if (!r) return null;
  if (r.length !== 4 || r.some((v) => !Number.isFinite(v))) {
    throw new PdfRenderError('region 要写成 [x0, y0, x1, y1]，都是 0–1 之间的比例');
  }
  const [a, b, c, d] = r.map((v) => Math.min(1, Math.max(0, v))) as PageRegion;
  const x0 = Math.min(a, c);
  const x1 = Math.max(a, c);
  const y0 = Math.min(b, d);
  const y1 = Math.max(b, d);
  if (x1 - x0 < 0.02 || y1 - y0 < 0.02) throw new PdfRenderError('region 太小（宽高都至少 0.02）');
  if (x0 === 0 && y0 === 0 && x1 === 1 && y1 === 1) return null;
  return [x0, y0, x1, y1];
}

export async function renderPdfPage(
  pdf: Uint8Array,
  page: number,
  region: PageRegion | null = null,
): Promise<RenderedPage> {
  const { getDocumentProxy } = await import('unpdf');
  const canvasMod = await import('@napi-rs/canvas').catch((err: unknown) => {
    throw new PdfRenderError(
      `服务器缺少 PDF 渲染组件（@napi-rs/canvas）：${(err as Error).message}`,
    );
  });
  // pdf.js 在 Node 下画矢量路径要用全局的 Path2D / ImageData / DOMMatrix
  const g = globalThis as Record<string, unknown>;
  for (const k of ['Path2D', 'ImageData', 'DOMMatrix'] as const) {
    if (!g[k]) g[k] = (canvasMod as unknown as Record<string, unknown>)[k];
  }
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  try {
    if (!Number.isInteger(page) || page < 1 || page > doc.numPages) {
      throw new PdfRenderError(`页码超出范围（共 ${doc.numPages} 页）`);
    }
    const p = await doc.getPage(page);
    const base = p.getViewport({ scale: 1 });
    const fw = region ? region[2] - region[0] : 1;
    const fh = region ? region[3] - region[1] : 1;
    // 目标区域的长边放到 MAX_EDGE
    const scale = Math.min(MAX_SCALE, MAX_EDGE / Math.max(base.width * fw, base.height * fh));
    const vp = p.getViewport({ scale });
    const ox = region ? Math.floor(region[0] * vp.width) : 0;
    const oy = region ? Math.floor(region[1] * vp.height) : 0;
    const w = Math.max(1, Math.ceil(vp.width * fw));
    const h = Math.max(1, Math.ceil(vp.height * fh));
    const canvas = canvasMod.createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    // 白底：很多论文图是透明背景，黑字透明底交给 OCR 会全黑
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    await p.render({
      canvas: canvas as unknown,
      canvasContext: ctx as unknown,
      viewport: vp,
      // 只画区域：整体平移，超出画布的部分自然裁掉
      transform: [1, 0, 0, 1, -ox, -oy],
    } as unknown as Parameters<typeof p.render>[0]).promise;
    p.cleanup();
    const png = await canvas.encode('png');
    return { png: Buffer.from(png), width: w, height: h, pages: doc.numPages, region };
  } finally {
    await (doc as unknown as { destroy?: () => Promise<unknown> })
      .destroy?.()
      ?.catch?.(() => undefined);
  }
}
