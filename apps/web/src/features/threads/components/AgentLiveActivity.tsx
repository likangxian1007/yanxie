import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import {
  AlertCircle,
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  Loader2,
  MessageSquareText,
  RotateCw,
  Wrench,
} from 'lucide-react';
import type { AgentSession } from '@srh/shared';
import { AgentThinking, Button, toast } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { useResumeAgent } from '@/lib/agents';
import { cn } from '@/lib/cn';
import { useMessageFeed } from '@/lib/messages';
import { useMotionPreset } from '@/lib/motion';
import { useAgentSteps } from '../thread-api';
import {
  buildActivity,
  clip,
  summarizeGroup,
  type ActivityItem,
  type SummaryContext,
} from '../step-summary';
import {
  LIVE_TEXT as T,
  PENDING_WINDOW_MS,
  deriveLiveState,
  fmtSeconds,
  readOpen,
  stripNote,
  writeOpen,
  type LiveState,
} from '../live-activity';
import { tr } from '@/lib/i18n';

/*
 * 聊天流底部的「agent 现在在干什么」：工作中显示动画 + 当前动作 + 计时 + 可折叠的工作过程；
 * 一轮结束收成「已完成 · N 步 · 用时 Xs」；出错 / 停下 / 没回复时给红色说明和「重试」。
 */

// ---------------------------------------------------------------- 视图

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') return p;
  }
  return document.getElementById('app-scroll');
}

/**
 * 自己长高（新步骤、展开 / 收起）时，人若停在底部附近就继续贴底；
 * MessageFeed 只在消息变化时跟随，管不到这块。
 */
function useStickToBottom(active: boolean) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!active || !el || typeof ResizeObserver === 'undefined') return;
    const scroller = scrollParent(el);
    if (!scroller) return;
    let last = el.offsetHeight;
    const observer = new ResizeObserver(() => {
      const h = el.offsetHeight;
      const grew = h - last;
      last = h;
      const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (gap - Math.max(grew, 0) < 160) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [active]);
  return ref;
}

function ItemRow({ item, ctx }: { item: ActivityItem; ctx: SummaryContext }) {
  let icon: ReactNode;
  let text: ReactNode;
  let tone: 'muted' | 'danger' | 'warning' = 'muted';
  switch (item.kind) {
    case 'thinking': {
      const content = item.steps.map((s) => s.content).join(' ');
      icon = <Brain size={13} strokeWidth={1.75} />;
      text = (
        <>
          <span className="font-medium text-fg">{T.think}</span>
          {content.trim() && <span className="ml-1.5">{clip(content, 90)}</span>}
        </>
      );
      break;
    }
    case 'text':
      icon = <MessageSquareText size={13} strokeWidth={1.75} />;
      text = (
        <>
          <span className="font-medium text-fg">{T.draft}</span>
          <span className="ml-1.5">{clip(item.step.content, 90)}</span>
        </>
      );
      break;
    case 'tools': {
      const g = summarizeGroup(item.calls, ctx);
      const pending = item.calls.some((c) => c.ok === null);
      if (g.tone === 'error') tone = 'danger';
      icon = pending ? (
        <Loader2 size={13} strokeWidth={1.75} className="animate-spin motion-reduce:animate-none" />
      ) : g.tone === 'error' ? (
        <AlertCircle size={13} strokeWidth={1.75} />
      ) : g.tone === 'success' ? (
        <Check size={13} strokeWidth={1.75} />
      ) : (
        <Wrench size={13} strokeWidth={1.75} />
      );
      text = (
        <>
          <span className={cn(tone === 'danger' ? 'text-danger' : 'text-fg')}>{g.text}</span>
          {g.outcome && <span className="ml-1.5">· {g.outcome}</span>}
        </>
      );
      break;
    }
    case 'note': {
      const s = item.step;
      if (s.name === 'error') tone = 'danger';
      else if (s.name === 'round_limit' || s.name === 'stopped') tone = 'warning';
      icon =
        tone === 'muted' ? (
          <MessageSquareText size={13} strokeWidth={1.75} />
        ) : (
          <CircleAlert size={13} strokeWidth={1.75} />
        );
      text =
        s.name === 'wake' ? (
          <>
            <span className="font-medium text-fg">{T.received}</span>
            <span className="ml-1.5">{clip(stripNote(s.content), 90)}</span>
          </>
        ) : (
          clip(stripNote(s.content), 120)
        );
      break;
    }
  }
  return (
    <li
      className={cn(
        'flex min-w-0 items-start gap-2 text-caption font-normal',
        tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-fg-muted',
      )}
    >
      <span aria-hidden className="mt-0.5 shrink-0">
        {icon}
      </span>
      <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{text}</span>
    </li>
  );
}

