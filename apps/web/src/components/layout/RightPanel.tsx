import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router';
import { X } from 'lucide-react';
import { IconButton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { isProfessionalWorkspace, useLayoutStore } from './layout-store';
import { useMediaQuery } from '@/lib/use-media-query';
import { useFocusTrap } from './focus-trap';
import { DeferredPanel } from './right-panel-loader';
import {
  RESOURCE_LABEL,
  parsePreview,
  previewFocusTarget,
} from '@/features/resource-preview/links';

import { parseDiscussion } from '@/features/discussion/links';
import { tr } from '@/lib/i18n';

const loadDiscussion = () =>
  import('@/features/discussion/TeamDiscussion').then((m) => ({ default: m.TeamDiscussion }));

const INLINE_QUERY = '(min-width: 1280px)';
const loadThreads = () =>
  import('./RightPanelThreads').then((m) => ({ default: m.RightPanelThreads }));
const loadActivity = () =>
  import('./RightPanelActivity').then((m) => ({ default: m.RightPanelActivity }));
const loadPreview = () =>
  import('@/features/resource-preview/ResourcePreview').then((m) => ({
    default: m.ResourcePreview,
  }));

/** 全局只有一个辅助面板。隐藏保留组件状态，线程草稿不会因切换标签而消失。 */
export function RightPanel() {
  const { projectId = '' } = useParams();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const requestedOpen = useLayoutStore((s) => s.rightPanelOpen);
  const setOpen = useLayoutStore((s) => s.setRightPanelOpen);
  const preferredTab = useLayoutStore((s) => s.panelTab);
  const setTab = useLayoutStore((s) => s.setPanelTab);
  const inline = useMediaQuery(INLINE_QUERY);
  const blocked = isProfessionalWorkspace(location.pathname);
  const preview = useMemo(() => parsePreview(params.get('preview')), [params]);
  const discussion = parseDiscussion(params.get('discussion'));
  const selectedId = preview || discussion ? null : params.get('thread');
  // URL 直接决定深链接视图，避免快速后退时 React 合并更新跳过中间 effect。
  const tab = discussion
    ? 'discussion'
    : preview
      ? 'preview'
      : selectedId
        ? 'threads'
        : preferredTab;
  const open =
    (requestedOpen || Boolean(selectedId) || Boolean(preview) || Boolean(discussion)) && !blocked;
  const panelRef = useRef<HTMLDivElement>(null);

  const clearThread = useCallback(() => {
    if (!params.has('thread') && !params.has('preview') && !params.has('discussion')) return;
    const next = new URLSearchParams(params);
    next.delete('thread');
    next.delete('threadTab');
    next.delete('preview');
    next.delete('discussion');
    setParams(next, { state: location.state });
  }, [params, setParams, location.state]);
  const close = () => {
    setOpen(false);
    clearThread();
    if (inline)
      (
        document.querySelector<HTMLElement>('[data-discussion-trigger]') ??
        previewFocusTarget() ??
        document.querySelector<HTMLElement>('[data-panel-trigger]')
      )?.focus();
  };
  useFocusTrap(panelRef, open && !inline, close, {
    restoreFocus: () =>
      document.querySelector<HTMLElement>('[data-discussion-trigger]') ??
      previewFocusTarget() ??
      document.querySelector<HTMLElement>('[data-panel-trigger]'),
  });

  // 链接和浏览器前进后退以 URL 为准；仅 URL 改变才自动打开，手动关闭不会被反向拉开。
  useEffect(() => {
    if (selectedId && !blocked) {
      setTab('threads');
    }
  }, [selectedId, location.key, blocked, setTab]);
  useEffect(() => {
    if (!discussion || (!params.has('thread') && !params.has('preview'))) return;
    const next = new URLSearchParams(params);
    next.delete('thread');
    next.delete('threadTab');
    next.delete('preview');
    setParams(next, { replace: true, state: location.state });
  }, [discussion, params, setParams, location.state]);
  useEffect(() => {
    if (discussion || !preview || !params.has('thread')) return;
    const next = new URLSearchParams(params);
    next.delete('thread');
    next.delete('threadTab');
    setParams(next, { replace: true, state: location.state });
  }, [discussion, preview, params, setParams, location.state]);
  useEffect(() => {
    if (blocked) setOpen(false);
  }, [blocked, setOpen]);

  const select = (id: string | null) => {
    const next = new URLSearchParams(params);
    next.delete('preview');
    next.delete('discussion');
    if (id) next.set('thread', id);
    else next.delete('thread');
    next.delete('threadTab');
    setParams(next, { state: location.state });
  };
  const changeTab = (next: 'threads' | 'activity') => {
    setTab(next);
    setOpen(true);
    if (next === 'activity' || preview || discussion) clearThread();
  };

  return (
    <>
      {open && !inline && (
        <div
          aria-hidden
          className="fixed inset-0 z-overlay bg-overlay backdrop-blur-[2px]"
          onClick={close}
        />
      )}
      <div
        ref={panelRef}
        hidden={!open}
        role={open ? (inline ? 'complementary' : 'dialog') : undefined}
        aria-label={tr('辅助面板')}
        aria-modal={!inline && open ? true : undefined}
        tabIndex={-1}
        className={cn(
          'chrome flex h-full min-h-0 shrink-0 flex-col border-l border-line outline-none',
          !open && 'hidden',
          inline
            ? 'relative w-(--panel-w)'
            : 'fixed inset-y-0 right-0 z-modal w-[min(var(--panel-w),100vw)] shadow-lg pb-[env(safe-area-inset-bottom)]',
        )}
      >
        <div className="flex h-(--topbar-h) shrink-0 items-center justify-between gap-2 border-b border-line px-3">
          {discussion ? (
            <h2 className="truncate px-1 text-h3 text-fg">{tr('团队讨论')}</h2>
          ) : preview ? (
            <h2 className="truncate px-1 text-h3 text-fg">
              {tr('{value}预览', { value: RESOURCE_LABEL[preview.type] })}
            </h2>
          ) : (
            <div
              role="tablist"
              aria-label={tr('辅助面板内容')}
              className="flex gap-1 rounded-md bg-muted/60 p-0.5"
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next =
                  event.key === 'Home'
                    ? 'threads'
                    : event.key === 'End'
                      ? 'activity'
                      : tab === 'threads'
                        ? 'activity'
                        : 'threads';
                changeTab(next);
                document.getElementById(`aux-tab-${next}`)?.focus();
              }}
            >
              {(
                [
                  { value: 'threads', label: tr('线程') },
                  { value: 'activity', label: tr('动态') },
                ] as const
              ).map((item) => (
                <button
                  key={item.value}
                  type="button"
                  role="tab"
                  id={`aux-tab-${item.value}`}
                  aria-controls={`aux-panel-${item.value}`}
                  aria-selected={tab === item.value}
                  tabIndex={tab === item.value ? 0 : -1}
                  onClick={() => changeTab(item.value)}
                  className={cn(
                    'h-7 rounded-sm px-3 text-small max-md:min-h-11',
                    tab === item.value
                      ? 'bg-surface font-medium text-fg shadow-xs'
                      : 'text-fg-muted hover:text-fg',
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
          <IconButton
            label={tr('关闭辅助面板')}
            size="sm"
            className="max-md:size-11"
            onClick={close}
          >
            <X strokeWidth={1.75} aria-hidden />
          </IconButton>
        </div>
        {open && discussion && (
          <DeferredPanel
            key={`${projectId}:discussion:${discussion}`}
            active
            load={loadDiscussion}
            componentProps={{ projectId, scope: discussion }}
          />
        )}
        {open && !discussion && preview && (
          <DeferredPanel
            key={`${projectId}:${preview.type}:${preview.id}`}
            active
            load={loadPreview}
            componentProps={{ projectId, resource: preview }}
          />
        )}
        <div
          id="aux-panel-threads"
          role="tabpanel"
          aria-labelledby="aux-tab-threads"
          hidden={tab !== 'threads'}
          className={cn(
            'min-h-0 flex-1 bg-surface',
            tab === 'threads' ? 'flex flex-col' : 'hidden',
          )}
        >
          <DeferredPanel
            active={open && tab === 'threads'}
            load={loadThreads}
            componentProps={{ projectId, selectedId, onSelect: select }}
          />
        </div>
        <div
          id="aux-panel-activity"
          role="tabpanel"
          aria-labelledby="aux-tab-activity"
          hidden={tab !== 'activity'}
          className={cn(
            'min-h-0 flex-1 bg-surface',
            tab === 'activity' ? 'flex flex-col' : 'hidden',
          )}
        >
          {open && tab === 'activity' && (
            <DeferredPanel active load={loadActivity} componentProps={{ projectId }} />
          )}
        </div>
      </div>
    </>
  );
}
