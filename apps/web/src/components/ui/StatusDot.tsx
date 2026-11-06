import { forwardRef, type HTMLAttributes } from 'react';
import type { StatusBucket } from '@srh/shared';
import { cn } from '@/lib/cn';
import { STATUS_DOT_CLASS, STATUS_LABEL } from '@/lib/status';

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  status: StatusBucket;
  /** 读屏文案，默认取状态中文名（颜色不是唯一信息来源） */
  label?: string;
}

/**
 * 8px 状态点（STYLE §1.3）：working 带呼吸光环（1.8s 循环），failed 出现时轻抖一次。
 */
export const StatusDot = forwardRef<HTMLSpanElement, StatusDotProps>(function StatusDot(
  { status, label, className, ...props },
  ref,
) {
  const color = STATUS_DOT_CLASS[status];
  return (
    <span
      ref={ref}
      role="img"
      aria-label={label ?? STATUS_LABEL[status]}
      data-status={status}
      className={cn('relative inline-flex size-2 shrink-0', className)}
      {...props}
    >
      {status === 'working' && (
        <span
          aria-hidden
          className={cn('absolute inset-0 rounded-full opacity-0 animate-pulse-ring', color)}
        />
      )}
      <span
        aria-hidden
        className={cn(
          'relative inline-flex size-2 rounded-full',
          color,
          status === 'failed' && 'animate-shake',
        )}
      />
    </span>
  );
});
