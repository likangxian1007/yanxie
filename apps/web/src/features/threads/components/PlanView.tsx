import { useId, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Check, ChevronRight } from 'lucide-react';
import {
  checklistProgress,
  parseChecklist,
  type AgentSession,
  type ChecklistLine,
} from '@srh/shared';
import { RelativeTime } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { isAgentBusy } from '@/lib/project';
import { summarizePlan } from './plan-summary';
import { tr } from '@/lib/i18n';

export interface PlanViewProps {
  /** 状态清单原文（第 1 行是目标，之后 ✓ / ✱ / ○ 开头） */
  text: string;
  /** 执行这份计划的 agent：工作中时在当前一步下面写出它正在做什么 */
  agent?: AgentSession | null;
  /** agent 没在工作时，当前一步下面的说明（如「等你回复」） */
  idleNote?: string;
  /** idleNote 的文字色（语义色类名） */
  idleNoteClassName?: string;
  /** 不显示目标行（外层已经写了标题时） */
  hideGoal?: boolean;
  /** 已完成超过这么多步时，把较早的已完成步骤收起（只留最近一步）；0 表示总是收起 */
  collapseDoneAfter?: number;
  /** 当前一步的标记是否带一圈缓慢的呼吸光环（只在 agent 工作中时开） */
  animate?: boolean;
  className?: string;
}

const STATUS_SR: Record<'done' | 'current' | 'todo', string> = {
  done: tr('已完成'),
  current: tr('当前步骤'),
  todo: tr('未开始'),
};

type StepState = 'done' | 'current' | 'todo';

function StepMarker({ state, n, pulse }: { state: StepState; n: number; pulse: boolean }) {
  if (state === 'done') {
    return (
      <span className="grid size-5 place-items-center rounded-full bg-success-soft text-success">
        <Check size={12} strokeWidth={2.25} aria-hidden />
      </span>
    );
  }
  return (
    <span
      className={cn(
        'relative grid size-5 place-items-center rounded-full text-[11px] leading-none font-medium tabular-nums',
        state === 'current'
          ? 'bg-accent-solid text-accent-fg'
          : 'bg-surface text-fg-subtle ring-1 ring-line-strong ring-inset',
      )}
    >
      {pulse && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-full bg-accent opacity-0 animate-pulse-ring"
        />
      )}
      <span className="relative">{n}</span>
    </span>
  );
}

/**
 * 线程 / 个人会话的计划（来自 agent 的状态清单）：
 * 目标 → 「第 x 步，共 y 步」+ 细进度条 → 步骤列表。
 * 当前一步加粗并写出 agent 正在做什么、从什么时候开始；已完成的步骤安静地收在上面，未开始的平铺在下面。
 */
