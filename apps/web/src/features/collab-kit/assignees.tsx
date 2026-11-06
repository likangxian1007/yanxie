/* eslint-disable react-refresh/only-export-components --
 * 约定把指派相关的 hook、纯函数与组件放在同一个文件里（看板、待办、实验共用一个入口）。 */
import {
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Check, Search, UserPlus } from 'lucide-react';
import {
  COORDINATOR_ASSIGNEE,
  isAgentAssignee,
  type ProjectMember,
  type Thread,
} from '@srh/shared';
import { Avatar, Button, Input, Popover, Tooltip, type AvatarSize } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  ACTIVE_PROJECT_THREADS,
  ROLE_LABEL,
  useMembers,
  useProjectId,
  useThreads,
} from '@/lib/project';
import { useMeUser } from '@/lib/session';
import { tr } from '@/lib/i18n';

/**
 * 指派对象（看板卡片、待办、实验共用）：
 * - 成员：用户 id
 * - agent：`agent:coordinator`（协调者）或 `agent:<threadId>`（进行中的项目线程的 agent）
 */

export interface AssigneeOption {
  value: string;
  kind: 'user' | 'agent';
  label: string;
  sublabel?: string;
  /** 成员头像色（0–7） */
  color?: number;
}

/** 选择器里列出的线程：进行中的项目线程（与 useThreads 的查询键一致，页面预取也用它） */
export { ACTIVE_PROJECT_THREADS };

export const COORDINATOR_OPTION: AssigneeOption = {
  value: COORDINATOR_ASSIGNEE,
  kind: 'agent',
  label: tr('协调者'),
  sublabel: tr('统筹整个项目的 agent'),
};

/** 组合成员与 agent：成员（自己排最前）→ 协调者 → 进行中线程的 agent（最近活跃在前）。 */
export function buildAssigneeOptions(
  members: readonly ProjectMember[],
  threads: readonly Thread[],
  meId?: string | null,
): AssigneeOption[] {
  const people = [...members]
    .sort((a, b) => {
      if (a.user.id === meId) return -1;
      if (b.user.id === meId) return 1;
      return a.user.name.localeCompare(b.user.name, 'zh-Hans-CN');
    })
    .map<AssigneeOption>((m) => ({
      value: m.user.id,
      kind: 'user',
      label: m.user.name,
      sublabel: m.user.id === meId ? tr('你') : ROLE_LABEL[m.role],
      color: m.user.avatarColor,
    }));

  const agents = threads
    .filter((t) => t.kind === 'project' && !t.resolved)
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    .map<AssigneeOption>((t) => ({
      value: `agent:${t.id}`,
      kind: 'agent',
      label: t.title.trim() || tr('未命名线程'),
      sublabel: tr('线程 agent'),
    }));

  return [...people, COORDINATOR_OPTION, ...agents];
}

/**
 * 按值找指派对象；找不到时：协调者照常返回，`agent:<threadId>` 视为已结束线程的 agent，
 * 其余（已离开项目的成员等）返回 null。
 */
export function describeAssignee(
  value: string,
  byValue: ReadonlyMap<string, AssigneeOption>,
): AssigneeOption | null {
  const found = byValue.get(value);
  if (found) return found;
  if (value === COORDINATOR_ASSIGNEE) return COORDINATOR_OPTION;
  if (isAgentAssignee(value)) {
    return { value, kind: 'agent', label: tr('线程 agent'), sublabel: tr('线程已结束') };
  }
  return null;
}

/** 搜索：名字或副标题包含关键词（不区分大小写）。 */
export function filterAssigneeOptions(
  options: readonly AssigneeOption[],
  query: string,
): AssigneeOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...options];
  return options.filter(
    (o) => o.label.toLowerCase().includes(q) || (o.sublabel ?? '').toLowerCase().includes(q),
  );
}

/** 多选切换：有则去掉，无则追加。 */
export function toggleAssignee(current: readonly string[], value: string): string[] {
  return current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
}

export function useAssigneeOptions(pid: string) {
  const me = useMeUser();
  const members = useMembers(pid);
  const threads = useThreads(pid, ACTIVE_PROJECT_THREADS);
  const options = useMemo(
    () => buildAssigneeOptions(members.data ?? [], threads.data ?? [], me?.id ?? null),
    [members.data, threads.data, me?.id],
  );
  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  return { options, byValue, isLoading: members.isLoading || threads.isLoading };
}

// ---------------------------------------------------------------- 头像

const UNKNOWN_SIZE: Record<AvatarSize, string> = {
  20: 'size-5 text-[0.625rem]',
  24: 'size-6 text-[0.6875rem]',
  32: 'size-8 text-small',
  40: 'size-10 text-h3',
};

