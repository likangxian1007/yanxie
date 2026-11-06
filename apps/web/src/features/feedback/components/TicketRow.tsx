import { Link } from 'react-router';
import { MessageCircle, ThumbsUp } from 'lucide-react';
import type { TicketSummary } from '@srh/shared';
import { TICKET_STATUS_LABEL } from '@srh/shared';
import { Badge, RelativeTime } from '@/components/ui';
import { cn } from '@/lib/cn';
import { FEEDBACK_COPY } from '../copy';
import {
  formatWait,
  KIND_TONE,
  STATUS_TONE,
  waitedMs,
  waitHeat,
  waitingLabel,
} from '../ticket-meta';

const c = FEEDBACK_COPY.list;

export function TicketRow({
  ticket: t,
  isAdmin,
  now,
}: {
  ticket: TicketSummary;
  isAdmin: boolean;
  now: number;
}) {
  const wait = waitingLabel(t, isAdmin);
  const ms = waitedMs(t, now);
  const heat = t.waiting ? waitHeat(ms) : 'none';
  return (
    <li>
      <Link
        to={`/feedback/${t.no}`}
        className="flex items-start gap-3 px-1 py-3 hover:bg-muted/50 max-md:min-h-11 md:px-2"
      >
        <span
          aria-hidden
          className={cn(
            'mt-2 size-2 shrink-0 rounded-full',
            t.unread ? 'bg-accent-solid' : 'bg-transparent',
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-small text-fg-subtle tabular-nums">{t.code}</span>
            <Badge tone={KIND_TONE[t.kind]}>{FEEDBACK_COPY.kindShort[t.kind]}</Badge>
            <Badge tone={STATUS_TONE[t.status]}>{TICKET_STATUS_LABEL[t.status]}</Badge>
            {wait && (
              <Badge
                tone={t.waiting ? (heat === 'hot' ? 'danger' : 'warning') : 'neutral'}
                dot={t.waiting}
              >
                {wait}
                {t.waiting && heat !== 'none' && ` · ${c.waited(formatWait(ms))}`}
              </Badge>
            )}
            {t.unread && <span className="sr-only">{c.unread}</span>}
          </span>
          <span
            className={cn(
              'mt-1 block truncate text-body',
              t.unread ? 'font-semibold text-fg' : 'text-fg',
            )}
          >
            {t.title}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-small text-fg-subtle">
            <span>{t.reporter?.name ?? c.anonymous}</span>
            <span aria-hidden>·</span>
            <span>{c.sourceLabel[t.source]}</span>
            <span aria-hidden>·</span>
            <RelativeTime iso={t.updatedAt} />
            {t.lastReplyBy && (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1">
                  <MessageCircle size={14} strokeWidth={1.75} aria-hidden />
                  {t.lastReplyBy === 'admin' ? FEEDBACK_COPY.detail.support : c.reporterReplied}
                </span>
              </>
            )}
            {t.kind === 'idea' && (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1 tabular-nums">
                  <ThumbsUp size={14} strokeWidth={1.75} aria-hidden />
                  {c.votes(t.voteCount)}
                </span>
              </>
            )}
          </span>
        </span>
      </Link>
    </li>
  );
}
