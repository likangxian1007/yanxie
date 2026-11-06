import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  icon: LucideIcon;
  title: ReactNode;
  /** 说明“这里会出现什么 + 怎么开始”，不超过 2 行 */
  description?: ReactNode;
  /** 一个主按钮 */
  action?: ReactNode;
  /** 包一层虚线框（页面级空状态） */
  framed?: boolean;
  /** agent 相关的空状态：图标用 agent 色（底色保持中性） */
  tone?: 'default' | 'agent';
}

/**
 * 空状态（STYLE §6）：40px 中性图标块 + 20px 图标 → H3 标题 → small 描述 → 主按钮。
 * 克制为主：不用渐变、光晕和彩色大圆，靠排版说清「这里会出现什么 + 怎么开始」。
 */
export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  {
    icon: Icon,
    title,
    description,
    action,
    framed,
    tone = 'default',
    className,
    children,
    ...props
  },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        'flex flex-col items-center px-6 py-12 text-center',
        framed && 'rounded-xl border border-dashed border-line-strong bg-surface/40 py-14',
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          'mb-4 grid size-10 place-items-center rounded-lg bg-surface shadow-xs ring-1 ring-line',
          tone === 'agent' ? 'text-agent-text' : 'text-fg-muted',
        )}
      >
        <Icon size={20} strokeWidth={1.75} aria-hidden />
      </div>
      <h3 className="text-h3 text-fg">{title}</h3>
      {description && (
        <p className="mt-1.5 line-clamp-2 max-w-[26rem] text-small text-pretty text-fg-muted">
          {description}
        </p>
      )}
      {action && <div className="mt-5 flex items-center gap-2">{action}</div>}
      {children}
    </div>
  );
});
