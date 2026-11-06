import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import { FolderX, X } from 'lucide-react';
import { Button, Dialog, EmptyState, IconButton, Toaster } from '@/components/ui';
import { FullPageError, FullPageLoading } from '@/app/pages/FullPageState';
import { useIdlePreload } from '@/app/route-preload';
import { OnboardingHost } from '@/features/onboarding/OnboardingHost';
import { FeedbackDialogHost } from '@/features/feedback/components/FeedbackDialog';
import { cn } from '@/lib/cn';
import { withBase } from '@/lib/base-path';
import { useMotionPreset } from '@/lib/motion';
import { useIsMobile } from '@/lib/use-media-query';
import { useProjectRealtime } from '@/lib/realtime';
import { isUnauthorized, rememberProject, useMe } from '@/lib/session';
import { useGlobalShortcuts } from '@/lib/shortcuts';
import { DeferredPanel } from './right-panel-loader';
import { ConnectionBanner } from './ConnectionBanner';
import { useFocusTrap } from './focus-trap';
import { isProfessionalWorkspace, useLayoutStore } from './layout-store';
import { MobileTabBar } from './MobileTabBar';
import { projectPath } from './nav-items';
import { PageTransition } from './PageTransition';
import { PageTitleProvider } from './Page';
import { RightPanel } from './RightPanel';
import { useRouteTitle } from './route-title';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { SettingsNavigation } from '@/features/settings/components/SettingsNavigation';
import { tr } from '@/lib/i18n';

const loadPalette = () => import('./CommandPalette').then((m) => ({ default: m.CommandPalette }));

/** 顶栏的「打开导航」按钮：抽屉关闭后焦点回到这里 */
function menuButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`button[aria-label="${tr('打开导航')}"]`);
}

