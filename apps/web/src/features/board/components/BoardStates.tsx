import { RotateCw, TriangleAlert } from 'lucide-react';
import { Button, EmptyState, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { ApiRequestError } from '@/lib/api';
import { COLUMN_WIDTH } from './BoardColumnView';
import { tr } from '@/lib/i18n';

const CARD_ROWS = [3, 2, 1];

/** 看板骨架：三列，每列几张卡片 */
export function BoardSkeleton() {
  return (
    <div
      className="-mx-4 flex gap-3 overflow-hidden px-4 md:-mx-6 md:px-6 lg:-mx-8 lg:px-8"
      aria-busy="true"
      aria-label={tr('正在加载看板')}
    >
      {CARD_ROWS.map((rows, i) => (
        <div
          key={i}
          className={cn('shrink-0 rounded-lg border border-line bg-subtle/70 p-2', COLUMN_WIDTH)}
        >
          <Skeleton className="mx-1 mt-1 mb-3 h-4 w-24" />
          {Array.from({ length: rows }, (_, j) => (
            <Skeleton key={j} className="mb-2 h-16 rounded-lg" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function LoadError({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: unknown;
  onRetry: () => void;
}) {
  const message = error instanceof ApiRequestError ? error.message : tr('出了点问题，请稍后再试。');
  return (
    <EmptyState
      framed
      icon={TriangleAlert}
      title={title}
      description={message}
      action={
        <Button leftIcon={<RotateCw strokeWidth={1.75} aria-hidden />} onClick={onRetry}>
          {tr('重新加载')}
        </Button>
      }
    />
  );
}
