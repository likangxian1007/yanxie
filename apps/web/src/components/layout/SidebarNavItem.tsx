import { useRoutePreload } from '@/app/route-preload';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { motion } from 'motion/react';
import { Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { projectPath, type NavItem } from './nav-items';

export interface SidebarNavItemProps {
  item: NavItem;
  projectId: string;
  collapsed: boolean;
  /** 右侧附加内容（计数徽标）；收起时改为图标右上角的小圆点 */
  badge?: ReactNode;
  onNavigate?: (() => void) | undefined;
  children?: ReactNode;
}

/** 侧栏导航项：选中底色用 layoutId 在项之间滑动（spring.snappy）。 */
export function SidebarNavItem({
  item,
  projectId,
  collapsed,
  badge,
  onNavigate,
  children,
}: SidebarNavItemProps) {
  const { spring } = useMotionPreset();
  const Icon = item.icon;
  const preload = useRoutePreload(projectPath(projectId, item.to));

  return (
    <li>
      <Tooltip content={item.label} side="right" disabled={!collapsed} className="flex w-full">
        <NavLink
          to={projectPath(projectId, item.to)}
          {...preload}
          end={item.to === ''}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'group relative flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-small max-md:h-11 select-none',
              'transition-colors duration-(--dur-fast) ease-(--ease-standard)',
              isActive ? 'font-medium text-fg' : 'text-fg-muted hover:bg-muted/60 hover:text-fg',
              collapsed && 'justify-center px-0',
            )
          }
        >
          {({ isActive }) => (
            <>
              {isActive && (
                <motion.span
                  layoutId="sidebar-active-pill"
                  transition={spring.snappy}
                  aria-hidden
                  className="absolute inset-0 rounded-sm bg-muted"
                />
              )}
              <span className="relative flex shrink-0">
                <Icon
                  size={18}
                  strokeWidth={1.75}
                  aria-hidden
                  className={cn(isActive ? 'text-fg' : 'text-fg-subtle group-hover:text-fg-muted')}
                />
                {collapsed && badge && (
                  <span
                    aria-hidden
                    className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-warning ring-2 ring-subtle"
                  />
                )}
              </span>
              <span className={cn('relative min-w-0 flex-1 truncate', collapsed && 'sr-only')}>
                {item.label}
              </span>
              {!collapsed && badge && <span className="relative">{badge}</span>}
            </>
          )}
        </NavLink>
      </Tooltip>
      {children}
    </li>
  );
}
