import { forwardRef, useMemo, type HTMLAttributes } from 'react';
import { motion } from 'motion/react';
import { Circle } from 'lucide-react';
import {
  checklistProgress,
  parseChecklist,
  type ChecklistMark,
  type ParsedChecklist,
} from '@srh/shared';
import { cn } from '@/lib/cn';
import { ease, useMotionPreset } from '@/lib/motion';
import { tr } from '@/lib/i18n';

export interface ChecklistViewProps extends HTMLAttributes<HTMLDivElement> {
  /** 状态清单原文（第 1 行标题，之后 ✓ / ✱ / ○ 开头） */
  text?: string;
  /** 已解析的清单（优先于 text） */
  checklist?: ParsedChecklist;
  showTitle?: boolean;
  showProgress?: boolean;
  /** 当前一步的圆点是否呼吸（只在线程工作中时开，控制同屏循环动画数量） */
  animateActive?: boolean;
}

const MARK_LABEL: Record<ChecklistMark, string> = {
  done: tr('已完成'),
  active: tr('进行中'),
  todo: tr('未开始'),
};

function MarkIcon({
  mark,
  highlight,
  spin,
}: {
  mark: ChecklistMark;
  highlight: boolean;
  spin: boolean;
}) {
  const { reduced } = useMotionPreset();
  if (mark === 'done') {
    return (
      <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden className="shrink-0 text-success">
        <motion.path
          d="M3.5 8.5 6.5 11.5 12.5 4.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.9}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: highlight && !reduced ? 0 : 1 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.3, ease: ease.out, delay: 0.1 }}
        />
      </svg>
    );
  }
  if (mark === 'active') {
    // 当前一步：实心 accent 圆点；agent 工作中时外圈缓慢呼吸（减少动态时 CSS 会停掉）
    return (
      <span aria-hidden className="relative grid size-4 shrink-0 place-items-center">
        {spin && (
          <span className="absolute inset-1 rounded-full bg-accent opacity-0 animate-pulse-ring" />
        )}
        <span className="relative size-2 rounded-full bg-accent ring-3 ring-accent/15" />
      </span>
    );
  }
  return (
    <Circle size={12} strokeWidth={1.75} aria-hidden className="mx-0.5 shrink-0 text-fg-subtle" />
  );
}

/**
 * 线程状态清单的紧凑版（STYLE §6 ChecklistView，用在线程卡片里）：✓ success 对勾、✱ accent 实心圆点、○ 空心圆；
 * 详情页和个人会话用完整的 PlanView。
 * 加粗行（刚完成的一步）对勾描线 + 底色闪一次 success-soft。
 */
export const ChecklistView = forwardRef<HTMLDivElement, ChecklistViewProps>(function ChecklistView(
  {
    text,
    checklist,
    showTitle = true,
    showProgress = true,
    animateActive = true,
    className,
    ...props
  },
  ref,
) {
  const { spring } = useMotionPreset();
  const list = useMemo(() => checklist ?? parseChecklist(text ?? ''), [checklist, text]);
  const total = list.lines.length;
  const done = list.lines.filter((l) => l.mark === 'done').length;
  const progress = checklistProgress(list);

  if (total === 0 && !list.title) return null;

  return (
    <div ref={ref} className={cn('min-w-0', className)} {...props}>
      {showTitle && list.title && (
        <div className="mb-1.5 flex items-center justify-between gap-3 px-1.5">
          <p className="truncate text-small font-medium text-fg">{list.title}</p>
          {total > 0 && (
            <span className="shrink-0 text-caption text-fg-subtle tabular-nums">
              {done}/{total}
            </span>
          )}
        </div>
      )}
      {showProgress && total > 0 && (
        <div
          role="progressbar"
          aria-label={tr('清单进度')}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          className="mx-1.5 mb-2 h-1 overflow-hidden rounded-full bg-muted"
        >
          <motion.div
            className="h-full origin-left rounded-full bg-success"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: progress }}
            transition={spring.gentle}
          />
        </div>
      )}
      <ul className="flex flex-col gap-px" aria-label={list.title || tr('状态清单')}>
        {list.lines.map((line, i) => (
          <li
            key={`${i}-${line.text}`}
            data-mark={line.mark}
            data-highlight={line.highlight || undefined}
            className={cn(
              'relative flex items-start gap-2 rounded-sm px-1.5 py-0.5 text-small',
              line.mark === 'active'
                ? 'font-medium text-fg'
                : line.mark === 'done'
                  ? 'text-fg-subtle'
                  : 'text-fg-muted',
              line.highlight && 'font-medium text-fg',
            )}
          >
            {line.highlight && (
              <span
                aria-hidden
                className="absolute inset-0 rounded-sm bg-success-soft animate-flash"
              />
            )}
            <span className="relative flex h-5 shrink-0 items-center">
              <MarkIcon mark={line.mark} highlight={line.highlight} spin={animateActive} />
            </span>
            <span className="relative min-w-0 break-words">
              <span className="sr-only">{tr('{value}：', { value: MARK_LABEL[line.mark] })}</span>
              {line.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
});
