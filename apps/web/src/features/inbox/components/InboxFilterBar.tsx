import { useId } from 'react';
import { motion } from 'motion/react';
import type { InboxKind } from '@srh/shared';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { INBOX_FILTER_KINDS, INBOX_KIND_META, type InboxFilter } from '../kind-meta';
import { tr } from '@/lib/i18n';

export interface InboxFilterBarProps {
  value: InboxFilter;
  onValueChange: (value: InboxFilter) => void;
  total: number;
  counts: Record<InboxKind, number>;
  className?: string;
}

/**
 * 按类型筛选的小药丸：全部 / 决策 / 审阅 / 冲突 / 提及 / 指派 / 完成。
 * 计数为 0 的类型不显示（当前选中的除外）；选中底色用 layoutId 在药丸之间滑动。
 * 换行排布，360px 宽也不会横向滚动。
 */
export function InboxFilterBar({
  value,
  onValueChange,
  total,
  counts,
  className,
}: InboxFilterBarProps) {
  const group = useId();
  const { spring } = useMotionPreset();

  const options: { value: InboxFilter; label: string; count: number }[] = [
    { value: 'all', label: tr('全部'), count: total },
    ...INBOX_FILTER_KINDS.filter((k) => counts[k] > 0 || k === value).map((k) => ({
      value: k,
      label: INBOX_KIND_META[k].filterLabel,
      count: counts[k],
    })),
  ];

  return (
    <div
      role="group"
      aria-label={tr('按类型筛选')}
      className={cn('flex flex-wrap gap-1.5', className)}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onValueChange(opt.value)}
            className={cn(
              'press relative inline-flex h-7 cursor-pointer max-md:h-9 max-md:pl-3.5 items-center gap-1.5 rounded-full pr-1 pl-3 text-small font-medium whitespace-nowrap select-none',
              'transition-colors duration-(--dur-fast) ease-(--ease-standard)',
              active
                ? 'text-accent-text'
                : 'text-fg-muted ring-1 ring-line ring-inset hover:bg-subtle hover:text-fg',
            )}
          >
            {active && (
              <motion.span
                layoutId={`${group}-chip`}
                transition={spring.snappy}
                aria-hidden
                className="absolute inset-0 rounded-full bg-accent-soft ring-1 ring-accent/20 ring-inset"
              />
            )}
            <span className="relative">{opt.label}</span>
            <Badge tone={active ? 'accent' : 'neutral'} animateKey={opt.count} className="relative">
              {opt.count}
            </Badge>
          </button>
        );
      })}
    </div>
  );
}
