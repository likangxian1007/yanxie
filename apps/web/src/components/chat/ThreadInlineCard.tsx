import { useMemo } from 'react';
import { Link } from 'react-router';
import { ChevronRight, MessageSquare } from 'lucide-react';
import { checklistProgress, parseChecklist, type AgentSession, type Thread } from '@srh/shared';
import { AgentThinking, Badge, StatusDot } from '@/components/ui';
import { cn } from '@/lib/cn';
import { paletteFromString } from '@/lib/palette';
import { displayTextClass, threadDisplay } from '@/lib/status';
import { tr } from '@/lib/i18n';

export interface ThreadInlineCardProps {
  thread: Thread;
  href: string;
  /** agent 当前一句话动态（工作中时显示扫光） */
  activity?: string | null | undefined;
  /** 线程 agent 会话（用来如实显示停工、出错） */
  agent?: AgentSession | null | undefined;
  /** 是否允许扫光动画（控制同屏循环动画数量） */
  animate?: boolean;
  className?: string;
}

/**
 * 时间线消息下方的线程行（类似 Projects 的 thread card）：标题、状态、当前步骤、回复数，点开进线程。
 */
export function ThreadInlineCard({
  thread,
  href,
  activity,
  agent,
  animate = true,
  className,
}: ThreadInlineCardProps) {
  const list = useMemo(() => parseChecklist(thread.statusText), [thread.statusText]);
  const current =
    list.lines.find((l) => l.mark === 'active') ?? list.lines[list.lines.length - 1] ?? null;
  const progress = checklistProgress(list);
  const display = threadDisplay(thread, agent);
  const working = display.kind === 'working';

  return (
    <Link
      to={href}
      className={cn(
        'group mt-2 flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 shadow-xs',
        'transition-[border-color,box-shadow,translate] duration-(--dur-fast) ease-(--ease-standard)',
        'hover:-translate-y-px hover:border-line-strong hover:shadow-sm motion-reduce:hover:translate-y-0',
        className,
      )}
    >
      <StatusDot status={display.dot} label={display.label} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-body font-medium text-fg">{thread.title}</span>
          {thread.label && (
            <Badge color={paletteFromString(thread.label)} className="hidden sm:inline-flex">
              {thread.label}
            </Badge>
          )}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-small text-fg-muted">
          {working && activity && animate ? (
            <AgentThinking label={activity} className="min-w-0" />
          ) : (
            <span className="truncate">
              <span className={displayTextClass(display.kind)}>{display.label}</span>
              {current && <span> · {current.text}</span>}
            </span>
          )}
        </span>
      </span>
      {list.lines.length > 0 && (
        <span
          aria-label={tr('进度 {Math}%', { Math: Math.round(progress * 100) })}
          className="relative hidden h-1 w-14 shrink-0 overflow-hidden rounded-full bg-muted sm:block"
        >
          <span
            className="absolute inset-y-0 left-0 origin-left rounded-full bg-success transition-transform duration-(--dur-slow) ease-(--ease-out)"
            style={{ width: '100%', transform: `scaleX(${progress})` }}
          />
        </span>
      )}
      <span className="inline-flex shrink-0 items-center gap-1 text-caption font-normal text-fg-subtle tabular-nums">
        <MessageSquare size={13} strokeWidth={1.75} aria-hidden />
        {thread.replyCount}
      </span>
      <ChevronRight
        size={16}
        strokeWidth={1.75}
        aria-hidden
        className="shrink-0 text-fg-subtle transition-transform duration-(--dur-fast) group-hover:translate-x-0.5"
      />
    </Link>
  );
}
