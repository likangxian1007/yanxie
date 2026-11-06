import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type KbdProps = HTMLAttributes<HTMLElement>;

/** 键盘按键：bg-muted rounded-xs px-1.5 text-caption font-mono */
export const Kbd = forwardRef<HTMLElement, KbdProps>(function Kbd({ className, ...props }, ref) {
  return (
    <kbd
      ref={ref}
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-xs bg-muted px-1.5 font-mono text-caption text-fg-muted',
        className,
      )}
      {...props}
    />
  );
});