function ProcessList({
  items,
  ctx,
  empty,
}: {
  items: ActivityItem[];
  ctx: SummaryContext;
  empty?: string;
}) {
  if (items.length === 0)
    return empty ? <p className="text-caption font-normal text-fg-subtle">{empty}</p> : null;
  return (
    <ol className="flex min-w-0 flex-col gap-1.5" aria-label={T.process}>
      {items.map((it) => (
        <ItemRow key={it.id} item={it} ctx={ctx} />
      ))}
    </ol>
  );
}

export interface AgentLiveActivityViewProps {
  state: LiveState;
  now: number;
  ctx?: SummaryContext;
  /** 「重试」：让 agent 接着做；不传就不显示按钮 */
  onRetry?: (() => void) | undefined;
  retrying?: boolean;
  /** 出错 / 停下已由页面上的横幅处理时，这里只给原因不给按钮 */
  haltedHandled?: boolean;
  className?: string;
}

/** 纯展示：传入推导好的状态 */
export function AgentLiveActivityView({
  state,
  now,
  ctx = {},
  onRetry,
  retrying = false,
  haltedHandled = false,
  className,
}: AgentLiveActivityViewProps) {
  const { variants } = useMotionPreset();
  const listId = useId();
  const [liveOpen, setLiveOpen] = useState(readOpen);
  const [doneOpen, setDoneOpen] = useState(false);
  const items = useMemo(() => buildActivity(state.turnSteps), [state.turnSteps]);
  const countable = items.filter((i) => !(i.kind === 'note' && i.step.name === 'wake')).length;
  const rootRef = useStickToBottom(state.visible);

  if (!state.visible) return null;

  const open = state.live ? liveOpen : doneOpen;
  const toggle = () => {
    if (state.live) {
      setLiveOpen((v) => {
        writeOpen(!v);
        return !v;
      });
    } else setDoneOpen((v) => !v);
  };

  const err = state.error;
  const halted = err?.kind === 'failed' || err?.kind === 'stopped';
  const showRetry = Boolean(err?.retryable && onRetry && !(halted && haltedHandled));
  const elapsed = state.startedAt !== null ? fmtSeconds(now - state.startedAt) : null;
  const hasProcess = state.live || items.length > 0;

  return (
    <motion.section
      ref={rootRef}
      variants={variants.fadeUp}
      initial="hidden"
      animate="visible"
      aria-label={tr('agent 状态')}
      data-state={state.live ? 'live' : err ? 'error' : 'done'}
      className={cn('my-3 flex min-w-0 max-w-full flex-col gap-2', className)}
    >
      {hasProcess && (
        <div
          className={cn(
            'min-w-0 rounded-lg border px-3 py-2',
            state.live ? 'border-agent/30 bg-agent-soft/40' : 'border-line bg-subtle/60',
          )}
        >
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={toggle}
            className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-xs text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              size={14}
              strokeWidth={1.75}
              aria-hidden
              className={cn(
                'shrink-0 text-fg-subtle transition-transform duration-(--dur-fast) ease-(--ease-standard)',
                open && 'rotate-90',
              )}
            />
            {state.live ? (
              <>
                <AgentThinking label={state.label} className="min-w-0 flex-1" />
                {elapsed && (
                  <span className="shrink-0 text-caption font-normal tabular-nums text-fg-subtle">
                    {elapsed}
                  </span>
                )}
              </>
            ) : (
              <span className="min-w-0 flex-1 truncate text-caption font-normal text-fg-muted">
                <span className="font-medium text-fg">{err && halted ? err.title : T.done}</span>
                {` · ${countable} ${T.steps}`}
                {state.tookMs !== null && ` · ${T.took} ${fmtSeconds(state.tookMs)}`}
              </span>
            )}
            {state.live && (
              <span className="hidden shrink-0 text-caption font-normal text-fg-subtle min-[400px]:inline">
                {T.process}
              </span>
            )}
          </button>
          {open && (
            <motion.div
              id={listId}
              variants={variants.fadeIn}
              initial="hidden"
              animate="visible"
              className="mt-2 max-h-60 min-w-0 overflow-y-auto overscroll-contain border-t border-line pt-2"
            >
              <ProcessList items={items} ctx={ctx} empty={state.live ? T.noSteps : undefined} />
            </motion.div>
          )}
        </div>
      )}

      {err && (
        <div
          role="alert"
          className={cn(
            'flex min-w-0 flex-wrap items-start gap-2 rounded-lg border px-3 py-2',
            err.tone === 'danger'
              ? 'border-danger/30 bg-danger-soft/60 text-danger'
              : 'border-warning/30 bg-warning-soft/60 text-warning',
          )}
        >
          <CircleAlert size={16} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-small font-medium">{err.title}</p>
            {err.reason && (
              <p className="mt-0.5 text-caption font-normal break-words [overflow-wrap:anywhere] text-fg-muted">
                {err.reason}
              </p>
            )}
          </div>
          {showRetry && (
            <Button
              size="sm"
              variant="secondary"
              loading={retrying}
              leftIcon={<RotateCw size={14} strokeWidth={1.75} />}
              onClick={onRetry}
              className="shrink-0"
            >
              {err.kind === 'notStarted' ? T.wake : T.retry}
            </Button>
          )}
        </div>
      )}
    </motion.section>
  );
}

