import type { HTMLAttributes } from 'react';
import { cn } from './cn';
import { labelColor } from './label-colors';

export interface LabelDotProps extends HTMLAttributes<HTMLSpanElement> {
  label: string | null | undefined;
  /** 直径：sm = 6px，md = 8px */
  size?: 'sm' | 'md';
}

/** 标签的色点（装饰性，旁边总有标签文字，所以对读屏隐藏）。 */
export function LabelDot({ label, size = 'md', className, ...props }: LabelDotProps) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block shrink-0 rounded-full',
        size === 'sm' ? 'size-1.5' : 'size-2',
        labelColor(label).dot,
        className,
      )}
      {...props}
    />
  );
}
