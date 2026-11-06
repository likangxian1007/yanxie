import { useEffect, useId, useState, type RefObject, type KeyboardEvent } from 'react';
import { MessageMentions, type MessageMention, type ProjectMember } from '@srh/shared';
import { Avatar, Button } from '@/components/ui';
import { useMembers } from '@/lib/project';
import { mentionQuery, rebaseMentions, trimmedMentions } from './mentions';
import { tr } from '@/lib/i18n';

export function useMemberMentions({
  pid,
  value,
  initial = [],
  draftKey,
  onChange,
  input,
}: {
  pid?: string | undefined;
  value: string;
  initial?: MessageMention[];
  draftKey?: string | undefined;
  onChange: (value: string) => void;
  input: RefObject<HTMLTextAreaElement | null>;
}) {
  const id = useId();
  const [caret, setCaret] = useState(value.length);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const scope = draftKey ?? pid ?? '';
  const readDraft = (): MessageMention[] => {
    if (!draftKey) return initial;
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) ?? 'null');
      if (!saved || saved.body !== value) return initial;
      const mentions = MessageMentions.safeParse(saved.mentions).data ?? [];
      return mentions.filter((m) => value.slice(m.start, m.end) === `@${m.label}`);
    } catch {
      return initial;
    }
  };
  const [tracked, setTracked] = useState(() => ({ scope, value, mentions: readDraft() }));
  const currentMentions =
    tracked.scope !== scope
      ? readDraft()
      : tracked.value === value
        ? tracked.mentions
        : rebaseMentions(tracked.value, value, tracked.mentions);
  if (tracked.scope !== scope || tracked.value !== value)
    setTracked({ scope, value, mentions: currentMentions });
  useEffect(() => {
    if (!draftKey) return;
    try {
      if (value && currentMentions.length)
        localStorage.setItem(draftKey, JSON.stringify({ body: value, mentions: currentMentions }));
      else localStorage.removeItem(draftKey);
    } catch {
      /* 草稿存储不可用时仍可继续发送。 */
    }
  }, [draftKey, value, currentMentions]);
  const query = pid && dismissed !== `${value}:${caret}` ? mentionQuery(value, caret) : null;
  const members = useMembers(query ? (pid ?? '') : '');
  const needle = query?.query.trim().toLocaleLowerCase() ?? '';
  const options = (members.data ?? [])
    .filter((m) => `${m.user.name}\n${m.user.email}`.toLocaleLowerCase().includes(needle))
    .slice(0, 12);
  const selected = Math.min(index, Math.max(0, options.length - 1));
  const change = (next: string) => {
    setTracked({ scope, value: next, mentions: rebaseMentions(value, next, currentMentions) });
    setCaret(input.current?.selectionStart ?? next.length);
    setIndex(0);
    onChange(next);
  };
  const pick = (member: ProjectMember) => {
    if (!query) return;
    const label = `@${member.user.name}`;
    const next = value.slice(0, query.start) + label + ' ' + value.slice(query.end);
    setTracked({
      scope,
      value: next,
      mentions: [
        ...rebaseMentions(value, next, currentMentions),
        {
          userId: member.user.id,
          label: member.user.name,
          start: query.start,
          end: query.start + label.length,
        },
      ],
    });
    const position = query.start + label.length + 1;
    setCaret(position);
    setDismissed(`${next}:${position}`);
    setIndex(0);
    onChange(next);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(position, position);
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!query || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(`${value}:${caret}`);
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex(
        (selected + (event.key === 'ArrowDown' ? 1 : -1) + options.length) %
          Math.max(1, options.length),
      );
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
      event.preventDefault();
      const member = options[selected];
      if (member) pick(member);
    }
  };
  return {
    change,
    onKeyDown,
    onSelect: () => setCaret(input.current?.selectionStart ?? value.length),
    mentions: () => trimmedMentions(value, currentMentions),
    aria: query
      ? {
          role: 'combobox' as const,
          'aria-expanded': true,
          'aria-autocomplete': 'list' as const,
          'aria-controls': id,
          ...(options.length ? { 'aria-activedescendant': `${id}-${selected}` } : {}),
        }
      : undefined,
    menu: query ? (
      <div className="absolute bottom-full z-popover mb-2 max-h-72 w-full overflow-y-auto rounded-lg border border-line bg-elevated p-2 shadow-lg">
        <p className="px-2 py-1 text-caption text-fg-subtle">{tr('提及成员，对方会收到提醒')}</p>
        <div role="listbox" id={id} aria-label={tr('提及成员')}>
          {options.map((m, i) => (
            <button
              type="button"
              role="option"
              aria-label={`${m.user.name} ${m.user.email}`}
              aria-selected={i === selected}
              id={`${id}-${i}`}
              key={m.user.id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(m)}
              className={`flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-left ${i === selected ? 'bg-accent-soft text-accent-text' : 'text-fg hover:bg-subtle'}`}
            >
              <Avatar aria-hidden name={m.user.name} color={m.user.avatarColor} size={24} />
              <span className="min-w-0">
                <span className="block truncate text-small">{m.user.name}</span>
                <span className="block truncate text-caption text-fg-muted">{m.user.email}</span>
              </span>
            </button>
          ))}
        </div>
        {members.isPending ? (
          <p role="status" className="p-2 text-small">
            {tr('正在加载成员…')}
          </p>
        ) : members.isError ? (
          <div role="alert" className="p-2 text-small">
            {tr('成员加载失败')}
            <Button variant="ghost" size="sm" onClick={() => void members.refetch()}>
              {tr('重试')}
            </Button>
          </div>
        ) : options.length === 0 ? (
          <p className="p-2 text-small text-fg-muted">{tr('没有找到成员')}</p>
        ) : null}
      </div>
    ) : null,
  };
}
