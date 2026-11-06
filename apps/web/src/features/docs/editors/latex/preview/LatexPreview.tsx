import {
  useLayoutEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type UIEvent,
} from 'react';
import { cn } from '@/lib/cn';
import type { LatexBlock } from '../render/types';
import { patchBlocks } from './patchBlocks';
import { tr } from '@/lib/i18n';

interface LatexPreviewProps {
  blocks: LatexBlock[];
  scrollRef: RefObject<HTMLDivElement | null>;
  /** 预览内容变化（DOM 更新完）时通知，用于刷新同步滚动的位置缓存 */
  onContentChange?: () => void;
  onScroll?: (e: UIEvent<HTMLDivElement>) => void;
  /** 点击章节标题：跳到源码行 */
  onJumpToLine?: (line: number) => void;
  empty?: boolean;
  className?: string;
}

/** A4 纸样式的排版预览。内容由 patchBlocks 按块增量写入（不经过 React 渲染）。 */
export function LatexPreview({
  blocks,
  scrollRef,
  onContentChange,
  onScroll,
  onJumpToLine,
  empty,
  className,
}: LatexPreviewProps) {
  const paperRef = useRef<HTMLElement | null>(null);
  const changeRef = useRef(onContentChange);
  useLayoutEffect(() => {
    changeRef.current = onContentChange;
  });

  useLayoutEffect(() => {
    const paper = paperRef.current;
    if (!paper) return;
    patchBlocks(paper, blocks);
    changeRef.current?.();
  }, [blocks]);

  const handleClick = (e: ReactMouseEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    const refLink = target.closest<HTMLElement>('a.ltx-ref');
    if (refLink) {
      e.preventDefault();
      const id = refLink.dataset.ref;
      const scroller = scrollRef.current;
      if (!id || !scroller) return;
      const dest = scroller.querySelector<HTMLElement>(`[data-anchor~="${cssEscape(id)}"]`);
      if (dest) {
        dest.scrollIntoView({ block: 'center', behavior: 'smooth' });
        dest.classList.remove('ltx-target');
        void dest.offsetWidth;
        dest.classList.add('ltx-target');
      }
      return;
    }
    const heading = target.closest<HTMLElement>('.ltx-h');
    if (heading && onJumpToLine) {
      const block = heading.closest<HTMLElement>('.ltx-block');
      const line = Number(block?.dataset.line);
      if (Number.isFinite(line) && line > 0) onJumpToLine(line);
    }
  };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={cn(
        'ltx-preview-scroll relative min-h-0 overflow-x-hidden overflow-y-auto',
        className,
      )}
      tabIndex={0}
      role="region"
      aria-label={tr('排版预览')}
    >
      <article
        ref={paperRef}
        className={cn('ltx-paper', onJumpToLine && 'ltx-paper-linked')}
        onClick={handleClick}
      />
      {empty && (
        <p className="pointer-events-none absolute inset-x-0 top-24 px-6 text-center text-small text-fg-subtle">
          {tr('源码还是空的，在左边开始写，预览会实时出现在这里。')}
        </p>
      )}
    </div>
  );
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}