function MobileNavDrawer({ projectId }: { projectId: string }) {
  const open = useLayoutStore((s) => s.mobileNavOpen);
  const setOpen = useLayoutStore((s) => s.setMobileNavOpen);
  const { variants } = useMotionPreset();
  const panelRef = useRef<HTMLDivElement>(null);

  // 模态抽屉：打开时焦点进抽屉，Tab 锁在里面，Esc 关闭，关闭后焦点回到「打开导航」
  useFocusTrap(panelRef, open, () => setOpen(false), { restoreFocus: menuButton });

  return (
    <AnimatePresence>
      {open && (
        <div key="mobile-nav" className="fixed inset-0 z-overlay md:hidden">
          <motion.div
            variants={variants.fadeIn}
            initial="hidden"
            animate="visible"
            exit="exit"
            aria-hidden
            className="absolute inset-0 bg-overlay backdrop-blur-[2px]"
            onClick={() => setOpen(false)}
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={tr('导航')}
            tabIndex={-1}
            variants={variants.drawerLeft}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="absolute inset-y-0 left-0 flex w-[min(280px,85vw)] flex-col border-r border-line shadow-lg outline-none pb-[env(safe-area-inset-bottom)]"
          >
            <Sidebar
              projectId={projectId}
              collapsed={false}
              layoutGroupId="sidebar-drawer"
              onNavigate={() => setOpen(false)}
              headerAction={
                <IconButton label={tr('关闭导航')} size="sm" onClick={() => setOpen(false)}>
                  <X strokeWidth={1.75} aria-hidden />
                </IconButton>
              }
            />
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

/**
 * 项目外壳：先确认登录与成员身份，再渲染侧栏 + 顶栏 + 内容区 + 右侧动态面板。
 * - < 768px：侧栏变为左侧抽屉（顶栏出现菜单按钮）
 * - ≥ 768px：侧栏 224px，可收起到 60px（存 localStorage['srh-sidebar']）
 * - < 1280px：右侧面板变成覆盖式 Sheet
 */
export function AppShell() {
  const { projectId = '' } = useParams();
  const location = useLocation();
  const me = useMe();

  if (me.isPending) return <FullPageLoading />;
  if (me.error) {
    if (isUnauthorized(me.error)) {
      const next = encodeURIComponent(location.pathname + location.search);
      return <Navigate to={`/login?next=${next}`} replace />;
    }
    return <FullPageError error={me.error} onRetry={() => void me.refetch()} />;
  }
  const isMember = me.data.projects.some((p) => p.id === projectId);
  if (!isMember) return <NoAccess />;
  return <ProjectShell projectId={projectId} meId={me.data.user.id} />;
}

function NoAccess() {
  const navigate = useNavigate();
  return (
    <div className="grid min-h-dvh place-items-center bg-canvas px-4">
      <EmptyState
        icon={FolderX}
        title={tr('打不开这个课题')}
        description={tr('课题不存在，或者你还不是它的成员。可以请负责人发你一个邀请链接。')}
        action={
          <Button variant="primary" onClick={() => navigate('/')}>
            {tr('回到我的课题')}
          </Button>
        }
      />
    </div>
  );
}

export function ProjectShell({ projectId, meId }: { projectId: string; meId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const settings = /\/settings\/?$/u.test(location.pathname);
  const mobile = useIsMobile();
  const collapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const paletteOpen = useLayoutStore((s) => s.paletteOpen);
  const setPaletteOpen = useLayoutStore((s) => s.setPaletteOpen);
  const [scrolled, setScrolled] = useState(false);
  const title = useRouteTitle();

  useProjectRealtime(projectId, meId);
  // 空闲时预取各列表页的代码和首屏数据，切页不再等骨架屏
  useIdlePreload(projectId);

  useEffect(() => {
    rememberProject(projectId);
  }, [projectId]);

  useEffect(() => {
    document.title = title ? tr('{title} · 研协', { title }) : tr('研协');
  }, [title]);

  useGlobalShortcuts({
    onPalette: () => setPaletteOpen(!useLayoutStore.getState().paletteOpen),
    onGoTimeline: () => navigate(projectPath(projectId, '')),
    onGoInbox: () => navigate(projectPath(projectId, 'inbox')),
    onGoWorkspace: () => navigate(projectPath(projectId, 'workspace')),
  });

  return (
    <PageTitleProvider>
      <div className="flex h-dvh overflow-hidden bg-canvas text-fg">
        <a
          href="#main-content"
          className="sr-only z-tooltip rounded-md bg-elevated px-3 py-2 text-body text-fg shadow-lg focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          {tr('跳到主要内容')}
        </a>

        <aside
          aria-label={tr('侧边栏')}
          data-collapsed={(!settings && collapsed) || undefined}
          className={cn(
            'relative z-sidebar hidden h-full shrink-0 overflow-hidden border-r border-line md:block',
            // 侧栏收起是唯一一处宽度过渡（--dur-slow），见 STYLE §4.1
            'transition-[width] duration-(--dur-slow) ease-(--ease-out) motion-reduce:transition-none',
            !settings && collapsed ? 'w-(--sidebar-w-collapsed)' : 'w-(--sidebar-w)',
          )}
        >
          {settings ? (
            !mobile && <SettingsNavigation projectId={projectId} />
          ) : (
            <Sidebar projectId={projectId} collapsed={collapsed} layoutGroupId="sidebar-desktop" />
          )}
        </aside>

        <MobileNavDrawer projectId={projectId} />

        <div className="relative isolate flex min-w-0 flex-1 flex-col bg-canvas">
          {!isProfessionalWorkspace(location.pathname) && (
            <svg
              className="workspace-watermark"
              viewBox="36 0 196 204"
              aria-hidden="true"
              focusable="false"
            >
              <image href={withBase('/branding/fudan-official.png')} width="487" height="213" />
            </svg>
          )}
          <ConnectionBanner />
          <div
            id="app-scroll"
            className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain"
            onScroll={(e) => {
              const next = e.currentTarget.scrollTop > 0;
              if (next !== scrolled) setScrolled(next);
            }}
          >
            <Topbar scrolled={scrolled} navigationProjectId={projectId} />
            <main id="main-content" tabIndex={-1} className="flex flex-1 flex-col outline-none">
              <PageTransition />
            </main>
          </div>
          {!settings && <MobileTabBar projectId={projectId} />}
        </div>

        <RightPanel />
        <DeferredPanel
          active={paletteOpen}
          load={loadPalette}
          componentProps={{ projectId }}
          fallback={
            <Dialog
              open={paletteOpen}
              onOpenChange={setPaletteOpen}
              title={tr('正在加载命令面板')}
              placement="top"
              instantClose
            >
              <p role="status" className="text-small text-fg-muted">
                {tr('正在加载命令面板…')}
              </p>
            </Dialog>
          }
          renderError={(retry) => (
            <Dialog
              open={paletteOpen}
              onOpenChange={setPaletteOpen}
              title={tr('命令面板')}
              placement="top"
              instantClose
            >
              <div role="alert" className="text-small text-fg-muted">
                <p className="mb-3">{tr('命令面板加载失败')}</p>
                <Button variant="secondary" onClick={retry}>
                  {tr('重新加载')}
                </Button>
              </div>
            </Dialog>
          )}
        />
        <OnboardingHost projectId={projectId} userId={meId} />
        <FeedbackDialogHost />
        <Toaster />
      </div>
    </PageTitleProvider>
  );
}
