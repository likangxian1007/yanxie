import { useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AnimatePresence, motion } from 'motion/react';
import { MoreHorizontal, Plus } from 'lucide-react';
import { Avatar, IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import type { CollabPeer } from '../../collab/useCollabDoc';
import { useElementSize } from '../shared/dom';
import type { SlideRef } from './model/deck';
import { useSlide } from './model/hooks';
import type { DeckInfo } from './model/types';
import { SlideRender } from './render/SlideRender';
import { tr } from '@/lib/i18n';

interface SlideThumbnailsProps {
  slides: SlideRef[];
  deck: DeckInfo;
  currentId: string | null;
  peers: CollabPeer[];
  editable: boolean;
  onSelect: (id: string) => void;
  onMove: (from: number, to: number) => void;
  onMenu: (id: string, x: number, y: number) => void;
  onAdd: () => void;
}

/**
 * 缩略图列（窄屏变成顶部横向条）：序号 + 16:9 小缩略 + 正在看这一页的成员头像。
 * 拖拽排序用 @dnd-kit/sortable；远端增删、重排时用 layout 动画过渡。
 */
export function SlideThumbnails({
  slides,
  deck,
  currentId,
  peers,
  editable,
  onSelect,
  onMove,
  onMenu,
  onAdd,
}: SlideThumbnailsProps) {
  const { spring, variants } = useMotionPreset();
  // 拖放落下的那一帧关掉 layout 动画，避免和 dnd-kit 的位移叠加成“二次移动”
  const [settling, setSettling] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = slides.findIndex((s) => s.id === active.id);
    const to = slides.findIndex((s) => s.id === over.id);
    if (from < 0 || to < 0) return;
    setSettling(true);
    onMove(from, to);
    window.setTimeout(() => setSettling(false), 60);
  };

  const viewers = (id: string) =>
    peers.filter((p) => !p.isSelf && p.state.slide === id).slice(0, 3);

  return (
    <nav
      aria-label={tr('幻灯片列表')}
      className="flex shrink-0 gap-3 overflow-x-auto border-b border-line bg-subtle p-3 md:w-56 md:flex-col md:overflow-x-hidden md:overflow-y-auto md:border-r md:border-b-0"
      onKeyDown={(e) => {
        if (e.defaultPrevented || !(e.target as HTMLElement).dataset.thumb) return;
        const i = slides.findIndex((s) => s.id === currentId);
        const step =
          e.key === 'ArrowDown' || e.key === 'ArrowRight'
            ? 1
            : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
              ? -1
              : 0;
        if (!step) return;
        const next = slides[Math.max(0, Math.min(slides.length - 1, i + step))];
        if (next) {
          e.preventDefault();
          onSelect(next.id);
          e.currentTarget
            .querySelector<HTMLElement>(`[data-thumb="${window.CSS.escape(next.id)}"]`)
            ?.focus();
        }
      }}
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={slides.map((s) => s.id)} strategy={rectSortingStrategy}>
          <ol className="flex gap-3 md:flex-col">
            <AnimatePresence initial={false}>
              {slides.map((s, i) => (
                <motion.li
                  key={s.id}
                  layout={settling ? false : 'position'}
                  transition={spring.gentle}
                  variants={variants.scaleIn}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  className="w-36 shrink-0 md:w-auto"
                >
                  <Thumb
                    slide={s}
                    deck={deck}
                    index={i}
                    active={s.id === currentId}
                    editable={editable}
                    viewers={viewers(s.id)}
                    onSelect={onSelect}
                    onMenu={onMenu}
                  />
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
        </SortableContext>
      </DndContext>
      {editable && (
        <button
          type="button"
          onClick={onAdd}
          className="press flex w-36 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed border-line-strong py-2 text-small text-fg-muted hover:bg-surface hover:text-fg md:w-auto"
        >
          <Plus size={16} strokeWidth={1.75} aria-hidden />
          {tr('新建页面')}
        </button>
      )}
    </nav>
  );
}

interface ThumbProps {
  slide: SlideRef;
  deck: DeckInfo;
  index: number;
  active: boolean;
  editable: boolean;
  viewers: CollabPeer[];
  onSelect: (id: string) => void;
  onMenu: (id: string, x: number, y: number) => void;
}

function Thumb({
  slide: ref,
  deck,
  index,
  active,
  editable,
  viewers,
  onSelect,
  onMenu,
}: ThumbProps) {
  const slide = useSlide(ref, deck) ?? { id: ref.id, title: '', elements: [], bg: null };
  const [boxRef, box] = useElementSize<HTMLDivElement>();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: slide.id,
    disabled: !editable,
  });
  const openMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onMenu(slide.id, e.clientX, e.clientY);
  };
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('group relative flex gap-2', isDragging && 'z-[1] opacity-90')}
    >
      <span
        aria-hidden
        className={cn(
          'w-4 shrink-0 pt-0.5 text-right text-caption tabular-nums',
          active ? 'text-accent-text' : 'text-fg-subtle',
        )}
      >
        {index + 1}
      </span>
      <div ref={boxRef} className="relative min-w-0 flex-1">
        <button
          type="button"
          data-thumb={slide.id}
          aria-current={active ? 'true' : undefined}
          aria-label={tr('第 {value} 页：{value2}', {
            value: index + 1,
            value2: slide.title || tr('未命名页面'),
          })}
          {...attributes}
          {...listeners}
          tabIndex={active ? 0 : -1}
          onClick={() => onSelect(slide.id)}
          onContextMenu={openMenu}
          className={cn(
            'block w-full cursor-pointer overflow-hidden rounded-md ring-1 transition-shadow duration-(--dur-fast)',
            active ? 'ring-2 ring-accent' : 'ring-line hover:ring-line-strong',
            isDragging && 'shadow-md',
          )}
        >
          {box.width > 0 ? (
            <SlideRender
              elements={slide.elements}
              bg={slide.bg}
              deck={deck}
              width={box.width}
              className="pointer-events-none"
            />
          ) : (
            <span className="block" style={{ aspectRatio: `${deck.width} / ${deck.height}` }} />
          )}
        </button>
        {viewers.length > 0 && (
          <span className="pointer-events-none absolute right-1 bottom-1 flex -space-x-1.5">
            {viewers.map((p) => (
              <Avatar
                key={p.clientId}
                name={p.user.name}
                color={p.user.colorIndex}
                kind={p.user.kind}
                size={20}
                ring
              />
            ))}
          </span>
        )}
        {editable && (
          <IconButton
            label={tr('页面操作')}
            size="sm"
            variant="secondary"
            tooltip={false}
            onClick={openMenu}
            className="absolute top-1 right-1 size-6 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
          >
            <MoreHorizontal strokeWidth={1.75} aria-hidden />
          </IconButton>
        )}
      </div>
    </div>
  );
}