function OptionAvatar({
  option,
  size,
  ring,
}: {
  option: AssigneeOption | null;
  size: AvatarSize;
  ring?: boolean | undefined;
}) {
  if (!option) {
    return (
      <span
        role="img"
        aria-label={tr('未知指派对象')}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-fg-subtle select-none',
          UNKNOWN_SIZE[size],
          ring && 'ring-2 ring-canvas',
        )}
      >
        ?
      </span>
    );
  }
  const kind =
    option.kind === 'user'
      ? 'user'
      : option.value === COORDINATOR_ASSIGNEE
        ? 'coordinator'
        : 'agent';
  return (
    <Avatar
      name={option.label}
      color={option.color}
      kind={kind}
      size={size}
      ring={ring}
      title={undefined}
    />
  );
}

function tooltipOf(option: AssigneeOption | null): ReactNode {
  if (!option) return tr('未知指派对象（可能已离开项目）');
  return (
    <span>
      {option.label}
      {option.sublabel && <span className="opacity-70"> · {option.sublabel}</span>}
    </span>
  );
}

export interface AssigneeAvatarProps {
  value: string;
  size?: AvatarSize;
  /** 不传时取当前路由的项目 */
  projectId?: string;
  ring?: boolean;
  className?: string;
}

/** 单个指派对象的头像：成员用头像色，agent 用 agent 渐变（协调者带内描边），未知显示灰色问号。 */
export function AssigneeAvatar({
  value,
  size = 20,
  projectId,
  ring,
  className,
}: AssigneeAvatarProps) {
  const routePid = useProjectId();
  const { byValue } = useAssigneeOptions(projectId ?? routePid);
  const option = describeAssignee(value, byValue);
  return (
    <Tooltip content={tooltipOf(option)}>
      <span className={cn('inline-flex', className)}>
        <OptionAvatar option={option} size={size} ring={ring} />
      </span>
    </Tooltip>
  );
}

export interface AssigneeStackProps {
  values: readonly string[];
  max?: number;
  size?: AvatarSize;
  projectId?: string;
  className?: string;
}

