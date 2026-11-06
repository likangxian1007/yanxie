import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { projectPath } from '@/components/layout/nav-items';
import { useMyRole, useProject } from '@/lib/project';
import { Button, Dialog } from '@/components/ui';
import { DeferredPanel } from '@/components/layout/right-panel-loader';
import { writeTourRecord } from './storage';
import { useTourStore } from './tour-store';
import { tourVariantForRole } from './tour-steps';
import { tr } from '@/lib/i18n';
const loadTour = () => import('./TourOverlay').then((m) => ({ default: m.TourOverlay }));
const loadWelcome = () => import('./AdvisorWelcome').then((m) => ({ default: m.AdvisorWelcome }));

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function modalOpen(): boolean {
  return Array.from(document.querySelectorAll('[aria-modal="true"]')).some(
    (el) => el.getClientRects().length > 0,
  );
}

export interface OnboardingHostProps {
  projectId: string;
  userId: string;
}

/**
 * 外壳里唯一的引导入口：
 * - 首次访问与未完成的引导都不打断工作，只响应用户主动请求。
 * - 帮助中心、命令面板通过 `requestTour()` 让这里重新开始。
 * - `?` 打开帮助中心。
 */
export function OnboardingHost({ projectId, userId }: OnboardingHostProps) {
  const navigate = useNavigate();
  const role = useMyRole(projectId);
  const project = useProject(projectId);
  const active = useTourStore((s) => s.active);
  const welcomeOpen = useTourStore((s) => s.welcomeOpen);
  const setWelcomeOpen = useTourStore((s) => s.setWelcomeOpen);
  const start = useTourStore((s) => s.start);
  const close = useTourStore((s) => s.close);
  const request = useTourStore((s) => s.request);
  const clearRequest = useTourStore((s) => s.clearRequest);
  const variant = tourVariantForRole(role);

  // 换课题 / 离开外壳：收起进行中的引导（进度已经存了，下次进来接着走）
  useEffect(() => () => close(), [projectId, close]);

  // 别处请求重看引导
  useEffect(() => {
    if (!request) return;
    clearRequest();
    start({ userId, projectId, variant: request.variant ?? variant });
  }, [request, clearRequest, start, userId, projectId, variant]);

  // ? 打开帮助中心
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (isTyping(e.target) || modalOpen()) return;
      e.preventDefault();
      navigate(projectPath(projectId, 'help'));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, projectId]);

  const dismissWelcome = () => {
    setWelcomeOpen(false);
    writeTourRecord(userId, projectId, {
      status: 'skipped',
      step: 0,
      variant: 'advisor',
      welcomed: true,
    });
  };

  return (
    <>
      <DeferredPanel
        active={Boolean(active)}
        load={loadTour}
        componentProps={{}}
        fallback={
          <Dialog
            open={Boolean(active)}
            onOpenChange={(next) => {
              if (!next) close();
            }}
            title={tr('引导')}
            instantClose
          >
            <p role="status" className="text-small text-fg-muted">
              {tr('正在加载引导…')}
            </p>
          </Dialog>
        }
        renderError={(retry) => (
          <Dialog
            open={Boolean(active)}
            onOpenChange={(next) => {
              if (!next) close();
            }}
            title={tr('引导')}
            instantClose
          >
            <div role="alert" className="text-small text-fg-muted">
              <p className="mb-3">{tr('引导加载失败')}</p>
              <Button variant="secondary" onClick={retry}>
                {tr('重新加载')}
              </Button>
            </div>
          </Dialog>
        )}
      />
      <DeferredPanel
        active={welcomeOpen}
        load={loadWelcome}
        componentProps={{
          open: welcomeOpen,
          projectId,
          projectName: project.data?.name,
          onDismiss: dismissWelcome,
          onStartTour: () => start({ userId, projectId, variant: 'advisor' }),
        }}
        fallback={
          <Dialog
            open={welcomeOpen}
            onOpenChange={(next) => {
              if (!next) dismissWelcome();
            }}
            title={tr('欢迎，导师')}
            instantClose
          >
            <p role="status" className="text-small text-fg-muted">
              {tr('正在加载…')}
            </p>
          </Dialog>
        }
        renderError={(retry) => (
          <Dialog
            open={welcomeOpen}
            onOpenChange={(next) => {
              if (!next) dismissWelcome();
            }}
            title={tr('欢迎，导师')}
            instantClose
          >
            <div role="alert" className="text-small text-fg-muted">
              <p className="mb-3">{tr('欢迎页加载失败')}</p>
              <Button variant="secondary" onClick={retry}>
                {tr('重新加载')}
              </Button>
            </div>
          </Dialog>
        )}
      />
    </>
  );
}
