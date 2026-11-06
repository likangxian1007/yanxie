import { createContext, useContext, useSyncExternalStore } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PaperChunk, PaperDetail, PdfBox } from '@srh/shared';
import type { LibraryScope } from './scope';
import { tr } from '@/lib/i18n';

/** 阅读器上下文：右侧面板跳到 PDF、裁图共用同一份 PDF 文档 */
export interface ReaderCtx {
  paper: PaperDetail;
  doc: PDFDocumentProxy | null;
  /** 跳到某页并闪烁高亮这些框 */
  jump: (page: number, boxes?: PdfBox[]) => void;
  /** 当前在 PDF 上选中的段落 */
  activeSeq: number | null;
  writable: boolean;
  /** 文献笔记和标签允许全部项目成员编辑；管理和付费调用另看 writable。 */
  editable: boolean;
  scope: LibraryScope;
}

export const ReaderContext = createContext<ReaderCtx | null>(null);

export function useReader(): ReaderCtx {
  const c = useContext(ReaderContext);
  if (!c) throw new Error(tr('useReader 只能在阅读器里用'));
  return c;
}

/** 引用标记 → 段落：同页同段号；只有页码时取那一页第一段 */
export function findChunk(
  chunks: PaperChunk[],
  page: number,
  para: number | null,
): PaperChunk | undefined {
  if (para !== null) {
    const exact = chunks.find((c) => c.page === page && c.para === para);
    if (exact) return exact;
  }
  return chunks.find((c) => c.page === page);
}

/** 点到 PDF 上某个点 → 包含它的段落 */
export function chunkAt(chunks: PaperChunk[], page: number, x: number, y: number) {
  return chunks.find((c) =>
    c.boxes.some(
      (b) =>
        b.page === page && x >= b.x - 2 && x <= b.x + b.w + 2 && y >= b.y - 2 && y <= b.y + b.h + 2,
    ),
  );
}

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const mq = window.matchMedia(query);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true),
    () => true,
  );
}
