import { useMemo, useRef, useState } from 'react';
import { Button, Textarea } from '@/components/ui';
import { useMembers } from '@/lib/project';
import { MemberOptions, filterMembers } from '../components/MemberOptions';
import { matchMention } from '../ext/mention-suggest';
import { shortcutLabel } from '../lib/text';
import { mentionsInBody } from './anchor';
import { tr } from '@/lib/i18n';

export interface CommentComposerProps {
  projectId: string;
  placeholder: string;
  submitLabel: string;
  busy?: boolean;
  autoFocus?: boolean;
  onSubmit: (body: string, mentions: string[]) => Promise<unknown> | void;
  onCancel?: () => void;
}

/**
 * 评论输入框：输入 “@” 弹出成员列表（↑↓ 选择、回车确认），⌘/Ctrl + Enter 发送，Esc 取消。
 * 选中的成员记在本地，发送时按正文里还留着的 “@名字” 算出 mentions。
 */
export function CommentComposer({
  projectId,
  placeholder,
  submitLabel,
  busy,
  autoFocus,
  onSubmit,
  onCancel,
}: CommentComposerProps) {
  const [value, setValue] = useState('');
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const picked = useRef(new Map<string, string>());
  const ref = useRef<HTMLTextAreaElement>(null);
  const members = useMembers(projectId);

  const query = matchMention(value.slice(0, caret));
  const at = query === null ? null : caret - query.length - 1;
  const open = query !== null && at !== closedAt;
  const items = useMemo(
    () => (open ? filterMembers(members.data ?? [], query ?? '', 6) : []),
    [open, members.data, query],
  );

  const sync = (el: HTMLTextAreaElement) => {
    setCaret(el.selectionStart ?? el.value.length);
    setIndex(0);
  };

  const pick = (id: string, name: string) => {
    if (at === null) return;
    const next = `${value.slice(0, at)}@${name} ${value.slice(caret)}`;
    picked.current.set(id, name);
    setValue(next);
    const pos = at + name.length + 2;
    setCaret(pos);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
  };

  const submit = async () => {
    const body = value.trim();
    if (!body || busy) return;
    try {
      await onSubmit(body, mentionsInBody(body, picked.current));
      setValue('');
      picked.current.clear();
    } catch {
      // 失败时保留草稿（调用方已提示）
    }
  };

  return (
    <div className="relative flex flex-col gap-2" data-node-interactive>
      <Textarea
        ref={ref}
        rows={2}
        autoGrow
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-h-14 text-small"
        onChange={(e) => {
          setValue(e.target.value);
          sync(e.target);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (open && items.length > 0) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((index + 1) % items.length);
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((index - 1 + items.length) % items.length);
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              const m = items[index];
              if (m) pick(m.user.id, m.user.name);
              return;
            }
          }
          if (e.key === 'Escape') {
            e.stopPropagation();
            if (open) setClosedAt(at);
            else onCancel?.();
            return;
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {open && (
        <div
          role="listbox"
          aria-label={tr('提及成员')}
          className="absolute top-full right-0 left-0 z-popover mt-1 rounded-lg border border-line bg-elevated p-1 shadow-lg"
        >
          <MemberOptions
            items={items}
            index={index}
            onHover={setIndex}
            onPick={(m) => pick(m.user.id, m.user.name)}
            empty={members.isPending ? tr('正在加载成员…') : tr('没有找到这个成员')}
          />
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-caption text-fg-subtle">
          {tr('@ 提及成员 · {value} 发送', { value: shortcutLabel('Mod-Enter') })}
        </span>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {tr('取消')}
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          disabled={!value.trim() || busy}
          onClick={() => void submit()}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
