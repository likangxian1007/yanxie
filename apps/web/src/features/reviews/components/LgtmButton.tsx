import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { checkDraw, pressFeedback, ripple } from '@/features/collab-kit/motion';
import { Spinner } from '@/components/ui';
import { tr } from '@/lib/i18n';

export interface LgtmButtonProps {
  onApprove: () => void;
  loading?: boolean;
  /** 我已经批准过：文案变成“已 LGTM” */
  approved?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * LGTM 按钮（STYLE §4.2-11）：按下时按钮内对勾描线 + 外圈 success 涟漪一次（480ms）。
 * 减少动态效果时只显示静态对勾。
 */
export function LgtmButton({ onApprove, loading, approved, disabled, className }: LgtmButtonProps) {
  const { reduced, spring } = useMotionPreset();
  const [burst, setBurst] = useState(0);

  return (
    <motion.button
      type="button"
      whileTap={pressFeedback(reduced)}
      transition={spring.snappy}
      disabled={disabled || loading}
      onClick={() => {
        setBurst((n) => n + 1);
        onApprove();
      }}
      className={cn(
        'relative inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 text-body font-medium',
        // 深色主题下 success 很亮：文字用 fg-inverse（浅色白、深色近黑），两种主题都够对比
        'bg-success text-fg-inverse shadow-xs transition-[filter,opacity] duration-(--dur-fast) ease-(--ease-standard)',
        'hover:brightness-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-success',
        'disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
    >
      {/* 涟漪：每次按下换 key 重新播放一次 */}
      <AnimatePresence>
        {burst > 0 && !reduced && (
          <motion.span
            key={burst}
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-success"
            {...ripple}
          />
        )}
      </AnimatePresence>
      {loading ? (
        <Spinner size={16} />
      ) : (
        <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden className="shrink-0">
          <motion.path
            key={burst}
            d="M3.5 8.5 6.5 11.5 12.5 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: burst > 0 && !reduced ? 0 : 1 }}
            animate={{ pathLength: 1 }}
            transition={checkDraw(reduced, 'signature')}
          />
        </svg>
      )}
      <span>{approved ? tr('已 LGTM') : 'LGTM'}</span>
    </motion.button>
  );
}
