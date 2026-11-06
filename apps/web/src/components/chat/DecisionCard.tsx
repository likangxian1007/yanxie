import { useState } from 'react';
import { motion } from 'motion/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleQuestionMark, CheckCircle2 } from 'lucide-react';
import type { Decision } from '@srh/shared';
import { Badge, Markdown, RelativeTime, Spinner, toast } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { qk } from '@/lib/query-keys';
import { tr, trServer } from '@/lib/i18n';

export interface DecisionCardProps {
  projectId: string;
  decision: Decision;
  /** 只读（访客、或不是请求对象） */
  readOnly?: boolean;
  className?: string;
}

/**
 * 决策卡（STYLE §6）：问题 H3，选项是可点的行（label 粗体 + consequence small），推荐项有「推荐」标签；
 * 回答后折叠成一行「已选：xx · 谁 · 何时」。
 */
export function DecisionCard({ projectId, decision, readOnly, className }: DecisionCardProps) {
  const qc = useQueryClient();
  const { spring, variants } = useMotionPreset();
  const [picked, setPicked] = useState<number | null>(null);
  const answer = useMutation({
    mutationFn: (chosen: number) =>
      api.post<Decision>(`/projects/${projectId}/decisions/${decision.id}/answer`, { chosen }),
    onMutate: (chosen) => setPicked(chosen),
    onSuccess: (d) => {
      qc.setQueryData(qk.decision(projectId, d.id), d);
      toast.success(tr('已回答，agent 会按这个方向继续。'));
    },
    onError: (err) => {
      setPicked(null);
      toast.error(tr('没能提交你的选择'), err instanceof Error ? err.message : undefined);
    },
  });

  if (decision.state !== 'open') {
    const chosen = decision.chosen !== null ? decision.options[decision.chosen] : undefined;
    return (
      <motion.div
        layout
        transition={spring.gentle}
        data-decision-id={decision.id}
        className={cn(
          'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2 text-small text-fg-muted',
          className,
        )}
      >
        <CheckCircle2 size={14} strokeWidth={1.75} aria-hidden className="text-success" />
        <span className="min-w-0 truncate text-fg">{decision.question}</span>
        <span aria-hidden>·</span>
        {decision.state === 'withdrawn' ? (
          <span>{tr('已撤回')}</span>
        ) : (
          <>
            <span>
              {tr('已选：')}
              <span className="font-medium text-fg">{chosen?.label ?? '—'}</span>
            </span>
            {decision.chosenBy && <span>· {trServer(decision.chosenBy.name)}</span>}
            {decision.answeredAt && (
              <>
                <span aria-hidden>·</span>
                <RelativeTime iso={decision.answeredAt} />
              </>
            )}
          </>
        )}
      </motion.div>
    );
  }

  return (
    <motion.div
      layout
      variants={variants.fadeUp}
      initial="hidden"
      animate="visible"
      transition={spring.gentle}
      // 站内引用 #dec_… 在当前页面上找卡片用（lib/message-link.ts）
      data-decision-id={decision.id}
      className={cn(
        'overflow-hidden rounded-lg border border-warning/35 bg-surface shadow-sm',
        className,
      )}
    >
      <div className="flex items-start gap-2.5 border-b border-line bg-warning-soft/50 px-4 py-3">
        <CircleQuestionMark
          size={16}
          strokeWidth={1.75}
          aria-hidden
          className="mt-0.5 shrink-0 text-warning"
        />
        <div className="min-w-0">
          <p className="text-caption text-warning">{tr('等你拍板')}</p>
          <h3 className="text-h3 text-pretty text-fg">{decision.question}</h3>
        </div>
      </div>
      {decision.context && (
        <div className="px-4 pt-3 text-small text-fg-muted">
          <Markdown size="compact" className="text-fg-muted">
            {decision.context}
          </Markdown>
        </div>
      )}
      <div role="radiogroup" aria-label={decision.question} className="flex flex-col gap-1.5 p-3">
        {decision.options.map((opt, i) => {
          const recommended = i === decision.recommended;
          const loading = answer.isPending && picked === i;
          return (
            <button
              key={opt.label}
              type="button"
              role="radio"
              aria-checked={picked === i}
              disabled={readOnly || answer.isPending}
              onClick={() => answer.mutate(i)}
              className={cn(
                'press group flex w-full cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 text-left',
                'transition-colors duration-(--dur-fast) ease-(--ease-standard) disabled:cursor-not-allowed',
                recommended
                  ? 'border-accent/40 bg-accent-soft/40 hover:bg-accent-soft'
                  : 'border-line hover:border-line-strong hover:bg-subtle',
                readOnly && 'opacity-70',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-body font-semibold text-fg">{opt.label}</span>
                  {recommended && <Badge tone="accent">{tr('推荐')}</Badge>}
                </span>
                <span className="mt-0.5 block text-small text-pretty text-fg-muted">
                  {opt.consequence}
                </span>
              </span>
              {loading && <Spinner className="mt-0.5 text-accent" />}
            </button>
          );
        })}
      </div>
      {decision.reason && (
        <p className="border-t border-line px-4 py-2.5 text-caption font-normal text-pretty text-fg-subtle">
          {tr('推荐理由：{reason}', { reason: decision.reason })}
        </p>
      )}
      {readOnly && (
        <p className="border-t border-line px-4 py-2.5 text-caption font-normal text-fg-subtle">
          {tr('访客不能回答决策。')}
        </p>
      )}
    </motion.div>
  );
}
