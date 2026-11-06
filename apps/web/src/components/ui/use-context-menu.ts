import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

export interface ContextMenuPoint {
  x: number;
  y: number;
}

/**
 * 右键菜单的状态：在列表项上挂 onContextMenu / onKeyDown，菜单在指针位置弹出。
 * - 按住 Shift 右键仍是浏览器原生菜单（需要“检查”“复制链接地址”时用）。
 * - 键盘：菜单键或 Shift+F10 在元素左下角打开。
 * - 关闭后焦点回到触发的列表项。
 */
export function useContextMenu() {
  const [at, setAt] = useState<ContextMenuPoint | null>(null);
  const origin = useRef<HTMLElement | null>(null);

  const onContextMenu = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    if (e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    origin.current = e.currentTarget;
    setAt({ x: e.clientX, y: e.clientY });
  }, []);

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    origin.current = e.currentTarget;
    setAt({ x: rect.left + 16, y: rect.bottom - 4 });
  }, []);

  const close = useCallback(() => {
    setAt(null);
    const el = origin.current;
    // 等菜单卸载后再还焦点（菜单里的动作可能打开对话框，那时对话框会自己接管焦点）
    window.setTimeout(() => {
      const active = document.activeElement;
      if (el?.isConnected && (!active || active === document.body)) el.focus();
    }, 0);
  }, []);

  return { at, open: at !== null, onContextMenu, onKeyDown, close };
}
