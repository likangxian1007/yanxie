import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { RotateCw, TriangleAlert } from 'lucide-react';
import { Button, Card, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { tr } from '@/lib/i18n';

/**
 * 线程页共用的小块：链接按钮、错误卡、骨架卡。
 * LinkButton 与 Button 的 secondary / primary 样式一致（components/ui 的 Button 不支持渲染成链接）。
 */

const LINK_BUTTON_VARIANT = {
  primary: 'bg-accent-solid text-accent-fg shadow-xs hover:bg-accent-solid-hover',
  secondary: 'border border-line-strong bg-surface text-fg shadow-xs hover:bg-subtle',
  ghost: 'text-fg-muted hover:bg-subtle hover:text-fg',
} as const;

const LINK_BUTTON_SIZE = {
  sm: 'h-7 gap-1.5 px-2.5 text-small',
  md: 'h-8 gap-1.5 px-3 text-body',
} as const;

export function LinkButton({
  to,
  children,
  leftIcon,
  variant = 'secondary',
  size = 'md',
  className,
}: {
  to: string;
  children: ReactNode;
  leftIcon?: ReactNode;
  variant?: keyof typeof LINK_BUTTON_VARIANT;
  size?: keyof typeof LINK_BUTTON_SIZE;
  className?: string;
}) {
  return (
    <Link
      to={to}
      className={cn(
        'press relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md font-medium whitespace-nowrap select-none [&_svg]:size-4 [&_svg]:shrink-0',
        'transition-colors duration-(--dur-fast) ease-(--ease-standard)',
        LINK_BUTTON_VARIANT[variant],
        LINK_BUTTON_SIZE[size],
        className,
      )}
    >
      {leftIcon}
      <span className="inline-flex items-center">{children}</span>
    </Link>
  );
}

export function ErrorCard({
  title,
  message,
  retrying,
  onRetry,
}: {
  title: string;
  message?: string | undefined;
  retrying?: boolean;
  onRetry: () => void;
}) {
  return (
    <Card role="alert" className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-md bg-danger-soft text-danger ring-1 ring-danger/15"
      >
        <TriangleAlert size={16} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-h3 text-fg">{title}</h3>
        <p className="mt-1 text-small text-pretty text-fg-muted">
          {message || tr('请检查网络或稍后再试。')}
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        loading={retrying}
        leftIcon={<RotateCw strokeWidth={1.75} aria-hidden />}
        onClick={onRetry}
        className="self-start"
      >
        {tr('重试')}
      </Button>
    </Card>
  );
}

export function ThreadCardSkeleton({ compact }: { compact?: boolean }) {
  return (
    <div
      className={cn('rounded-lg border border-line bg-surface shadow-sm', compact ? 'p-3' : 'p-4')}
    >
      <div className="flex items-start gap-3">
        <Skeleton className="mt-1.5 size-2 rounded-full" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-3.5 w-2/5" />
        </div>
      </div>
      {!compact && (
        <div className="mt-4 flex flex-col gap-2 sm:pl-5">
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-3/5" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      )}
      <div className="mt-4 flex items-center gap-3 sm:pl-5">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="ml-auto size-5 rounded-full" />
      </div>
    </div>
  );
}
