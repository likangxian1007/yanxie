import { useState, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Button, Sheet } from '@/components/ui';
import { useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/cn';
import { tr } from '@/lib/i18n';

export interface ListToolbarProps {
  search: ReactNode;
  filters?: ReactNode;
  activeFilterCount?: number;
  view?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** 手机保留搜索和视图入口，筛选集中到抽屉；只挂载一份控件，避免重复 id。 */
export function ListToolbar({
  search,
  filters,
  activeFilterCount = 0,
  view,
  actions,
  className,
}: ListToolbarProps) {
  const mobile = useMediaQuery('(max-width: 767px)');
  const [filtersOpen, setFiltersOpen] = useState(false);
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-2', className)}>
      <div className="min-w-0 flex-1 sm:max-w-80">{search}</div>
      {mobile
        ? filters && (
            <>
              <Button
                variant="secondary"
                className="min-h-11 shrink-0"
                aria-haspopup="dialog"
                aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen(true)}
              >
                <SlidersHorizontal size={16} aria-hidden />
                {tr('筛选')}
                {activeFilterCount > 0 && <span className="tabular-nums">{activeFilterCount}</span>}
              </Button>
              <Sheet
                open={filtersOpen}
                onOpenChange={setFiltersOpen}
                title={tr('筛选')}
                side="bottom"
              >
                <div className="flex flex-col gap-4 p-4">{filters}</div>
              </Sheet>
            </>
          )
        : filters && <div className="flex flex-wrap items-center gap-2">{filters}</div>}
      {view && <div className="shrink-0">{view}</div>}
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
