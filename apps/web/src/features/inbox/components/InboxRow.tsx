import { Link } from 'react-router';
import { Check, Mail, MailOpen, Undo2 } from 'lucide-react';
import type { InboxItem } from '@srh/shared';
import { IconButton, RelativeTime } from '@/components/ui';
import { cn } from '@/lib/cn';
import { INBOX_KIND_META } from '../kind-meta';
import { tr } from '@/lib/i18n';

export type InboxRowMode = 'pending' | 'done';

export interface InboxRowProps {
  item: InboxItem;
  mode: InboxRowMode;
  /** 点开条目（Link 本身负责跳转，这里只做“标为已读”之类的副作用） */
  onOpen: (item: InboxItem) => void;
  onMarkDone: (item: InboxItem) => void;
  onToggleRead: (item: InboxItem) => void;
  onRestore: (item: InboxItem) => void;
}

/** 32px 图标块：中性底，图标按类型着色。 */
export function InboxKindTile({
  kind,
  className,
}: {
  kind: InboxItem['kind'];
  className?: string;
}) {
  const meta = INBOX_KIND_META[kind];
  const Icon = meta.icon;
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-md ring-1',
        meta.tile,
        className,
      )}
    >
      <Icon size={16} strokeWidth={1.75} />
    </span>
  );
}

/**
 * 一条待处理事项：整行是一个链接（可聚焦，Enter 打开），
 * 右侧操作在悬停 / 聚焦时浮现；触屏设备上常驻在条目下方。
 */
export function InboxRow({
  item,
  mode,
  onOpen,
  onMarkDone,
  onToggleRead,
  onRestore,
}: InboxRowProps) {
  const meta = INBOX_KIND_META[item.kind];
  const unread = mode === 'pending' && item.readAt === null;
  const time = mode === 'done' ? (item.doneAt ?? item.createdAt) : item.createdAt;

  return (
    <div className="group relative" data-inbox-item={item.id}>
      <Link
        to={item.href}
        data-inbox-row={item.id}
        onClick={() => onOpen(item)}
        className={cn(
          'flex w-full min-w-0 items-start gap-3 rounded-md px-3 py-2.5 text-left',
          'transition-colors duration-(--dur-fast) ease-(--ease-standard) hover:bg-subtle focus-visible:bg-subtle',
        )}
      >
        <InboxKindTile kind={item.kind} className={cn(mode === 'done' && 'opacity-70')} />

        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn('text-caption', meta.text)}>
            {meta.label}
            {unread && <span className="sr-only">{tr('（未读）')}</span>}
          </span>
          <span
            className={cn(
              'mt-0.5 line-clamp-2 text-body [overflow-wrap:anywhere]',
              unread ? 'font-semibold text-fg' : mode === 'done' ? 'text-fg-muted' : 'text-fg',
            )}
          >
            {item.title}
          </span>
        </span>

        <span
          className={cn(
            'flex shrink-0 flex-col items-end gap-2 pt-px',
            'transition-opacity duration-(--dur-fast) ease-(--ease-standard)',
            'group-hover:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-0',
          )}
        >
          <RelativeTime iso={time} className="text-caption text-fg-subtle" />
          {unread && <span aria-hidden className="size-2 rounded-full bg-accent" />}
        </span>
      </Link>

      <div
        className={cn(
          // 默认（有悬停能力的设备）：浮在右侧，悬停 / 聚焦时出现
          'absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-surface p-0.5 shadow-xs ring-1 ring-line',
          'pointer-events-none opacity-0 transition-opacity duration-(--dur-fast) ease-(--ease-standard)',
          'group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100',
          // 触屏（没有悬停）：常驻在条目下方，靠右
          '[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:static [@media(hover:none)]:-mt-1 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:justify-end',
          '[@media(hover:none)]:bg-transparent [@media(hover:none)]:px-2 [@media(hover:none)]:pt-0 [@media(hover:none)]:pb-1.5 [@media(hover:none)]:opacity-100 [@media(hover:none)]:shadow-none [@media(hover:none)]:ring-0',
        )}
      >
        {mode === 'pending' ? (
          <>
            <IconButton
              size="sm"
              className="[@media(hover:none)]:size-10"
              label={item.readAt === null ? tr('标为已读') : tr('标为未读')}
              tooltipSide="top"
              onClick={() => onToggleRead(item)}
            >
              {item.readAt === null ? (
                <MailOpen strokeWidth={1.75} aria-hidden />
              ) : (
                <Mail strokeWidth={1.75} aria-hidden />
              )}
            </IconButton>
            <IconButton
              size="sm"
              className="[@media(hover:none)]:size-10"
              label={tr('标为完成')}
              shortcut="E"
              tooltipSide="top"
              onClick={() => onMarkDone(item)}
            >
              <Check strokeWidth={1.75} aria-hidden />
            </IconButton>
          </>
        ) : (
          <IconButton
            size="sm"
            className="[@media(hover:none)]:size-10"
            label={tr('移回待处理')}
            tooltipSide="top"
            onClick={() => onRestore(item)}
          >
            <Undo2 strokeWidth={1.75} aria-hidden />
          </IconButton>
        )}
      </div>
    </div>
  );
}
