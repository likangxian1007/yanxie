import { useRef, useState, type FormEvent } from 'react';
import { CornerDownLeft, Flag, Plus } from 'lucide-react';
import type { TodoCreateInput, TodoPriority } from '@srh/shared';
import { Badge, Button, Input, Select, Switch } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  AssigneeAvatar,
  AssigneePicker,
  describeAssignee,
  useAssigneeOptions,
} from '@/features/collab-kit/assignees';
import { fromDateInputValue } from '@/features/board/lib/due';
import { parseQuickAdd, stripPendingMention } from '../lib/quick-add';
import { PRIORITY_LABEL, PRIORITY_OPTIONS } from '../lib/todo-list';
import { tr } from '@/lib/i18n';

export interface QuickAddProps {
  pid: string;
  onCreate: (input: TodoCreateInput) => Promise<boolean>;
}

/**
 * 快速添加：回车添加；“!高”“!!”标记优先级，“@名字”指派（输入 @ 时弹出指派选择）。
 * 右侧还有指派、优先级、截止日期和“仅自己可见”。
 */
export function QuickAdd({ pid, onCreate }: QuickAddProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [assignee, setAssignee] = useState<string | null>(null);
  const [priority, setPriority] = useState<TodoPriority>('normal');
  const [due, setDue] = useState('');
  const [personal, setPersonal] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { options, byValue } = useAssigneeOptions(pid);

  const parsed = parseQuickAdd(text, options);
  const effectivePriority = parsed.priority ?? priority;
  const effectiveAssignee = parsed.assigneeId ?? assignee;

  const focusInput = () => window.setTimeout(() => inputRef.current?.focus(), 0);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!parsed.title || busy) return;
    setBusy(true);
    const ok = await onCreate({
      title: parsed.title.slice(0, 200),
      priority: effectivePriority,
      assigneeId: effectiveAssignee,
      dueAt: fromDateInputValue(due),
      personal,
    });
    setBusy(false);
    if (ok) {
      setText('');
      setAssignee(null);
      setPriority('normal');
      setDue('');
      // 「仅自己可见」只对这一条生效，免得下一条悄悄变成私有
      setPersonal(false);
      focusInput();
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className={cn(
        'rounded-xl border border-line bg-surface p-2 shadow-sm',
        'transition-[border-color,box-shadow] duration-(--dur-fast) ease-(--ease-standard)',
        'focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--ring)]',
      )}
    >
      <div className="flex items-center gap-2 px-1.5">
        <Plus size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-fg-subtle" />
        <input
          ref={inputRef}
          value={text}
          maxLength={260}
          aria-label={tr('添加待办')}
          placeholder={tr('添加待办，回车保存；!高 或 !! 标记优先级，@ 指派')}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            if (v.endsWith('@') && (v.length === 1 || /\s$/u.test(v.slice(0, -1)))) {
              setPickerOpen(true);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault();
          }}
          className="h-9 min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-subtle"
        />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={busy}
          disabled={!parsed.title}
          leftIcon={<CornerDownLeft strokeWidth={1.75} aria-hidden />}
          className="hidden sm:inline-flex"
        >
          {tr('添加待办')}
        </Button>
      </div>

      {(parsed.priority || parsed.assigneeId) && (
        <div
          className="flex flex-wrap items-center gap-2 px-1.5 pt-1 text-caption text-fg-muted"
          aria-live="polite"
        >
          <span>{tr('将会')}</span>
          {parsed.priority && (
            <Badge
              tone={
                parsed.priority === 'urgent'
                  ? 'danger'
                  : parsed.priority === 'high'
                    ? 'warning'
                    : 'neutral'
              }
            >
              <Flag size={11} strokeWidth={2} aria-hidden />
              {tr('标记为')}
              {PRIORITY_LABEL[parsed.priority]}
            </Badge>
          )}
          {parsed.assigneeId && (
            <span className="inline-flex items-center gap-1">
              <AssigneeAvatar value={parsed.assigneeId} projectId={pid} />
              {tr('指派给 ')}
              {describeAssignee(parsed.assigneeId, byValue)?.label ?? tr('对方')}
            </span>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line pt-2">
        <AssigneePicker
          projectId={pid}
          value={effectiveAssignee}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onChange={(v) => {
            setAssignee(v);
            setText((t) => {
              const stripped = stripPendingMention(t);
              return stripped ? `${stripped} ` : '';
            });
            focusInput();
          }}
        />
        <Select
          size="sm"
          wrapperClassName="w-24"
          aria-label={tr('优先级')}
          value={effectivePriority}
          options={PRIORITY_OPTIONS}
          onChange={(e) => setPriority(e.target.value as TodoPriority)}
        />
        <Input
          type="date"
          size="sm"
          wrapperClassName="w-36"
          aria-label={tr('截止日期')}
          value={due}
          onChange={(e) => setDue(e.target.value)}
        />
        <label className="inline-flex items-center gap-2 px-1 text-small text-fg-muted">
          <Switch label={tr('仅自己可见')} checked={personal} onCheckedChange={setPersonal} />
          {tr('仅自己可见')}
        </label>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={busy}
          disabled={!parsed.title}
          className="ml-auto sm:hidden"
        >
          {tr('添加待办')}
        </Button>
      </div>
    </form>
  );
}
