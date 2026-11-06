import { forwardRef, type HTMLAttributes, type Key } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { paletteSoft, paletteVar } from '@/lib/palette';

export type BadgeTone = 'neutral' | 'accent' | 'agent' | 'success' | 'warning' | 'danger';

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'color'> {
  tone?: BadgeTone;
  /** 色板序号 0–7（标签、项目色）；设置后忽略 tone */
  color?: number | undefined;
  /** 内容变化时（例如计数）用 overshoot 弹一下：传入会变化的值 */
  animateKey?: Key;
  /** 前置一个同色小圆点 */
  dot?: boolean;
}

const TONE: Record<BadgeTone, string> = {
  neutral: 'bg-muted text-fg-muted',
  accent: 'bg-accent-soft text-accent-text',
  agent: 'bg-agent-soft text-agent-text',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
};

/** 高 20 的药丸标签：*-soft 底 + 对应文字。 */
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { tone = 'neutral', color, animateKey, dot, className, style, children, ...props },
  ref,
) {
  // 减少动态效果时 popIn 只剩淡入淡出
  const { variants } = useMotionPreset();
  const paletteStyle =
    color === undefined
      ? undefined
      : { backgroundColor: paletteSoft(color), color: paletteVar(color) };

  return (
    <span
      ref={ref}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-caption whitespace-nowrap tabular-nums',
        color === undefined && TONE[tone],
        className,
      )}
      style={{ ...paletteStyle, ...style }}
      {...props}
    >
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {animateKey === undefined ? (
        children
      ) : (
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={animateKey}
            className="inline-flex"
            variants={variants.popIn}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            {children}
          </motion.span>
        </AnimatePresence>
      )}
    </span>
  );
});
