import { useListQueryState, useListStateScope } from '@/lib/list-state';
import { useMediaQuery } from '@/lib/use-media-query';
import { useMemo, type KeyboardEvent } from 'react';
import { Link, useLocation } from 'react-router';
import { Archive, ChevronRight, CloudOff, Forward, Layers, Pin, Plus, Search } from 'lucide-react';
import type { AgentSession, Thread } from '@srh/shared';
import {
  AgentThinking,
  Badge,
  Button,
  IconButton,
  Input,
  RelativeTime,
  Skeleton,
  StatusDot,
  Tooltip,
} from '@/components/ui';
import { projectPath } from '@/components/layout/nav-items';
import { cn } from '@/lib/cn';
import { usePins } from '@/lib/pins';
import { isAgentBusy, useAgents } from '@/lib/project';
import { threadDisplay } from '@/lib/status';
import { ThreadActionsMenu } from '@/features/threads/components/ThreadActions';
import { useThreadContextMenu } from '@/features/threads/components/thread-actions';
import { LabelFilter } from '@/features/threads/components/LabelFilter';
import {
  collectLabels,
  groupByLabel,
  matchesLabel,
  sortThreads,
} from '@/features/threads/thread-utils';
import { useLocalPref } from '@/lib/local-pref';
import { paletteFromString } from '@/lib/palette';
import { tr } from '@/lib/i18n';

export interface SessionListProps {
  projectId: string;
  threads: Thread[] | undefined;
  isPending: boolean;
  error: Error | null;
  onRetry: () => void;
  /** 当前打开的会话 */
  activeId: string | undefined;
  /** 新建会话（跳到 ?new=1） */
  onNew: () => void;
  canCreate: boolean;
  /** 列表里最多几条显示“思考中”扫光（同屏循环动画 ≤ 3） */
  thinkingBudget: number;
  className?: string;
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-1 px-1" aria-label={tr('加载中')}>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex flex-col gap-2 rounded-md px-2.5 py-2.5">
          <div className="flex items-center gap-2">
            <Skeleton className="size-2 rounded-full" />
            <Skeleton className="h-3.5 flex-1" />
            <Skeleton className="h-3 w-10" />
          </div>
          {i % 2 === 0 && <Skeleton className="ml-4 h-3 w-24" />}
        </div>
      ))}
    </div>
  );
}

/** 列表上下键移动焦点（STYLE §8）。 */
function onListKeyDown(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const links = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('a[data-session]'));
  if (links.length === 0) return;
  e.preventDefault();
  const i = links.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === 'ArrowDown' ? (i + 1) % links.length : (i - 1 + links.length) % links.length;
  links[i === -1 ? 0 : next]?.focus();
}

interface RowProps {
  projectId: string;
  thread: Thread;
  agent: AgentSession | undefined;
  active: boolean;
  thinking: boolean;
  pinned: boolean;
  showLabel: boolean;
}

/** 一条会话：整行是链接；右键 / 「⋯」打开同一组操作。 */
function SessionRow({
  projectId,
  thread: t,
  agent,
  active,
  thinking,
  pinned,
  showLabel,
}: RowProps) {
  const { handlers, menu } = useThreadContextMenu(t, projectId);
  const location = useLocation();
  const sessionParams = new URLSearchParams(location.search);
  sessionParams.delete('new');
  const display = threadDisplay(t, agent);
  const showMeta = thinking || Boolean(t.forwardedAt) || (showLabel && Boolean(t.label));
  return (
    <li className="research-row group/row relative">
      <Link
        to={`${projectPath(projectId, `workspace/${t.id}`)}?${sessionParams}`}
        data-list-item={`session:${t.id}`}
        data-session
        aria-current={active ? 'page' : undefined}
        {...handlers}
        className={cn(
          'flex flex-col gap-1 rounded-md py-2 pr-9 pl-2.5 outline-offset-[-2px]',
          'transition-colors duration-(--dur-fast) ease-(--ease-standard)',
          active ? 'bg-accent-soft' : 'hover:bg-subtle',
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <StatusDot
            status={display.dot}
            label={display.label}
            // 列表里的状态点不放光环：循环动画留给“思考中”和右侧会话
            className="[&_.animate-pulse-ring]:hidden"
          />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-body',
              active ? 'font-medium text-fg' : 'text-fg',
              t.resolved && !active && 'text-fg-muted',
            )}
          >
            {t.title}
          </span>
          {pinned && (
            <Pin
              size={12}
              strokeWidth={1.75}
              aria-label={tr('已置顶')}
              className="shrink-0 text-fg-subtle"
            />
          )}
          <RelativeTime
            iso={t.lastActivityAt}
            className={cn(
              'shrink-0 text-caption font-normal text-fg-subtle',
              // 悬停时让位给「⋯」按钮
              'transition-opacity duration-(--dur-fast) group-focus-within/row:opacity-0 group-hover/row:opacity-0',
            )}
          />
        </span>
        {showMeta && (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-4">
            {thinking && (
              <AgentThinking
                label={agent?.activity ?? tr('个人 agent 正在回复')}
                className="max-w-full text-caption"
              />
            )}
            {showLabel && t.label && <Badge color={labelIndex(t.label)}>{t.label}</Badge>}
            {t.forwardedAt && (
              <Badge tone="agent" className="gap-1">
                <Forward size={12} strokeWidth={1.75} aria-hidden />
                {tr('已转给协调者')}
              </Badge>
            )}
          </span>
        )}
      </Link>
      <div
        className={cn(
          'absolute top-1.5 right-1.5',
          'opacity-0 transition-opacity duration-(--dur-fast) group-focus-within/row:opacity-100 group-hover/row:opacity-100',
          // 触屏没有悬停：一直显示
          '[@media(hover:none)]:opacity-100',
        )}
      >
        <ThreadActionsMenu thread={t} projectId={projectId} />
      </div>
      {menu}
    </li>
  );
}

