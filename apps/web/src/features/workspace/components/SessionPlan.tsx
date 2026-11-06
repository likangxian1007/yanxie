import { useId, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { ChevronDown, ListChecks } from 'lucide-react';
import { parseChecklist, type AgentSession, type Thread } from '@srh/shared';
import { EditablePlan } from '@/features/threads/components/EditablePlan';
import { summarizePlan } from '@/features/threads/components/plan-summary';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { canWrite, isAgentBusy, useMyRole } from '@/lib/project';
import { tr } from '@/lib/i18n';

/**
 * 个人会话的计划：个人 agent 列了状态清单时，在消息流上方显示一行摘要（目标 · 第几步），
 * 点开看完整步骤。默认收起，不挤占对话；agent 工作中时摘要里写出它正在做什么。
 */
export function SessionPlan({
  thread,
  agent,
  className,
}: {
  thread: Thread;
  agent: AgentSession | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { variants } = useMotionPreset();
  const list = useMemo(() => parseChecklist(thread.statusText), [thread.statusText]);
  const summary = summarizePlan(list);
  const busy = isAgentBusy(agent);
  // 个人会话只有主人能看到；主人是成员时可以直接改计划
  const writable = canWrite(useMyRole(thread.projectId));

  if (summary.total === 0) return null;
  const goal = list.title || thread.title;

  return (
    <section
      aria-label={tr('计划')}
      className={cn('rounded-lg border border-line bg-surface shadow-xs', className)}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-left"
      >
        <ListChecks size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-small font-medium text-fg">{goal}</span>
          <span className="block truncate text-caption text-fg-muted">
            {summary.label}
            {busy && agent?.activity ? ` · ${agent.activity}` : ''}
          </span>
        </span>
        <span className="shrink-0 text-caption text-fg-subtle tabular-nums">
          {summary.done}/{summary.total}
        </span>
        <ChevronDown
          size={16}
          strokeWidth={1.75}
          aria-hidden
          className={cn(
            'shrink-0 text-fg-subtle transition-transform duration-(--dur-fast) ease-(--ease-standard)',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <motion.div
          id={panelId}
          variants={variants.fadeIn}
          initial="hidden"
          animate="visible"
          className="border-t border-line px-3 pt-3 pb-3"
        >
          <EditablePlan
            thread={thread}
            canEdit={writable}
            agent={agent}
            hideGoal
            collapseDoneAfter={2}
          />
        </motion.div>
      )}
    </section>
  );
}
