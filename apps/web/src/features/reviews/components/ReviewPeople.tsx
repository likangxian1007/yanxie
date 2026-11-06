import { Check, Minus, X } from 'lucide-react';
import type { ActorRef, ReviewParticipant, ReviewStatus, ReviewVerdict } from '@srh/shared';
import { Avatar, Badge, Tooltip, type AvatarSize } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useMemberMap, useProjectId } from '@/lib/project';
import { REVIEW_STATUS_LABEL, REVIEW_STATUS_TONE, VERDICT_LABEL } from '../lib/review-state';
import { tr, trServer } from '@/lib/i18n';

/** 人 / agent / 系统的头像（agent 用渐变，协调者用协调者样式） */
export function ActorAvatar({
  actor,
  size = 24,
  className,
}: {
  actor: ActorRef;
  size?: AvatarSize;
  className?: string;
}) {
  const members = useMemberMap(useProjectId());
  if (actor.kind === 'agent') {
    return (
      <Avatar
        kind={/协调者/u.test(actor.name) ? 'coordinator' : 'agent'}
        name={trServer(actor.name)}
        size={size}
        className={className}
      />
    );
  }
  const m = actor.id ? members.get(actor.id) : undefined;
  return (
    <Avatar
      name={m?.user.name ?? trServer(actor.name)}
      color={actor.kind === 'system' ? 7 : m?.user.avatarColor}
      src={m?.user.avatarUrl}
      size={size}
      className={className}
    />
  );
}

export function ReviewStatusBadge({
  status,
  className,
}: {
  status: ReviewStatus;
  className?: string;
}) {
  return (
    <Badge tone={REVIEW_STATUS_TONE[status]} dot className={className}>
      {REVIEW_STATUS_LABEL[status]}
    </Badge>
  );
}

const VERDICT_MARK: Record<ReviewVerdict, { cls: string; icon: typeof Check | null }> = {
  // 暗色下 success 很亮，勾用 success-fg（深色）；红底用 danger-solid，白叉够对比
  lgtm: { cls: 'bg-success text-success-fg', icon: Check },
  changes_requested: { cls: 'bg-danger-solid text-accent-fg', icon: X },
  commented: { cls: 'bg-muted text-fg-muted ring-1 ring-line-strong', icon: Minus },
  pending: { cls: 'bg-muted ring-1 ring-line-strong', icon: null },
};

/** 头像右下角的结论小标：LGTM 绿勾、要求修改红叉、待审阅灰点 */
export function VerdictMark({
  verdict,
  className,
}: {
  verdict: ReviewVerdict;
  className?: string;
}) {
  const mark = VERDICT_MARK[verdict];
  const Icon = mark.icon;
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-3.5 place-items-center rounded-full ring-2 ring-surface',
        mark.cls,
        className,
      )}
    >
      {Icon ? (
        <Icon size={9} strokeWidth={3} />
      ) : (
        <span className="size-1 rounded-full bg-fg-subtle" />
      )}
    </span>
  );
}

/** 一位审阅人：头像 + 结论小标（悬停显示姓名与结论） */
export function ReviewerAvatar({
  participant,
  size = 24,
}: {
  participant: ReviewParticipant;
  size?: AvatarSize;
}) {
  const members = useMemberMap(useProjectId());
  const m = members.get(participant.userId);
  const name = m?.user.name ?? tr('成员');
  const label = tr('{name}：{value}', { name, value: VERDICT_LABEL[participant.verdict] });
  return (
    <Tooltip content={label}>
      <span
        tabIndex={0}
        role="img"
        aria-label={label}
        className="relative inline-flex rounded-full"
      >
        <Avatar name={name} color={m?.user.avatarColor} src={m?.user.avatarUrl} size={size} />
        <VerdictMark verdict={participant.verdict} className="absolute -right-1 -bottom-1" />
      </span>
    </Tooltip>
  );
}

/** 审阅人头像组 */
export function ReviewerStack({
  reviewers,
  max = 4,
  size = 24,
}: {
  reviewers: ReviewParticipant[];
  max?: number;
  size?: AvatarSize;
}) {
  const shown = reviewers.slice(0, max);
  const rest = reviewers.length - shown.length;
  return (
    <span className="inline-flex items-center gap-1.5" aria-label={tr('审阅人')}>
      {shown.map((r) => (
        <ReviewerAvatar key={r.userId} participant={r} size={size} />
      ))}
      {rest > 0 && <span className="text-caption text-fg-subtle tabular-nums">+{rest}</span>}
    </span>
  );
}
