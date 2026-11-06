import { Link } from 'react-router';
import { motion } from 'motion/react';
import { Lock, TriangleAlert } from 'lucide-react';
import type { WorkClaim } from '@srh/shared';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { claimTarget } from './claim-target';
import { tr } from '@/lib/i18n';

/** 认领的显示名：谁在改、改什么、点了去哪 */
export interface ClaimDisplay {
  holder: string;
  target: string;
  href: string | null;
}

/** 调用方没给解析函数时的兜底：持有者原名 + 资源类型与原始 ref */
function defaultDisplay(c: WorkClaim): ClaimDisplay {
  return { holder: c.holder.name, target: claimTarget(c), href: null };
}

function Target({ display, className }: { display: ClaimDisplay; className?: string }) {
  if (!display.href) return <span className={className}>{display.target}</span>;
  return (
    <Link
      to={display.href}
      className={cn(
        'underline decoration-current/30 underline-offset-2 hover:decoration-current',
        className,
      )}
    >
      {display.target}
    </Link>
  );
}

export interface ClaimBadgeProps {
  claim: WorkClaim;
  /** 代表的成员名字（onBehalfOfUserId 对应的人） */
  onBehalfOf?: string | undefined;
  /** 把持有者和认领对象换成可读名字（文档标题、“某线程的 agent”）；不传时显示原始 ref */
  describe?: (c: WorkClaim) => ClaimDisplay;
  className?: string;
}

/** 认领（STYLE §6）：agent-soft 底「🔒 正在改：xx（为 张三）」。 */
export function ClaimBadge({
  claim,
  onBehalfOf,
  describe = defaultDisplay,
  className,
}: ClaimBadgeProps) {
  const display = describe(claim);
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md bg-agent-soft px-2.5 py-2 text-small text-agent-text',
        className,
      )}
    >
      <Lock size={14} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="break-words">
          <span className="font-medium">{display.holder}</span>
          {tr(' 正在改：')}
          <Target display={display} />
          {onBehalfOf && (
            <span className="text-agent-text/80">{tr('（为 {onBehalfOf}）', { onBehalfOf })}</span>
          )}
        </p>
        {claim.intent && (
          <p className="mt-0.5 text-caption font-normal text-pretty text-fg-muted">
            {claim.intent}
          </p>
        )}
      </div>
    </div>
  );
}

export interface ConflictBannerProps {
  claim: WorkClaim;
  conflictsWith: WorkClaim[];
  onCoordinate?: () => void;
  onDismiss?: () => void;
  /** 同 ClaimBadge.describe */
  describe?: (c: WorkClaim) => ClaimDisplay;
  className?: string;
}

/**
 * 冲突预警（STYLE §4.2-7 / §6）：左侧 warning 竖条 scaleY 0→1，整体轻抖一次，之后静止。
 * 写清楚“谁的什么和谁的什么重叠”，给“协调 / 忽略”两个按钮。
 */
export function ConflictBanner({
  claim,
  conflictsWith,
  onCoordinate,
  onDismiss,
  describe = defaultDisplay,
  className,
}: ConflictBannerProps) {
  // 减少动态效果时 shake / growY 不再位移缩放，竖条直接显示
  const { variants } = useMotionPreset();
  const display = describe(claim);
  const others = conflictsWith.map((c) => {
    const d = describe(c);
    return tr('{holder} 的「{value}」', { holder: d.holder, value: c.intent || d.target });
  });
  return (
    <motion.div
      role="alert"
      variants={variants.shake}
      initial="hidden"
      animate="visible"
      className={cn(
        'relative overflow-hidden rounded-lg border border-warning/30 bg-warning-soft py-3 pr-3 pl-4',
        className,
      )}
    >
      <motion.span
        aria-hidden
        variants={variants.growY}
        className="absolute inset-y-0 left-0 w-1 origin-top bg-warning"
      />
      <div className="flex items-start gap-2">
        <TriangleAlert
          size={16}
          strokeWidth={1.75}
          aria-hidden
          className="mt-0.5 shrink-0 text-warning"
        />
        <div className="min-w-0 flex-1">
          <p className="text-small font-medium break-words text-fg">
            {tr('冲突预警：')}
            <Target display={display} />
          </p>
          <p className="mt-0.5 text-small text-pretty text-fg-muted">
            {display.holder}
            {tr(' 的「')}
            {claim.intent || tr('改动')}
            {tr('」和 ')}
            {others.join(tr('、'))}
            {tr(' 重叠了。')}
          </p>
          {(onCoordinate || onDismiss) && (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {onCoordinate && (
                <Button size="sm" variant="secondary" onClick={onCoordinate}>
                  {tr('协调')}
                </Button>
              )}
              {onDismiss && (
                <Button size="sm" variant="ghost" onClick={onDismiss}>
                  {tr('忽略')}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
