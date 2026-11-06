import { useMemo, type ReactNode } from 'react';
import { useQueries } from '@tanstack/react-query';
import { ChevronDown, CircleQuestionMark, Square } from 'lucide-react';
import type { AgentSession, Decision, Message, Thread } from '@srh/shared';
import { AgentThinking, Avatar, Badge, Button } from '@/components/ui';
import { DecisionCard } from '@/components/chat/DecisionCard';
import { cn } from '@/lib/cn';
import { isAgentBusy, useThreadAgent } from '@/lib/project';
import { qk } from '@/lib/query-keys';
import { AGENT_STATUS_LABEL, displayTextClass, threadDisplay } from '@/lib/status';
import { formatTokens } from '../thread-utils';
import { EditablePlan } from './EditablePlan';
import { tr } from '@/lib/i18n';

export function AsideCard({
  title,
  action,
  children,
  className,
  ...props
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <section className={cn('min-w-0 border-t border-line', className)} {...props}>
      <div className="flex items-center gap-2 px-1 py-3">
        <h2 className="min-w-0 flex-1 truncate text-caption text-fg-muted">{title}</h2>
        {action}
      </div>
      <div className="pb-4">{children}</div>
    </section>
  );
}

/**
 * 计划（agent 的状态清单）：目标、第几步、当前一步在做什么。
 * agent 没在工作时，当前一步下面如实写出线程的状态（等你回复、已停下……）。
 */
export function ThreadChecklistCard({
  thread,
  animate,
  writable = false,
}: {
  thread: Thread;
  animate: boolean;
  /** 成员可以直接改计划（访客没有编辑入口） */
  writable?: boolean;
}) {
  const agent = useThreadAgent(thread.projectId, thread);
  const display = threadDisplay(thread, agent);
  const idleNote =
    display.kind === 'working' || display.kind === 'idle' ? undefined : display.label;
  return (
    <AsideCard title={tr('计划')}>
      <EditablePlan
        thread={thread}
        canEdit={writable}
        emptyText={tr('agent 列出计划后会显示在这里，你也可以自己写。')}
        agent={agent}
        animate={animate}
        idleNote={idleNote}
        idleNoteClassName={displayTextClass(display.kind) || undefined}
        className="px-1 pb-0.5"
      />
    </AsideCard>
  );
}

const AGENT_TONE: Record<AgentSession['status'], 'agent' | 'warning' | 'danger' | 'neutral'> = {
  running: 'agent',
  queued: 'agent',
  waiting: 'warning',
  failed: 'danger',
  stopped: 'neutral',
  idle: 'neutral',
};

/** 当前线程 agent：状态、在做什么、模型、token 用量。 */
export function ThreadAgentCard({
  agent,
  animate,
  canStop,
  stopping,
  onStop,
}: {
  agent: AgentSession | null;
  animate: boolean;
  canStop: boolean;
  stopping: boolean;
  onStop: () => void;
}) {
  const busy = isAgentBusy(agent);
  return (
    <AsideCard
      title={tr('当前 agent')}
      action={
        agent && <Badge tone={AGENT_TONE[agent.status]}>{AGENT_STATUS_LABEL[agent.status]}</Badge>
      }
    >
      {!agent ? (
        <p className="px-1 text-small text-fg-subtle">{tr('这个线程还没有分配 agent。')}</p>
      ) : (
        <div className="flex flex-col gap-3 px-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar kind="agent" name={tr('线程 agent')} size={32} />
            <div className="min-w-0 flex-1">
              <p className="text-body font-semibold text-agent-text">{tr('线程 agent')}</p>
              {busy && animate ? (
                <AgentThinking label={agent.activity ?? tr('思考中')} className="max-w-full" />
              ) : (
                <p className="truncate text-small text-fg-muted">
                  {agent.activity ?? (busy ? tr('工作中') : tr('暂时没有在做的事'))}
                </p>
              )}
            </div>
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-small">
            <dt className="text-fg-subtle">{tr('模型')}</dt>
            <dd className="truncate font-mono text-caption leading-5 font-normal text-fg">
              {agent.model}
            </dd>
            <dt className="text-fg-subtle">{tr('输入')}</dt>
            <dd className="text-fg tabular-nums">{formatTokens(agent.tokenUsage.input)} tokens</dd>
            <dt className="text-fg-subtle">{tr('输出')}</dt>
            <dd className="text-fg tabular-nums">{formatTokens(agent.tokenUsage.output)} tokens</dd>
            {agent.tokenUsage.cached > 0 && (
              <>
                <dt className="text-fg-subtle">{tr('缓存命中')}</dt>
                <dd className="text-fg-muted tabular-nums">
                  {formatTokens(agent.tokenUsage.cached)} tokens
                </dd>
              </>
            )}
          </dl>
          {busy && canStop && (
            <Button
              size="sm"
              variant="secondary"
              loading={stopping}
              leftIcon={<Square strokeWidth={2} fill="currentColor" aria-hidden />}
              onClick={onStop}
              className="self-start"
            >
              {tr('停止 agent')}
            </Button>
          )}
        </div>
      )}
    </AsideCard>
  );
}

function decisionOf(m: Message): { id: string; snapshot: Decision } | null {
  const snapshot = m.meta.decision as Decision | undefined;
  const id = (m.meta.decisionId as string | undefined) ?? snapshot?.id;
  return id && snapshot ? { id, snapshot } : null;
}

/** 这个线程里还没回答的决策（读消息缓存里的决策卡，和 DecisionCard / useDecision 同一个缓存）。 */
export function ThreadDecisions({
  projectId,
  messages,
  readOnly,
  className,
}: {
  projectId: string;
  messages: Message[];
  readOnly: boolean;
  className?: string;
}) {
  const refs = useMemo(
    () =>
      messages
        .filter((m) => m.kind === 'decision')
        .map(decisionOf)
        .filter((x): x is { id: string; snapshot: Decision } => x !== null),
    [messages],
  );
  const results = useQueries({
    queries: refs.map((r) => ({
      queryKey: qk.decision(projectId, r.id),
      queryFn: () => r.snapshot,
      initialData: r.snapshot,
      staleTime: Infinity,
    })),
  });
  const open = results
    .map((q) => q.data)
    .filter((d): d is Decision => Boolean(d) && d?.state === 'open');

  if (open.length === 0) return null;
  return (
    <section aria-label={tr('待决定')} className={cn('min-w-0', className)}>
      <details className="group rounded-lg border border-line bg-surface">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 text-small text-fg hover:bg-subtle [&::-webkit-details-marker]:hidden">
          <CircleQuestionMark size={16} strokeWidth={1.75} aria-hidden className="text-warning" />
          <span className="flex-1 font-medium">
            {tr('待决定 · {count}', { count: open.length })}
          </span>
          <ChevronDown
            size={16}
            strokeWidth={1.75}
            aria-hidden
            className="shrink-0 text-fg-subtle group-open:rotate-180"
          />
        </summary>
        <div className="flex flex-col gap-2 px-3 pb-3">
          {open.map((d) => (
            <DecisionCard key={d.id} projectId={projectId} decision={d} readOnly={readOnly} />
          ))}
        </div>
      </details>
    </section>
  );
}