/** 指派头像堆叠：重叠 -6px，超出折叠为 +N（悬停列出其余名字）。 */
export function AssigneeStack({
  values,
  max = 3,
  size = 20,
  projectId,
  className,
}: AssigneeStackProps) {
  const routePid = useProjectId();
  const { byValue } = useAssigneeOptions(projectId ?? routePid);
  if (values.length === 0) return null;
  const shown = values.slice(0, max);
  const rest = values.slice(max);
  return (
    <span
      className={cn('inline-flex items-center', className)}
      aria-label={tr('指派给 {count} 个对象', { count: values.length })}
    >
      {shown.map((v, i) => {
        const option = describeAssignee(v, byValue);
        return (
          <Tooltip key={v} content={tooltipOf(option)}>
            <span className={cn('inline-flex', i > 0 && '-ml-1.5')} style={{ zIndex: max - i }}>
              <OptionAvatar option={option} size={size} ring />
            </span>
          </Tooltip>
        );
      })}
      {rest.length > 0 && (
        <Tooltip
          content={rest
            .map((v) => describeAssignee(v, byValue)?.label ?? tr('未知'))
            .join(tr('、'))}
        >
          <span
            className={cn(
              '-ml-1.5 inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-fg-muted tabular-nums ring-2 ring-canvas',
              UNKNOWN_SIZE[size],
            )}
          >
            +{rest.length}
          </span>
        </Tooltip>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- 选择器

interface PickerCommon {
  /** 自定义触发按钮；默认是“指派”按钮 / 已选头像 */
  trigger?: ReactElement;
  projectId?: string;
  disabled?: boolean;
  align?: 'start' | 'end' | 'center';
  side?: 'bottom' | 'top';
  /** 受控打开（例如输入 @ 时弹出） */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export type AssigneePickerProps = PickerCommon &
  (
    | { multiple: true; value: readonly string[]; onChange: (value: string[]) => void }
    | { multiple?: false; value: string | null; onChange: (value: string | null) => void }
  );

interface OptionGroup {
  key: 'user' | 'agent';
  title: string;
  hint?: string;
  options: AssigneeOption[];
}

/**
 * 指派选择器：Popover 里一个搜索框 + 分组列表（成员 / AI agent）。
 * 上下键移动、回车切换，选中项打勾；单选时选完即关闭。
 */
export function AssigneePicker(props: AssigneePickerProps) {
  const { trigger, projectId, disabled, align = 'start', side = 'bottom' } = props;
  const routePid = useProjectId();
  const { options } = useAssigneeOptions(projectId ?? routePid);
  const [innerOpen, setInnerOpen] = useState(false);
  const open = props.open ?? innerOpen;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const baseId = useId();

  const selected: readonly string[] = props.multiple
    ? props.value
    : props.value
      ? [props.value]
      : [];

  const setOpen = (next: boolean) => {
    if (props.open === undefined) setInnerOpen(next);
    props.onOpenChange?.(next);
    if (!next) {
      setQuery('');
      setActive(0);
    }
  };

  const filtered = filterAssigneeOptions(options, query);
  const groups: OptionGroup[] = [
    { key: 'user' as const, title: tr('成员'), options: filtered.filter((o) => o.kind === 'user') },
    {
      key: 'agent' as const,
      title: 'AI agent',
      hint: tr('指派给 agent 会唤醒它开始做'),
      options: filtered.filter((o) => o.kind === 'agent'),
    },
  ].filter((g) => g.options.length > 0);
  const flat = groups.flatMap((g) => g.options);
  const offsets = groups.map((_, gi) =>
    groups.slice(0, gi).reduce((sum, g) => sum + g.options.length, 0),
  );
  const activeIndex = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const choose = (value: string) => {
    if (props.multiple) {
      props.onChange(toggleAssignee(props.value, value));
    } else {
      props.onChange(props.value === value ? null : value);
      setOpen(false);
    }
  };

  const moveActive = (next: number) => {
    if (flat.length === 0) return;
    const i = (next + flat.length) % flat.length;
    setActive(i);
    requestAnimationFrame(() => {
      document.getElementById(optionId(i))?.scrollIntoView?.({ block: 'nearest' });
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveActive(activeIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(activeIndex - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      moveActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      moveActive(flat.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const option = flat[activeIndex];
      if (option) choose(option.value);
    }
  };

  const defaultTrigger = (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      aria-label={
        selected.length ? tr('指派：已选 {count} 个', { count: selected.length }) : tr('指派')
      }
      leftIcon={selected.length ? undefined : <UserPlus strokeWidth={1.75} aria-hidden />}
    >
      {selected.length ? (
        <AssigneeStack values={selected} projectId={projectId ?? routePid} />
      ) : (
        tr('指派')
      )}
    </Button>
  );

  return (
    <Popover
      trigger={trigger ?? defaultTrigger}
      open={disabled ? false : open}
      onOpenChange={setOpen}
      align={align}
      side={side}
      role="dialog"
      label={tr('选择指派对象')}
      className="w-72 max-w-[calc(100vw-1rem)]"
    >
      <div className="p-1 pb-1.5">
        <Input
          size="sm"
          data-autofocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={tr('搜索成员或 agent')}
          leading={<Search strokeWidth={1.75} aria-hidden />}
          role="combobox"
          aria-label={tr('搜索指派对象')}
          aria-expanded
          aria-controls={`${baseId}-list`}
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          aria-autocomplete="list"
        />
      </div>
      <div
        id={`${baseId}-list`}
        role="listbox"
        aria-label={tr('指派对象')}
        aria-multiselectable={props.multiple ? true : undefined}
        className="max-h-72 overflow-y-auto"
      >
        {groups.map((g, gi) => (
          <div key={g.key} role="group" aria-labelledby={`${baseId}-${g.key}`}>
            <div id={`${baseId}-${g.key}`} className="px-2 pt-2 pb-0.5 text-caption text-fg-subtle">
              {g.title}
            </div>
            {g.hint && (
              <p className="px-2 pb-1 text-caption font-normal text-agent-text">{g.hint}</p>
            )}
            {g.options.map((o, oi) => {
              const i = (offsets[gi] ?? 0) + oi;
              const isSelected = selected.includes(o.value);
              return (
                <div
                  key={o.value}
                  id={optionId(i)}
                  role="option"
                  aria-selected={isSelected}
                  data-active={i === activeIndex || undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => {
                    if (i !== activeIndex) setActive(i);
                  }}
                  onClick={() => choose(o.value)}
                  className={cn(
                    'flex min-h-8 cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 select-none',
                    'transition-colors duration-(--dur-fast) ease-(--ease-standard)',
                    i === activeIndex && 'bg-subtle',
                  )}
                >
                  <OptionAvatar option={o} size={20} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body text-fg">{o.label}</span>
                    {o.sublabel && (
                      <span className="block truncate text-caption font-normal text-fg-subtle">
                        {o.sublabel}
                      </span>
                    )}
                  </span>
                  <Check
                    size={16}
                    strokeWidth={2}
                    aria-hidden
                    className={cn('shrink-0 text-accent', !isSelected && 'invisible')}
                  />
                </div>
              );
            })}
          </div>
        ))}
        {flat.length === 0 && (
          <p className="px-2 py-6 text-center text-small text-fg-muted">
            {options.length === 0 ? tr('正在加载成员…') : tr('没有匹配的成员或 agent')}
          </p>
        )}
      </div>
      {selected.length > 0 && (
        <div className="mt-1 border-t border-line pt-1">
          <button
            type="button"
            onClick={() => {
              if (props.multiple) props.onChange([]);
              else props.onChange(null);
              setOpen(false);
            }}
            className="flex h-8 w-full cursor-pointer items-center rounded-sm px-2 text-small text-fg-muted transition-colors duration-(--dur-fast) hover:bg-subtle hover:text-fg"
          >
            {tr('清除指派')}
          </button>
        </div>
      )}
    </Popover>
  );
}
