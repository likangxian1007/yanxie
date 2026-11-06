import { forwardRef, type HTMLAttributes } from 'react';
import { AlignLeft, CalendarDays, MessagesSquare } from 'lucide-react';
import type { Card } from '@srh/shared';
import { Badge, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { paletteFromString } from '@/lib/palette';
import { AssigneeStack } from '@/features/collab-kit/assignees';
import { formatDue, isOverdue } from '../lib/due';
import { hasAgentAssignee } from '../lib/filter';
import { tr } from '@/lib/i18n';

export interface CardTileProps extends HTMLAttributes<HTMLDivElement> {
  card: Card;
  /** 拖拽浮层：shadow-md + 轻微旋转 */
  overlay?: boolean;
  /** 渲染时刻（测试可注入） */
  now?: Date;
}

/**
 * 看板卡片的外观：标题、标签、截止日期、关联线程/实验、指派头像；
 * agent 指派的卡片左侧有一道 agent 渐变细竖条。
 */
export const CardTile = forwardRef<HTMLDivElement, CardTileProps>(function CardTile(
  { card, overlay, now, className, ...props },
  ref,
) {
  const agent = hasAgentAssignee(card);
  const overdue = isOverdue(card.dueAt, now);
  const hasMeta =
    Boolean(card.dueAt || card.threadId || card.description.trim()) || card.assigneeIds.length > 0;

  return (
    <div
      ref={ref}
      className={cn(
        'relative rounded-lg border border-line bg-surface px-3 py-2.5 shadow-xs',
        'transition-[border-color,box-shadow] duration-(--dur-fast) ease-(--ease-standard)',
        'group-hover/card:border-line-strong group-hover/card:shadow-md',
        agent && 'pl-4',
        overlay && 'rotate-1 cursor-grabbing border-line-strong shadow-md',
        className,
      )}
      {...props}
    >
      {agent && (
        <span
          aria-hidden
          className="absolute inset-y-2 left-1.5 w-0.5 rounded-full bg-agent-gradient"
        />
      )}
      <p className="line-clamp-4 text-body font-medium break-words text-fg">{card.title}</p>

      {card.labels.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {card.labels.map((label) => (
            <Badge key={label} color={paletteFromString(label)} className="max-w-full">
              <span className="truncate">{label}</span>
            </Badge>
          ))}
        </div>
      )}

      {hasMeta && (
        <div className="mt-2.5 flex min-h-5 items-center gap-2.5 text-caption font-normal text-fg-subtle">
          {card.dueAt && (
            <span
              className={cn(
                'inline-flex items-center gap-1 tabular-nums',
                overdue && 'font-medium text-danger',
              )}
            >
              <CalendarDays size={13} strokeWidth={1.75} aria-hidden />
              <span>
                {overdue && <span className="sr-only">{tr('已过期，')}</span>}
                {formatDue(card.dueAt, now)}
              </span>
            </span>
          )}
          {card.threadId && (
            <Tooltip content={tr('关联了线程')}>
              <span className="inline-flex" aria-label={tr('关联了线程')} role="img">
                <MessagesSquare size={13} strokeWidth={1.75} aria-hidden />
              </span>
            </Tooltip>
          )}

          {card.description.trim() && (
            <span className="inline-flex" aria-label={tr('有描述')} role="img">
              <AlignLeft size={13} strokeWidth={1.75} aria-hidden />
            </span>
          )}
          <AssigneeStack values={card.assigneeIds} className="ml-auto" />
        </div>
      )}
    </div>
  );
});
