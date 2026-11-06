import { forwardRef, memo, type HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { Avatar, type AvatarKind, type AvatarSize } from './Avatar';
import { Popover } from './Popover';
import { tr } from '@/lib/i18n';

export interface AvatarStackMember {
  id: string;
  name: string;
  color?: number | undefined;
  kind?: AvatarKind;
  activity?: string | undefined;
}
export interface AvatarStackProps extends HTMLAttributes<HTMLDivElement> {
  members: AvatarStackMember[];
  max?: number;
  size?: AvatarSize;
  expand?: 'left' | 'right';
  label?: string;
}

const Faces = memo(
  function Faces({
    members,
    size,
    max,
  }: {
    members: AvatarStackMember[];
    size: AvatarSize;
    max: number;
  }) {
    return (
      <span className="inline-flex items-center" aria-hidden>
        {members.slice(0, max).map((m, i) => (
          <span key={m.id} className={cn('inline-flex', i > 0 && '-ml-1')}>
            <Avatar name={m.name} color={m.color} kind={m.kind} size={size} ring />
          </span>
        ))}
        {members.length > max && (
          <span className="-ml-1 inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-muted px-1 text-caption text-fg-muted ring-2 ring-canvas">
            +{members.length - max}
          </span>
        )}
      </span>
    );
  },
  (a, b) =>
    a.size === b.size &&
    a.max === b.max &&
    a.members.length === b.members.length &&
    a.members.every((m, i) => {
      const n = b.members[i]!;
      return m.id === n.id && m.name === n.name && m.color === n.color && m.kind === n.kind;
    }),
);

/** Resource-local collaborators. Activity updates never move or animate their identities. */
export const AvatarStack = forwardRef<HTMLDivElement, AvatarStackProps>(function AvatarStack(
  {
    members,
    max = 3,
    size = 24,
    expand = 'right',
    label = tr('当前资源在线成员'),
    className,
    ...props
  },
  ref,
) {
  const unique = [...new Map(members.map((m) => [m.id, m])).values()].sort(
    (a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id),
  );
  if (!unique.length) return null;
  return (
    <div ref={ref} className={cn('inline-flex items-center', className)} {...props}>
      <Popover
        label={label}
        align={expand === 'left' ? 'end' : 'start'}
        className="w-72 max-w-[calc(100vw-2rem)]"
        trigger={
          <button
            type="button"
            aria-label={tr('{label}：{count} 人', { label, count: unique.length })}
            className="inline-flex min-h-8 items-center rounded-md px-1 outline-offset-2 hover:bg-muted/60 max-md:min-h-11 max-md:min-w-11"
          >
            <Faces members={unique} size={size} max={Math.max(1, Math.min(3, max))} />
          </button>
        }
      >
        <h2 tabIndex={-1} data-autofocus className="px-2 py-2 text-caption text-fg-muted">
          {label} · {unique.length}
        </h2>
        <ul className="max-h-80 overflow-y-auto px-2 pb-2">
          {unique.map((m) => (
            <li key={m.id} className="flex items-center gap-2.5 py-2">
              <Avatar name={m.name} color={m.color} kind={m.kind} size={24} />
              <span className="min-w-0">
                <span className="block break-words text-small text-fg">{m.name}</span>
                {m.activity && (
                  <span className="block break-words text-caption text-fg-muted">{m.activity}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </Popover>
    </div>
  );
});
