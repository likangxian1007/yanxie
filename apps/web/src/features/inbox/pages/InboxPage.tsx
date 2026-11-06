import { ListToolbar } from '@/components/layout/ListToolbar';
import { useListQueryState, useListStateScope } from '@/lib/list-state';
import { useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion, type Variants } from 'motion/react';
import { CheckCheck, CircleCheck, Inbox, ListFilter, RotateCw, TriangleAlert } from 'lucide-react';
import type { InboxItem, InboxKind } from '@srh/shared';
import { Badge, Button, Card, EmptyState, Input, Tabs, toast } from '@/components/ui';
import { Page, PageTitle, PageActions } from '@/components/layout/Page';
import { useMotionPreset } from '@/lib/motion';
import { useProjectId } from '@/lib/project';
import { InboxFilterBar } from '../components/InboxFilterBar';
import { InboxRow, type InboxRowMode } from '../components/InboxRow';
import { InboxSkeleton } from '../components/InboxSkeleton';
import { inboxQueryOptions, sortDone, sortPending } from '../inbox-api';
import { INBOX_KIND_META, type InboxFilter } from '../kind-meta';
import { useInboxPatch, useMarkAllRead } from '../use-inbox-mutations';
import { tr } from '@/lib/i18n';

type InboxTab = InboxRowMode;

const EMPTY: InboxItem[] = [];

function countByKind(items: InboxItem[]): Record<InboxKind, number> {
  const counts: Record<InboxKind, number> = {
    decision: 0,
    review: 0,
    conflict: 0,
    mention: 0,
    assignment: 0,
    recheck: 0,
    finished: 0,
  };
  for (const item of items) counts[item.kind] += 1;
  return counts;
}

