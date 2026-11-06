import { useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { BookOpen, FileText, SquareSlash, type LucideIcon } from 'lucide-react';
import { Kbd } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { SLASH_GROUP_LABEL, slashOptionId, type SlashGroup, type SlashItem } from '../slash';
import { tr, trServer } from '@/lib/i18n';

const GROUP_ICON: Record<SlashGroup, LucideIcon> = {
  builtin: SquareSlash,
  skill: BookOpen,
  custom: FileText,
};

export interface SlashMenuProps {
  id: string;
  items: SlashItem[];
  index: number;
  /** 没有输入查询时按分组显示小标题 */
  grouped: boolean;
  onHover: (index: number) => void;
  onPick: (item: SlashItem) => void;
}

/**
 * 斜杠指令菜单：浮在输入框上方，焦点始终留在输入框（aria-activedescendant）。
 * 行在 mousedown 时阻止失焦，点击选择；↑↓ / Enter / Tab / Esc 由输入框处理。
 */
export function SlashMenu({ id, items, index, grouped, onHover, onPick }: SlashMenuProps) {
  const { variants } = useMotionPreset();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [index]);

  return (
    <motion.div
      variants={variants.scaleIn}
      initial="hidden"
      animate="visible"
      exit="exit"
      style={{ transformOrigin: 'bottom left' }}
      className="absolute inset-x-0 bottom-full z-popover mb-2 overflow-hidden rounded-lg border border-line bg-elevated text-left shadow-lg"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div
        ref={listRef}
        id={id}
        role="listbox"
        aria-label={tr('斜杠指令')}
        className="max-h-[min(18rem,45dvh)] overflow-y-auto p-1"
      >
        {items.map((item, i) => {
          const Icon = GROUP_ICON[item.group];
          const prev = items[i - 1];
          const showGroup = grouped && (!prev || prev.group !== item.group);
          const active = i === index;
          return (
            <div key={`${item.group}:${item.name}`} role="presentation">
              {showGroup && (
                <div role="presentation" className="px-2 pt-1.5 pb-1 text-caption text-fg-subtle">
                  {SLASH_GROUP_LABEL[item.group]}
                </div>
              )}
              <div
                id={slashOptionId(id, i)}
                role="option"
                aria-selected={active}
                onMouseEnter={() => onHover(i)}
                onClick={() => onPick(item)}
                className={cn(
                  'flex min-h-8 cursor-pointer items-start gap-2.5 rounded-sm px-2 py-1.5 select-none',
                  'transition-colors duration-(--dur-fast) ease-(--ease-standard)',
                  active ? 'bg-subtle' : 'hover:bg-subtle',
                )}
              >
                <Icon
                  size={16}
                  strokeWidth={1.75}
                  aria-hidden
                  className={cn(
                    'mt-0.5 shrink-0',
                    item.group === 'skill' ? 'text-agent' : 'text-fg-subtle',
                  )}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-x-3 sm:flex-row sm:items-baseline">
                  <span className="flex min-w-0 shrink-0 items-baseline gap-1.5">
                    <span className="font-mono text-small text-fg">/{item.name}</span>
                    {item.argumentHint && (
                      <span className="truncate font-mono text-caption font-normal text-fg-subtle">
                        {trServer(item.argumentHint)}
                      </span>
                    )}
                    {item.label && (
                      <span className="truncate text-small text-fg-muted">{item.label}</span>
                    )}
                  </span>
                  <span className="min-w-0 truncate text-caption font-normal text-fg-subtle sm:ml-auto sm:text-right">
                    {trServer(item.description)}
                  </span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <div
        aria-hidden
        className="hidden items-center gap-3 border-t border-line px-3 py-1.5 text-caption font-normal text-fg-subtle sm:flex"
      >
        <span className="inline-flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          {tr('选择')}
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Enter</Kbd>
          {tr('确认')}
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Esc</Kbd>
          {tr('关闭')}
        </span>
      </div>
    </motion.div>
  );
}
