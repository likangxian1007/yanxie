import { Skeleton } from '@/components/ui';
import { tr } from '@/lib/i18n';

const WIDTHS = ['w-3/4', 'w-1/2', 'w-2/3', 'w-5/12', 'w-3/5'];

/** 加载中：与真实列表同样的外框和行高，避免数据到达时跳动。 */
export function InboxSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-label={tr('正在加载待我处理的事项')}
      className="flex flex-col gap-0.5 rounded-lg border border-line bg-surface p-1 shadow-sm"
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-start gap-3 px-3 py-2.5">
          <Skeleton className="size-8 shrink-0 rounded-md" />
          <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
            <Skeleton className="h-3 w-14" />
            <Skeleton className={WIDTHS[i % WIDTHS.length]} />
          </div>
          <Skeleton className="h-3 w-10 shrink-0" />
        </div>
      ))}
    </div>
  );
}
