import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { IconButton } from './IconButton';
import { tr } from '@/lib/i18n';

export type DialogSize = 'sm' | 'md' | 'lg';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** sm 480 / md 640 / lg 860 */
  size?: DialogSize;
  /** 底部按钮（右对齐：次要在左、主要在右） */
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** 不显示右上角关闭按钮 */
  hideClose?: boolean;
  /** 隐藏标题栏（命令面板这类自带头部的浮层用；title 仍给读屏） */
  bare?: boolean;
  /** 面板相对视口的位置：居中（默认）或偏上（命令面板） */
  placement?: 'center' | 'top';
  /**
   * 关闭时不播退出动画，立即从页面移除（命令面板：按一下 Esc 就该马上消失，
   * 退出动画期间面板还留在 DOM 里，看起来像「第一下 Esc 没关上」）。
   */
  instantClose?: boolean;
}

const WIDTH: Record<DialogSize, string> = {
  sm: 'max-w-[480px]',
  md: 'max-w-[640px]',
  lg: 'max-w-[860px]',
};

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 打开的对话框栈：焦点不在任何面板里时（例如落在 body 上），只有最上层响应 Esc / Tab。
 * 每次打开压入一个独立的 token（而不是组件 id），关闭时按引用移除，不会因为 id 重复或残留而错位。
 */
const stack: object[] = [];

function isTop(token: object): boolean {
  return stack[stack.length - 1] === token;
}

/**
 * 对话框（STYLE §6）：遮罩 --overlay + 2px 模糊；面板 rounded-xl chrome-popover shadow-lg；
 * scaleIn + 遮罩淡入；Esc 关闭；焦点锁在面板内，关闭后还给原来的元素。
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  size = 'sm',
  footer,
  children,
  className,
  hideClose,
  bare,
  placement = 'center',
  instantClose,
}: DialogProps) {
  // AnimatePresence 只等有 exit 的子元素：不给 exit 就立即卸载
  const exit = instantClose ? undefined : 'exit';
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const panelRef = useRef<HTMLDivElement>(null);
  const { variants } = useMotionPreset();
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  });

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const token = {};
    stack.push(token);
    const body = document.body;
    const prevOverflow = body.style.overflow;
    body.style.overflow = 'hidden';

    const t = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const target =
        panel.querySelector<HTMLElement>('[data-autofocus]') ??
        panel.querySelector<HTMLElement>('input, textarea, select') ??
        panel;
      target.focus();
    }, 0);

    // 兜底：焦点在面板外（body、被别处抢走）时由最上层对话框处理。
    // 焦点在面板内的 Esc 由面板自己的 onKeyDown 处理（见下方），不依赖这里。
    const onKey = (e: KeyboardEvent) => {
      if (!isTop(token)) return;
      if (e.key === 'Escape') {
        if (e.defaultPrevented || e.isComposing) return;
        e.preventDefault();
        onOpenChangeRef.current(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      const i = stack.indexOf(token);
      if (i !== -1) stack.splice(i, 1);
      if (stack.length === 0) body.style.overflow = prevOverflow;
      previous?.focus?.();
    };
  }, [open]);

  if (typeof document === 'undefined') return null;

  const content = open && (
    <div
      key="dialog"
      className={cn(
        'fixed inset-0 z-modal flex justify-center overflow-y-auto px-3 sm:px-4',
        placement === 'center' ? 'items-center py-6' : 'items-start pt-[12vh] pb-6',
      )}
    >
      <motion.div
        aria-hidden
        variants={variants.fadeIn}
        initial="hidden"
        animate="visible"
        exit={exit}
        className="fixed inset-0 bg-overlay backdrop-blur-[2px]"
        onClick={() => onOpenChange(false)}
      />
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onKeyDown={(e) => {
          // 焦点在面板里：就地关闭并截住事件，不经过全局栈，
          // 也不会再被 document / window 上的其他 Esc 监听（Tooltip、抽屉等）重复处理。
          // 内层对话框（React 树里更深）先收到并截住，所以嵌套时只关最上层。
          if (e.key !== 'Escape' || e.defaultPrevented || e.nativeEvent.isComposing) return;
          e.preventDefault();
          e.stopPropagation();
          onOpenChange(false);
        }}
        variants={variants.scaleIn}
        initial="hidden"
        animate="visible"
        exit={exit}
        className={cn(
          'relative flex max-h-[calc(100dvh-3rem)] w-full flex-col overflow-hidden rounded-xl border border-line chrome-popover shadow-lg outline-none',
          WIDTH[size],
          className,
        )}
      >
        {bare ? (
          <h2 id={titleId} className="sr-only">
            {title}
          </h2>
        ) : (
          <div className="flex shrink-0 items-start gap-3 px-5 pt-5 pb-3 sm:px-6">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-h2 text-fg">
                {title}
              </h2>
              {description && (
                <p id={descId} className="mt-1 text-small text-pretty text-fg-muted">
                  {description}
                </p>
              )}
            </div>
            {!hideClose && (
              <IconButton
                label={tr('关闭')}
                size="sm"
                className="-mt-0.5 -mr-2"
                onClick={() => onOpenChange(false)}
              >
                <X strokeWidth={1.75} aria-hidden />
              </IconButton>
            )}
          </div>
        )}
        {children !== undefined && (
          <div
            className={cn(
              'min-h-0 flex-1 overflow-y-auto',
              !bare && 'px-5 pb-5 sm:px-6',
              !bare && footer && 'pb-4',
            )}
          >
            {children}
          </div>
        )}
        {footer && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-subtle/50 px-5 py-3 sm:px-6">
            {footer}
          </div>
        )}
      </motion.div>
    </div>
  );

  // instantClose：不经过 AnimatePresence，open 变 false 时这一帧就卸载
  return createPortal(
    instantClose ? content : <AnimatePresence>{content}</AnimatePresence>,
    document.body,
  );
}
