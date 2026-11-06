import { useCallback, useRef, useState, type ComponentProps } from 'react';
import { Button } from '@/components/ui';
import { Quote } from 'lucide-react';
import { cn } from '@/lib/cn';
import { PaperPdfViewer } from './PaperPdfViewer';
import type { PdfTextSelection } from './selection';
import { SelectionAnnotationMenu } from './SelectionAnnotationMenu';
import { tr } from '@/lib/i18n';

type Props = Omit<ComponentProps<typeof PaperPdfViewer>, 'onSelection' | 'selectionTools'> & {
  onTextSelected: (selection: PdfTextSelection) => void;
  onOpenTranslation: () => void;
  onCreateAnnotation?: (kind: 'highlight' | 'comment', selection: PdfTextSelection) => void;
  onAskSelection?: (selection: PdfTextSelection) => void;
};

/** 外层由账号/库/论文/文件 ID 作 key；切换任何一个都会销毁选区与正在进行的翻译。 */
export function PaperSelectionReader({
  onTextSelected,
  onOpenTranslation,
  onCreateAnnotation,
  onAskSelection,
  ...viewer
}: Props) {
  const [selection, setSelection] = useState<PdfTextSelection | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [menu, setMenu] = useState<PdfTextSelection | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const lastSelection = useRef('');
  const change = useCallback(
    (next: PdfTextSelection | null, hint?: string) => {
      setSelection(next);
      setMessage(hint ?? null);
      const signature = next ? JSON.stringify([next.page, next.text, next.boxes]) : '';
      if (!next) setMenu(null);
      else if (signature !== lastSelection.current) {
        setMenu(next);
        onTextSelected(next);
      }
      lastSelection.current = signature;
    },
    [onTextSelected],
  );
  const clear = () => {
    window.getSelection()?.removeAllRanges();
    change(null);
  };
  return (
    <>
      {menu && (onCreateAnnotation || onAskSelection) && (
        <SelectionAnnotationMenu
          selection={menu}
          onChoose={onCreateAnnotation}
          onAsk={onAskSelection}
          onClose={closeMenu}
        />
      )}
      <PaperPdfViewer
        {...viewer}
        onSelection={change}
        selectionTools={
          <div
            data-library-selection-tools
            data-library-selection-bar
            className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-surface px-2 text-caption text-fg-muted select-none"
          >
            <span
              role={message ? 'status' : undefined}
              className="min-w-0 flex-1 truncate"
              title={message ?? undefined}
            >
              {selection
                ? tr('第 {page} 页 · 已选 {count} 字符', {
                    page: selection.page,
                    count: selection.text.length,
                  })
                : (message ?? tr('拖动选词或划句；双击选择一个词。'))}
            </span>
            <div className={cn('flex shrink-0 gap-1', !selection && 'hidden')}>
              {onAskSelection && (
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<Quote strokeWidth={1.75} aria-hidden />}
                  onClick={() => selection && onAskSelection(selection)}
                >
                  {tr('引用到问答')}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={onOpenTranslation}>
                {tr('查看翻译')}
              </Button>
              <Button size="sm" variant="ghost" onClick={clear}>
                {tr('取消选区')}
              </Button>
            </div>
          </div>
        }
      />
    </>
  );
}
