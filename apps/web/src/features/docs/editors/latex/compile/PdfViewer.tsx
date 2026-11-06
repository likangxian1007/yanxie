import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, MoveHorizontal, ZoomIn, ZoomOut } from 'lucide-react';
import type * as PdfJsLib from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { IconButton, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { tr } from '@/lib/i18n';

/**
 * PDF.js 画布阅读器：翻页、缩放、适合宽度；按需渲染可见页（IntersectionObserver），
 * 重新编译后保持阅读位置。pdfjs-dist 懒加载，不进首屏包。
 */

type PdfJs = typeof PdfJsLib;
let pdfjsPromise: Promise<PdfJs> | null = null;

// export：文献库阅读器（features/library）复用同一份 PDF.js 加载与资源配置
export function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  });
  return pdfjsPromise;
}

/** 文档 → 加载任务（释放 worker 里的文档要调用加载任务的 destroy） */
const tasks = new WeakMap<PDFDocumentProxy, PDFDocumentLoadingTask>();
function destroyDoc(doc: PDFDocumentProxy): void {
  void tasks.get(doc)?.destroy();
  tasks.delete(doc);
}

/**
 * 中文（ctex / xeCJK）PDF 的 CID 字体要用 Adobe CMap 才能显示；标准字体数据给没嵌入字体的 PDF 用。
 * 这些文件随 pdfjs-dist 发布：按需懒加载成静态资源（不改 Vite 配置，也不进首屏包）。
 */
const CMAPS = import.meta.glob<string>('/node_modules/pdfjs-dist/cmaps/*.bcmap', {
  query: '?url',
  import: 'default',
});
const STD_FONTS = import.meta.glob<string>('/node_modules/pdfjs-dist/standard_fonts/*', {
  query: '?url',
  import: 'default',
});

// export：同上（features/library 的 PDF 阅读器）
export class BundledDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const table = kind === 'cMapUrl' ? CMAPS : kind === 'standardFontDataUrl' ? STD_FONTS : null;
    const dir = kind === 'cMapUrl' ? 'cmaps' : 'standard_fonts';
    const load = table?.[`/node_modules/pdfjs-dist/${dir}/${filename}`];
    if (!load) throw new Error(tr('缺少 PDF 资源 {kind}/{filename}', { kind, filename }));
    const res = await fetch(await load());
    if (!res.ok)
      throw new Error(tr('加载 {filename} 失败（{status}）', { filename, status: res.status }));
    return new Uint8Array(await res.arrayBuffer());
  }
}

const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const PAGE_GAP = 16;
const PAD = 16;

interface PageSize {
  width: number;
  height: number;
}

export interface PdfViewerProps {
  data: Uint8Array;
  /** 工具栏右侧额外的按钮（下载等） */
  actions?: ReactNode;
  className?: string;
}

