import { forwardRef, type SVGAttributes } from 'react';
import { cn } from '@/lib/cn';

export interface SpinnerProps extends SVGAttributes<SVGSVGElement> {
  /** 像素尺寸，默认 16 */
  size?: number;
  /** 提供时作为独立的加载提示朗读；不提供则视为装饰（例如按钮内） */
  label?: string;
}

/**
 * 旋转加载图标：浅色轨道 + 当前色弧线。
 * 减少动态效果时不旋转（styles/index.css 把 .animate-spin 换成原地明暗呼吸）。
 */
export const Spinner = forwardRef<SVGSVGElement, SpinnerProps>(function Spinner(
  { size = 16, label, className, ...props },
  ref,
) {
  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('shrink-0 animate-spin', className)}
      {...props}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
});
