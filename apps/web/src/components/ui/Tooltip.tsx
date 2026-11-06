import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  content: ReactNode;
  side?: TooltipSide;
  /** 悬停多久后出现，默认 400ms */
  delay?: number;
  disabled?: boolean;
  /** 触发元素（一个可聚焦的元素，会被注入 aria-describedby） */
  children: ReactElement;
  /** 包裹触发元素的 span 的类名（默认 display: contents，不影响布局） */
  className?: string;
}

const GAP = 6;
const EDGE = 8;

const ORIGIN: Record<TooltipSide, string> = {
  top: 'origin-bottom',
  bottom: 'origin-top',
  left: 'origin-right',
  right: 'origin-left',
};

function place(node: HTMLElement, wrapper: HTMLElement, side: TooltipSide) {
  // 包裹层默认 display: contents，没有自己的盒子，按真正的触发元素定位
  const target = wrapper.firstElementChild ?? wrapper;
  const r = target.getBoundingClientRect();
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  let left: number;
  let top: number;
  if (side === 'top' || side === 'bottom') {
    left = r.left + r.width / 2 - w / 2;
    top = side === 'top' ? r.top - GAP - h : r.bottom + GAP;
  } else {
    top = r.top + r.height / 2 - h / 2;
    left = side === 'left' ? r.left - GAP - w : r.right + GAP;
  }
  left = Math.max(EDGE, Math.min(left, window.innerWidth - w - EDGE));
  top = Math.max(EDGE, Math.min(top, window.innerHeight - h - EDGE));
  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
}

function isKeyboardFocus(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * 轻量 Tooltip：悬停 400ms 或键盘聚焦时出现，渲染到 body（不会被滚动容器裁切）。
 * 样式：bg-fg text-fg-inverse text-caption rounded-sm px-2 py-1，动效用 variants.tooltipIn。
 */
export function Tooltip({
  content,
  side = 'top',
  delay = 400,
  disabled,
  children,
  className,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  // 减少动态效果时 tooltipIn 只剩淡入淡出
  const { variants } = useMotionPreset();

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  };
  const show = (wait: number) => {
    if (disabled) return;
    clear();
    timer.current = setTimeout(() => setOpen(true), wait);
  };
  const hide = () => {
    clear();
    setOpen(false);
  };

  useEffect(() => clear, []);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const positionRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node && triggerRef.current) place(node, triggerRef.current, side);
    },
    [side],
  );

  const visible = open && !disabled;
  const trigger = isValidElement<{ 'aria-describedby'?: string }>(children)
    ? cloneElement(children, { 'aria-describedby': visible ? id : undefined })
    : children;

  return (
    <>
      <span
        ref={triggerRef}
        className={cn('contents', className)}
        onPointerEnter={(e) => {
          if (e.pointerType !== 'touch') show(delay);
        }}
        onPointerLeave={hide}
        onPointerDown={hide}
        onFocus={(e: FocusEvent<HTMLSpanElement>) => {
          if (isKeyboardFocus(e.target)) show(0);
        }}
        onBlur={hide}
      >
        {trigger}
      </span>
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {visible && (
              <div
                ref={positionRef}
                className="pointer-events-none fixed top-0 left-0 z-tooltip"
                role="tooltip"
                id={id}
              >
                <motion.div
                  variants={variants.tooltipIn}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  className={cn(
                    'flex max-w-64 items-center gap-1.5 rounded-sm bg-fg px-2 py-1 text-caption text-fg-inverse shadow-md',
                    ORIGIN[side],
                  )}
                >
                  {content}
                </motion.div>
              </div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}
