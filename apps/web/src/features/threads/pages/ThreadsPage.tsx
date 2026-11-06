import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { AnimatePresence, LayoutGroup, motion, type Variants } from 'motion/react';
import {
  LayoutList,
  ListTree,
  MessagesSquare,
  Search,
  SearchX,
  SquareKanban,
  X,
} from 'lucide-react';
import type { AgentSession, ProjectMember, Thread } from '@srh/shared';
import { Button, EmptyState, IconButton, Input, Select, Switch, Tabs } from '@/components/ui';
import { Page, PageActions } from '@/components/layout/Page';
import { projectPath } from '@/components/layout/nav-items';
import { cn } from '@/lib/cn';
import { useMotionPreset } from '@/lib/motion';
import { useLocalPref } from '@/lib/local-pref';
import { paletteFromString, paletteVar } from '@/lib/palette';
import { usePins } from '@/lib/pins';
import { useAgents, useMemberMap, useProjectId, useThreads } from '@/lib/project';
import { STATUS_DOT_CLASS } from '@/lib/status';
import { ThreadCard } from '../components/ThreadCard';
import { ErrorCard, LinkButton, ThreadCardSkeleton } from '../components/ThreadStates';
import {
  BOARD_COLUMNS,
  BUCKET_TABS,
  collectLabels,
  countByBucket,
  groupByLabel,
  isBucketTab,
  sortThreads,
  threadsInBucket,
  type BucketTab,
  type ThreadFilter,
} from '../thread-utils';
import { tr } from '@/lib/i18n';

type ViewMode = 'list' | 'board';

const EMPTY: Thread[] = [];
const scrollPositions = new Map<string, number>();

interface CardContext {
  pid: string;
  listHref: string;
  members: Map<string, ProjectMember>;
  agents: Map<string, AgentSession>;
  pins: readonly string[];
  /** 允许循环动画的线程（同屏 ≤ 3：只给最靠前的一个工作中线程） */
  animatedId: string | null;
}

function cardProps(t: Thread, ctx: CardContext) {
  const member = t.ownerUserId ? ctx.members.get(t.ownerUserId) : undefined;
  const agent =
    (t.agentSessionId ? ctx.agents.get(t.agentSessionId) : undefined) ??
    [...ctx.agents.values()].find((a) => a.threadId === t.id);
  return {
    thread: t,
    href: `${ctx.listHref}${ctx.listHref.includes('?') ? '&' : '?'}thread=${encodeURIComponent(t.id)}`,
    fullHref: projectPath(ctx.pid, `threads/${t.id}`),
    returnHref: ctx.listHref,
    owner: member ? { name: member.user.name, color: member.user.avatarColor } : null,
    activity: agent?.activity ?? null,
    agent: agent ?? null,
    animate: t.id === ctx.animatedId,
    pinned: ctx.pins.includes(t.id),
    projectId: ctx.pid,
  };
}

function useItemVariants(): Variants {
  const { variants } = useMotionPreset();
  return useMemo(
    () => ({
      hidden: variants.fadeUp.hidden ?? {},
      visible: variants.fadeUp.visible ?? {},
      exit: variants.fadeIn.exit ?? {},
    }),
    [variants],
  );
}

function ThreadList({ threads, ctx }: { threads: Thread[]; ctx: CardContext }) {
  const { stagger, spring } = useMotionPreset();
  const item = useItemVariants();
  const list = useMemo(() => stagger(), [stagger]);
  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface">
      <div
        aria-hidden
        className="hidden grid-cols-[minmax(0,1fr)_112px_112px_80px_60px] gap-4 border-b border-line bg-subtle/50 px-4 py-2 text-caption font-normal text-fg-subtle sm:grid"
      >
        <span>{tr('标题')}</span>
        <span>{tr('状态')}</span>
        <span>{tr('负责人')}</span>
        <span>{tr('更新')}</span>
        <span />
      </div>
      <motion.ul
        variants={list}
        initial="hidden"
        animate="visible"
        className="divide-y divide-line"
        aria-label={tr('线程列表')}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {threads.map((t) => (
            <motion.li
              key={t.id}
              layout="position"
              transition={spring.gentle}
              variants={item}
              exit="exit"
              className="min-w-0"
            >
              <ThreadCard {...cardProps(t, ctx)} />
            </motion.li>
          ))}
        </AnimatePresence>
      </motion.ul>
    </div>
  );
}

