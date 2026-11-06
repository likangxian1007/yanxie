import { forwardRef } from 'react';
import { motion, type HTMLMotionProps } from 'motion/react';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';

export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

export interface CardProps extends HTMLMotionProps<'div'> {
  /** 可点卡片：hover 描边加深 + shadow-md + 上浮 1px（spring.gentle） */
  interactive?: boolean;
  padding?: CardPadding;
}

const PADDING: Record<CardPadding, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
};

/** bg-surface border border-line rounded-lg，默认内边距 16。 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { interactive = false, padding = 'md', className, ...props },
  ref,
) {
  const { spring } = useMotionPreset();
  return (
    <motion.div
      ref={ref}
      whileHover={interactive ? { y: -1 } : undefined}
      transition={spring.gentle}
      className={cn(
        'relative rounded-lg border border-line bg-surface shadow-sm',
        interactive &&
          'cursor-pointer transition-[border-color,box-shadow] duration-(--dur-fast) ease-(--ease-standard) hover:border-line-strong hover:shadow-md',
        PADDING[padding],
        className,
      )}
      {...props}
    />
  );
});
