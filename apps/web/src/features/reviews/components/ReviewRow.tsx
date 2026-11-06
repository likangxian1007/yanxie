import { Link } from 'react-router';
import { ResourcePreviewLink } from '@/features/resource-preview/ResourcePreviewLink';
import { MessageSquare } from 'lucide-react';
import type { Review } from '@srh/shared';
import { Badge, RelativeTime } from '@/components/ui';
import { TARGET_KIND_LABEL } from '../lib/target';
import { useAgentThreadTitle } from '../lib/use-agent-thread';
import { ActorAvatar, ReviewerStack, ReviewStatusBadge } from './ReviewPeople';
import { TargetIcon } from './TargetIcon';
import { tr, trServer } from '@/lib/i18n';

/** 审阅列表的一行：目标图标 + 标题、发起者、审阅人结论、状态、评论数、相对时间 */
export function ReviewRow({ review, href }: { review: Review; href: string }) {
  const agentThread = useAgentThreadTitle(review.requestedBy);
  const agent = review.requestedBy.kind === 'agent';
  return (
    <div className="group relative flex flex-col gap-2 px-4 py-3 transition-colors duration-(--dur-fast) hover:bg-subtle sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-sm bg-subtle text-fg-muted group-hover:bg-muted">
          <TargetIcon kind={review.targetKind} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-body font-medium text-fg">
            <ResourcePreviewLink
              type="review"
              id={review.id}
              className="outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
            >
              {review.title}
            </ResourcePreviewLink>
          </h3>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption font-normal text-fg-subtle">
            <ActorAvatar actor={review.requestedBy} size={20} />
            <span className="truncate">
              {trServer(review.requestedBy.name)}
              {agent && (
                <span className="text-agent-text">
                  {agentThread ? tr('（{agentThread}）', { agentThread }) : tr('（agent）')}
                </span>
              )}{' '}
              {tr('发起 · ')}
              {TARGET_KIND_LABEL[review.targetKind]} · <RelativeTime iso={review.updatedAt} />
            </span>
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-4 pl-10 sm:pl-0">
        <ReviewerStack reviewers={review.reviewers} size={24} />
        {review.supersededById ? (
          <Badge tone="neutral">{tr('已被新一轮取代')}</Badge>
        ) : (
          <ReviewStatusBadge status={review.status} />
        )}
        <span
          className="inline-flex w-10 items-center justify-end gap-1 text-caption font-normal text-fg-subtle tabular-nums"
          aria-label={tr('{commentCount} 条评论', { commentCount: review.commentCount })}
        >
          <MessageSquare size={14} strokeWidth={1.75} aria-hidden />
          {review.commentCount}
        </span>
      </div>
      <Link
        to={href}
        aria-label={tr('打开{title}完整页面', { title: review.title })}
        className="relative z-10 shrink-0 rounded-md px-2 py-2 text-small text-fg-muted hover:bg-muted hover:text-fg max-md:min-h-11"
      >
        {tr('完整页面')}
      </Link>
    </div>
  );
}
