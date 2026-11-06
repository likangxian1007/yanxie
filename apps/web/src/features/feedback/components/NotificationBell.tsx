import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { BellDot, BellRing, CheckCheck } from 'lucide-react';
import type { UserNotification } from '@srh/shared';
import { Button, EmptyState, IconButton, Popover, RelativeTime, Tabs } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useMarkNotificationsRead, useNotifications } from '../api';
import { FEEDBACK_COPY } from '../copy';
import { trServer } from '@/lib/i18n';

const c = FEEDBACK_COPY.bell;

export function badgeText(n: number): string {
  return n > 99 ? '99+' : String(n);
}

/** 站内通知（工单回复、状态变化、更新日志）。手机上也显示。 */
export function NotificationBell({ className }: { className?: string }) {
  const [tab, setTab] = useState<'unread' | 'all'>('unread');
  const [open, setOpen] = useState(false);
  // 角标计数始终轮询未读；「全部」只在打开且切到该页时拉
  const unread = useNotifications(true);
  const all = useNotifications(false, open && tab === 'all');
  const mark = useMarkNotificationsRead();
  const navigate = useNavigate();
  const count = unread.data?.unread ?? 0;
  const list = tab === 'unread' ? unread : all;
  const items = list.data?.items ?? [];

  const go = (n: UserNotification, close: () => void) => {
    if (!n.readAt) mark.mutate({ ids: [n.id] });
    close();
    if (n.href) navigate(n.href);
  };

  return (
    <Popover
      label={c.label}
      side="bottom"
      align="end"
      open={open}
      onOpenChange={setOpen}
      className="w-[min(360px,calc(100vw-16px))] p-0"
      trigger={
        <IconButton
          label={count > 0 ? c.labelCount(count) : c.label}
          className={cn('max-md:size-11', className)}
        >
          {count > 0 ? (
            <BellDot strokeWidth={1.75} aria-hidden />
          ) : (
            <BellRing strokeWidth={1.75} aria-hidden />
          )}
          {count > 0 && (
            <span
              aria-hidden
              data-testid="notification-count"
              className="pointer-events-none absolute -top-0.5 -right-1 min-w-4 rounded-full bg-danger-solid px-1 text-center text-[11px] leading-4 font-semibold text-accent-fg tabular-nums ring-2 ring-canvas"
            >
              {badgeText(count)}
            </span>
          )}
        </IconButton>
      }
    >
      {(close) => (
        <div className="flex max-h-[min(480px,70dvh)] flex-col">
          <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
            <Tabs
              size="sm"
              variant="segmented"
              layoutId="notification-tabs"
              aria-label={c.label}
              value={tab}
              onValueChange={setTab}
              items={[
                { value: 'unread', label: c.unread, count: count || undefined },
                { value: 'all', label: c.all },
              ]}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={count === 0 || mark.isPending}
              leftIcon={<CheckCheck strokeWidth={1.75} aria-hidden />}
              onClick={() => mark.mutate({ all: true })}
              className="max-md:h-11"
            >
              {c.readAll}
            </Button>
          </div>
          {items.length === 0 ? (
            <EmptyState
              icon={BellRing}
              className="py-8"
              title={list.isPending ? c.loading : tab === 'unread' ? c.emptyUnread : c.empty}
            />
          ) : (
            <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => go(n, close)}
                    className="flex w-full cursor-pointer items-start gap-2.5 px-3 py-2.5 text-left hover:bg-muted/60 max-md:min-h-11"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'mt-1.5 size-2 shrink-0 rounded-full',
                        n.readAt ? 'bg-transparent' : 'bg-accent-solid',
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          'line-clamp-2 text-small',
                          n.readAt ? 'text-fg-muted' : 'font-medium text-fg',
                        )}
                      >
                        {trServer(n.title)}
                      </span>
                      <RelativeTime
                        iso={n.createdAt}
                        className="block text-caption text-fg-subtle"
                      />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Link
            to="/feedback"
            onClick={close}
            className="flex h-10 shrink-0 items-center justify-center border-t border-line text-small text-accent-text hover:bg-muted/60 max-md:h-11"
          >
            {c.openCenter}
          </Link>
        </div>
      )}
    </Popover>
  );
}
