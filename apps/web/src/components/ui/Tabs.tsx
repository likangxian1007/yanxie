import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';

export interface TabItem<V extends string = string> {
  value: V;
  label: ReactNode;
  count?: number | undefined;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<V extends string = string> {
  value: V;
  onValueChange: (value: V) => void;
  items: TabItem<V>[];
  /** underline：文字 tabs + 2px accent 滑动条；segmented：分段控件 */
  variant?: 'underline' | 'segmented';
  /** 同页多组 Tabs 时传不同的 id，避免高亮块串组 */
  layoutId?: string;
  size?: 'sm' | 'md';
  className?: string;
  'aria-label'?: string;
  /** 每个 tab 关联的 panel id 前缀（可选） */
  idPrefix?: string;
}

/**
 * Tabs（STYLE §6 / §4.2-4）：选中指示用 layoutId 在项之间滑动（spring.snappy）。
 * 左右键切换，Home/End 到首尾。只渲染 tab 条，内容由调用方按 value 切换。
 */
export function Tabs<V extends string = string>({
  value,
  onValueChange,
  items,
  variant = 'underline',
  layoutId,
  size = 'md',
  className,
  idPrefix,
  'aria-label': ariaLabel,
}: TabsProps<V>) {
  const autoId = useId();
  const group = layoutId ?? autoId;
  const { spring } = useMotionPreset();
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabled = items.filter((i) => !i.disabled);
    const idx = enabled.findIndex((i) => i.value === value);
    let next: TabItem<V> | undefined;
    if (e.key === 'ArrowRight') next = enabled[(idx + 1) % enabled.length];
    else if (e.key === 'ArrowLeft') next = enabled[(idx - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    onValueChange(next.value);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)
      ?.focus();
  };

  // 窄屏横向滚动时，让选中的 tab 留在可见范围内（例如深链 ?tab=routines）
  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-value="${CSS.escape(value)}"]`);
    if (!list || !el || list.scrollWidth <= list.clientWidth) return;
    const left = el.offsetLeft - list.offsetLeft;
    if (left < list.scrollLeft || left + el.offsetWidth > list.scrollLeft + list.clientWidth) {
      list.scrollTo({ left: Math.max(0, left - 16), behavior: 'smooth' });
    }
  }, [value]);

  const segmented = variant === 'segmented';

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        'relative flex min-w-0 items-center',
        segmented
          ? 'inline-flex gap-0.5 rounded-md bg-subtle p-0.5 ring-1 ring-line'
          : 'gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]',
        className,
      )}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            data-value={item.value}
            id={idPrefix ? `${idPrefix}-tab-${item.value}` : undefined}
            aria-controls={idPrefix ? `${idPrefix}-panel-${item.value}` : undefined}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onValueChange(item.value)}
            className={cn(
              'relative inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap select-none',
              'transition-colors duration-(--dur-fast) ease-(--ease-standard) disabled:cursor-not-allowed disabled:opacity-50',
              '[&_svg]:size-4 [&_svg]:shrink-0',
              segmented
                ? cn(
                    'rounded-sm px-2.5 font-medium',
                    // 触屏：看不见的上下外扩点击区，热区到 44px 高
                    'pointer-coarse:after:absolute pointer-coarse:after:inset-x-0',
                    size === 'sm'
                      ? 'h-6 text-small pointer-coarse:after:-inset-y-2.5'
                      : 'h-7 text-small pointer-coarse:after:-inset-y-2',
                    active ? 'text-fg' : 'text-fg-muted hover:text-fg',
                  )
                : cn(
                    'px-2 font-medium',
                    size === 'sm' ? 'h-8 text-small' : 'h-10 text-body',
                    active ? 'text-fg' : 'text-fg-muted hover:text-fg',
                  ),
            )}
          >
            {active &&
              (segmented ? (
                <motion.span
                  layoutId={`${group}-seg`}
                  transition={spring.snappy}
                  aria-hidden
                  className="absolute inset-0 rounded-sm bg-surface shadow-xs ring-1 ring-line dark:bg-muted"
                />
              ) : (
                <motion.span
                  layoutId={`${group}-bar`}
                  transition={spring.snappy}
                  aria-hidden
                  className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-accent"
                />
              ))}
            {item.icon && <span className="relative flex">{item.icon}</span>}
            <span className="relative">{item.label}</span>
            {item.count !== undefined && item.count > 0 && (
              <span
                className={cn(
                  'relative min-w-4 rounded-full px-1 text-center text-caption tabular-nums',
                  active ? 'bg-accent-soft text-accent-text' : 'bg-muted text-fg-subtle',
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