export function PlanView({
  text,
  agent,
  idleNote,
  idleNoteClassName,
  hideGoal,
  collapseDoneAfter = 3,
  animate = false,
  className,
}: PlanViewProps) {
  const { spring, reduced } = useMotionPreset();
  const list = useMemo(() => parseChecklist(text), [text]);
  const summary = summarizePlan(list);
  const progress = checklistProgress(list);
  const [showAllDone, setShowAllDone] = useState(false);
  const listId = useId();
  const busy = isAgentBusy(agent);

  if (summary.total === 0 && !list.title) return null;

  const steps = list.lines.map((line, i) => ({
    line,
    n: i + 1,
    state: (i + 1 === summary.current
      ? 'current'
      : line.mark === 'done'
        ? 'done'
        : 'todo') as StepState,
  }));
  const doneSteps = steps.filter((s) => s.state === 'done');
  // 收起时：只藏「更早的」已完成步骤，最近完成的一步留着，衔接当前一步
  const canCollapse = doneSteps.length > Math.max(collapseDoneAfter, 1);
  const hidden =
    canCollapse && !showAllDone
      ? new Set<number>(doneSteps.slice(0, -1).map((s) => s.n))
      : new Set<number>();
  const complete = summary.current === null && summary.total > 0;

  return (
    <div className={cn('min-w-0', className)}>
      {!hideGoal && list.title && (
        <p className="text-body font-medium text-pretty text-fg">{list.title}</p>
      )}
      {summary.total > 0 && (
        <div className={cn(!hideGoal && list.title && 'mt-1')}>
          <div className="flex items-baseline justify-between gap-3 text-caption text-fg-muted">
            <span>{summary.label}</span>
            <span className="text-fg-subtle tabular-nums">
              {tr('已完成 {done}/{total}', { done: summary.done, total: summary.total })}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label={tr('计划进度')}
            aria-valuemin={0}
            aria-valuemax={summary.total}
            aria-valuenow={summary.done}
            aria-valuetext={summary.label}
            className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
          >
            <motion.div
              className={cn(
                'h-full origin-left rounded-full',
                complete ? 'bg-success' : 'bg-accent',
              )}
              initial={reduced ? false : { scaleX: 0 }}
              animate={{ scaleX: progress }}
              transition={spring.gentle}
            />
          </div>
        </div>
      )}

      {summary.total > 0 && (
        <ol id={listId} aria-label={list.title || tr('计划步骤')} className="mt-3 flex flex-col">
          {canCollapse && (
            <li className="mb-1">
              <button
                type="button"
                aria-expanded={showAllDone}
                aria-controls={listId}
                onClick={() => setShowAllDone((v) => !v)}
                className="flex cursor-pointer items-center gap-1 rounded-xs py-0.5 text-caption text-fg-subtle hover:text-fg-muted"
              >
                <ChevronRight
                  size={14}
                  strokeWidth={1.75}
                  aria-hidden
                  className={cn(
                    'transition-transform duration-(--dur-fast) ease-(--ease-standard)',
                    showAllDone && 'rotate-90',
                  )}
                />
                {showAllDone
                  ? tr('收起已完成的步骤')
                  : tr('显示更早完成的 {value} 步', { value: doneSteps.length - 1 })}
              </button>
            </li>
          )}
          {steps
            .filter((s) => !hidden.has(s.n))
            .map(({ line, n, state }, i, shown) => (
              <PlanStep
                key={`${n}-${line.text}`}
                line={line}
                n={n}
                state={state}
                last={i === shown.length - 1}
                pulse={state === 'current' && busy && animate}
                agent={state === 'current' ? agent : null}
                busy={busy}
                idleNote={state === 'current' ? idleNote : undefined}
                idleNoteClassName={idleNoteClassName}
              />
            ))}
        </ol>
      )}
    </div>
  );
}

function PlanStep({
  line,
  n,
  state,
  last,
  pulse,
  agent,
  busy,
  idleNote,
  idleNoteClassName,
}: {
  line: ChecklistLine;
  n: number;
  state: StepState;
  last: boolean;
  pulse: boolean;
  agent: AgentSession | null | undefined;
  busy: boolean;
  idleNote: string | undefined;
  idleNoteClassName: string | undefined;
}) {
  const current = state === 'current';
  return (
    <li
      data-state={state}
      data-highlight={line.highlight || undefined}
      className="relative grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2.5"
    >
      {/* 步骤之间的竖线 */}
      {!last && (
        <span aria-hidden className="absolute top-6 bottom-0.5 left-[0.5625rem] w-px bg-line" />
      )}
      <span className="pt-0.5">
        <StepMarker state={state} n={n} pulse={pulse} />
      </span>
      <div className={cn('relative min-w-0', last ? 'pb-0' : 'pb-3')}>
        {line.highlight && (
          <span
            aria-hidden
            className="absolute -inset-x-1.5 -top-0.5 bottom-2 rounded-sm bg-success-soft animate-flash"
          />
        )}
        <p
          className={cn(
            'relative text-small text-pretty break-words',
            current ? 'font-medium text-fg' : state === 'done' ? 'text-fg-subtle' : 'text-fg-muted',
          )}
        >
          <span className="sr-only">{tr('{value}：', { value: STATUS_SR[state] })}</span>
          {line.text}
        </p>
        {current && agent && busy && (
          <p className="relative mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-caption text-fg-muted">
            <span className="min-w-0 truncate text-accent-text">
              {agent.activity ?? tr('正在处理这一步')}
            </span>
            <span aria-hidden className="text-fg-subtle">
              ·
            </span>
            <span className="text-fg-subtle">
              {tr('更新于 ')}
              <RelativeTime iso={agent.lastActivityAt} />
            </span>
          </p>
        )}
        {current && !busy && idleNote && (
          <p className={cn('relative mt-1 text-caption', idleNoteClassName ?? 'text-fg-subtle')}>
            {idleNote}
          </p>
        )}
      </div>
    </li>
  );
}
