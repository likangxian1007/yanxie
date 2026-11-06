import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Kbd } from './Kbd';
import { Tooltip, type TooltipSide } from './Tooltip';

export type IconButtonVariant = 'ghost' | 'subtle' | 'secondary' | 'primary';
export type IconButtonSize = 'sm' | 'md' | 'lg';

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label'
> {
  /** 必填：同时作为 aria-label 和 Tooltip 文案 */
  label: string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  /** Tooltip 里展示的快捷键，如 "⌘K" */
  shortcut?: string;
  tooltipSide?: TooltipSide;
  /** 想关掉 Tooltip 时传 false（例如所在区域已有可见文字） */
  tooltip?: boolean;
  children: ReactNode;
}

const VARIANT: Record<IconButtonVariant, string> = {
  ghost:
    'text-fg-muted hover:bg-subtle hover:text-fg aria-expanded:bg-subtle aria-expanded:text-fg aria-pressed:bg-subtle aria-pressed:text-fg',
  subtle: 'bg-subtle text-fg-muted hover:bg-muted hover:text-fg',
  secondary:
    'border border-line-strong bg-surface text-fg-muted shadow-xs hover:bg-subtle hover:text-fg',
  primary: 'bg-accent-solid text-accent-fg shadow-xs hover:bg-accent-solid-hover',
};

/** 触屏上看不见的外扩点击区：28 → 44、32 → 44、36 → 44px */
const SIZE: Record<IconButtonSize, string> = {
  sm: 'size-7 rounded-sm pointer-coarse:after:-inset-2',
  md: 'size-8 rounded-md pointer-coarse:after:-inset-1.5',
  lg: 'size-9 rounded-md pointer-coarse:after:-inset-1',
};

/** 方形图标按钮（28/32/36），必须带 label（aria-label + Tooltip）。 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    variant = 'ghost',
    size = 'md',
    shortcut,
    tooltipSide = 'bottom',
    tooltip = true,
    type = 'button',
    className,
    children,
    ...props
  },
  ref,
) {
  return (
    <Tooltip
      disabled={!tooltip}
      side={tooltipSide}
      content={
        <>
          <span>{label}</span>
          {shortcut && (
            <Kbd className="h-4 min-w-4 bg-fg-inverse/15 px-1 text-[0.6875rem] text-fg-inverse">
              {shortcut}
            </Kbd>
          )}
        </>
      }
    >
      <button
        ref={ref}
        type={type}
        aria-label={label}
        className={cn(
          'press relative inline-flex shrink-0 cursor-pointer items-center justify-center disabled:cursor-not-allowed disabled:opacity-50',
          '[&_svg]:size-4 [&_svg]:shrink-0',
          // 触屏：看不见的外扩点击区（外扩量见 SIZE），不改版面
          'pointer-coarse:after:absolute',
          VARIANT[variant],
          SIZE[size],
          className,
        )}
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  );
});
