import { motion } from 'motion/react';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { checkDraw } from '@/features/collab-kit/motion';
import { tr } from '@/lib/i18n';

export interface TodoCheckboxProps {
  checked: boolean;
  onToggle: () => void;
  /** 读屏用：待办标题 */
  title: string;
  disabled?: boolean;
  /** 刚勾选：对勾 pathLength 0→1 描线（300ms） */
  draw?: boolean;
}

/** 待办复选框：rounded-xs，勾选后 success 实心 + 白色对勾（STYLE §4.2-6 清单完成） */
export function TodoCheckbox({ checked, onToggle, title, disabled, draw }: TodoCheckboxProps) {
  const { reduced } = useMotionPreset();
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={
        checked ? tr('标记为未完成：{title}', { title }) : tr('标记为完成：{title}', { title })
      }
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'press relative grid size-4.5 shrink-0 cursor-pointer place-items-center rounded-xs border',
        // 触屏：看起来还是 18px，点击区外扩到 42px，手指不容易点到旁边
        'pointer-coarse:after:absolute pointer-coarse:after:-inset-3',
        'transition-colors duration-(--dur-fast) ease-(--ease-standard) disabled:cursor-not-allowed',
        checked
          ? 'border-success bg-success text-fg-inverse'
          : 'border-line-strong bg-surface hover:border-success',
      )}
    >
      <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden fill="none">
        <motion.path
          d="M3.5 8.5 6.5 11.5 12.5 4.5"
          stroke="currentColor"
          strokeWidth={2.25}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={draw && !reduced ? { pathLength: 0 } : false}
          animate={{ pathLength: checked ? 1 : 0, opacity: checked ? 1 : 0 }}
          transition={checkDraw(reduced)}
        />
      </svg>
    </button>
  );
}
