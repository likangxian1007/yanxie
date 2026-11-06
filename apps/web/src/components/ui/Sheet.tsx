import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { IconButton } from './IconButton';
import { focusReturnTarget, restoreFocusTo } from './sheet-focus';
import { tr } from '@/lib/i18n';

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** bottom = 手机上从底部升起的面板（全宽、顶部圆角、最高 85dvh），忽略 width */
  side?: 'right' | 'left' | 'bottom';
  /** CSS 宽度，默认 min(420px, 92vw) */
  width?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/** 侧边抽屉（STYLE §6 Sheet）：左/右滑入，--dur-slow + --ease-out；Esc 与遮罩关闭。 */
export function Sheet({
  open,
  onOpenChange,
  title,
  side = 'right',
  width = 'min(420px, 92vw)',
  children,
  footer,
  className,
}: SheetProps) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const { variants } = useMotionPreset();
  const cb = useRef(onOpenChange);
  useEffect(() => {
    cb.current = onOpenChange;
  });

  useEffect(() => {
    if (!open) return;
    // 打开前的焦点；点按钮不聚焦的浏览器（Safari、手机）退回到 aria-expanded 的触发按钮
    const previous = focusReturnTarget(document.activeElement, panelRef.current);
    const t = window.setTimeout(() => panelRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      // 叠在上面的另一个模态层（例如从 Sheet 里打开的对话框）先处理自己的 Esc
      const panel = panelRef.current;
      const owner = e.target instanceof Element ? e.target.closest('[aria-modal="true"]') : null;
      if (owner && panel && owner !== panel && !panel.contains(owner)) return;
      e.preventDefault();
      cb.current(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      restoreFocusTo(previous);
    };
  }, [open]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <div key="sheet" className="fixed inset-0 z-modal">
          <motion.div
            aria-hidden
            variants={variants.fadeIn}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="absolute inset-0 bg-overlay backdrop-blur-[2px]"
            onClick={() => onOpenChange(false)}
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${id}-title`}
            tabIndex={-1}
            variants={
              side === 'bottom'
                ? variants.drawerUp
                : side === 'right'
                  ? variants.drawerRight
                  : variants.drawerLeft
            }
            initial="hidden"
            animate="visible"
            exit="exit"
            style={side === 'bottom' ? undefined : { width }}
            className={cn(
              'absolute flex flex-col bg-elevated shadow-lg outline-none',
              'pb-[env(safe-area-inset-bottom)]',
              side === 'bottom'
                ? 'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-xl border-t border-line'
                : 'inset-y-0',
              side === 'right' && 'right-0 border-l border-line',
              side === 'left' && 'left-0 border-r border-line',
              className,
            )}
          >
            {side === 'bottom' && (
              <span
                aria-hidden
                className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line-strong"
              />
            )}
            <div
              className={cn(
                'flex shrink-0 items-center justify-between gap-2 pr-2 pl-4',
                side === 'bottom' ? 'h-12' : 'h-(--topbar-h) border-b border-line',
              )}
            >
              <h2 id={`${id}-title`} className="truncate text-h3 text-fg">
                {title}
              </h2>
              <IconButton
                label={tr('关闭')}
                size={side === 'bottom' ? 'md' : 'sm'}
                onClick={() => onOpenChange(false)}
              >
                <X strokeWidth={1.75} aria-hidden />
              </IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
            {footer && (
              <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
                {footer}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
