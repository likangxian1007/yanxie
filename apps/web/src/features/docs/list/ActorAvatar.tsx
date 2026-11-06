import type { ActorRef } from '@srh/shared';
import { Avatar, type AvatarSize } from '@/components/ui';
import { useMemberMap, useProjectId } from '@/lib/project';
import { tr, trServer } from '@/lib/i18n';

/** ActorRef 的头像：成员用其头像色；agent 用 agent 渐变（协调者带内描边）；系统用石板灰。 */
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
