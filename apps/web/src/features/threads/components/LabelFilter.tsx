import { useMemo } from 'react';
import type { Thread } from '@srh/shared';
import { cn } from '@/lib/cn';
import { paletteFromString, paletteVar } from '@/lib/palette';
import { tr } from '@/lib/i18n';

export interface LabelFilterProps {
  /** 要显示的标签（按常用程度排好） */
  labels: string[];
  /** undefined = 全部；'' = 未加标签 */
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  /** 用来算每个标签有几条 */
  counts?: readonly Pick<Thread, 'label'>[];
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * 标签筛选：一排可横向滚动的小胶囊，带色点和计数。再点一次已选中的标签回到全部。
 * 会话列表、线程列表、协作台右栏共用。
 */
export function LabelFilter({
  labels,
  value,
  onChange,
  counts,
  size = 'md',
  className,
}: LabelFilterProps) {
  const n = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of counts ?? []) {
      const k = t.label ?? '';
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [counts]);
  const hasUnlabeled = (n.get('') ?? 0) > 0;

  const chip = (
    key: string,
    label: string,
    selected: boolean,
    onClick: () => void,
    dot?: string,
  ) => (
    <button
      key={key}
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border whitespace-nowrap',
        size === 'sm' ? 'h-6 px-2 text-caption' : 'h-7 px-2.5 text-small',
        'transition-colors duration-(--dur-fast) ease-(--ease-standard)',
        selected
          ? 'border-line-strong bg-subtle font-medium text-fg'
          : 'border-line text-fg-muted hover:bg-subtle hover:text-fg',
      )}
    >
      {dot && <span aria-hidden className="size-1.5 rounded-full" style={{ background: dot }} />}
      {label}
      {counts && key !== '__all' && (
        <span className="font-normal text-fg-subtle tabular-nums">
          {n.get(key === '__none' ? '' : key) ?? 0}
        </span>
      )}
    </button>
  );

  return (
    <div
      role="group"
      aria-label={tr('按标签筛选')}
      className={cn(
        '-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      {chip('__all', tr('全部'), value === undefined, () => onChange(undefined))}
      {labels.map((l) =>
        chip(
          l,
          l,
          value === l,
          () => onChange(value === l ? undefined : l),
          paletteVar(paletteFromString(l)),
        ),
      )}
      {hasUnlabeled &&
        chip('__none', tr('未加标签'), value === '', () => onChange(value === '' ? undefined : ''))}
    </div>
  );
}
