import { Link, useSearchParams } from 'react-router';
import { BoardPage } from '@/features/board/pages/BoardPage';
import { TodosPage } from '@/features/todos/pages/TodosPage';
import { cn } from '@/lib/cn';
import { tr } from '@/lib/i18n';

export function TasksPage() {
  const [params] = useSearchParams();
  const todos = params.get('view') === 'todos';
  return (
    <>
      <nav aria-label={tr('任务视图')} className="flex gap-2 px-4 pt-4 md:px-8">
        {(['board', 'todos'] as const).map((view) => {
          const next = new URLSearchParams(params);
          next.set('view', view);
          return (
            <Link
              key={view}
              to={`?${next}`}
              aria-current={(view === 'todos') === todos ? 'page' : undefined}
              className={cn(
                'inline-flex min-h-11 items-center rounded-md px-3 py-2 text-small',
                (view === 'todos') === todos
                  ? 'bg-accent-soft text-accent-text'
                  : 'text-fg-muted hover:bg-subtle',
              )}
            >
              {view === 'todos' ? tr('待办') : tr('看板')}
            </Link>
          );
        })}
      </nav>
      {todos ? <TodosPage /> : <BoardPage />}
    </>
  );
}
