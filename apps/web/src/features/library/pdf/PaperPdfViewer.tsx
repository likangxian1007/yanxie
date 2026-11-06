import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, MoveHorizontal, ZoomIn, ZoomOut } from 'lucide-react';
import type { PDFDocumentProxy, RenderTask, TextLayer, PageViewport } from 'pdfjs-dist';
import type { PdfBox, AnnotationColor } from '@srh/shared';
import { IconButton, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';
import { loadPdfJs } from '@/features/docs/editors/latex/compile/PdfViewer';
import { AnnotationMarks } from './AnnotationMarks';
import {
  columnWarning,
  projectSelectionBox,
  selectionBoxes,
  textLayerFor,
  type PdfTextSelection,
} from './selection';
import { tr } from '@/lib/i18n';

/**
 * 论文 PDF 阅读器：按需渲染可见页，叠加高亮框（坐标 = PDF pt，左上角原点，与 GROBID 一致）。
 * target 变化（n 递增）时滚到对应位置——问答里的引用、结构面板里的段落都用它，高亮由 marks 负责。
 */
export interface PdfJumpTarget {
  /** 每次跳转递增，同一位置可以重复跳 */
  n: number;
  page: number;
  boxes: PdfBox[];
  coordinateSpace?: 'pdf';
}

export interface PdfMark {
  key: string;
  boxes: PdfBox[];
  tone: 'flash' | 'select' | 'highlight' | 'comment';
  color?: AnnotationColor;
  active?: boolean;
}

interface PageMark {
  key: string;
  annotationKey: string;
  box: PdfBox;
  tone: PdfMark['tone'];
  color?: AnnotationColor;
  active?: boolean;
}

interface Props {
  doc: PDFDocumentProxy | null;
  sizes: { width: number; height: number }[];
  error: string | null;
  marks: PdfMark[];
  target?: PdfJumpTarget | null;
  /** 点到页面某处（pt 坐标），用来选中段落 */
  onPointer?: (page: number, x: number, y: number) => void;
  actions?: ReactNode;
  onSelection?: (selection: PdfTextSelection | null, message?: string) => void;
  selectionTools?: ReactNode;
  className?: string;
}

const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const GAP = 12;
const PAD = 12;

export function PaperPdfViewer({
  doc,
  sizes,
  error,
  marks,
  target,
  onPointer,
  actions,
  onSelection,
  selectionTools,
  className,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const baseWidth = Math.max(...sizes.map((s) => s.width), 1) || 612;
  const scale = fit && width > 0 ? Math.max(0.25, (width - PAD * 2) / baseWidth) : zoom;

  useEffect(() => {
    if (!onSelection) return;
    const root = scrollRef.current;
    let revision = 0;
    let frame = 0;
    let dragging = false;
    let pointer: { x: number; y: number } | null = null;
    let lastSelection: {
      start: Node;
      startOffset: number;
      end: Node;
      endOffset: number;
      text: string;
    } | null = null;
    const read = async () => {
      if (dragging) return;
      const current = ++revision;
      // 侧栏自行保留文字快照；即使焦点仍在模型选择器，也要读取 PDF 中的新选区。
      const selected = window.getSelection();
      if (!selected || selected.isCollapsed || !selected.rangeCount) {
        lastSelection = null;
        onSelection(null);
        return;
      }
      const range = selected.getRangeAt(0);
      const start = textLayerFor(range.startContainer),
        end = textLayerFor(range.endContainer);
      if (!start || !end || !root?.contains(start) || !root.contains(end)) {
        lastSelection = null;
        onSelection(null);
        return;
      }
      if (start !== end) {
        lastSelection = null;
        onSelection(null, tr('请在同一页选择文字；跨页内容可以分次翻译。'));
        return;
      }
      const pageBox = start.closest<HTMLElement>('[data-page]');
      const text = selected.toString().replaceAll('\u0000', '').trim();
      if (!pageBox || !doc || !text) {
        lastSelection = null;
        onSelection(null);
        return;
      }
      // 定位原文会滚动页面，使屏幕坐标出现微差；相同文字范围不是一次新划词。
      const snapshot = {
        start: range.startContainer,
        startOffset: range.startOffset,
        end: range.endContainer,
        endOffset: range.endOffset,
        text,
      };
      if (
        lastSelection?.start === snapshot.start &&
        lastSelection.startOffset === snapshot.startOffset &&
        lastSelection.end === snapshot.end &&
        lastSelection.endOffset === snapshot.endOffset &&
        lastSelection.text === snapshot.text
      )
        return;
      const pageNo = Number(pageBox.dataset.page);
      const rects = [...range.getClientRects()];
      const bounds = pageBox.getBoundingClientRect();
      const visibleRects = rects.filter((r) => r.right > r.left && r.bottom > r.top);
      const backwards =
        selected.focusNode === range.startContainer && selected.focusOffset === range.startOffset;
      const endRect = backwards ? visibleRects[0] : visibleRects.at(-1);
      const nearSelection =
        pointer &&
        visibleRects.some(
          (r) =>
            pointer!.x >= r.left - 24 &&
            pointer!.x <= r.right + 24 &&
            pointer!.y >= r.top - 24 &&
            pointer!.y <= r.bottom + 24,
        );
      const menuAnchor = nearSelection
        ? pointer!
        : endRect
          ? { x: backwards ? endRect.left : endRect.right, y: endRect.bottom }
          : undefined;
      try {
        const pdfPage = await doc.getPage(pageNo);
        if (revision !== current || dragging) return;
        const boxes = selectionBoxes(rects, bounds, pdfPage.getViewport({ scale: 1 }), pageNo);
        if (!boxes.length) {
          onSelection(null);
          return;
        }
        lastSelection = snapshot;
        onSelection({
          text,
          page: pageNo,
          boxes,
          warning: columnWarning(rects, bounds.width),
          menuAnchor,
        });
      } catch {
        if (revision === current && !dragging)
          onSelection(null, tr('暂时无法定位选区，请重新选择。'));
      }
    };
    const schedule = () => {
      if (dragging) return;
      revision++;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        void read();
      });
    };
    // 拖选结束后才更新工具条，避免工具条改变高度、推动 PDF 而使选区跳行。
    const begin = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (!root?.contains(event.target as Node)) {
        // 侧栏操作优先于尚未完成的划词计算，晚到的结果不能切回“翻译”。
        revision++;
        cancelAnimationFrame(frame);
        return;
      }
      // 新一轮拖动使之前的测量失效，防止旧 getPage Promise 在拖选期间改动工具条。
      dragging = true;
      pointer = null;
      lastSelection = null;
      revision++;
      cancelAnimationFrame(frame);
      onSelection(null);
      // 在已有高亮上再次拖动应重新选词，不能被浏览器变成拖放旧文本。
      // 保留 Shift 扩选和触摸设备原生选区手柄。
      if (event.pointerType !== 'touch' && !event.shiftKey && textLayerFor(event.target as Node)) {
        const selection = window.getSelection();
        if (root.contains(textLayerFor(selection?.anchorNode ?? null)))
          selection?.removeAllRanges();
      }
    };
    const finish = (event: PointerEvent) => {
      // 只读取从 PDF 开始或在 PDF 内结束的选择，不把侧栏点击当成划词。
      if (!dragging && !root?.contains(event.target as Node)) return;
      if (
        (dragging || root?.contains(event.target as Node)) &&
        Number.isFinite(event.clientX) &&
        Number.isFinite(event.clientY)
      )
        pointer = { x: event.clientX, y: event.clientY };
      dragging = false;
      schedule();
    };
    const cancel = () => {
      const wasDragging = dragging;
      dragging = false;
      revision++;
      cancelAnimationFrame(frame);
      if (wasDragging) {
        const selection = window.getSelection();
        if (root?.contains(textLayerFor(selection?.anchorNode ?? null)))
          selection?.removeAllRanges();
        onSelection(null);
      }
    };
    const clear = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End')
        pointer = null;
      if (
        event.key === 'Escape' &&
        !document.activeElement?.closest('[data-library-selection-tools]')
      ) {
        revision++;
        cancelAnimationFrame(frame);
        window.getSelection()?.removeAllRanges();
        onSelection(null);
      }
    };
    // 尺寸变化后旧坐标不再对应当前 DOM，要求重新选择。
    const initial = requestAnimationFrame(() => {
      // 翻译侧栏独立持有文件身份和文字快照，缩放只清除原文坐标。
      const selection = window.getSelection();
      if (root?.contains(textLayerFor(selection?.anchorNode ?? null))) selection?.removeAllRanges();
      onSelection(null);
    });
    document.addEventListener('selectionchange', schedule);
    document.addEventListener('pointerdown', begin);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    document.addEventListener('keydown', clear);
    return () => {
      revision++;
      cancelAnimationFrame(initial);
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('pointerdown', begin);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('keydown', clear);
    };
  }, [doc, scale, onSelection]);

  const tops = useMemo(() => {
    const list: number[] = [];
    let y = PAD;
    for (const s of sizes) {
      list.push(y);
      y += s.height * scale + GAP;
    }
    return list;
  }, [sizes, scale]);
  const topsRef = useRef(tops);
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

  const scrollToPage = useCallback(
    (n: number, yPt?: number) => {
      const el = scrollRef.current;
      if (!el || sizes.length === 0) return;
      const target = Math.max(1, Math.min(sizes.length, n));
      const top =
        (tops[target - 1] ?? 0) +
        (yPt !== undefined ? yPt * scale - el.clientHeight / 3 : -PAD / 2);
      el.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      setPage(target);
      setPageInput(String(target));
    },
    [sizes.length, tops, scale],
  );

  // 跳转目标：每个 n 只处理一次；等 PDF 加载完、容器宽度量出来（缩放比例确定）再滚
  const handled = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (
      !target ||
      target.n === handled.current ||
      !el ||
      !doc ||
      sizes.length === 0 ||
      width === 0 ||
      el.clientHeight === 0
    )
      return;
    const p = Math.max(1, Math.min(sizes.length, target.page));
    const onPage = target.boxes.filter((b) => b.page === p);
    let cancelled = false;
    void (async () => {
      const viewport =
        target.coordinateSpace === 'pdf' ? (await doc.getPage(p)).getViewport({ scale }) : null;
      if (cancelled) return;
      handled.current = target.n;
      const y = onPage.length
        ? Math.min(
            ...onPage.map((b) => (viewport ? projectSelectionBox(b, viewport).top : b.y * scale)),
          )
        : undefined;
      const top = (tops[p - 1] ?? 0) + (y !== undefined ? y - el.clientHeight / 3 : -PAD / 2);
      el.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    })().catch(() => {
      /* PDF 被切换或卸载时忽略过期跳转。 */
    });
    return () => {
      cancelled = true;
    };
  }, [target, doc, sizes.length, width, tops, scale]);

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
  const marksByPage = useMemo(() => {
    const m = new Map<number, PageMark[]>();
    for (const mark of marks) {
      mark.boxes.forEach((box, i) => {
        const list = m.get(box.page) ?? [];
        list.push({
          key: `${mark.key}:${i}`,
          annotationKey: mark.key,
          box,
          tone: mark.tone,
          color: mark.color,
          active: mark.active,
        });
        m.set(box.page, list);
      });
    }
    return m;
  }, [marks]);

  return (
    <div className={cn('flex min-h-0 min-w-0 flex-col', className)}>
      <div
        role="toolbar"
        aria-label={tr('PDF 阅读')}
        className="flex h-10 shrink-0 items-center gap-0.5 border-b border-line bg-surface px-1.5"
      >
        <IconButton
          label={tr('上一页')}
          size="sm"
          disabled={page <= 1}
          onClick={() => scrollToPage(page - 1)}
        >
          <ChevronLeft strokeWidth={1.75} aria-hidden />
        </IconButton>
        <form
          className="flex items-center gap-1 text-caption text-fg-muted tabular-nums"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number.parseInt(pageInput, 10);
            if (Number.isFinite(n)) scrollToPage(n);
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
          onClick={() => scrollToPage(page + 1)}
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
        <div className="ml-auto flex min-w-0 items-center gap-0.5">{actions}</div>
      </div>

      {selectionTools}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-auto bg-subtle [scrollbar-gutter:stable]"
        tabIndex={0}
        aria-label={tr('PDF 页面')}
      >
        {error ? (
          <p className="px-4 py-10 text-center text-small text-danger">
            {tr('PDF 显示失败：{error}', { error })}
          </p>
        ) : !doc ? (
          <div className="flex h-full items-center justify-center">
            <Spinner label={tr('正在加载 PDF')} />
          </div>
        ) : (
          <div
            className="flex flex-col items-center"
            style={{ padding: PAD, gap: GAP, minWidth: 'min-content' }}
          >
            {sizes.map((s, i) => (
              <PdfPage
                key={i}
                doc={doc}
                index={i + 1}
                size={s}
                scale={scale}
                root={scrollRef}
                marks={marksByPage.get(i + 1)}
                onPointer={onPointer}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PdfPage({
  doc,
  index,
  size,
  scale,
  root,
  marks,
  onPointer,
}: {
  doc: PDFDocumentProxy;
  index: number;
  size: { width: number; height: number };
  scale: number;
  root: React.RefObject<HTMLDivElement | null>;
  marks: PageMark[] | undefined;
  onPointer: Props['onPointer'];
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [markViewport, setMarkViewport] = useState<{
    scale: number;
    viewport: PageViewport;
  } | null>(null);
  const [textState, setTextState] = useState<{
    scale: number;
    status: 'ready' | 'empty' | 'failed';
  } | null>(null);
  const [visible, setVisible] = useState(
    () => index <= 2 || typeof IntersectionObserver === 'undefined',
  );
  const w = Math.floor(size.width * scale);
  const h = Math.floor(size.height * scale);

  useEffect(() => {
    if (!visible || !textRef.current) return;
    const host = textRef.current;
    host.replaceChildren();
    let cancelled = false;
    let layer: TextLayer | null = null;
    void (async () => {
      try {
        const [p, lib] = await Promise.all([doc.getPage(index), loadPdfJs()]);
        const content = await p.getTextContent();
        if (cancelled) return;
        if (!content.items.some((item) => 'str' in item && item.str.trim())) {
          setTextState({ scale, status: 'empty' });
          return;
        }
        const viewport = p.getViewport({ scale });
        setMarkViewport({ scale, viewport });
        host.style.setProperty('--total-scale-factor', String(scale * p.userUnit));
        layer = new lib.TextLayer({ textContentSource: content, container: host, viewport });
        await layer.render();
        if (!cancelled) setTextState({ scale, status: 'ready' });
      } catch {
        if (!cancelled) setTextState({ scale, status: 'failed' });
      }
    })();
    return () => {
      cancelled = true;
      layer?.cancel();
      host.replaceChildren();
    };
  }, [doc, index, scale, visible]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { root: root.current, rootMargin: '800px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!visible) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    void (async () => {
      const p = await doc.getPage(index);
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const dpr = Math.min(2.5, window.devicePixelRatio || 1);
      const vp = p.getViewport({ scale: scale * dpr });
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
    })().catch(() => {
      /* 文字层与画布的异步取消不向页面抛出未处理错误。 */
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, index, scale, visible]);

  return (
    <div
      ref={boxRef}
      className="lib-pdf-page relative shrink-0 shadow-md"
      style={{ width: w, height: h }}
      data-page={index}
      onClick={(e) => {
        if (!onPointer) return;
        if (window.getSelection()?.toString().trim()) return;
        const r = e.currentTarget.getBoundingClientRect();
        onPointer(index, (e.clientX - r.left) / scale, (e.clientY - r.top) / scale);
      }}
    >
      <canvas
        ref={canvasRef}
        aria-label={tr('第 {index} 页', { index })}
        style={{ width: w, height: h }}
      />
      <div ref={textRef} className="lib-pdf-text" aria-label={tr('第 {index} 页文字', { index })} />
      {textState?.scale === scale && textState.status !== 'ready' && (
        <p className="pointer-events-none absolute inset-x-2 bottom-2 rounded-md bg-elevated px-3 py-2 text-caption text-fg-muted">
          {textState.status === 'empty'
            ? tr('本页没有可选文字，可能是扫描图片。暂不支持划词翻译。')
            : tr('本页文字层加载失败，请重新打开论文后再试。')}
        </p>
      )}
      {markViewport?.scale === scale && (
        <AnnotationMarks
          marks={(marks ?? []).flatMap((m) =>
            m.tone === 'highlight' || m.tone === 'comment'
              ? [
                  {
                    key: m.annotationKey,
                    tone: m.tone,
                    color: m.color,
                    active: m.active,
                    rect: projectSelectionBox(m.box, markViewport.viewport),
                  },
                ]
              : [],
          )}
        />
      )}
      {marks?.map((m) => {
        if (m.tone === 'highlight' || m.tone === 'comment') return null;
        return (
          <span
            key={m.key}
            aria-hidden
            className={cn(
              'lib-mark pointer-events-none absolute rounded-xs',
              m.tone === 'flash' ? 'lib-mark-flash' : 'lib-mark-select',
            )}
            style={{
              left: m.box.x * scale - 2,
              top: m.box.y * scale - 1,
              width: m.box.w * scale + 4,
              height: m.box.h * scale + 2,
            }}
          />
        );
      })}
    </div>
  );
}
