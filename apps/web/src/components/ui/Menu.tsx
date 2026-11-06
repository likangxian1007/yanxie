import {
  createContext,
  forwardRef,
  useContext,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { FloatingAlign, FloatingSide } from './floating';
import { Popover } from './Popover';

const MenuCloseContext = createContext<() => void>(() => {});

export interface MenuProps {
  trigger: ReactElement;
  children: ReactNode;
  align?: FloatingAlign;
  side?: FloatingSide;
  label?: string;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function focusItem(container: HTMLElement, dir: 1 | -1 | 'first' | 'last') {
  const items = Array.from(
    container.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])'),
  );
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (dir === 'first') next = 0;
  else if (dir === 'last') next = items.length - 1;
  else next = (current + dir + items.length) % items.length;
  items[next]?.focus();
}

/**
 * 下拉菜单（STYLE §6）：项高 32、圆角 sm、hover subtle；上下键移动、Home/End、Enter 选择、Esc 关闭。
 */
export function Menu({
  trigger,
  children,
  align = 'start',
  side = 'bottom',
  label,
  className,
  open,
  onOpenChange,
}: MenuProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusItem(el, 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusItem(el, -1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusItem(el, 'first');
    } else if (e.key === 'End') {
      e.preventDefault();
      focusItem(el, 'last');
    } else if (e.key === 'Tab') {
      e.preventDefault();
    }
  };
  return (
    <Popover
      trigger={trigger}
      align={align}
      side={side}
      role="menu"
      label={label}
      className={className}
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      {(close) => (
        <MenuCloseContext.Provider value={close}>
          <div onKeyDown={onKeyDown} className="flex flex-col">
            {children}
          </div>
        </MenuCloseContext.Provider>
      )}
    </Popover>
  );
}

export interface MenuItemProps {
  children: ReactNode;
  onSelect?: () => void;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  /** 单选/多选菜单里的勾选状态 */
  checked?: boolean;
  description?: ReactNode;
  /** 选择后不关闭菜单 */
  keepOpen?: boolean;
  className?: string;
}

export const MenuItem = forwardRef<HTMLDivElement, MenuItemProps>(function MenuItem(
  {
    children,
    onSelect,
    icon,
    shortcut,
    danger,
    disabled,
    checked,
    description,
    keepOpen,
    className,
  },
  ref,
) {
  const close = useContext(MenuCloseContext);
  const select = () => {
    if (disabled) return;
    if (!keepOpen) close();
    onSelect?.();
  };
  return (
    <div
      ref={ref}
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select();
        }
      }}
      className={cn(
        'flex min-h-8 cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 text-body outline-none select-none',
        'transition-colors duration-(--dur-fast) ease-(--ease-standard)',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        danger
          ? 'text-danger hover:bg-danger-soft focus:bg-danger-soft'
          : 'text-fg hover:bg-subtle focus:bg-subtle',
        disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
        className,
      )}
    >
      {icon && <span className={cn('flex', !danger && 'text-fg-muted')}>{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {description && (
          <span className="block truncate text-caption font-normal text-fg-subtle">
            {description}
          </span>
        )}
      </span>
      {shortcut && <span className="pl-3 font-mono text-caption text-fg-subtle">{shortcut}</span>}
      {checked && <Check strokeWidth={2} aria-hidden className="text-accent" />}
    </div>
  );
});

export function MenuSeparator() {
  return <div role="separator" className="-mx-1 my-1 h-px bg-line" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div role="presentation" className="px-2 pt-1.5 pb-1 text-caption text-fg-subtle">
      {children}
    </div>
  );
}
