import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type SkeletonProps = HTMLAttributes<HTMLDivElement>;

/** 骨架屏：bg-subtle rounded-md + 1.4s 扫光。尺寸由 className 决定。 */
export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(function Skeleton(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      aria-hidden
      className={cn('skeleton-shimmer h-4 w-full rounded-md', className)}
      {...props}
    />
  );
});
