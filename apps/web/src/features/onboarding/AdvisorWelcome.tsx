import { Link } from 'react-router';
import { motion } from 'motion/react';
import { BadgeCheck, ChevronRight, Inbox, ListTree, type LucideIcon } from 'lucide-react';
import { Button, Dialog } from '@/components/ui';
import { projectPath } from '@/components/layout/nav-items';
import { useMotionPreset } from '@/lib/motion';
import { tr } from '@/lib/i18n';

export interface AdvisorWelcomeProps {
  open: boolean;
  projectId: string;
  projectName?: string | undefined;
  /** 带我看一遍 */
  onStartTour: () => void;
  /** 我自己逛逛 / 关闭 / 点了某张卡片 */
  onDismiss: () => void;
}

interface Entry {
  to: string;
  icon: LucideIcon;
  title: string;
  where: string;
  body: string;
}

const ENTRIES: Entry[] = [
  {
    to: 'threads',
    icon: ListTree,
    title: tr('看进展'),
    where: tr('协作台 · 线程'),
    body: tr('学生的计划、每个线程做到哪一步、实验结果，都在这两处。'),
  },
  {
    to: 'inbox',
    icon: Inbox,
    title: tr('待我处理'),
    where: tr('需要你拍板或审阅的'),
    body: tr('请你审阅的内容、等你做决定的问题都汇总在这里，不用翻聊天记录。'),
  },
  {
    to: 'reviews',
    icon: BadgeCheck,
    title: tr('给 LGTM'),
    where: tr('审阅页'),
    body: tr('打开一条审阅，在「你的结论」里点 LGTM，或点「要求修改」写一句原因。'),
  },
];

/** 导师第一次进入课题时的欢迎框：三个最常用的入口 + 要不要跟着引导看一遍。 */
export function AdvisorWelcome({
  open,
  projectId,
  projectName,
  onStartTour,
  onDismiss,
}: AdvisorWelcomeProps) {
  const { variants, stagger } = useMotionPreset();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
      size="md"
      title={tr('欢迎，导师')}
      description={
        projectName
          ? tr(
              '「{projectName}」的讨论、进展和产出都在研协里。你最常用的是下面三处，也可以花一分钟跟着引导看一遍。',
              { projectName },
            )
          : tr(
              '课题的讨论、进展和产出都在研协里。你最常用的是下面三处，也可以花一分钟跟着引导看一遍。',
            )
      }
      footer={
        <>
          <Button variant="ghost" onClick={onDismiss} className="max-sm:h-11">
            {tr('我自己逛逛')}
          </Button>
          <Button variant="primary" data-autofocus onClick={onStartTour} className="max-sm:h-11">
            {tr('带我看一遍')}
          </Button>
        </>
      }
    >
      <motion.ul
        variants={stagger(0.05)}
        initial="hidden"
        animate="visible"
        className="grid gap-2.5 sm:grid-cols-3"
      >
        {ENTRIES.map((e) => {
          const Icon = e.icon;
          return (
            <motion.li key={e.to} variants={variants.fadeUp} className="flex">
              <Link
                to={projectPath(projectId, e.to)}
                onClick={onDismiss}
                className="group flex w-full flex-col rounded-lg border border-line bg-surface p-3.5 shadow-xs transition-[border-color,box-shadow] duration-(--dur-fast) ease-(--ease-standard) hover:border-line-strong hover:shadow-md max-sm:flex-row max-sm:items-start max-sm:gap-3"
              >
                <span
                  aria-hidden
                  className="grid size-8 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-text sm:mb-3"
                >
                  <Icon size={16} strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 text-h3 text-fg">
                    {e.title}
                    <ChevronRight
                      size={14}
                      strokeWidth={1.75}
                      aria-hidden
                      className="text-fg-subtle transition-transform duration-(--dur-fast) ease-(--ease-standard) group-hover:translate-x-0.5"
                    />
                  </span>
                  <span className="mt-0.5 block text-caption text-fg-subtle">{e.where}</span>
                  <span className="mt-1.5 block text-small text-pretty text-fg-muted">
                    {e.body}
                  </span>
                </span>
              </Link>
            </motion.li>
          );
        })}
      </motion.ul>
    </Dialog>
  );
}
