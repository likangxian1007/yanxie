import { cn } from '@/lib/cn';

/** 研协日月圆印；与 public/favicon.svg 保持同一轮廓。 */
export function BrandSymbol({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 40 40"
      fill="none"
      className={cn('size-8 shrink-0 text-accent', className)}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="20" cy="20" r="17" />
      <path d="M11 12h8v11h-8V12Zm0 5.5h8M10 28h10M15 23v5M24 11v17M24 12h5v7h-5M24 23h5v5" />
    </svg>
  );
}
