import { Link, useSearchParams } from 'react-router';
import { cn } from '@/lib/cn';
import { ResearchWorkspacesPage } from './ResearchListPage';
import { ResearchSourcesPage } from './ResearchSourcesPage';
import { tr } from '@/lib/i18n';
export function ResearchHomePage() {
  const [params] = useSearchParams();
  const sources = params.get('view') === 'sources';
  return (
    <>
      <nav aria-label={tr('研究空间视图')} className="flex gap-2 px-4 pt-4 md:px-8">
        {(['workspaces', 'sources'] as const).map((view) => {
          const next = new URLSearchParams();
          next.set('view', view);
          return (
            <Link
              key={view}
              to={`?${next}`}
              aria-current={(view === 'sources') === sources ? 'page' : undefined}
              className={cn(
                'inline-flex min-h-11 items-center rounded-md px-3 py-2 text-small',
                (view === 'sources') === sources
                  ? 'bg-accent-soft text-accent-text'
                  : 'text-fg-muted hover:bg-subtle',
              )}
            >
              {view === 'sources' ? tr('研究资料') : tr('工作空间')}
            </Link>
          );
        })}
      </nav>
      {sources ? <ResearchSourcesPage /> : <ResearchWorkspacesPage />}
    </>
  );
}
