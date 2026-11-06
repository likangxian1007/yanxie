import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { PdfBox } from '@srh/shared';
import { Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * 从 PDF 里裁出一块区域（图、表、没有 LaTeX 源码的公式）画到画布上。
 * 用 PDF.js 的 viewport offset 只渲染这一块，不渲染整页。
 */
export function PdfCrop({
  doc,
  box,
  maxWidth = 520,
  className,
  label,
}: {
  doc: PDFDocumentProxy | null;
  box: PdfBox;
  maxWidth?: number;
  className?: string;
  label: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [done, setDone] = useState(false);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((e) => {
      if (e.some((x) => x.isIntersecting)) setVisible(true);
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const pad = 4;
  const scale = Math.min(2.5, maxWidth / Math.max(1, box.w + pad * 2));
  const cssW = Math.round((box.w + pad * 2) * scale);
  const cssH = Math.round((box.h + pad * 2) * scale);

  useEffect(() => {
    if (!doc || !visible) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    void (async () => {
      const page = await doc.getPage(box.page);
      const canvas = ref.current;
      if (cancelled || !canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const s = scale * dpr;
      const vp = page.getViewport({
        scale: s,
        offsetX: -(box.x - pad) * s,
        offsetY: -(box.y - pad) * s,
      });
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      task = page.render({ canvas, viewport: vp });
      try {
        await task.promise;
        if (!cancelled) setDone(true);
      } catch {
        // 取消
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, visible, box.page, box.x, box.y, scale, cssW, cssH]);

  return (
    <div
      ref={wrapRef}
      className={cn(
        'lib-crop relative max-w-full overflow-hidden rounded-sm border border-line',
        className,
      )}
      style={{ width: cssW, aspectRatio: `${cssW} / ${cssH}` }}
    >
      {!done && <Skeleton className="absolute inset-0 h-full w-full" />}
      <canvas ref={ref} role="img" aria-label={label} className="block h-full w-full" />
    </div>
  );
}
