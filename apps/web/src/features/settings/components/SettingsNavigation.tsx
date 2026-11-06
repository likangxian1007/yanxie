import { useEffect, useRef } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { cn } from '@/lib/cn';
import { projectPath } from '@/components/layout/nav-items';
import { parseSettingsTab, SETTINGS_TAB_LABEL, type SettingsTab } from '../lib';
import { tr } from '@/lib/i18n';

const SETTINGS_GROUPS: { label: string; tabs: SettingsTab[] }[] = [
  { label: tr('个人'), tabs: ['profile', 'integrations', 'notify'] },
  { label: tr('课题'), tabs: ['general', 'members', 'invites', 'memory', 'versioning'] },
  {
    label: tr('智能体'),
    tabs: ['instructions', 'routines', 'models', 'mcp', 'skills', 'commands', 'agent-profiles'],
  },
];

/** 与内容独立滚动的设置目录，链接保留公开的 ?tab= 标识。 */
export function SettingsNavigation({
  projectId,
  className,
  onNavigate,
}: {
  projectId: string;
  className?: string;
  onNavigate?: () => void;
}) {
  const [params] = useSearchParams();
  const selected = parseSettingsTab(params.get('tab'));
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navRef.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  return (
    <div className={cn('chrome flex h-full min-h-0 flex-col', className)}>
      <Link
        to={projectPath(projectId, '')}
        onClick={onNavigate}
        className="flex h-(--topbar-h) shrink-0 items-center gap-2 border-b border-line px-5 text-small text-fg-muted hover:text-fg"
      >
        <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
        {tr('返回课题')}
      </Link>
      <nav
        ref={navRef}
        aria-label={tr('设置分区')}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-5"
        onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>('a')];
          const current = links.indexOf(event.target as HTMLAnchorElement);
          if (current < 0) return;
          event.preventDefault();
          const index =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? links.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
          links[index]?.focus();
        }}
      >
        {SETTINGS_GROUPS.map((group) => (
          <section key={group.label} aria-label={group.label} className="mb-6 last:mb-0">
            <h2 className="mb-2 px-2 text-caption text-fg-subtle">{group.label}</h2>
            <ul className="space-y-0.5">
              {group.tabs.map((tab) => (
                <li key={tab}>
                  <Link
                    to={`${projectPath(projectId, 'settings')}?tab=${tab}`}
                    aria-current={selected === tab ? 'page' : undefined}
                    onClick={onNavigate}
                    className={cn(
                      'flex min-h-8 items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-small max-md:min-h-11',
                      selected === tab
                        ? 'bg-muted font-medium text-fg'
                        : 'text-fg-muted hover:bg-muted/60 hover:text-fg',
                    )}
                  >
                    {SETTINGS_TAB_LABEL[tab]}
                    <ChevronRight size={14} aria-hidden className="text-fg-subtle md:hidden" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>
    </div>
  );
}