function ThreadBoard({
  threads,
  filter,
  ctx,
}: {
  threads: Thread[];
  filter: ThreadFilter;
  ctx: CardContext;
}) {
  const { stagger, spring } = useMotionPreset();
  const item = useItemVariants();
  const list = useMemo(() => stagger(), [stagger]);
  return (
    <LayoutGroup id="threads-board">
      <div
        className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-4 md:-mx-6 md:px-6 lg:mx-0 lg:snap-none lg:px-0"
        role="list"
        aria-label={tr('线程看板')}
      >
        {BOARD_COLUMNS.map((col) => {
          const items = threadsInBucket(threads, col.value, filter);
          return (
            <section
              key={col.value}
              role="listitem"
              aria-label={tr('{label} {count} 个', { label: col.label, count: items.length })}
              className="flex w-[min(280px,calc(100vw-4rem))] shrink-0 snap-start flex-col rounded-lg bg-subtle/60 p-2 ring-1 ring-line lg:w-auto lg:min-w-[240px] lg:flex-1 lg:shrink"
            >
              <header className="flex items-center gap-2 px-1.5 pt-1 pb-2">
                <span
                  aria-hidden
                  className={cn('size-2 rounded-full', STATUS_DOT_CLASS[col.value])}
                />
                <h2 className="text-caption text-fg-muted">{col.label}</h2>
                <span className="ml-auto text-caption font-normal text-fg-subtle tabular-nums">
                  {items.length}
                </span>
              </header>
              <motion.ul
                variants={list}
                initial="hidden"
                animate="visible"
                className="flex min-h-16 flex-col gap-2"
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  {items.map((t) => (
                    <motion.li
                      key={t.id}
                      layoutId={`board-${t.id}`}
                      transition={spring.gentle}
                      variants={item}
                      exit="exit"
                      className="min-w-0"
                    >
                      <ThreadCard {...cardProps(t, ctx)} density="compact" />
                    </motion.li>
                  ))}
                </AnimatePresence>
                {items.length === 0 && (
                  <li className="rounded-md border border-dashed border-line px-3 py-6 text-center text-caption font-normal text-fg-subtle">
                    {tr('暂无')}
                  </li>
                )}
              </motion.ul>
            </section>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

/** 线程列表：协调者拆出来的每一项工作，按状态分组，列表或看板两种看法。 */
export function ThreadsPage() {
  const pid = useProjectId();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: BucketTab = isBucketTab(tabParam) ? tabParam : 'all';
  const view: ViewMode = params.get('view') === 'board' ? 'board' : 'list';
  const query = params.get('q') ?? '';
  const showResolved = params.get('resolved') === '1';
  const labelParam = params.get('label');
  const [grouped, setGrouped] = useLocalPref('srh-threads-grouped', false);
  const { variants } = useMotionPreset();

  const threadsQuery = useThreads(pid, { kind: 'project' });
  const agentsQuery = useAgents(pid);
  const members = useMemberMap(pid);
  const pins = usePins(pid);

  const all = threadsQuery.data ?? EMPTY;
  // 只列当前范围里（是否含已解决）用得上的标签，避免出现计数为 0 的胶囊
  const scope = useMemo(
    () => all.filter((t) => t.kind === 'project' && (showResolved || !t.resolved)),
    [all, showResolved],
  );
  const labels = useMemo(() => collectLabels(scope), [scope]);
  // 链接里的标签已经没人用了，就当没筛
  const label =
    labelParam === null || (labelParam !== '' && !labels.includes(labelParam))
      ? undefined
      : labelParam;
  const filter = useMemo<ThreadFilter>(
    () => ({ query, showResolved, label }),
    [query, showResolved, label],
  );
  const sorted = useMemo(() => sortThreads(all, pins), [all, pins]);
  const counts = useMemo(() => countByBucket(sorted, filter), [sorted, filter]);
  const visible = useMemo(() => threadsInBucket(sorted, tab, filter), [sorted, tab, filter]);
  const agents = useMemo(
    () => new Map((agentsQuery.data ?? []).map((a) => [a.id, a])),
    [agentsQuery.data],
  );
  const onScreen = view === 'board' ? threadsInBucket(sorted, 'working', filter) : visible;
  const animatedId = onScreen.find((t) => t.statusBucket === 'working')?.id ?? null;
  const listParams = new URLSearchParams(params);
  listParams.delete('thread');
  listParams.delete('threadTab');
  const listHref = `${projectPath(pid, 'threads')}${listParams.size ? `?${listParams}` : ''}`;
  const ctx: CardContext = { pid, listHref, members, agents, pins, animatedId };
  const scrollKey = useRef(listHref);
  useLayoutEffect(() => {
    scrollKey.current = listHref;
  }, [listHref]);
  useLayoutEffect(() => {
    const scroller = document.getElementById('app-scroll');
    if (scroller && threadsQuery.data) scroller.scrollTop = scrollPositions.get(listHref) ?? 0;
    // 仅列表重新挂载或数据首次就绪时恢复；打开辅助面板不影响列表位置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(threadsQuery.data)]);
  useEffect(() => {
    const scroller = document.getElementById('app-scroll');
    const remember = () => scrollPositions.set(scrollKey.current, scroller?.scrollTop ?? 0);
    scroller?.addEventListener('scroll', remember, { passive: true });
    return () => {
      remember();
      scroller?.removeEventListener('scroll', remember);
    };
  }, []);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const setQuery = (value: string) => setParam('q', value || null);
  const setShowResolved = (value: boolean) => setParam('resolved', value ? '1' : null);

  const hasAny = all.some((t) => t.kind === 'project');
  const hiddenResolved =
    !showResolved && tab !== 'completed' && view === 'list'
      ? threadsInBucket(sorted, tab, { query, showResolved: true, label }).length - visible.length
      : 0;

  let bodyKey: string;
  let body: ReactNode;
  if (threadsQuery.isError && !threadsQuery.data) {
    bodyKey = 'error';
    body = (
      <ErrorCard
        title={tr('线程没加载出来')}
        message={threadsQuery.error.message}
        retrying={threadsQuery.isFetching}
        onRetry={() => void threadsQuery.refetch()}
      />
    );
  } else if (!threadsQuery.data) {
    bodyKey = 'loading';
    body = (
      <div className="flex flex-col gap-3" aria-label={tr('加载中')} aria-busy="true">
        {[0, 1, 2].map((i) => (
          <ThreadCardSkeleton key={i} />
        ))}
      </div>
    );
  } else if (!hasAny) {
    bodyKey = 'empty';
    body = (
      <EmptyState
        framed
        icon={ListTree}
        title={tr('还没有线程')}
        description={tr('从协作台开始一项工作。')}
        action={
          <LinkButton
            to={projectPath(pid, '')}
            variant="primary"
            leftIcon={<MessagesSquare strokeWidth={1.75} aria-hidden />}
          >
            {tr('去协作台提需求')}
          </LinkButton>
        }
      />
    );
  } else if (view === 'board') {
    bodyKey = 'board';
    body = <ThreadBoard threads={sorted} filter={filter} ctx={ctx} />;
  } else if (visible.length === 0) {
    bodyKey = `empty-${tab}`;
    body = (
      <EmptyState
        framed
        icon={SearchX}
        title={
          query.trim()
            ? tr('没有找到和「{query}」相关的线程', { query: query.trim() })
            : tr('这一组里没有线程')
        }
        description={
          hiddenResolved > 0
            ? tr('有 {hiddenResolved} 个已解决的线程被隐藏了，打开「显示已解决」可以看到。', {
                hiddenResolved,
              })
            : tr('换个分组或关键词看看。')
        }
        action={
          query.trim() ? (
            <Button size="sm" onClick={() => setQuery('')}>
              {tr('清空搜索')}
            </Button>
          ) : hiddenResolved > 0 ? (
            <Button size="sm" onClick={() => setShowResolved(true)}>
              {tr('显示已解决')}
            </Button>
          ) : (
            <Button size="sm" onClick={() => setParam('tab', null)}>
              {tr('查看全部')}
            </Button>
          )
        }
      />
    );
  } else {
    bodyKey = 'list';
    body =
      grouped && labels.length > 0 ? (
        <div className="flex flex-col gap-6">
          {groupByLabel(visible).map((g) => (
            <section key={g.label ?? '__none'} aria-label={g.label ?? tr('未加标签')}>
              <h2 className="mb-2 flex items-center gap-2 text-caption text-fg-muted">
                {g.label && (
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ background: paletteVar(paletteFromString(g.label)) }}
                  />
                )}
                {g.label ?? tr('未加标签')}
                <span className="font-normal text-fg-subtle tabular-nums">{g.items.length}</span>
              </h2>
              <ThreadList threads={g.items} ctx={ctx} />
            </section>
          ))}
        </div>
      ) : (
        <ThreadList threads={visible} ctx={ctx} />
      );
  }

  return (
    <Page width="full">
      <PageActions>
        <LinkButton
          to={projectPath(pid, '')}
          leftIcon={<MessagesSquare strokeWidth={1.75} aria-hidden />}
        >
          {tr('去协作台')}
        </LinkButton>
      </PageActions>

      <div className={cn('mb-4 flex flex-wrap items-center gap-2')}>
        <Input
          type="search"
          size="sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tr('搜索标题或标签')}
          aria-label={tr('搜索线程')}
          leading={<Search strokeWidth={1.75} aria-hidden />}
          trailing={
            query ? (
              <IconButton
                label={tr('清空搜索')}
                size="sm"
                className="size-6"
                onClick={() => setQuery('')}
              >
                <X strokeWidth={1.75} aria-hidden />
              </IconButton>
            ) : undefined
          }
          wrapperClassName="w-full sm:w-56"
          className="[&::-webkit-search-cancel-button]:hidden"
        />
        <Select
          size="sm"
          aria-label={tr('按状态筛选线程')}
          value={tab}
          onChange={(e) => setParam('tab', e.target.value === 'all' ? null : e.target.value)}
          wrapperClassName="w-auto min-w-28"
          options={BUCKET_TABS.map((t) => ({
            value: t.value,
            label: `${t.label}${threadsQuery.data ? ` · ${counts[t.value]}` : ''}`,
          }))}
        />
        {labels.length > 0 && (
          <Select
            size="sm"
            aria-label={tr('按标签筛选')}
            value={label === undefined ? '__all' : label}
            onChange={(e) => setParam('label', e.target.value === '__all' ? null : e.target.value)}
            wrapperClassName="w-auto max-w-40"
            options={[
              { value: '__all', label: tr('全部标签') },
              ...labels.map((l) => ({ value: l, label: l })),
              { value: '', label: tr('未加标签') },
            ]}
          />
        )}
        <label className="inline-flex cursor-pointer items-center gap-2 text-small text-fg-muted select-none">
          <Switch
            checked={showResolved}
            onCheckedChange={setShowResolved}
            label={tr('显示已解决')}
          />
          <span aria-hidden>{tr('显示已解决')}</span>
        </label>
        {view === 'list' && labels.length > 0 && (
          <label className="inline-flex cursor-pointer items-center gap-2 text-small text-fg-muted select-none">
            <Switch checked={grouped} onCheckedChange={setGrouped} label={tr('按标签分组')} />
            <span aria-hidden>{tr('按标签分组')}</span>
          </label>
        )}
        <Tabs<ViewMode>
          variant="segmented"
          size="sm"
          value={view}
          onValueChange={(v) => setParam('view', v === 'list' ? null : v)}
          aria-label={tr('切换视图')}
          layoutId="threads-view-toggle"
          className="ml-auto"
          items={[
            {
              value: 'list',
              label: tr('列表'),
              icon: <LayoutList strokeWidth={1.75} aria-hidden />,
            },
            {
              value: 'board',
              label: tr('看板'),
              icon: <SquareKanban strokeWidth={1.75} aria-hidden />,
            },
          ]}
        />
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={bodyKey}
          variants={variants.fadeIn}
          initial="hidden"
          animate="visible"
          exit="exit"
          className="min-w-0"
        >
          {body}
        </motion.div>
      </AnimatePresence>
    </Page>
  );
}
