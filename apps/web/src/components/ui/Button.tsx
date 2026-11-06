import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 加载中：文字保留，左侧图标换成旋转图标，宽度不变 */
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  fullWidth?: boolean;
}

const VARIANT: Record<ButtonVariant, string> = {
  // 实心底用 *-solid：暗色主题下白字也 ≥ 4.5:1（tokens.css）
  primary: 'bg-accent-solid text-accent-fg shadow-xs hover:bg-accent-solid-hover',
  secondary: 'border border-line-strong bg-surface text-fg shadow-xs hover:bg-subtle',
  ghost:
    'text-fg-muted hover:bg-subtle hover:text-fg aria-expanded:bg-subtle aria-pressed:bg-subtle',
  subtle: 'bg-subtle text-fg hover:bg-muted',
  danger: 'bg-danger-solid text-accent-fg shadow-xs hover:bg-danger-solid-hover',
};

/** 触屏上看不见的外扩点击区，让热区到 40–44px，不改版面 */
const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-small pointer-coarse:after:-inset-2',
  md: 'h-8 gap-1.5 px-3 text-body pointer-coarse:after:-inset-1.5',
  lg: 'h-10 gap-2 px-4 text-body pointer-coarse:after:-inset-0.5',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    leftIcon,
    rightIcon,
    fullWidth,
    disabled,
    type = 'button',
    className,
    children,
    ...props
  },
  ref,
) {
  const hasIcon = Boolean(leftIcon);
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-variant={variant}
      className={cn(
        'press relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md font-medium whitespace-nowrap select-none',
        'disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
        // 触屏：看不见的外扩点击区（28px → 44px，32px → 44px，40px → 44px），外扩量见 SIZE
        'pointer-coarse:after:absolute',
        VARIANT[variant],
        SIZE[size],
        fullWidth && 'w-full',
        loading && 'disabled:opacity-80',
        className,
      )}
      {...props}
    >
      {hasIcon && (loading ? <Spinner /> : leftIcon)}
      {!hasIcon && loading && (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner />
        </span>
      )}
      <span className={cn('inline-flex items-center', !hasIcon && loading && 'opacity-0')}>
        {children}
      </span>
      {rightIcon}
    </button>
  );
});