export interface AgentLiveActivityProps {
  projectId: string;
  /** 线程 id；协作台时间线传 null */
  threadId: string | null;
  agent: AgentSession | null | undefined;
  /** 本页最近一次发送成功的时间（ms），用来判断「刚发、还没回」 */
  sentAt?: number | null;
  writable: boolean;
  haltedHandled?: boolean;
  className?: string;
}

/** 接好数据的版本：放在聊天流底部、输入框上方 */
export function AgentLiveActivity({
  projectId,
  threadId,
  agent,
  sentAt = null,
  writable,
  haltedHandled,
  className,
}: AgentLiveActivityProps) {
  const steps = useAgentSteps(projectId, agent?.id);
  const feed = useMessageFeed(projectId, threadId, 'agent');
  const resume = useResumeAgent(projectId);
  const [now, setNow] = useState(() => Date.now());

  const state = deriveLiveState({
    agent,
    steps: steps.steps,
    messages: feed.messages,
    sentAt,
    now,
  });
  // 进行中或等回复时每秒走一次（计时 + 20s 提示）
  const ticking = state.live || (sentAt !== null && now - sentAt < PENDING_WINDOW_MS);
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  const onRetry =
    writable && agent
      ? () =>
          resume.mutate(agent.id, {
            onSuccess: () => toast({ title: T.resumed, tone: 'success' }),
            onError: (e) =>
              toast.error(
                T.resumeFailed,
                e instanceof ApiRequestError && e.status === 404 ? T.resumeGone : e.message,
              ),
          })
      : undefined;

  return (
    <AgentLiveActivityView
      state={state}
      now={now}
      onRetry={onRetry}
      retrying={resume.isPending}
      haltedHandled={haltedHandled}
      className={className}
    />
  );
}
