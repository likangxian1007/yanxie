import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';

export interface SwitchProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onChange' | 'value'
> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}

/** 滑块行程（px）：轨道 w-9(36) − 内边距 p-0.5×2(4) − 滑块 size-4(16) */
const KNOB_TRAVEL = 16;

/**
 * 开关：rounded-full，拨动用 spring.snappy（STYLE §4.1 --dur-instant 级别的反馈）。
 * 滑块位置表示开/关状态，减少动态效果时 useMotionPreset 的弹簧变为瞬时，直接跳到终点、不滑动。
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onCheckedChange, label, className, disabled, ...props },
  ref,
) {
  const { spring } = useMotionPreset();
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full p-0.5',
        // 触屏：看不见的外扩点击区 36×20 → 44×44，不改版面
        'pointer-coarse:after:absolute pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-3',
        'transition-colors duration-(--dur-fast) ease-(--ease-standard) disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-muted ring-1 ring-line-strong ring-inset',
        className,
      )}
      {...props}
    >
      <motion.span
        aria-hidden
        className="block size-4 rounded-full bg-accent-fg shadow-xs"
        initial={false}
        animate={{ x: checked ? KNOB_TRAVEL : 0 }}
        transition={spring.snappy}
      />
    </button>
  );
});
