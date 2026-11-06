import { useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import type { AgentProfile } from '@srh/shared';
import { Input, Popover } from '@/components/ui';
import { cn } from '@/lib/cn';
import { ProfileGlyph } from './ProfileGlyph';
import { tr, trServer } from '@/lib/i18n';

export interface ProfilePickerProps {
  profiles: AgentProfile[];
  value: string | null;
  onChange: (slug: string | null) => void;
  disabled?: boolean;
  className?: string;
}

/** A bounded, searchable role selector; no horizontally hidden options. */
export function ProfilePicker({
  profiles,
  value,
  onChange,
  disabled,
  className,
}: ProfilePickerProps) {
  const [query, setQuery] = useState('');
  const selected = profiles.find((p) => p.slug === value);
  const options = [
    { slug: null, name: tr('通用'), icon: null, description: tr('不附加角色设定') },
    ...profiles,
  ];
  const visible = options.filter((p) =>
    `${p.name} ${p.description} ${trServer(p.name)} ${trServer(p.description)}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <div className={cn('min-w-0', className)}>
      <Popover
        label={tr('选择科研角色')}
        className="w-96 max-w-[calc(100vw-2rem)]"
        onOpenChange={() => setQuery('')}
        trigger={
          <button
            type="button"
            disabled={disabled}
            aria-label={tr('科研角色：{value}', {
              value: selected ? trServer(selected.name) : tr('通用'),
            })}
            className="inline-flex min-h-9 max-w-full items-center gap-2 rounded-md border border-line bg-surface px-3 text-small text-fg hover:bg-muted disabled:opacity-60 max-md:min-h-11"
          >
            <ProfileGlyph icon={selected?.icon} size={16} className="shrink-0" />
            <span className="min-w-0 truncate">
              {selected ? trServer(selected.name) : tr('通用')}
            </span>
            <ChevronDown size={14} className="shrink-0 text-fg-muted" aria-hidden />
          </button>
        }
      >
        {(close) => (
          <>
            <div className="sticky top-0 z-10 bg-elevated p-2">
              <Input
                aria-label={tr('搜索科研角色')}
                placeholder={tr('搜索角色')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                leading={<Search size={15} />}
              />
            </div>
            <div
              role="radiogroup"
              aria-label={tr('科研角色')}
              className="max-h-[min(22rem,55dvh)] overflow-y-auto overscroll-contain p-1"
              onKeyDown={(e) => {
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
                e.preventDefault();
                const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? buttons.length - 1
                      : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                        buttons.length;
                buttons[next]?.focus();
              }}
            >
              {visible.map((p) => (
                <button
                  key={p.slug ?? '__none'}
                  type="button"
                  role="radio"
                  aria-label={trServer(p.name)}
                  aria-checked={p.slug === value}
                  className="flex min-h-11 w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-muted focus-visible:bg-muted"
                  onClick={() => {
                    onChange(p.slug);
                    close();
                  }}
                >
                  <ProfileGlyph icon={p.icon} size={16} className="mt-0.5 shrink-0 text-fg-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-small text-fg">{trServer(p.name)}</span>
                    {p.description && (
                      <span className="mt-0.5 block text-caption break-words text-fg-muted">
                        {trServer(p.description)}
                      </span>
                    )}
                  </span>
                  {p.slug === value && (
                    <Check size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                  )}
                </button>
              ))}
              {!visible.length && (
                <p className="px-2 py-4 text-small text-fg-muted">{tr('没有匹配的角色')}</p>
              )}
            </div>
          </>
        )}
      </Popover>
    </div>
  );
}