/** 待我处理：决策、审阅、@、冲突预警、指派，按优先级排好，处理完标为完成。 */
export function InboxPage() {
  const pid = useProjectId();
  useListStateScope('inbox');
  const [rawTab, setTab] = useListQueryState('tab', 'pending');
  const tab: InboxTab = rawTab === 'done' ? 'done' : 'pending';
  const [rawFilter, setFilter] = useListQueryState('kind', 'all');
  const filter: InboxFilter = rawFilter in INBOX_KIND_META ? (rawFilter as InboxFilter) : 'all';
  const [search, setSearch] = useListQueryState('q', '');
  const listRef = useRef<HTMLUListElement>(null);
  const { variants, stagger } = useMotionPreset();

  const pending = useQuery({ ...inboxQueryOptions(pid, false), select: sortPending });
  const done = useQuery({
    ...inboxQueryOptions(pid, true),
    select: sortDone,
    // 已完成列表打开过一次才拉取
    enabled: Boolean(pid) && tab === 'done',
  });
  const current = tab === 'pending' ? pending : done;

  const patchItem = useInboxPatch(pid);
  const markAllRead = useMarkAllRead(pid);

  const pendingItems = pending.data ?? EMPTY;
  const items = current.data ?? EMPTY;
  const counts = useMemo(() => countByKind(items), [items]);
  const visible = useMemo(
    () =>
      items.filter(
        (item) =>
          (filter === 'all' || item.kind === filter) &&
          (!search.trim() || item.title.toLowerCase().includes(search.trim().toLowerCase())),
      ),
    [items, filter, search],
  );
  const unread = useMemo(() => pendingItems.filter((x) => x.readAt === null), [pendingItems]);

  const listVariants = useMemo(() => stagger(), [stagger]);
  const rowVariants = useMemo<Variants>(
    () => ({
      hidden: variants.fadeUp.hidden ?? {},
      visible: variants.fadeUp.visible ?? {},
      exit: variants.slideInRight.exit ?? {},
    }),
    [variants],
  );

  // ------------------------------------------------------------ 操作

  const focusRow = (id: string | undefined) => {
    if (!id) return;
    listRef.current?.querySelector<HTMLElement>(`[data-inbox-row="${CSS.escape(id)}"]`)?.focus();
  };

  /** 条目即将离开列表时，如果焦点在它身上，先把焦点交给相邻的条目。 */
  const handOffFocus = (item: InboxItem) => {
    const holder = listRef.current?.querySelector(`[data-inbox-item="${CSS.escape(item.id)}"]`);
    if (!holder || !holder.contains(document.activeElement)) return;
    const idx = visible.findIndex((x) => x.id === item.id);
    focusRow((visible[idx + 1] ?? visible[idx - 1])?.id);
  };

  const openItem = (item: InboxItem) => {
    if (item.readAt === null) patchItem.mutate({ item, patch: { read: true } });
  };

  const toggleRead = (item: InboxItem) => {
    patchItem.mutate({ item, patch: { read: item.readAt === null } });
  };

  const markDone = (item: InboxItem) => {
    handOffFocus(item);
    patchItem.mutate({ item, patch: { done: true } });
    toast({
      title: tr('已标为完成'),
      description: item.title,
      tone: 'success',
      action: {
        label: tr('撤销'),
        onClick: () => patchItem.mutate({ item, patch: { done: false } }),
      },
    });
  };

  const restore = (item: InboxItem) => {
    handOffFocus(item);
    patchItem.mutate({ item, patch: { done: false } });
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return;
    const holder = (e.target as HTMLElement).closest<HTMLElement>('[data-inbox-item]');
    const id = holder?.dataset.inboxItem;
    const idx = id ? visible.findIndex((x) => x.id === id) : -1;
    if (idx === -1) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusRow(visible[Math.min(idx + 1, visible.length - 1)]?.id);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusRow(visible[Math.max(idx - 1, 0)]?.id);
        break;
      case 'Home':
        e.preventDefault();
        focusRow(visible[0]?.id);
        break;
      case 'End':
        e.preventDefault();
        focusRow(visible[visible.length - 1]?.id);
        break;
      case 'e':
      case 'E': {
        const item = visible[idx];
        if (tab !== 'pending' || !item) return;
        e.preventDefault();
        markDone(item);
        break;
      }
      default:
        break;
    }
  };

  const changeTab = (next: InboxTab) => {
    setTab(next);
    setFilter('all');
  };

  // ------------------------------------------------------------ 内容区

  let bodyKey: string;
  let body: ReactNode;

  if (current.isError && !current.data) {
    bodyKey = `${tab}-error`;
    body = (
      <InboxError
        message={current.error instanceof Error ? current.error.message : undefined}
        retrying={current.isFetching}
        onRetry={() => void current.refetch()}
      />
    );
  } else if (!current.data) {
    bodyKey = `${tab}-loading`;
    body = <InboxSkeleton />;
  } else if (items.length === 0) {
    bodyKey = `${tab}-empty`;
    body =
      tab === 'pending' ? (
        <EmptyState
          framed
          icon={Inbox}
          title={tr('没有待处理的事项')}
          description={tr('需要你拍板的决策、请你审阅的内容和 @ 你的消息会出现在这里。')}
        />
      ) : (
        <EmptyState
          framed
          icon={CircleCheck}
          title={tr('还没有已完成的事项')}
          description={tr('标为完成的事项会收在这里，需要时可以随时移回待处理。')}
        />
      );
  } else if (visible.length === 0 && (filter !== 'all' || search.trim())) {
    bodyKey = `${tab}-filtered-empty`;
    body = (
      <EmptyState
        framed
        icon={ListFilter}
        title={
          filter === 'all'
            ? tr('没有符合条件的事项')
            : tr('没有「{filterLabel}」类的事项', {
                filterLabel: INBOX_KIND_META[filter].filterLabel,
              })
        }
        description={tr('这一类已经处理完了。')}
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setFilter('all');
              setSearch('');
            }}
          >
            {tr('查看全部')}
          </Button>
        }
      />
    );
  } else {
    bodyKey = `${tab}-list`;
    body = (
      <>
        <motion.ul
          ref={listRef}
          variants={listVariants}
          initial="hidden"
          animate="visible"
          onKeyDown={onListKeyDown}
          aria-label={tab === 'pending' ? tr('待处理事项') : tr('已完成事项')}
          className="research-list relative"
        >
          <AnimatePresence mode="popLayout">
            {visible.map((item) => (
              <motion.li
                key={item.id}
                data-list-item={`inbox:${item.id}`}
                layout="position"
                variants={rowVariants}
                exit="exit"
                className="research-row min-w-0"
              >
                <InboxRow
                  item={item}
                  mode={tab}
                  onOpen={openItem}
                  onMarkDone={markDone}
                  onToggleRead={toggleRead}
                  onRestore={restore}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </motion.ul>
      </>
    );
  }

  return (
    <Page width="feed">
      <PageTitle>{tr('待我处理')}</PageTitle>
      <PageActions>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<CheckCheck strokeWidth={1.75} aria-hidden />}
          disabled={unread.length === 0}
          onClick={() => markAllRead.mutate(unread)}
        >
          {tr('全部标为已读')}
        </Button>
      </PageActions>

      <ListToolbar
        search={
          <Input
            type="search"
            aria-label={tr('搜索待处理事项')}
            placeholder={tr('搜索事项')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
        filters={
          <>
            {
              <Tabs<InboxTab>
                value={tab}
                onValueChange={changeTab}
                aria-label={tr('待我处理分组')}
                layoutId="inbox-tabs"
                items={[
                  {
                    value: 'pending',
                    label: (
                      <span className="inline-flex items-center gap-1.5">
                        {tr('待处理')}
                        {pending.data && pendingItems.length > 0 && (
                          <Badge
                            tone={tab === 'pending' ? 'accent' : 'neutral'}
                            animateKey={pendingItems.length}
                          >
                            {pendingItems.length}
                          </Badge>
                        )}
                      </span>
                    ),
                  },
                  { value: 'done', label: tr('已完成') },
                ]}
              />
            }
            {current.data && items.length > 0 && (
              <InboxFilterBar
                value={filter}
                onValueChange={setFilter}
                total={items.length}
                counts={counts}
              />
            )}
          </>
        }
        activeFilterCount={Number(tab !== 'pending') + Number(filter !== 'all')}
      />

      <div className="mt-3 min-w-0">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={bodyKey}
            variants={variants.fadeIn}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            {body}
          </motion.div>
        </AnimatePresence>
      </div>
    </Page>
  );
}

function InboxError({
  message,
  retrying,
  onRetry,
}: {
  message: string | undefined;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <Card role="alert" className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-md bg-danger-soft text-danger ring-1 ring-danger/15"
      >
        <TriangleAlert size={16} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-h3 text-fg">{tr('没能加载待我处理的事项')}</h3>
        <p className="mt-1 text-small text-pretty text-fg-muted">
          {message || tr('请检查网络或稍后再试。')}
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        loading={retrying}
        leftIcon={<RotateCw strokeWidth={1.75} aria-hidden />}
        onClick={onRetry}
        className="self-start"
      >
        {tr('重试')}
      </Button>
    </Card>
  );
}
