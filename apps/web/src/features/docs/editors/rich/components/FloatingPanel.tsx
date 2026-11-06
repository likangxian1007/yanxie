import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { computePosition } from '@/components/ui/floating';
import type { AnchorRect } from './anchor';

function toDomRect(r: AnchorRect): DOMRect {
  const width = Math.max(0, r.right - r.left);
  const height = Math.max(0, r.bottom - r.top);
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    width,
    height,
    x: r.left,
    y: r.top,
    toJSON: () => r,
  } as DOMRect;
}

export interface FloatingPanelProps {
  /** 视口坐标（光标 / 节点的位置） */
  anchor: AnchorRect;
  children: ReactNode;
  className?: string;
  role?: 'dialog' | 'listbox' | 'menu';
  label?: string;
  id?: string;
  /** 点面板外面时调用（不传则不处理） */
  onDismiss?: () => void;
  /** 面板里按 Esc 时调用 */
  onEscape?: () => void;
}

/**
 * 跟随编辑器坐标的浮层（斜杠菜单、公式编辑）：渲染到 body，fixed 定位，空间不够时翻到上方；
 * 外观同 Popover：bg-elevated rounded-lg shadow-lg border-line，scaleIn 从锚点展开。
 */
export function FloatingPanel({
  anchor,
  children,
  className,
  role = 'dialog',
  label,
  id,
  onDismiss,
  onEscape,
}: FloatingPanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { variants } = useMotionPreset();
  const { left, top, right, bottom } = anchor;

  // 每次渲染后（绘制前）按自身尺寸重新定位；直接写 DOM，不经过 state
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pos = computePosition(
      toDomRect({ left, top, right, bottom }),
      { width: el.offsetWidth, height: el.scrollHeight },
      'bottom',
      'start',
    );
    el.style.top = `${pos.top}px`;
    el.style.left = `${pos.left}px`;
    el.style.maxHeight = `${pos.maxHeight}px`;
    el.style.transformOrigin = pos.origin;
  });

  useEffect(() => {
    if (!onDismiss) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onDismiss();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [onDismiss]);

  return createPortal(
    <motion.div
      ref={ref}
      id={id}
      role={role}
      aria-label={label}
      variants={variants.scaleIn}
      initial="hidden"
      animate="visible"
      exit="exit"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && onEscape) {
          e.stopPropagation();
          e.preventDefault();
          onEscape();
        }
      }}
      className={cn(
        'fixed top-0 left-0 z-popover overflow-y-auto rounded-lg border border-line bg-elevated p-1 text-body text-fg shadow-lg',
        className,
      )}
    >
      {children}
    </motion.div>,
    document.body,
  );
}
