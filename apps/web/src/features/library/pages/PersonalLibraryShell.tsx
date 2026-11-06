import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import {
  Coins,
  LibraryBig,
  LogOut,
  MessageSquareWarning,
  MessagesSquare,
  Plus,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { openFeedbackDialog } from '@/features/feedback/feedback-store';
import { FEEDBACK_COPY } from '@/features/feedback/copy';
import { ADMIN_COPY } from '@/features/admin/copy';
import { Button, IconButton, Menu, MenuItem, Select, Toaster } from '@/components/ui';
import { ThemeToggle } from '@/components/layout/ThemeToggle';
import { LanguageToggle } from '@/components/layout/LanguageToggle';
import { FullPageError, FullPageLoading } from '@/app/pages/FullPageState';
import { isUnauthorized, lastProject, useLogout, useMe } from '@/lib/session';
import { ProjectShell } from '@/components/layout/AppShell';
import { FeedbackDialogHost } from '@/features/feedback/components/FeedbackDialog';
import { NotificationBell } from '@/features/feedback/components/NotificationBell';
import { BalanceChip } from '@/features/billing/BalanceChip';
import { tr } from '@/lib/i18n';

/** 只要求登录；已有项目仅提供侧栏与导航上下文，个人数据不属于该项目。 */
export function PersonalLibraryShell() {
  const me = useMe();
  const logout = useLogout();
  const location = useLocation();
  const navigate = useNavigate();
  if (me.isPending) return <FullPageLoading />;
  if (me.error) {
    if (isUnauthorized(me.error))
      return (
        <Navigate
          to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
          replace
        />
      );
    return <FullPageError error={me.error} onRetry={() => void me.refetch()} />;
  }
  const projects = me.data.projects.filter((p) => !p.archivedAt);
  // 项目只提供导航上下文；/library 的数据仍由账号身份决定，不挂到项目下。
  const navigationProject = projects.find((p) => p.id === lastProject()) ?? projects[0];
  if (navigationProject)
    return (
      <ProjectShell key={me.data.user.id} projectId={navigationProject.id} meId={me.data.user.id} />
    );
  return (
    <div className="flex h-dvh min-w-0 flex-col bg-canvas text-fg">
      <header className="chrome flex h-(--topbar-h) shrink-0 items-center gap-2 border-b border-line px-4">
        <Link
          to="/library"
          className="flex min-h-11 shrink-0 items-center gap-2 text-small font-medium"
        >
          <LibraryBig size={18} strokeWidth={1.75} aria-hidden />
          <span className="max-[389px]:sr-only">{tr('我的资料')}</span>
        </Link>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {projects.length > 0 ? (
            <Select
              aria-label={tr('打开项目文献库')}
              value=""
              wrapperClassName="min-w-0 max-w-48 flex-1"
              onChange={(e) => {
                if (e.target.value) navigate(`/p/${e.target.value}/library`);
              }}
            >
              <option value="">{tr('项目文献库')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => navigate('/new')}>
              {tr('新建课题')}
            </Button>
          )}
          <LanguageToggle />
          <ThemeToggle />
          <BalanceChip className="max-sm:hidden" />
          <NotificationBell />
          <Menu
            label={tr('账号')}
            align="end"
            trigger={
              <IconButton label={tr('账号：{name}', { name: me.data.user.name })}>
                <UserRound strokeWidth={1.75} aria-hidden />
              </IconButton>
            }
          >
            <MenuItem
              icon={<Plus strokeWidth={1.75} aria-hidden />}
              onSelect={() => navigate('/new')}
            >
              {tr('新建课题')}
            </MenuItem>
            <MenuItem
              icon={<MessageSquareWarning strokeWidth={1.75} aria-hidden />}
              onSelect={openFeedbackDialog}
            >
              {FEEDBACK_COPY.entryLong}
            </MenuItem>
            <MenuItem
              icon={<MessagesSquare strokeWidth={1.75} aria-hidden />}
              onSelect={() => navigate('/feedback')}
            >
              {FEEDBACK_COPY.center}
            </MenuItem>
            <MenuItem
              icon={<Coins strokeWidth={1.75} aria-hidden />}
              onSelect={() => navigate('/billing')}
            >
              {tr('余额与充值')}
            </MenuItem>
            {me.data.user.isAdmin && (
              <MenuItem
                icon={<ShieldCheck strokeWidth={1.75} aria-hidden />}
                onSelect={() => navigate('/admin')}
              >
                {ADMIN_COPY.title}
              </MenuItem>
            )}
            <MenuItem
              icon={<LogOut strokeWidth={1.75} aria-hidden />}
              onSelect={() => logout.mutate()}
            >
              {tr('退出登录')}
            </MenuItem>
          </Menu>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside
          aria-label={tr('侧边栏')}
          className="hidden w-(--sidebar-w) shrink-0 border-r border-line p-4 md:block"
        >
          <p className="mb-3 text-small text-fg-muted">{tr('我的工作区')}</p>
          <Link
            to="/library"
            aria-current="page"
            className="block rounded-md bg-accent-soft px-3 py-2 text-small text-accent-text"
          >
            {tr('个人文献库')}
          </Link>
          <Link to="/new" className="mt-3 block px-3 py-2 text-small">
            {tr('新建课题')}
          </Link>
        </aside>
        <main id="app-scroll" className="min-h-0 min-w-0 flex-1 overflow-auto">
          <Outlet key={me.data.user.id} />
        </main>
      </div>
      <FeedbackDialogHost />
      <Toaster />
    </div>
  );
}
