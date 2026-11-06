import { motion } from 'motion/react';
import { CirclePause, OctagonAlert, Play } from 'lucide-react';
import { parseChecklist, type AgentSession, type Thread } from '@srh/shared';
import { Button, toast } from '@/components/ui';
import { useResumeAgent } from '@/lib/agents';
import { ApiRequestError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { threadDisplay } from '@/lib/status';
import { tr } from '@/lib/i18n';

export interface AgentHaltedBannerProps {
  projectId: string;
  thread: Thread;
  agent: AgentSession | null;
  writable: boolean;
  /** 点「查看记录」时切到记录页签；不传就不显示这个按钮 */
  onShowSteps?: () => void;
  className?: string;
}

/**
 * agent 停工时（出错、步数用完、被停止）在对话上方如实说明，并给「继续」。
 * 其他状态不渲染。
 */
export function AgentHaltedBanner({
  projectId,
  thread,
  agent,
  writable,
  onShowSteps,
  className,
}: AgentHaltedBannerProps) {
  const { variants } = useMotionPreset();
  const resume = useResumeAgent(projectId);
  const display = threadDisplay(thread, agent);
  if (!display.needsResume) return null;

  const active = parseChecklist(thread.statusText).lines.find((l) => l.mark === 'active');
  const danger = display.kind === 'halted';
  const Icon = danger ? OctagonAlert : CirclePause;
  const title =
    display.kind === 'halted' ? tr('agent 停下了，这件事还没做完') : tr('agent 已被停止');
  const detail =
    display.kind === 'halted'
      ? tr('查看记录了解中断原因。')
      : tr('有人停止了这一轮，排队的唤醒也一起取消了。');

  const doResume = () => {
    if (!agent) return;
    resume.mutate(agent.id, {
      onSuccess: () => toast({ title: tr('已让 agent 继续'), tone: 'success' }),
      onError: (e) =>
        toast.error(
          tr('没能让它继续'),
          e instanceof ApiRequestError && e.status === 404
            ? tr('在下面回一句「继续」也能唤醒它。')
            : e.message,
        ),
    });
  };

  return (
    <motion.div
      role="status"
      variants={variants.fadeUp}
      initial="hidden"
      animate="visible"
      className={cn(
        'flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center',
        danger ? 'border-danger/30 bg-danger-soft/60' : 'border-warning/30 bg-warning-soft/60',
        className,
      )}
    >
      <Icon
        size={18}
        strokeWidth={1.75}
        aria-hidden
        className={cn('hidden shrink-0 sm:block', danger ? 'text-danger' : 'text-warning')}
      />
      <div className="min-w-0 flex-1">
        <p className={cn('text-body font-medium', danger ? 'text-danger' : 'text-fg')}>{title}</p>
        <p className="mt-0.5 text-small text-pretty text-fg-muted">
          {active ? tr('停在「{text}」。', { text: active.text }) : ''}
          {detail}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {onShowSteps && (
          <Button variant="ghost" size="sm" onClick={onShowSteps}>
            {tr('查看记录')}
          </Button>
        )}
        {writable && agent && (
          <Button
            size="sm"
            variant="secondary"
            loading={resume.isPending}
            leftIcon={<Play strokeWidth={1.75} aria-hidden />}
            onClick={doResume}
          >
            {tr('继续')}
          </Button>
        )}
      </div>
    </motion.div>
  );
}