const labelIndex = (label: string) => paletteFromString(label);

/**
 * 我的会话列表：标题、状态点、最近活动时间；agent 正在回复的会话显示一行“思考中”，
 * 已转给协调者的会话带一个小标记。置顶的排最前；可按标签筛选、按标签分组；
 * 归档（已解决）的收在最下面。桌面端是页面内 280px 的左栏，手机上就是首页本身。
 */
export function SessionList({
  projectId,
  threads,
  isPending,
  error,
  onRetry,
  activeId,
  onNew,
  canCreate,
  thinkingBudget,
  className,
}: SessionListProps) {
  const desktopList = useMediaQuery('(min-width: 1024px)');
  useListStateScope('workspace', {
    scrollElementId: desktopList ? 'workspace-list-scroll' : 'app-scroll',
    path: projectPath(projectId, 'workspace'),
  });
  const [query, setQuery] = useListQueryState('q', '');
  const [rawLabel, setLabel] = useListQueryState('label', '__all');
  const label = rawLabel === '__all' ? undefined : rawLabel;
  const [preferredGrouped, setPreferredGrouped] = useLocalPref('srh-sessions-grouped', false);
  const [groupedValue, setGroupedValue] = useListQueryState(
    'grouped',
    preferredGrouped ? '1' : '0',
  );
  const grouped = groupedValue === '1';
  const setGrouped = (value: boolean) => {
    setGroupedValue(value ? '1' : '0');
    setPreferredGrouped(value);
  };
  const [archivedValue, setShowArchivedValue] = useListQueryState('archived', '0');
  const showArchived = archivedValue === '1';
  const setShowArchived = (value: boolean) => setShowArchivedValue(value ? '1' : '0');
  const agents = useAgents(projectId);
  const pins = usePins(projectId);

  const labels = useMemo(() => collectLabels(threads ?? []), [threads]);
  // 标签被改没了，筛选自动回到全部
  const activeLabel =
    label !== undefined && label !== '' && !labels.includes(label) ? undefined : label;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (threads ?? []).filter(
      (t) =>
        matchesLabel(t, activeLabel) &&
        (!q ||
          t.title.toLowerCase().includes(q) ||
          t.statusText.toLowerCase().includes(q) ||
          (t.label ?? '').toLowerCase().includes(q)),
    );
    return sortThreads(list, pins);
  }, [threads, query, activeLabel, pins]);

  const open = useMemo(() => filtered.filter((t) => !t.resolved), [filtered]);
  const archived = useMemo(() => filtered.filter((t) => t.resolved), [filtered]);

  const agentById = useMemo(
    () => new Map((agents.data ?? []).map((a) => [a.id, a])),
    [agents.data],
  );

  // 只给最靠前的几个“进行中”会话扫光；正打开的那个在右侧已经有状态，不重复
  const thinkingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of open) {
      if (ids.size >= thinkingBudget) break;
      if (t.id === activeId) continue;
      const agent = t.agentSessionId ? agentById.get(t.agentSessionId) : undefined;
      if (t.statusBucket === 'working' || isAgentBusy(agent)) ids.add(t.id);
    }
    return ids;
  }, [open, thinkingBudget, activeId, agentById]);

  const pinSet = useMemo(() => new Set(pins), [pins]);
  const renderRows = (items: Thread[], showLabel: boolean) =>
    items.map((t) => (
      <SessionRow
        key={t.id}
        projectId={projectId}
        thread={t}
        agent={t.agentSessionId ? agentById.get(t.agentSessionId) : undefined}
        active={t.id === activeId}
        thinking={thinkingIds.has(t.id)}
        pinned={pinSet.has(t.id)}
        showLabel={showLabel}
      />
    ));

  // 打开的会话即使被归档，也保证展开归档区能看到它
  const archivedOpen = showArchived || archived.some((t) => t.id === activeId);
  const nothing = filtered.length === 0;
  const canGroup = labels.length > 0;

  return (
    <nav aria-label={tr('我的会话')} className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex shrink-0 flex-col gap-2 px-1 pb-3">
        {canCreate && (
          <Button
            variant="secondary"
            fullWidth
            leftIcon={<Plus strokeWidth={1.75} aria-hidden />}
            onClick={onNew}
          >
            {tr('新建会话')}
          </Button>
        )}
        <Input
          size="sm"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tr('搜索会话')}
          aria-label={tr('搜索我的会话')}
          leading={<Search strokeWidth={1.75} aria-hidden />}
        />
        {labels.length > 0 && (
          <LabelFilter
            labels={labels}
            value={activeLabel}
            onChange={(value) => setLabel(value ?? '__all')}
            counts={threads ?? []}
            size="sm"
          />
        )}
      </div>

      <div className="flex items-center justify-between px-3 pb-1.5 text-caption text-fg-subtle">
        <h2>{tr('我的会话')}</h2>
        <span className="flex items-center gap-1">
          {threads && threads.length > 0 && (
            <span className="font-normal tabular-nums">{threads.length}</span>
          )}
          {canGroup && (
            <Tooltip content={grouped ? tr('取消按标签分组') : tr('按标签分组')}>
              <IconButton
                size="sm"
                label={tr('按标签分组')}
                aria-pressed={grouped}
                onClick={() => setGrouped(!grouped)}
                className={cn('-my-1 size-6', grouped && 'bg-subtle text-fg')}
              >
                <Layers strokeWidth={1.75} />
              </IconButton>
            </Tooltip>
          )}
        </span>
      </div>

      {isPending ? (
        <ListSkeleton />
      ) : error ? (
        <div className="mx-1 flex flex-col items-center gap-2 rounded-lg border border-line bg-surface px-3 py-6 text-center">
          <CloudOff size={20} strokeWidth={1.75} aria-hidden className="text-fg-subtle" />
          <p className="text-small text-fg">{tr('会话列表没加载出来')}</p>
          <p className="text-caption font-normal text-fg-muted">{error.message}</p>
          <Button size="sm" onClick={onRetry}>
            {tr('重试')}
          </Button>
        </div>
      ) : nothing ? (
        <p className="px-3 py-6 text-center text-small text-fg-muted">
          {query.trim()
            ? tr('没有找到和「{query}」有关的会话', { query: query.trim() })
            : activeLabel !== undefined
              ? tr('这个标签下还没有会话')
              : tr('还没有会话')}
        </p>
      ) : (
        <div className="flex flex-col gap-3" onKeyDown={onListKeyDown}>
          {grouped && canGroup ? (
            groupByLabel(open).map((g) => (
              <section key={g.label ?? '__none'} aria-label={g.label ?? tr('未加标签')}>
                <h3 className="flex items-center gap-1.5 px-3 pb-1 text-caption text-fg-muted">
                  {g.label ? (
                    <span
                      aria-hidden
                      className="size-2 rounded-full"
                      style={{ background: `var(--palette-${labelIndex(g.label)})` }}
                    />
                  ) : null}
                  {g.label ?? tr('未加标签')}
                  <span className="font-normal text-fg-subtle tabular-nums">{g.items.length}</span>
                </h3>
                <ul className="flex flex-col gap-0.5">{renderRows(g.items, false)}</ul>
              </section>
            ))
          ) : (
            <ul className="flex flex-col gap-0.5">{renderRows(open, true)}</ul>
          )}

          {archived.length > 0 && (
            <section aria-label={tr('已归档')}>
              <button
                type="button"
                aria-expanded={archivedOpen}
                onClick={() => setShowArchived(!archivedOpen)}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-caption text-fg-muted',
                  'transition-colors duration-(--dur-fast) ease-(--ease-standard) hover:bg-subtle hover:text-fg',
                )}
              >
                <ChevronRight
                  size={14}
                  strokeWidth={1.75}
                  aria-hidden
                  className={cn(
                    'transition-transform duration-(--dur-fast) ease-(--ease-standard)',
                    archivedOpen && 'rotate-90',
                  )}
                />
                <Archive size={13} strokeWidth={1.75} aria-hidden />
                {tr('已归档')}
                <span className="font-normal text-fg-subtle tabular-nums">{archived.length}</span>
              </button>
              {archivedOpen && (
                <ul className="mt-0.5 flex flex-col gap-0.5">{renderRows(archived, true)}</ul>
              )}
            </section>
          )}
        </div>
      )}
    </nav>
  );
}
