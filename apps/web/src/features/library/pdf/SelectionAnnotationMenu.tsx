import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Highlighter, MessageSquarePlus, Quote } from 'lucide-react';
import { Button } from '@/components/ui';
import type { PdfTextSelection } from './selection';
import { tr } from '@/lib/i18n';

/** 不占阅读区高度，也不抢走原文选区；屏幕坐标与保存的 PDF 坐标分离。 */
export function SelectionAnnotationMenu({
  selection,
  onChoose,
  onAsk,
  onClose,
}: {
  selection: PdfTextSelection;
  onChoose?: (kind: 'highlight' | 'comment', selection: PdfTextSelection) => void;
  onAsk?: (selection: PdfTextSelection) => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  useLayoutEffect(() => {
    const element = root.current,
      anchor = selection.menuAnchor;
    if (!element || !anchor) return;
    const bounds = element.getBoundingClientRect(),
      viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0,
      top = viewport?.offsetTop ?? 0;
    const right = left + (viewport?.width ?? window.innerWidth);
    const bottom = top + (viewport?.height ?? window.innerHeight);
    const x = Math.max(left + 8, Math.min(anchor.x + 12, right - bounds.width - 8));
    const y =
      anchor.y + 12 + bounds.height <= bottom - 8 ? anchor.y + 12 : anchor.y - bounds.height - 12;
    setPosition({
      left: x,
      top: Math.max(top + 8, Math.min(y, bottom - bounds.height - 8)),
    });
  }, [selection]);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      const focusKeepingSelection = (element: HTMLElement | null | undefined) => {
        if (!element) return;
        const selected = window.getSelection();
        const range = selected?.rangeCount ? selected.getRangeAt(0) : null;
        element.focus({ preventScroll: true });
        if (selected && range) {
          selected.removeAllRanges();
          selected.addRange(range);
        }
      };
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (root.current?.contains(document.activeElement)) {
          const node = window.getSelection()?.anchorNode;
          focusKeepingSelection(
            node?.parentElement?.closest<HTMLElement>(`[aria-label="${tr('PDF 页面')}"]`),
          );
        }
        onClose();
      } else if (event.key === 'Tab') {
        const controls = Array.from(
          root.current?.querySelectorAll<HTMLButtonElement>('button') ?? [],
        );
        const current = controls.indexOf(document.activeElement as HTMLButtonElement);
        const fromPdf =
          document.activeElement === document.body ||
          document.activeElement?.closest(`[aria-label="${tr('PDF 页面')}"]`);
        const next =
          current >= 0 ? current + (event.shiftKey ? -1 : 1) : !event.shiftKey && fromPdf ? 0 : -1;
        if (next >= 0 && next < controls.length) {
          event.preventDefault();
          focusKeepingSelection(controls[next]);
        }
      }
    };
    const scroll = (event: Event) => {
      // 菜单自身不滚动；不因侧栏输出滚动打断原文操作。
      if (
        event.target === document ||
        event.target === window ||
        (event.target instanceof Element && event.target.querySelector('.lib-pdf-text'))
      )
        onClose();
    };
    document.addEventListener('pointerdown', closeOutside, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('scroll', scroll, true);
    document.addEventListener('fullscreenchange', onClose);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    window.visualViewport?.addEventListener('resize', onClose);
    window.visualViewport?.addEventListener('scroll', onClose);
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('scroll', scroll, true);
      document.removeEventListener('fullscreenchange', onClose);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
      window.visualViewport?.removeEventListener('resize', onClose);
      window.visualViewport?.removeEventListener('scroll', onClose);
    };
  }, [onClose]);
  if (!selection.menuAnchor) return null;
  return createPortal(
    <div
      ref={root}
      role="group"
      aria-label={tr('选区标注操作')}
      data-library-selection-tools
      className="fixed z-popover flex gap-1 rounded-lg border border-line bg-elevated p-1 shadow-lg select-none"
      style={{ ...position, visibility: position ? 'visible' : 'hidden' }}
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      {onChoose && (
        <Button
          size="sm"
          variant="ghost"
          aria-label={tr('保存高亮')}
          className="h-9 pointer-coarse:h-11 pointer-coarse:after:inset-0"
          leftIcon={<Highlighter strokeWidth={1.75} aria-hidden />}
          onClick={() => {
            onClose();
            onChoose('highlight', selection);
          }}
        >
          {tr('高亮')}
        </Button>
      )}
      {onChoose && (
        <Button
          size="sm"
          variant="ghost"
          aria-label={tr('添加批注')}
          className="h-9 pointer-coarse:h-11 pointer-coarse:after:inset-0"
          leftIcon={<MessageSquarePlus strokeWidth={1.75} aria-hidden />}
          onClick={() => {
            onClose();
            onChoose('comment', selection);
          }}
        >
          {tr('批注')}
        </Button>
      )}
      {onAsk && (
        <Button
          size="sm"
          variant="ghost"
          className="h-9 pointer-coarse:h-11 pointer-coarse:after:inset-0"
          leftIcon={<Quote strokeWidth={1.75} aria-hidden />}
          onClick={() => {
            onClose();
            onAsk(selection);
          }}
        >
          {tr('引用到问答')}
        </Button>
      )}
    </div>,
    document.body,
  );
}
