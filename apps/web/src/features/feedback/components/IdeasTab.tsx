import { Link } from 'react-router';
import { ChevronUp, Lightbulb, Plus } from 'lucide-react';
import type { TicketSummary } from '@srh/shared';
import { Button, EmptyState, Skeleton, toast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useTickets, useVote } from '../api';
import { FEEDBACK_COPY } from '../copy';
import { openFeedbackDialog } from '../feedback-store';
import { tr } from '@/lib/i18n';

const c = FEEDBACK_COPY.ideas;

/** 按路线图分组，组内按票数排序。 */
export function groupIdeas(list: TicketSummary[]) {
  return c.groups.map((g) => ({
    ...g,
    items: list
      .filter((t) => t.roadmap === g.roadmap && t.status !== 'closed')
      .sort((a, b) => b.voteCount - a.voteCount || b.createdAt.localeCompare(a.createdAt)),
  }));
}

function IdeaRow({ t }: { t: TicketSummary }) {
  const vote = useVote();
  return (
    <li className="flex items-start gap-3 py-3">
      <button
        type="button"
        aria-pressed={t.voted}
        aria-label={tr('{label}：{name}', { label: t.voted ? c.unvote : c.vote, name: t.title })}
        disabled={vote.isPending}
        onClick={() =>
          vote.mutate({ no: t.no, voted: t.voted }, { onError: () => toast.error(c.voteFailed) })
        }
        className={cn(
          'press flex w-12 shrink-0 cursor-pointer flex-col items-center justify-center rounded-md border py-1 max-md:min-h-11',
          t.voted
            ? 'border-accent-solid bg-accent-soft text-accent-text'
            : 'border-line text-fg-muted hover:bg-subtle',
        )}
      >
        <ChevronUp size={16} strokeWidth={1.75} aria-hidden />
        <span className="text-small font-semibold tabular-nums">{t.voteCount}</span>
      </button>
      <Link to={`/feedback/${t.no}`} className="min-w-0 flex-1 hover:text-accent-text">
        <span className="block text-body text-fg">{t.title}</span>
        <span className="mt-0.5 block text-small text-fg-subtle">
          <span className="font-mono tabular-nums">{t.code}</span> ·{' '}
          {t.reporter?.name ?? FEEDBACK_COPY.list.anonymous}
        </span>
      </Link>
    </li>
  );
}

export function IdeasTab() {
  const query = useTickets({ kind: 'idea', sort: 'votes', limit: 200 });
  if (query.isPending)
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  const groups = groupIdeas(query.data ?? []);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const create = (
    <Button
      variant="primary"
      size="sm"
      leftIcon={<Plus strokeWidth={1.75} aria-hidden />}
      onClick={openFeedbackDialog}
      className="max-md:h-11"
    >
      {FEEDBACK_COPY.list.create}
    </Button>
  );
  if (total === 0)
    return (
      <EmptyState
        framed
        icon={Lightbulb}
        title={c.empty}
        description={c.emptyHint}
        action={create}
      />
    );
  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">{create}</div>
      {groups
        .filter((g) => g.items.length > 0)
        .map((g) => (
          <section key={g.roadmap} aria-label={g.label}>
            <h2 className="flex items-center gap-2 text-small font-medium text-fg-muted">
              {g.label}
              <span className="text-caption text-fg-subtle tabular-nums">{g.items.length}</span>
            </h2>
            <ul className="mt-1 divide-y divide-line">
              {g.items.map((t) => (
                <IdeaRow key={t.id} t={t} />
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}
