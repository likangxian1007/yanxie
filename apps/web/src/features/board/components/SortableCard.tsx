import type { KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Card } from '@srh/shared';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { cardRenderKey } from '../data';
import { CardTile } from './CardTile';
import { tr } from '@/lib/i18n';

export interface SortableCardProps {
  card: Card;
  /** 可写时才能拖动 */
  draggable: boolean;
  /** 关闭期间（拖拽中、刚放下）不做 layout 动画，避免和 dnd-kit 的位移打架 */
  animateLayout: boolean;
  onOpen: (cardId: string) => void;
}

/**
 * 可拖动的卡片：dnd-kit 负责拖拽位移，motion 负责“别人移动/新增”的 layout 动画与新卡 fadeUp。
 * 拖动中原位置显示同尺寸的虚线占位框。回车打开详情，空格拿起/放下（键盘拖动）。
 */
export function SortableCard({ card, draggable, animateLayout, onOpen }: SortableCardProps) {
  const { spring, variants } = useMotionPreset();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    disabled: !draggable,
    data: { type: 'card', columnId: card.columnId },
  });
  const layoutKey = cardRenderKey(card.id);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && !isDragging && e.target === e.currentTarget) {
      e.preventDefault();
      onOpen(card.id);
      return;
    }
    listeners?.onKeyDown?.(e);
  };

  return (
    <motion.div
      layout={animateLayout ? 'position' : false}
      layoutId={animateLayout ? `card-${layoutKey}` : undefined}
      transition={spring.gentle}
      variants={variants.fadeUp}
      initial="hidden"
      animate="visible"
      className="shrink-0"
    >
      <div
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        aria-roledescription={draggable ? tr('可拖动的卡片') : undefined}
        aria-disabled={undefined}
        aria-label={card.title}
        onKeyDown={onKeyDown}
        onClick={() => onOpen(card.id)}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        className={cn(
          'group/card relative cursor-pointer rounded-lg outline-offset-2 select-none',
          draggable && 'touch-manipulation',
        )}
      >
        {isDragging ? (
          <div className="rounded-lg border border-dashed border-line-strong bg-muted/40">
            <CardTile card={card} className="invisible" aria-hidden />
          </div>
        ) : (
          <CardTile card={card} />
        )}
      </div>
    </motion.div>
  );
}
