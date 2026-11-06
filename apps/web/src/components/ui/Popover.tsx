import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { useFloating, type FloatingAlign, type FloatingSide } from './floating';

type TriggerProps = {
  onClick?: (e: ReactMouseEvent<HTMLElement>) => void;
  'aria-expanded'?: boolean;
  'aria-haspopup'?: 'menu' | 'dialog' | 'listbox';
  'aria-controls'?: string;
};

export interface PopoverProps {
  /** 触发元素（按钮）；会被注入 onClick / aria-expanded */
  trigger: ReactElement;
  children: ReactNode | ((close: () => void) => ReactNode);
  side?: FloatingSide;
  align?: FloatingAlign;
  /** 受控 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  /** 读屏标签 */
  label?: string;
  role?: 'dialog' | 'menu' | 'listbox';
  /** 打开后聚焦面板里第一个可聚焦元素（默认 true） */
  autoFocus?: boolean;
}

/**
 * Popover：chrome-popover rounded-lg shadow-lg border-line p-1，从触发点 scaleIn 展开；
 * 点外面 / Esc 关闭并把焦点还给触发元素。渲染到 body，不被滚动容器裁切。
 */
export function Popover({
  trigger,
  children,
  side = 'bottom',
  align = 'start',
  open: openProp,
  onOpenChange,
  className,
  label,
  role = 'dialog',
  autoFocus = true,
}: PopoverProps) {
  const [inner, setInner] = useState(false);
  const open = openProp ?? inner;
  const setOpen = (v: boolean) => {
    if (openProp === undefined) setInner(v);
    onOpenChange?.(v);
  };
  const anchorRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const id = useId();
  const { variants } = useMotionPreset();
  const { setPanel, pos } = useFloating(anchorRef, open, side, align);
  const setOpenRef = useRef(setOpen);
  useEffect(() => {
    setOpenRef.current = setOpen;
  });

  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      setOpenRef.current(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 焦点在另一个模态层里（比如 ⌘K 打开的命令面板）：这一下 Esc 归那一层，弹层自己静默收起
        const modal = (document.activeElement as HTMLElement | null)?.closest(
          '[aria-modal="true"]',
        );
        if (modal && !modal.contains(panelRef.current)) {
          setOpenRef.current(false);
          return;
        }
        e.stopPropagation();
        setOpenRef.current(false);
        anchorRef.current?.querySelector<HTMLElement>('button, [tabindex]')?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  // 关闭后：焦点若还在面板里或丢到了 body，就还给触发按钮
  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body || panel?.contains(active)) {
        anchor?.querySelector<HTMLElement>('button, [tabindex]')?.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open || !autoFocus) return;
    const t = window.setTimeout(() => {
      const el = panelRef.current?.querySelector<HTMLElement>(
        '[data-autofocus], [role^="menuitem"]:not([aria-disabled="true"]), input, textarea, button, [tabindex]:not([tabindex="-1"])',
      );
      el?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [open, autoFocus]);

  const typed = trigger as ReactElement<TriggerProps>;
  const triggerEl = isValidElement(typed)
    ? cloneElement(typed, {
        onClick: (e: ReactMouseEvent<HTMLElement>) => {
          typed.props.onClick?.(e);
          if (!e.defaultPrevented) setOpen(!open);
        },
        'aria-expanded': open,
        'aria-haspopup': role === 'dialog' ? 'dialog' : role,
        'aria-controls': open ? id : undefined,
      })
    : typed;

  return (
    <>
      <span ref={anchorRef} className="contents">
        {triggerEl}
      </span>
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                key="popover"
                id={id}
                ref={(node: HTMLDivElement | null) => {
                  panelRef.current = node;
                  setPanel(node);
                }}
                role={role}
                aria-label={label}
                variants={variants.scaleIn}
                initial="hidden"
                animate="visible"
                exit="exit"
                style={{
                  top: pos?.top ?? -9999,
                  left: pos?.left ?? -9999,
                  transformOrigin: pos?.origin,
                  maxHeight: pos?.maxHeight,
                }}
                className={cn(
                  'fixed z-popover min-w-44 overflow-y-auto rounded-lg border border-line chrome-popover p-1 text-body text-fg shadow-lg',
                  className,
                )}
              >
                {typeof children === 'function' ? children(close) : children}
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}
