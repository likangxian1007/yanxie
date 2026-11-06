import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { withBase } from '@/lib/base-path';
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ImageOff,
  Maximize2,
  RotateCw,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { IconButton, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { ICON_STROKE } from '../components/icons';
import { tr } from '@/lib/i18n';

type Align = 'left' | 'center' | 'right';

const ALIGNS: { value: Align; label: string; icon: LucideIcon }[] = [
  { value: 'left', label: tr('靠左'), icon: AlignLeft },
  { value: 'center', label: tr('居中'), icon: AlignCenter },
  { value: 'right', label: tr('靠右'), icon: AlignRight },
];

const MIN_WIDTH = 80;

/**
 * 图片块：加载中骨架、加载失败可重试；选中时可以拖两侧把手调宽度、改对齐、写图注。
 * 宽度 / 对齐 / 图注都是节点属性（协同同步，最后写入的生效）。
 */
export function ImageView({
  node,
  updateAttributes,
  selected,
  editor,
  deleteNode,
}: ReactNodeViewProps) {
  const src = String(node.attrs.src ?? '');
  const alt = String(node.attrs.alt ?? '');
  const caption = String(node.attrs.caption ?? '');
  const width =
    typeof node.attrs.width === 'number' ? node.attrs.width : Number(node.attrs.width) || null;
  const align = (
    ['left', 'right'].includes(String(node.attrs.align)) ? node.attrs.align : 'center'
  ) as Align;
  const editable = editor.isEditable;

  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [draft, setDraft] = useState(caption);
  const focused = useRef(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const [prevSrc, setPrevSrc] = useState(src);
  if (prevSrc !== src) {
    setPrevSrc(src);
    setStatus('loading');
  }
  useEffect(() => {
    if (!focused.current) setDraft(caption);
  }, [caption]);

  const shownWidth = dragWidth ?? width;

  const startResize = (side: 'left' | 'right') => (e: ReactPointerEvent<HTMLSpanElement>) => {
    const frame = frameRef.current;
    if (!frame) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = frame.getBoundingClientRect().width;
    const maxW = frame.parentElement?.getBoundingClientRect().width ?? startW;
    const factor = align === 'center' ? 2 : 1;
    let latest = startW;
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) * (side === 'right' ? 1 : -1) * factor;
      latest = Math.round(Math.max(MIN_WIDTH, Math.min(maxW, startW + dx)));
      setDragWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDragWidth(null);
      updateAttributes({ width: latest >= maxW - 1 ? null : latest });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const commitCaption = () => {
    const next = draft.trim();
    if (next !== caption) updateAttributes({ caption: next });
  };

  return (
    <NodeViewWrapper
      as="figure"
      data-type="image"
      className={cn(
        'rich-image group/image relative my-1 flex flex-col',
        align === 'left' ? 'items-start' : align === 'right' ? 'items-end' : 'items-center',
      )}
    >
      <div
        ref={frameRef}
        data-drag-handle
        className={cn(
          'relative max-w-full overflow-hidden rounded-md',
          selected && editable && 'ring-2 ring-accent ring-offset-2 ring-offset-canvas',
        )}
        style={{ width: shownWidth ? `${shownWidth}px` : undefined }}
      >
        {status === 'loading' && (
          <Skeleton
            className="aspect-video w-[min(480px,100%)] rounded-md"
            aria-label={tr('图片加载中')}
          />
        )}
        {status === 'error' ? (
          <div className="flex aspect-video w-[min(480px,100%)] max-w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-line-strong bg-subtle px-4 text-center text-small text-fg-muted">
            <ImageOff size={20} strokeWidth={ICON_STROKE} aria-hidden />
            <span>
              {tr('图片没有加载出来')}
              {alt ? tr('：{alt}', { alt }) : ''}
            </span>
            <button
              type="button"
              data-node-interactive
              className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-accent-text hover:bg-accent-soft"
              onClick={() => {
                setStatus('loading');
                setAttempt((n) => n + 1);
              }}
            >
              <RotateCw size={12} strokeWidth={ICON_STROKE} aria-hidden />
              {tr('重试')}
            </button>
          </div>
        ) : (
          <img
            key={attempt}
            src={withBase(src)}
            alt={alt || caption || tr('图片')}
            draggable={false}
            onLoad={() => setStatus('ok')}
            onError={() => setStatus('error')}
            className={cn(
              'block h-auto w-full',
              status === 'loading' && 'absolute size-0 opacity-0',
            )}
          />
        )}
        {editable && selected && status !== 'error' && (
          <>
            <ResizeHandle side="left" onPointerDown={startResize('left')} />
            <ResizeHandle side="right" onPointerDown={startResize('right')} />
          </>
        )}
        {shownWidth !== null && dragWidth !== null && (
          <span className="absolute top-2 right-2 rounded-sm bg-overlay px-1.5 py-0.5 text-caption text-accent-fg tabular-nums">
            {dragWidth}px
          </span>
        )}
      </div>

      {editable && selected && (
        <div
          data-node-interactive
          role="toolbar"
          aria-label={tr('图片')}
          className="absolute -top-10 z-sticky flex items-center gap-0.5 rounded-lg border border-line bg-elevated p-1 shadow-md"
        >
          {ALIGNS.map((a) => {
            const Icon = a.icon;
            return (
              <IconButton
                key={a.value}
                size="sm"
                label={a.label}
                aria-pressed={align === a.value}
                className={cn(align === a.value && 'bg-accent-soft text-accent-text')}
                onClick={() => updateAttributes({ align: a.value })}
              >
                <Icon strokeWidth={ICON_STROKE} />
              </IconButton>
            );
          })}
          <IconButton
            size="sm"
            label={tr('原始宽度')}
            disabled={width === null}
            onClick={() => updateAttributes({ width: null })}
          >
            <Maximize2 strokeWidth={ICON_STROKE} />
          </IconButton>
          <IconButton
            size="sm"
            label={tr('删除图片')}
            className="hover:bg-danger-soft hover:text-danger"
            onClick={() => deleteNode()}
          >
            <Trash2 strokeWidth={ICON_STROKE} />
          </IconButton>
        </div>
      )}

      {editable ? (
        <input
          data-node-interactive
          aria-label={tr('图注')}
          value={draft}
          maxLength={200}
          placeholder={selected ? tr('添加图注') : ''}
          onFocus={() => (focused.current = true)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            focused.current = false;
            commitCaption();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') {
              setDraft(caption);
              e.currentTarget.blur();
            }
          }}
          className={cn(
            'mt-1.5 w-full max-w-full bg-transparent text-center text-small text-fg-muted outline-none placeholder:text-fg-subtle',
            !draft && !selected && 'h-0 mt-0',
          )}
          style={{ width: shownWidth ? `${shownWidth}px` : undefined }}
        />
      ) : (
        caption && (
          <figcaption className="mt-1.5 max-w-full text-center text-small text-fg-muted">
            {caption}
          </figcaption>
        )
      )}
    </NodeViewWrapper>
  );
}

function ResizeHandle({
  side,
  onPointerDown,
}: {
  side: 'left' | 'right';
  onPointerDown: (e: ReactPointerEvent<HTMLSpanElement>) => void;
}) {
  return (
    <span
      data-node-interactive
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? tr('拖动调整宽度（左）') : tr('拖动调整宽度（右）')}
      onPointerDown={onPointerDown}
      className={cn(
        'absolute top-1/2 h-10 w-1.5 -translate-y-1/2 cursor-ew-resize touch-none rounded-full border border-accent-fg bg-accent shadow-sm',
        side === 'left' ? 'left-1.5' : 'right-1.5',
      )}
    />
  );
}
