import { Link } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, GitPullRequestDraft } from 'lucide-react';
import type { ProposalTargetKind } from '@srh/shared';
import { useMotionPreset } from '@/lib/motion';
import { useProposalsOf, useVersioningEvents } from '../api';
import { tr } from '@/lib/i18n';

/**
 * 文档 / notebook 顶部的一行提示：有 agent 的改动提案在等审阅。
 * 点进去是对应的审阅（逐条接受 / 拒绝在那里做）。
 */
export function ProposalBanner({
  pid,
  targetKind,
  targetId,
}: {
  pid: string;
  targetKind: ProposalTargetKind;
  targetId: string;
}) {
  useVersioningEvents(pid);
  const { variants } = useMotionPreset();
  const q = useProposalsOf(pid, targetKind, targetId);
  const open = (q.data ?? []).filter((p) => p.status === 'open');
  const first = open[0];
  const hunks = open.reduce((n, p) => n + p.hunks.length, 0);
  const href = first
    ? first.reviewId
      ? `/p/${pid}/reviews/${first.reviewId}`
      : `/p/${pid}/proposals/${first.id}`
    : '';

  return (
    <AnimatePresence initial={false}>
      {first && (
        <motion.div
          key="proposal-banner"
          variants={variants.fadeUp}
          initial="hidden"
          animate="visible"
          exit="exit"
          role="status"
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-agent/25 bg-agent-soft px-3 py-2 text-small"
        >
          <GitPullRequestDraft
            size={16}
            strokeWidth={1.75}
            aria-hidden
            className="shrink-0 text-agent-text"
          />
          <span className="min-w-0 flex-1 text-fg">
            {open.length > 1
              ? tr('有 {count} 份改动提案待审阅，共 {hunks} 处改动', { count: open.length, hunks })
              : tr('有一份改动提案待审阅：{hunks} 处改动，审阅合入前正文不变', { hunks })}
          </span>
          <Link
            to={href}
            className="inline-flex shrink-0 items-center gap-1 rounded-sm font-medium text-agent-text hover:underline"
          >
            {tr('去审阅')}
            <ArrowRight size={14} strokeWidth={1.75} aria-hidden />
          </Link>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
