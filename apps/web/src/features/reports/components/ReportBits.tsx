import type { ActorRef, ReportStatus } from '@srh/shared';
import { Avatar, Badge, type AvatarSize } from '@/components/ui';
import { useMemberMap, useProjectId } from '@/lib/project';
import { tr, trServer } from '@/lib/i18n';

const STATUS: Record<ReportStatus, { label: string; tone: 'agent' | 'neutral' | 'success' }> = {
  generating: { label: tr('生成中'), tone: 'agent' },
  draft: { label: tr('草稿'), tone: 'neutral' },
  final: { label: tr('定稿'), tone: 'success' },
};

export function ReportStatusBadge({ status }: { status: ReportStatus }) {
  const s = STATUS[status];
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}

/** 作者头像：成员用头像色，agent 用渐变，系统用石板灰 */
export function ActorAvatar({ actor, size = 20 }: { actor: ActorRef; size?: AvatarSize }) {
  const members = useMemberMap(useProjectId());
  if (actor.kind === 'agent') {
    const coordinator = actor.name.includes('协调者');
    return (
      <Avatar
        name={trServer(actor.name) || 'agent'}
        kind={coordinator ? 'coordinator' : 'agent'}
        size={size}
      />
    );
  }
  if (actor.kind === 'system')
    return <Avatar name={trServer(actor.name) || tr('系统')} color={7} size={size} />;
  const member = actor.id ? members.get(actor.id) : undefined;
  return (
    <Avatar
      name={member?.user.name ?? trServer(actor.name)}
      color={member?.user.avatarColor}
      src={member?.user.avatarUrl}
      size={size}
    />
  );
}
