import { motion } from 'motion/react';
import type { Paper } from '@srh/shared';
import { useMotionPreset } from '@/lib/motion';
import { cn } from '@/lib/cn';
import { isWorking } from '../lib/format';
import { tr, trServer } from '@/lib/i18n';

/**
 * 解析进度条：宽度按 progress 过渡（transform: scaleX，不动 width），
 * 正在进行时有一道扫光（循环动画，列表里最多 3 条开启——由调用方传 animate）。
 */
export function ParseProgress({
  paper,
  animate = true,
  className,
}: {
  paper: Pick<Paper, 'status' | 'progress' | 'stage'>;
  animate?: boolean;
  className?: string;
}) {
  const { spring, reduced } = useMotionPreset();
  if (!isWorking(paper.status)) return null;
  const pct = Math.max(4, Math.min(100, paper.progress));
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div
        className="relative h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={paper.progress}
        aria-label={tr('解析进度')}
      >
        <motion.div
          className="absolute inset-0 origin-left rounded-full bg-accent"
          initial={false}
          animate={{ scaleX: pct / 100 }}
          transition={spring.gentle}
        />
        {animate && !reduced && (
          <motion.div
            aria-hidden
            className="absolute inset-y-0 w-1/3 bg-linear-to-r from-transparent via-accent-fg/40 to-transparent"
            initial={{ x: '-100%' }}
            animate={{ x: '300%' }}
            transition={{ duration: 1.6, ease: 'easeInOut', repeat: Infinity, repeatDelay: 0.4 }}
          />
        )}
      </div>
      <p className="truncate text-caption text-fg-muted" aria-live="polite">
        {paper.stage ? trServer(paper.stage) : tr('排队等待解析')}
      </p>
    </div>
  );
}
