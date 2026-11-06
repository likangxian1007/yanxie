import { BrandSymbol } from '@/components/ui/BrandSymbol';
import { cn } from '@/lib/cn';
import { tr } from '@/lib/i18n';

/** 原创日月圆印：圆形框架与连续折线构成研协的独立标识。 */
export function BrandMark({
  withText = true,
  className,
}: {
  withText?: boolean;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <BrandSymbol />
      {withText && <span className="text-h2 tracking-tight text-fg">{tr('研协')}</span>}
    </span>
  );
}
