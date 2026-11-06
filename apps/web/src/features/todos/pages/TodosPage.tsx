import { ListToolbar } from '@/components/layout/ListToolbar';
import { useListQueryState, useListStateScope } from '@/lib/list-state';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  CheckCheck,
  ChevronDown,
  ListTodo,
  RotateCw,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import type { Todo } from '@srh/shared';
import { Button, EmptyState, Input, Skeleton, Tabs } from '@/components/ui';
import { Page, PageTitle } from '@/components/layout/Page';
import { ApiRequestError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { canWrite, useMyRole, useProjectId } from '@/lib/project';
import { useMeUser } from '@/lib/session';
import { QuickAdd } from '../components/QuickAdd';
import { TodoList } from '../components/TodoList';
import { useTodoActions, useTodoRealtime, useTodos } from '../data';
import {
  activeTodos,
  completedTodos,
  groupByDue,
  isMine,
  type TodoGrouping,
  type TodoTab,
} from '../lib/todo-list';
import { tr } from '@/lib/i18n';

/** 已完成分组在“全部 / 我的”底部最多显示几条 */
const DONE_PREVIEW = 5;

/** 待办：全部 / 我的 / 已完成；快速添加；拖动排序或按截止日期分组；?todo= 高亮 */
export function TodosPage() {
  const pid = useProjectId();
  useListStateScope('todos');
  const me = useMeUser();
  const meId = me?.id ?? null;
  const writable = canWrite(useMyRole(pid));
  const [params] = useSearchParams();
  const highlightId = params.get('todo');
  const query = useTodos(pid);
  const actions = useTodoActions(pid);
  const { reduced } = useMotionPreset();
  useTodoRealtime(pid);

  const todos = useMemo(() => query.data ?? [], [query.data]);
  const target = highlightId ? todos.find((t) => t.id === highlightId) : undefined;
  const [rawTab, setTabChoice] = useListQueryState('tab', '');
  const tabChoice: TodoTab | null = ['all', 'mine', 'done'].includes(rawTab)
    ? (rawTab as TodoTab)
    : null;
  const tab: TodoTab = tabChoice ?? (target?.done ? 'done' : 'all');
  const [rawGrouping, setGrouping] = useListQueryState('grouping', 'order');
  const grouping: TodoGrouping = rawGrouping === 'due' ? 'due' : 'order';
  const [search, setSearch] = useListQueryState('q', '');
  const searched = todos.filter(
    (todo) =>
      !search.trim() ||
      `${todo.title} ${todo.notes}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const [doneOpen, setDoneOpen] = useState(true);
  const [completing, setCompleting] = useState<ReadonlySet<string>>(new Set());

  const counts = useMemo(
    () => ({
      all: todos.filter((t) => !t.done).length,
      mine: todos.filter((t) => !t.done && isMine(t, meId)).length,
      done: todos.filter((t) => t.done).length,
    }),
    [todos, meId],
  );

  const toggle = (todo: Todo) => {
    const done = !todo.done;
    if (done) {
      setCompleting((s) => new Set(s).add(todo.id));
      window.setTimeout(
        () =>
          setCompleting((s) => {
            const next = new Set(s);
            next.delete(todo.id);
            return next;
          }),
        reduced ? 240 : 720,
      );
    }
    void actions.updateTodo(todo.id, { done });
  };

  const rowProps = { pid, writable, actions, onToggle: toggle, completing, highlightId };

  const header = <PageTitle>{tr('待办')}</PageTitle>;

  if (query.isLoading) {
    return (
      <Page width="feed">
        {header}
        <div aria-busy="true" aria-label={tr('正在加载待办')} className="flex flex-col gap-3">
          <Skeleton className="h-24 rounded-xl" />
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3 px-2 py-1.5">
              <Skeleton className="size-4.5 rounded-xs" />
              <Skeleton className={cn('h-4', i % 2 ? 'w-1/2' : 'w-2/3')} />
            </div>
          ))}
        </div>
      </Page>
    );
  }

  if (query.isError) {
    return (
      <Page width="feed">
        {header}
        <EmptyState
          framed
          icon={TriangleAlert}
          title={tr('待办没能加载')}
          description={
            query.error instanceof ApiRequestError
              ? query.error.message
              : tr('出了点问题，请稍后再试。')
          }
          action={
            <Button
              leftIcon={<RotateCw strokeWidth={1.75} aria-hidden />}
              onClick={() => void query.refetch()}
            >
              {tr('重新加载')}
            </Button>
          }
        />
      </Page>
    );
  }

  const active = tab === 'done' ? [] : activeTodos(searched, tab, meId, completing);
  const done = completedTodos(searched, meId, tab === 'mine');
  const sortable = writable && grouping === 'order' && tab !== 'done' && !search.trim();

  let main;
  if (tab === 'done') {
    main =
      done.length === 0 ? (
        <EmptyState
          icon={CheckCheck}
          title={tr('还没有完成的待办')}
          description={tr('勾选完成的待办会移到这里，方便回顾这段时间做了什么。')}
        />
      ) : (
        <TodoList {...rowProps} todos={done} sortable={false} label={tr('已完成的待办')} />
      );
  } else if (active.length === 0) {
    main = (
      <EmptyState
        icon={tab === 'mine' ? UserRound : ListTodo}
        title={
          counts.done > 0 && tab === 'all'
            ? tr('都完成了')
            : tab === 'mine'
              ? tr('没有指派给你的待办')
              : tr('还没有待办')
        }
        description={
          writable
            ? tr('在上面输入一条待办并回车；也可以让协调者从组会汇报、线程结论里拆出待办。')
            : tr('有编辑权限的成员添加待办后，会出现在这里。')
        }
      />
    );
  } else if (grouping === 'due') {
    main = (
      <div className="flex flex-col gap-5">
        {groupByDue(active).map((g) => (
          <section key={g.key} aria-label={g.label}>
            <h3
              className={cn(
                'mb-1 px-2 text-caption',
                g.key === 'overdue' ? 'text-danger' : 'text-fg-subtle',
              )}
            >
              {g.label} · {g.todos.length}
            </h3>
            <TodoList {...rowProps} todos={g.todos} sortable={false} label={g.label} />
          </section>
        ))}
      </div>
    );
  } else {
    main = <TodoList {...rowProps} todos={active} sortable={sortable} label={tr('进行中的待办')} />;
  }

  return (
    <Page width="feed">
      {header}

      {writable && (
        <div className="mb-5">
          <QuickAdd
            pid={pid}
            onCreate={async (input) => Boolean(await actions.createTodo(input))}
          />
        </div>
      )}

      <ListToolbar
        className="mb-4"
        search={
          <Input
            type="search"
            aria-label={tr('搜索待办')}
            placeholder={tr('搜索待办')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
        filters={
          <Tabs
            className="min-w-0"
            layoutId="todo-tabs"
            aria-label={tr('待办范围')}
            value={tab}
            onValueChange={setTabChoice}
            items={[
              { value: 'all', label: tr('全部'), count: counts.all },
              { value: 'mine', label: tr('我的'), count: counts.mine },
              { value: 'done', label: tr('已完成'), count: counts.done },
            ]}
          />
        }
        view={
          tab !== 'done' ? (
            <Tabs
              variant="segmented"
              size="sm"
              layoutId="todo-grouping"
              aria-label={tr('排列方式')}
              className="mb-1.5"
              value={grouping}
              onValueChange={setGrouping}
              items={[
                { value: 'order', label: tr('按顺序') },
                { value: 'due', label: tr('按日期') },
              ]}
            />
          ) : undefined
        }
        activeFilterCount={Number(tab !== 'all')}
      />

      {main}

      {tab !== 'done' && done.length > 0 && (
        <section aria-label={tr('已完成')} className="mt-6 border-t border-line pt-3">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={doneOpen}
            onClick={() => setDoneOpen((v) => !v)}
            className="text-caption text-fg-subtle"
            leftIcon={
              <ChevronDown
                strokeWidth={1.75}
                aria-hidden
                className={cn(
                  'transition-transform duration-(--dur-fast) ease-(--ease-standard)',
                  !doneOpen && '-rotate-90',
                )}
              />
            }
          >
            {tr('已完成 · {count}', { count: done.length })}
          </Button>
          {doneOpen && (
            <>
              <TodoList
                {...rowProps}
                todos={done.filter((t) => !completing.has(t.id)).slice(0, DONE_PREVIEW)}
                sortable={false}
                label={tr('最近完成的待办')}
              />
              {done.length > DONE_PREVIEW && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1"
                  onClick={() => setTabChoice('done')}
                >
                  {tr('查看全部已完成')}
                </Button>
              )}
            </>
          )}
        </section>
      )}
    </Page>
  );
}
