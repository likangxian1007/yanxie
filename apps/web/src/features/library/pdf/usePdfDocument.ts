import { useEffect, useState } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { BundledDataFactory, loadPdfJs } from '@/features/docs/editors/latex/compile/PdfViewer';

export interface PdfDocState {
  doc: PDFDocumentProxy | null;
  sizes: { width: number; height: number }[];
  error: string | null;
}

/** 加载一份 PDF（复用 LaTeX 预览的 PDF.js 配置：worker、CMap、标准字体），阅读器与裁图共用 */
export function usePdfDocument(data: Uint8Array | undefined): PdfDocState {
  const [state, setState] = useState<PdfDocState & { source?: Uint8Array }>({
    doc: null,
    sizes: [],
    error: null,
  });
  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    void (async () => {
      try {
        const lib = await loadPdfJs();
        task = lib.getDocument({
          data: data.slice(),
          useWorkerFetch: false,
          BinaryDataFactory: BundledDataFactory,
        });
        const doc = await task.promise;
        const sizes: { width: number; height: number }[] = [];
        for (let i = 1; i <= doc.numPages; i += 1) {
          const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
          sizes.push({ width: vp.width, height: vp.height });
        }
        if (!cancelled) setState({ source: data, doc, sizes, error: null });
      } catch (err) {
        if (!cancelled) {
          setState({
            source: data,
            doc: null,
            sizes: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [data]);
  return state.source === data ? state : { doc: null, sizes: [], error: null };
}
