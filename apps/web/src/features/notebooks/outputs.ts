/** 输出区用到的小工具（和组件分开放，组件文件只导出组件） */

export const WIDGET_MIME = 'application/vnd.jupyter.widget-view+json';

export interface ImageMeta {
  /** 显示尺寸（CSS 像素）；retina 图的像素是它的 2 倍 */
  width?: number;
  height?: number;
  /** IPython.display.Image(unconfined=True)：不按容器宽度缩小 */
  unconfined?: boolean;
}

const positive = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;

/**
 * 按 nbformat 读图片的显示尺寸：metadata[mime].width / height
 * （matplotlib retina、IPython Image(width=…, retina=True) 都写在这里）。
 * 老格式把 width / height 直接放在 metadata 顶层，也认。
 */
export function imageMeta(metadata: Record<string, unknown> | undefined, mime: string): ImageMeta {
  const m = (metadata ?? {}) as Record<string, unknown>;
  const own = m[mime];
  const src = (own && typeof own === 'object' ? own : m) as Record<string, unknown>;
  return {
    width: positive(src.width),
    height: positive(src.height),
    unconfined: src.unconfined === true || undefined,
  };
}
