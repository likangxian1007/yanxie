import type { ReactNode } from 'react';
import { Menu } from './Menu';
import type { ContextMenuPoint } from './use-context-menu';

export interface ContextMenuProps {
  at: ContextMenuPoint | null;
  onClose: () => void;
  label: string;
  /** MenuItem / MenuSeparator / MenuLabel */
  children: ReactNode;
  className?: string;
}

/**
 * 右键菜单（STYLE §6 Menu 的同一套外观和键盘操作），锚在指针位置。
 * 列表项的右键菜单和「⋯」按钮共用同一组 MenuItem，两处的动作保持一致。
 */
export function ContextMenu({ at, onClose, label, children, className }: ContextMenuProps) {
  return (
    <Menu
      open={at !== null}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      label={label}
      className={className}
      trigger={
        // 0×0 的定位锚点：没有 tabindex，关闭时 Popover 不会把焦点还给它
        <span
          aria-hidden
          data-context-anchor=""
          style={{
            position: 'fixed',
            left: at?.x ?? -9999,
            top: at?.y ?? -9999,
            width: 0,
            height: 0,
            pointerEvents: 'none',
          }}
        />
      }
    >
      {children}
    </Menu>
  );
}
