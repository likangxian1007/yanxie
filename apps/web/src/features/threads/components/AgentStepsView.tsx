import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { motion } from 'motion/react';
import { Brain, Lightbulb, MessageSquareText, Wrench } from 'lucide-react';
import type { AgentStep } from '@srh/shared';
import { Badge, EmptyState, Markdown, RelativeTime, Skeleton, Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { groupStepsByTurn } from '../thread-utils';
import {
  buildActivity,
  summarizeCall,
  summarizeGroup,
  type ActivityItem,
  type SummaryContext,
  type Tone,
  type ToolCall,
} from '../step-summary';
import { useDocTitleContext } from '../use-doc-titles';
import { Disclosure, RawData } from './StepDisclosure';
import { ErrorCard } from './ThreadStates';
import { tr } from '@/lib/i18n';

export interface AgentStepsViewProps {
  /** 用来把文档 id 换成标题 */
  projectId?: string;
  steps: AgentStep[];
  isPending: boolean;
  error: Error | null;
  onRetry: () => void;
  retrying: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  /** 线程没有 agent 会话 */
  noSession?: boolean;
}

function ItemIcon({ item, tone }: { item: ActivityItem; tone: Tone }) {
  const Icon =
    item.kind === 'thinking'
      ? Brain
      : item.kind === 'tools'
        ? Wrench
        : item.kind === 'text'
          ? MessageSquareText
          : Lightbulb;
  const noteName = item.kind === 'note' ? item.step.name : null;
  return (
    <span
      aria-hidden
      className={cn(
        'absolute top-0.5 left-0 grid size-6 place-items-center rounded-full bg-surface ring-1',
        (item.kind === 'thinking' || item.kind === 'text') && 'text-agent-text ring-line',
        item.kind === 'tools' && tone !== 'error' && 'text-fg-muted ring-line-strong',
        item.kind === 'tools' && tone === 'error' && 'bg-danger-soft text-danger ring-danger/30',
        noteName === 'error' && 'bg-danger-soft text-danger ring-danger/30',
        noteName === 'round_limit' && 'bg-warning-soft text-warning ring-warning/30',
        item.kind === 'note' &&
          noteName !== 'error' &&
          noteName !== 'round_limit' &&
          'text-fg-subtle ring-line',
      )}
    >
      <Icon size={13} strokeWidth={1.75} />
    </span>
  );
}

function Outcome({ text, tone }: { text: string | null; tone: Tone }) {
  if (!text) return null;
  return (
    <span
      className={cn(
        'block text-caption font-normal text-pretty break-words',
        tone === 'error' ? 'text-danger' : 'text-fg-muted',
      )}
    >
      {text}
    </span>
  );
}

function StatusBadge({ tone, pending }: { tone: Tone; pending: boolean }) {
  if (tone === 'error') return <Badge tone="danger">{tr('没成功')}</Badge>;
  if (pending) return <Badge tone="neutral">{tr('进行中')}</Badge>;
  return null;
}

function OneCall({ call, ctx }: { call: ToolCall; ctx: SummaryContext }) {
  const s = summarizeCall(call, ctx);
  return (
    <div className="min-w-0">
      <p className="text-small text-pretty break-words text-fg">{s.text}</p>
      <Outcome text={s.outcome} tone={s.tone} />
      <RawData call={call} className="mt-1" />
    </div>
  );
}

function ToolsItem({ calls, ctx }: { calls: ToolCall[]; ctx: SummaryContext }) {
  const g = summarizeGroup(calls, ctx);
  const pending = calls.some((c) => c.ok === null);
  if (calls.length === 1) {
    const s = summarizeCall(calls[0]!, ctx);
    return (
      <div className="min-w-0">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-small text-fg">
          <span className="min-w-0 text-pretty break-words">{s.text}</span>
          <StatusBadge tone={s.tone} pending={pending} />
        </p>
        <Outcome text={s.outcome} tone={s.tone} />
        <RawData call={calls[0]!} className="mt-1" />
      </div>
    );
  }
  return (
    <Disclosure
      defaultOpen={g.tone === 'error'}
      summary={
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="min-w-0 text-small text-pretty break-words text-fg">{g.text}</span>
          <StatusBadge tone={g.tone} pending={pending} />
        </span>
      }
      preview={
        g.outcome ? (
          <span className="block pl-5">
            <Outcome text={g.outcome} tone={g.tone} />
          </span>
        ) : undefined
      }
    >
      <ol className="flex flex-col gap-2.5 border-l border-line pl-3 ml-1.5">
        {calls.map((c, i) => (
          <li key={c.call?.id ?? c.result?.id ?? i}>
            <OneCall call={c} ctx={ctx} />
          </li>
        ))}
      </ol>
    </Disclosure>
  );
}

function ItemBody({ item, ctx }: { item: ActivityItem; ctx: SummaryContext }) {
  switch (item.kind) {
    case 'thinking':
      // 模型的思考常是英文草稿：默认收起，只给一个入口
      return (
        <Disclosure
          summary={<span className="text-small text-fg-muted">{tr('查看思考过程')}</span>}
        >
          <div className="max-h-96 overflow-auto rounded-md bg-subtle px-3 py-2">
            {item.steps.map((s) => (
              <p
                key={s.id}
                className="text-small text-pretty whitespace-pre-wrap break-words text-fg-muted italic [&+&]:mt-2"
              >
                {s.content}
              </p>
            ))}
          </div>
        </Disclosure>
      );
    case 'text':
      // 模型偶尔在工具调用之间用英文自言自语：不含中文的整段也收进「查看思考过程」
      if (!/[\u3400-\u9fff]/.test(item.step.content)) {
        return (
          <Disclosure
            summary={<span className="text-small text-fg-muted">{tr('查看思考过程')}</span>}
          >
            <div className="max-h-96 overflow-auto rounded-md bg-subtle px-3 py-2">
              <p className="text-small text-pretty whitespace-pre-wrap break-words text-fg-muted italic">
                {item.step.content}
              </p>
            </div>
          </Disclosure>
        );
      }
      return <Markdown size="compact">{item.step.content}</Markdown>;
    case 'tools':
      return <ToolsItem calls={item.calls} ctx={ctx} />;
    case 'note': {
      const step = item.step;
      // name=wake：这一轮 agent 收到的原始输入，默认收起
      if (step.name === 'wake') {
        return (
          <Disclosure
            summary={<span className="text-small text-fg-muted">{tr('查看这一轮收到的消息')}</span>}
          >
            <pre className="max-h-80 overflow-auto rounded-md border border-line bg-subtle px-3 py-2 font-mono text-caption font-normal whitespace-pre-wrap break-all text-fg-muted">
              {step.content}
            </pre>
          </Disclosure>
        );
      }
      // name=round_limit / error：步数用完自动续跑、或出错停下，醒目标出
      if (step.name === 'round_limit' || step.name === 'error') {
        const error = step.name === 'error';
        return (
          <div
            className={cn(
              'rounded-md border px-3 py-2 text-small text-pretty break-words',
              error
                ? 'border-danger/30 bg-danger-soft/60 text-danger'
                : 'border-warning/30 bg-warning-soft/60 text-fg',
            )}
          >
            <span className="font-medium">{error ? tr('出错停下') : tr('步数用完')}</span>
            <span className="text-fg-muted"> · </span>
            {step.content}
            {error && step.data.code === 'insufficient_credits' && (
              <>
                {' '}
                <Link
                  to="/billing"
                  className="font-medium text-accent underline underline-offset-2 hover:no-underline"
                >
                  {tr('去充值')}
                </Link>
              </>
            )}
          </div>
        );
      }
      // name=goal_reminder / nudge：运行时给 agent 的提醒（原文带 <system-note> 标签），只给一句人话，原文收起
      if (step.name === 'goal_reminder' || step.name === 'nudge') {
        return (
          <Disclosure
            summary={
              <span className="text-small text-fg-muted">
                {step.name === 'goal_reminder'
                  ? tr('平台提醒 agent 对照任务目标')
                  : tr('平台提醒 agent 收尾')}
              </span>
            }
          >
            <pre className="max-h-80 overflow-auto rounded-md border border-line bg-subtle px-3 py-2 font-mono text-caption font-normal whitespace-pre-wrap break-all text-fg-muted">
              {step.content.replace(/<\/?system-note>/gu, '')}
            </pre>
          </Disclosure>
        );
      }
      return (
        <p className="text-caption font-normal text-pretty break-words text-fg-subtle">
          {step.content.replace(/<\/?system-note>/gu, '')}
        </p>
      );
    }
  }
}

function itemTone(item: ActivityItem, ctx: SummaryContext): Tone {
  return item.kind === 'tools' ? summarizeGroup(item.calls, ctx).tone : 'neutral';
}

function StepsSkeleton() {
  return (
    <div className="flex flex-col gap-5 py-2" aria-label={tr('加载中')} aria-busy="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="size-6 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3.5 w-full max-w-md" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * agent 思路（导师视角）：按轮次分组，每一步写成一句中文（读了什么、改了哪里、结果如何），
 * 连续的同类步骤合成一组；思考过程和原始数据默认收起。新到的步骤 fadeUp 入场。
 */
export function AgentStepsView({
  projectId,
  steps,
  isPending,
  error,
  onRetry,
  retrying,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  noSession,
}: AgentStepsViewProps) {
  const { variants } = useMotionPreset();
  const ctx = useDocTitleContext(projectId);
  const turns = useMemo(
    () => groupStepsByTurn(steps).map((t) => ({ ...t, items: buildActivity(t.steps) })),
    [steps],
  );
  // 挂载之后才到达的步骤才做入场动画（首屏不整页飞入）
  const [mountedAt] = useState(() => Date.now() - 1500);

  if (noSession || (!isPending && !error && steps.length === 0)) {
    return (
      <EmptyState
        icon={Brain}
        title={tr('还没有思路记录')}
        description={tr('agent 开始工作后，它读了什么、改了哪里、结果如何，会按轮次记在这里。')}
      />
    );
  }
  if (isPending) return <StepsSkeleton />;
  if (error && steps.length === 0) {
    return (
      <ErrorCard
        title={tr('思路记录没加载出来')}
        message={error.message}
        retrying={retrying}
        onRetry={onRetry}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {hasOlder && (
        <div className="flex justify-center">
          <Button size="sm" variant="ghost" loading={loadingOlder} onClick={onLoadOlder}>
            {tr('加载更早的思路')}
          </Button>
        </div>
      )}
      {turns.map((turn) => (
        <section
          key={`${turn.turnId}-${turn.startedAt}`}
          aria-label={tr('第 {ordinal} 轮', { ordinal: turn.ordinal })}
          className="min-w-0"
        >
          <header className="mb-2 flex items-center gap-2 text-caption text-fg-subtle">
            <span className="text-fg-muted">
              {tr('第 {ordinal} 轮', { ordinal: turn.ordinal })}
            </span>
            <span aria-hidden>·</span>
            <RelativeTime iso={turn.startedAt} className="font-normal" />
            <span className="h-px flex-1 bg-line" aria-hidden />
            <span className="font-normal tabular-nums">
              {tr('{count} 步', { count: turn.items.length })}
            </span>
          </header>
          <ol className="relative flex min-w-0 flex-col gap-3">
            <span aria-hidden className="absolute top-3 bottom-3 left-3 w-px bg-line" />
            {turn.items.map((item) => {
              const first =
                item.kind === 'thinking'
                  ? item.steps[0]
                  : item.kind === 'tools'
                    ? (item.calls[0]?.call ?? item.calls[0]?.result)
                    : item.step;
              const fresh = first ? new Date(first.createdAt).getTime() > mountedAt : false;
              return (
                <motion.li
                  key={item.id}
                  variants={variants.fadeUp}
                  initial={fresh ? 'hidden' : false}
                  animate="visible"
                  className="relative min-w-0 pl-9"
                >
                  <ItemIcon item={item} tone={itemTone(item, ctx)} />
                  <div className="min-w-0 pt-0.5">
                    <ItemBody item={item} ctx={ctx} />
                  </div>
                </motion.li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