export function PdfViewer({ data, actions, className }: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fit, setFit] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const restoreRef = useRef<number | null>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);

  // 加载文档（data 变了 = 重新编译；记住当前位置）
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    const el = scrollRef.current;
    if (el && el.scrollHeight > el.clientHeight) {
      restoreRef.current = el.scrollTop / Math.max(1, el.scrollHeight);
    }
    void (async () => {
      try {
        const lib = await loadPdfJs();
        // getDocument 会把 buffer 转给 worker：传一份拷贝
        const task = lib.getDocument({
          data: data.slice(),
          useWorkerFetch: false,
          BinaryDataFactory: BundledDataFactory,
        });
        const doc = await task.promise;
        tasks.set(doc, task);
        loaded = doc;
        const list: PageSize[] = [];
        for (let i = 1; i <= doc.numPages; i += 1) {
          const p = await doc.getPage(i);
          const vp = p.getViewport({ scale: 1 });
          list.push({ width: vp.width, height: vp.height });
        }
        if (cancelled) {
          destroyDoc(doc);
          return;
        }
        const old = pdfRef.current;
        pdfRef.current = doc;
        setError(null);
        setSizes(list);
        setPdf(doc);
        if (old && old !== doc) destroyDoc(old);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      if (loaded && loaded !== pdfRef.current) destroyDoc(loaded);
    };
  }, [data]);

  useEffect(
    () => () => {
      if (pdfRef.current) destroyDoc(pdfRef.current);
      pdfRef.current = null;
    },
    [],
  );

  // 容器宽度（适合宽度用）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const baseWidth = sizes[0]?.width ?? 595;
  const scale = fit && width > 0 ? Math.max(0.25, (width - PAD * 2) / baseWidth) : zoom;

  // 恢复阅读位置
  useEffect(() => {
    const el = scrollRef.current;
    const ratio = restoreRef.current;
    if (!el || ratio === null || sizes.length === 0) return;
    restoreRef.current = null;
    window.requestAnimationFrame(() => {
      el.scrollTop = ratio * el.scrollHeight;
    });
  }, [sizes, pdf]);

  // 当前页 = 视口中线所在的页
  const tops = useMemo(() => {
    const list: number[] = [];
    let y = PAD;
    for (const s of sizes) {
      list.push(y);
      y += s.height * scale + PAGE_GAP;
    }
    return list;
  }, [sizes, scale]);
  const topsRef = useRef<number[]>([]);
  useEffect(() => {
    topsRef.current = tops;
  }, [tops]);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const mid = el.scrollTop + el.clientHeight / 3;
    let n = 1;
    topsRef.current.forEach((t, i) => {
      if (t <= mid) n = i + 1;
    });
    setPage(n);
    setPageInput(String(n));
  }, []);

  const goTo = (n: number) => {
    const el = scrollRef.current;
    if (!el || sizes.length === 0) return;
    const target = Math.max(1, Math.min(sizes.length, n));
    el.scrollTo({ top: (tops[target - 1] ?? 0) - PAD / 2 });
    setPage(target);
    setPageInput(String(target));
  };

  const zoomBy = (dir: 1 | -1) => {
    const cur = scale;
    const next =
      dir > 0
        ? (ZOOMS.find((z) => z > cur + 0.01) ?? ZOOMS[ZOOMS.length - 1]!)
        : ([...ZOOMS].reverse().find((z) => z < cur - 0.01) ?? ZOOMS[0]!);
    const el = scrollRef.current;
    const ratio = el ? el.scrollTop / Math.max(1, el.scrollHeight) : 0;
    setFit(false);
    setZoom(next);
    window.requestAnimationFrame(() => {
      if (el) el.scrollTop = ratio * el.scrollHeight;
    });
  };

  const total = sizes.length;

  return (
    <div className={cn('ltx-pdf flex min-h-0 min-w-0 flex-col', className)}>
      <div
        role="toolbar"
        aria-label={tr('PDF 阅读')}
        className="flex h-9 shrink-0 items-center gap-0.5 border-b border-line bg-surface px-1.5"
      >
        <IconButton
          label={tr('上一页')}
          size="sm"
          disabled={page <= 1}
          onClick={() => goTo(page - 1)}
        >
          <ChevronLeft strokeWidth={1.75} aria-hidden />
        </IconButton>
        <form
          className="flex items-center gap-1 text-caption text-fg-muted tabular-nums"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number.parseInt(pageInput, 10);
            if (Number.isFinite(n)) goTo(n);
            else setPageInput(String(page));
          }}
        >
          <input
            aria-label={tr('页码')}
            inputMode="numeric"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/\D/gu, '').slice(0, 4))}
            onBlur={() => setPageInput(String(page))}
            className="h-6 w-9 rounded-sm border border-line bg-canvas px-1 text-center text-caption text-fg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          />
          <span>/ {total || '–'}</span>
        </form>
        <IconButton
          label={tr('下一页')}
          size="sm"
          disabled={page >= total}
          onClick={() => goTo(page + 1)}
        >
          <ChevronRight strokeWidth={1.75} aria-hidden />
        </IconButton>
        <span className="mx-1 h-4 w-px bg-line" aria-hidden />
        <IconButton label={tr('缩小')} size="sm" onClick={() => zoomBy(-1)}>
          <ZoomOut strokeWidth={1.75} aria-hidden />
        </IconButton>
        <span
          className="w-10 text-center text-caption text-fg-muted tabular-nums"
          aria-live="polite"
        >
          {Math.round(scale * 100)}%
        </span>
        <IconButton label={tr('放大')} size="sm" onClick={() => zoomBy(1)}>
          <ZoomIn strokeWidth={1.75} aria-hidden />
        </IconButton>
        <IconButton
          label={tr('适合宽度')}
          size="sm"
          aria-pressed={fit}
          className={cn(fit && 'bg-subtle text-fg')}
          onClick={() => setFit(true)}
        >
          <MoveHorizontal strokeWidth={1.75} aria-hidden />
        </IconButton>
        <div className="ml-auto flex items-center gap-0.5">{actions}</div>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="ltx-pdf-scroll relative min-h-0 flex-1 overflow-auto bg-subtle"
        tabIndex={0}
        aria-label={tr('PDF 页面')}
      >
        {error ? (
          <p className="px-4 py-10 text-center text-small text-danger">
            {tr('PDF 显示失败：{error}', { error })}
          </p>
        ) : !pdf ? (
          <div className="flex h-full items-center justify-center">
            <Spinner label={tr('正在加载 PDF')} />
          </div>
        ) : (
          <div
            className="flex flex-col items-center"
            style={{ padding: PAD, gap: PAGE_GAP, minWidth: 'min-content' }}
          >
            {sizes.map((s, i) => (
              <PdfPage key={i} pdf={pdf} index={i + 1} size={s} scale={scale} root={scrollRef} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PdfPage({
  pdf,
  index,
  size,
  scale,
  root,
}: {
  pdf: PDFDocumentProxy;
  index: number;
  size: PageSize;
  scale: number;
  root: React.RefObject<HTMLDivElement | null>;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(
    () => index <= 2 || typeof IntersectionObserver === 'undefined',
  );
  const w = Math.floor(size.width * scale);
  const h = Math.floor(size.height * scale);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { root: root.current, rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!visible) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    void (async () => {
      const p = await pdf.getPage(index);
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const vp = p.getViewport({ scale: scale * dpr });
      // 先画到离屏画布，完成后再换上，避免重新编译时闪白
      const off = document.createElement('canvas');
      off.width = Math.floor(vp.width);
      off.height = Math.floor(vp.height);
      task = p.render({ canvas: off, viewport: vp });
      try {
        await task.promise;
      } catch {
        return;
      }
      if (cancelled) return;
      canvas.width = off.width;
      canvas.height = off.height;
      canvas.getContext('2d')?.drawImage(off, 0, 0);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, index, scale, visible]);

  return (
    <div
      ref={boxRef}
      className="ltx-pdf-page relative shrink-0 bg-white shadow-md"
      style={{ width: w, height: h }}
      data-page={index}
    >
      <canvas
        ref={canvasRef}
        aria-label={tr('第 {index} 页', { index })}
        style={{ width: w, height: h }}
      />
    </div>
  );
}
