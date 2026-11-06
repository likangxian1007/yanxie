import { DiscussionButton } from '@/features/discussion/DiscussionButton';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  Bell,
  Menu as MenuIcon,
  MessageSquareWarning,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
} from 'lucide-react';
import { IconButton } from '@/components/ui';
import { FEEDBACK_COPY } from '@/features/feedback/copy';
import { openFeedbackDialog } from '@/features/feedback/feedback-store';
import { NotificationBell } from '@/features/feedback/components/NotificationBell';
import { BalanceChip } from '@/features/billing/BalanceChip';
import { useInboxCount } from '@/features/inbox/use-inbox-count';
import { cn } from '@/lib/cn';
import { isProfessionalWorkspace, useLayoutStore } from './layout-store';
import { useConflicts } from '@/lib/realtime-store';
import { projectPath } from './nav-items';
import { PresenceSummary } from './PresenceSummary';
import { useRouteTitle } from './route-title';
import { ThemeToggle } from './ThemeToggle';
import { LanguageToggle } from './LanguageToggle';
import { usePageTitle } from './page-title';
import { parseSettingsTab, SETTINGS_TAB_LABEL } from '@/features/settings/lib';
import { tr } from '@/lib/i18n';

export interface TopbarProps {
  navigationProjectId?: string;
  /** 内容区已滚动：显示底部发丝线 */
  scrolled: boolean;
}

/**
 * 顶栏 52px：导航、上下文标题与操作、在线人数、外观、收件箱及辅助面板。
 * sticky + bg-canvas/80 + backdrop-blur；底部发丝线只在内容滚动后出现。
 */
export function Topbar({ scrolled, navigationProjectId }: TopbarProps) {
  const { projectId: routeProjectId = '', threadId } = useParams();
  const projectId = navigationProjectId ?? routeProjectId;
  const navigate = useNavigate();
  const title = useRouteTitle();
  const pageTitle = usePageTitle();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const blocked = isProfessionalWorkspace(location.pathname);
  const conflicts = useConflicts(projectId);
  const inboxCount = useInboxCount(projectId);
  const collapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
  const setMobileNavOpen = useLayoutStore((s) => s.setMobileNavOpen);
  const rightPanelOpen = useLayoutStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useLayoutStore((s) => s.setRightPanelOpen);
  const panelVisible =
    !blocked &&
    (rightPanelOpen || params.has('thread') || params.has('preview') || params.has('discussion'));
  const settings = /\/settings\/?$/u.test(location.pathname);
  const contextHeading =
    pageTitle !== null ||
    settings ||
    location.pathname === projectPath(projectId, '') ||
    location.pathname === projectPath(projectId, 'threads');
  const heading =
    pageTitle ??
    (settings && params.has('tab')
      ? SETTINGS_TAB_LABEL[parseSettingsTab(params.get('tab'))]
      : (title ?? tr('研协')));

  return (
    <header
      className={cn(
        'chrome sticky top-0 z-sticky flex h-(--topbar-h) shrink-0 items-center gap-1.5 border-b px-2 sm:gap-2 sm:px-3 md:px-4',
        'transition-[border-color] duration-(--dur-base) ease-(--ease-standard)',
        scrolled ? 'border-line' : 'border-transparent',
      )}
    >
      <IconButton
        label={tr('打开导航')}
        className={cn('max-md:size-10 md:hidden', settings && 'hidden')}
        onClick={() => setMobileNavOpen(true)}
      >
        <MenuIcon strokeWidth={1.75} aria-hidden />
      </IconButton>
      <IconButton
        label={collapsed ? tr('展开侧栏') : tr('收起侧栏')}
        className={cn('hidden md:inline-flex', settings && 'md:hidden')}
        onClick={toggleSidebar}
      >
        {collapsed ? (
          <PanelLeftOpen strokeWidth={1.75} aria-hidden />
        ) : (
          <PanelLeftClose strokeWidth={1.75} aria-hidden />
        )}
      </IconButton>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        {settings && params.has('tab') && (
          <span className="hidden text-small text-fg-subtle md:inline">{tr('设置 /')}</span>
        )}
        {contextHeading ? (
          <h1
            title={typeof heading === 'string' ? heading : undefined}
            className="min-w-0 flex-1 text-small font-semibold text-fg max-md:line-clamp-2 max-md:leading-[1.15rem] max-md:break-words md:truncate"
          >
            {heading}
          </h1>
        ) : (
          <span
            aria-current="page"
            title={typeof heading === 'string' ? heading : undefined}
            className="min-w-0 text-small font-medium text-fg max-md:line-clamp-2 max-md:leading-[1.15rem] md:truncate"
          >
            {heading}
          </span>
        )}
      </div>
      <div id="page-actions" className="flex min-w-0 shrink-0 items-center gap-2 max-md:gap-1" />
      <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
        {!blocked && !/\/(workspace|settings)(\/|$)/.test(location.pathname) && (
          <DiscussionButton threadId={params.get('thread') ?? threadId} />
        )}
        <PresenceSummary projectId={projectId} />

        <LanguageToggle className="hidden sm:inline-flex" />
        <ThemeToggle className="hidden sm:inline-flex" />

        <IconButton
          label={FEEDBACK_COPY.entryLong}
          shortcut={FEEDBACK_COPY.shortcut}
          className="hidden md:inline-flex"
          onClick={openFeedbackDialog}
        >
          <MessageSquareWarning strokeWidth={1.75} aria-hidden />
        </IconButton>
        <BalanceChip className="max-sm:hidden" />
        <NotificationBell />

        {/* 手机上「待我处理」在底部标签栏里（带计数），顶栏不再重复一个铃铛 */}
        <span className="relative hidden md:inline-flex">
          <IconButton
            label={
              inboxCount > 0 ? tr('待我处理（{inboxCount} 条）', { inboxCount }) : tr('待我处理')
            }
            onClick={() => navigate(projectPath(projectId, 'inbox'))}
          >
            <Bell strokeWidth={1.75} aria-hidden />
          </IconButton>
          {inboxCount > 0 && (
            <span
              aria-hidden
              className="pointer-events-none absolute top-1.5 right-1.5 size-2 rounded-full bg-warning ring-2 ring-canvas"
            />
          )}
        </span>

        <span className="relative inline-flex">
          <IconButton
            label={
              blocked
                ? tr('专业工作区使用独立面板')
                : panelVisible
                  ? tr('收起辅助面板')
                  : tr('展开辅助面板')
            }
            data-panel-trigger="true"
            aria-expanded={panelVisible}
            disabled={blocked}
            onClick={() => {
              if (panelVisible) {
                const next = new URLSearchParams(params);
                next.delete('thread');
                next.delete('threadTab');
                next.delete('preview');
                next.delete('discussion');
                setParams(next);
              }
              setRightPanelOpen(!panelVisible);
            }}
            className="max-md:size-11"
          >
            <PanelRight strokeWidth={1.75} aria-hidden />
          </IconButton>
          {(conflicts.length > 0 || inboxCount > 0) && (
            <span
              className="pointer-events-none absolute -top-0.5 -right-1 rounded-full bg-warning-soft px-1 text-caption text-warning tabular-nums"
              aria-label={tr('{count} 个冲突，{inboxCount} 条待处理', {
                count: conflicts.length,
                inboxCount,
              })}
            >
              {conflicts.length + inboxCount}
            </span>
          )}
        </span>
      </div>
    </header>
  );
}
