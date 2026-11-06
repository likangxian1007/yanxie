import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { tr } from '@/lib/i18n';

export interface AgentThinkingProps extends HTMLAttributes<HTMLSpanElement> {
  /** 显示的文字，默认“思考中”；也可以是 agent 的一句话动态 */
  label?: string;
  size?: 'sm' | 'md';
}

const DOT_DELAYS = ['0ms', '160ms', '320ms'];

/**
 * Agent 思考中（STYLE §4.2-1）：文字上 agent 渐变光带从左扫到右（1.6s 循环），
 * 旁边三个点依次起伏。减少动态效果时显示静态渐变文字。
 */
export const AgentThinking = forwardRef<HTMLSpanElement, AgentThinkingProps>(function AgentThinking(
  { label = tr('思考中'), size = 'sm', className, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      role="status"
      aria-live="polite"
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5',
        size === 'sm' ? 'text-small' : 'text-body',
        className,
      )}
      {...props}
    >
      <span className="agent-sweep truncate font-medium">{label}</span>
      <span aria-hidden className="inline-flex shrink-0 items-center gap-[3px]">
        {DOT_DELAYS.map((delay) => (
          <span
            key={delay}
            className="size-1 rounded-full bg-agent animate-thinking-dot"
            style={{ animationDelay: delay }}
          />
        ))}
      </span>
    </span>
  );
});
