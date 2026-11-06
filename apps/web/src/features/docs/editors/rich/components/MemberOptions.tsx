import type { ProjectMember } from '@srh/shared';
import { Avatar } from '@/components/ui';
import { cn } from '@/lib/cn';
import { ROLE_LABEL } from '@/lib/project';
import { tr } from '@/lib/i18n';

/** 按名字 / 邮箱过滤成员：名字前缀 > 名字包含 > 邮箱包含。 */
export function filterMembers(
  members: readonly ProjectMember[],
  query: string,
  limit = 8,
): ProjectMember[] {
  const q = query.trim().toLowerCase();
  if (!q) return members.slice(0, limit);
  const scored: { m: ProjectMember; s: number; i: number }[] = [];
  members.forEach((m, i) => {
    const name = m.user.name.toLowerCase();
    const email = m.user.email.toLowerCase();
    const s = name.startsWith(q) ? 0 : name.includes(q) ? 1 : email.includes(q) ? 2 : -1;
    if (s >= 0) scored.push({ m, s, i });
  });
  scored.sort((a, b) => a.s - b.s || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.m);
}

export interface MemberOptionsProps {
  items: ProjectMember[];
  index: number;
  onHover: (i: number) => void;
  onPick: (m: ProjectMember) => void;
  empty?: string;
}

/** @ 成员候选列表（正文 @ 与评论框 @ 共用） */
export function MemberOptions({ items, index, onHover, onPick, empty }: MemberOptionsProps) {
  if (items.length === 0) {
    return (
      <div className="px-2 py-2 text-small text-fg-subtle">{empty ?? tr('没有找到这个成员')}</div>
    );
  }
  return (
    <div className="flex flex-col">
      {items.map((m, i) => (
        <div
          key={m.user.id}
          role="option"
          aria-selected={i === index}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(m)}
          className={cn(
            'flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 select-none',
            'transition-colors duration-(--dur-fast) ease-(--ease-standard)',
            i === index ? 'bg-subtle' : 'hover:bg-subtle',
          )}
        >
          <Avatar name={m.user.name} color={m.user.avatarColor} src={m.user.avatarUrl} size={20} />
          <span className="min-w-0 flex-1 truncate text-body text-fg">{m.user.name}</span>
          <span className="shrink-0 text-caption text-fg-subtle">{ROLE_LABEL[m.role]}</span>
        </div>
      ))}
    </div>
  );
}
