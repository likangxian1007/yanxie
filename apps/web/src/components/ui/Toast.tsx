import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { useToastStore, type ToastItem, type ToastTone } from './toast-store';
import { tr } from '@/lib/i18n';

const ICON: Record<ToastTone, typeof Info> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
};
const ICON_CLASS: Record<ToastTone, string> = {
  info: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

function ToastCard({ item }: { item: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);
  // 减少动态效果时 toastIn 只剩淡入淡出，也不做 layout 重排动画
  const { spring, variants, reduced } = useMotionPreset();
  const remaining = useRef(item.duration ?? 4000);
  const startedAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const tone = item.tone ?? 'info';
  const Icon = ICON[tone];

  const start = () => {
    if (remaining.current <= 0 && (item.duration ?? 4000) !== 0) return;
    if ((item.duration ?? 4000) === 0) return;
    startedAt.current = Date.now();
    timer.current = window.setTimeout(() => dismiss(item.id), remaining.current);
  };
  const pause = () => {
    if (timer.current === undefined) return;
    window.clearTimeout(timer.current);
    timer.current = undefined;
    remaining.current -= Date.now() - startedAt.current;
  };

  useEffect(() => {
    start();
    return () => window.clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时开始计时
  }, []);

  return (
    <motion.li
      layout={!reduced}
      variants={variants.toastIn}
      initial="hidden"
      animate="visible"
      exit="exit"
      transition={spring.gentle}
      onPointerEnter={pause}
      onPointerLeave={start}
      onFocus={pause}
      onBlur={start}
      role={tone === 'danger' ? 'alert' : 'status'}
      className="pointer-events-auto flex w-full items-start gap-3 rounded-lg border border-line bg-elevated p-3 pr-2 shadow-lg"
    >
      <Icon
        size={16}
        strokeWidth={1.75}
        aria-hidden
        className={cn('mt-0.5 shrink-0', ICON_CLASS[tone])}
      />
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium text-fg">{item.title}</p>
        {item.description && (
          <p className="mt-0.5 text-small text-pretty text-fg-muted">{item.description}</p>
        )}
        {item.action && (
          <button
            type="button"
            onClick={() => {
              item.action?.onClick();
              dismiss(item.id);
            }}
            className="press mt-2 cursor-pointer rounded-sm text-small font-medium text-accent-text hover:underline"
          >
            {item.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label={tr('关闭提示')}
        onClick={() => dismiss(item.id)}
        className="press grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-fg-subtle hover:bg-subtle hover:text-fg"
      >
        <X size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </motion.li>
  );
}

/** 挂在应用根部一次。 */
export function Toaster() {
  const items = useToastStore((s) => s.items);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <ol
      aria-label={tr('通知')}
      // 停在底部标签栏和页面吸底操作栏（--sticky-actions-h）上方，不挡住刚点过的按钮
      className="pointer-events-none fixed right-3 bottom-[calc(var(--tabbar-h)+var(--sticky-actions-h)+max(var(--safe-bottom),0.75rem))] left-3 z-toast flex flex-col items-end gap-2 sm:right-5 sm:left-auto sm:w-[360px] md:bottom-[calc(var(--sticky-actions-h)+1.25rem)]"
    >
      <AnimatePresence initial={false}>
        {items.map((item) => (
          <ToastCard key={item.id} item={item} />
        ))}
      </AnimatePresence>
    </ol>,
    document.body,
  );
}
