import { useId, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight, LayoutList, Rows3, SearchX, Split } from 'lucide-react';
import { Button, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { LabelDot } from '@/lib/label-dot';
import { useMotionPreset } from '@/lib/motion';
import {
  filterByLabel,
  flatList,
  groupByLabel,
  labelChips,
  type PanelGroup,
  type PanelThread,
} from '../thread-panel';
import type { PanelThreadsState } from '../use-panel-threads';
import { ThreadPanelDetail } from './ThreadPanelDetail';
import { ThreadPanelRow } from './ThreadPanelRow';
import { tr } from '@/lib/i18n';

type Mode = 'group' | 'flat';
const MODE_KEY = 'srh.threadPanel.mode';

function readMode(): Mode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'flat' ? 'flat' : 'group';
  } catch {
    return 'group';
  }
}

/** 同屏最多 3 个循环动画：只给排在最前的两个在跑线程的状态点加光环 */
function animatedIds(rows: readonly PanelThread[]): Set<string> {
  return new Set(
    rows
      .filter((r) => r.status.kind === 'running')
      .slice(0, 2)
      .map((r) => r.thread.id),
  );
}

export interface ThreadPanelProps {
  projectId: string;
  data: PanelThreadsState;
  /** 在面板里打开的线程；null = 列表 */
  selectedId: string | null;
  onSelect: (threadId: string | null) => void;
  className?: string;
}

/**
 * 协作台右栏：所有项目线程的实时面板。按标签筛选 / 分组，一行一个线程；
 * 点一行就在面板里打开它（对话、计划、回复），不离开协作台。
 */
export function ThreadPanel({
  projectId,
  data,
  selectedId,
  onSelect,
  className,
}: ThreadPanelProps) {
  const { variants } = useMotionPreset();
  // 列表 ↔ 线程只做入场淡入、不等离场动画：切换立即生效，后台标签页（动画帧被节流）也不会卡住
  return (
    <div className={cn('relative flex h-full min-h-0 flex-col', className)}>
      <div
        hidden={Boolean(selectedId)}
        className={cn('h-full min-h-0 flex-col', selectedId ? 'hidden' : 'flex')}
      >
        <ThreadList projectId={projectId} data={data} onOpen={(id) => onSelect(id)} />
      </div>
      {selectedId && (
        <motion.div
          key={selectedId}
          variants={variants.fadeIn}
          initial="hidden"
          animate="visible"
          className="flex h-full min-h-0 flex-col"
        >
          <ThreadPanelDetail
            projectId={projectId}
            threadId={selectedId}
            row={data.rows.find((r) => r.thread.id === selectedId)}
            nameOf={data.nameOf}
            onBack={() => onSelect(null)}
          />
        </motion.div>
      )}
    </div>
  );
}

function ThreadList({
  projectId,
  data,
  onOpen,
}: {
  projectId: string;
  data: PanelThreadsState;
  onOpen: (id: string) => void;
}) {
  const [label, setLabel] = useState<string | null>(null);
  const [mode, setModeState] = useState<Mode>(readMode);
  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      window.localStorage.setItem(MODE_KEY, m);
    } catch {
      // 隐私模式下存不了，只在本页生效
    }
  };

  const chips = useMemo(() => labelChips(data.rows), [data.rows]);
  // 筛选的标签已不存在（改名或删了线程）时回到全部
  const activeLabel = label !== null && chips.some((c) => c.label === label) ? label : null;
  const visible = useMemo(() => filterByLabel(data.rows, activeLabel), [data.rows, activeLabel]);
  const groups = useMemo(() => groupByLabel(visible), [visible]);
  const flat = useMemo(() => flatList(visible), [visible]);
  const animated = useMemo(() => animatedIds(flat.active), [flat.active]);
  const activeTotal = data.rows.filter((r) => !r.thread.resolved).length;

  const rowProps = {
    projectId,
    onOpen,
    nameOf: data.nameOf,
    colorOf: data.colorOf,
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-4 pb-3">
        <div className="flex items-center justify-between gap-2 text-small text-fg-muted">
          <span className="tabular-nums">{tr('{activeTotal} 个进行中', { activeTotal })}</span>
          {data.waitingOnMe > 0 && (
            <span className="text-warning">
              {tr('待你处理 {waitingOnMe}', { waitingOnMe: data.waitingOnMe })}
            </span>
          )}
        </div>
      </div>

      {chips.length > 0 && (
        <div className="flex shrink-0 items-start gap-2 border-b border-line px-4 pb-3">
          <div
            role="group"
            aria-label={tr('按标签筛选')}
            className="flex min-w-0 flex-1 flex-wrap gap-1.5"
          >
            <Chip pressed={activeLabel === null} onClick={() => setLabel(null)}>
              {tr('全部')}
              <span className="text-fg-subtle tabular-nums">{activeTotal}</span>
            </Chip>
            {chips.map((c) => (
              <Chip
                key={c.label || '__none'}
                pressed={activeLabel === c.label}
                onClick={() => setLabel(activeLabel === c.label ? null : c.label)}
              >
                <LabelDot label={c.label} size="sm" />
                {c.label || tr('未分类')}
                <span className="text-fg-subtle tabular-nums">{c.count}</span>
                {c.waitingOnMe > 0 && (
                  <span
                    className="size-1.5 rounded-full bg-warning"
                    aria-label={tr('{waitingOnMe} 个在等你', { waitingOnMe: c.waitingOnMe })}
                    role="img"
                  />
                )}
              </Chip>
            ))}
          </div>
          <div
            role="group"
            aria-label={tr('显示方式')}
            className="flex shrink-0 rounded-md border border-line p-0.5"
          >
            <ModeButton
              pressed={mode === 'group'}
              label={tr('按标签分组')}
              onClick={() => setMode('group')}
            >
              <Rows3 size={14} strokeWidth={1.75} aria-hidden />
            </ModeButton>
            <ModeButton
              pressed={mode === 'flat'}
              label={tr('列表')}
              onClick={() => setMode('flat')}
            >
              <LayoutList size={14} strokeWidth={1.75} aria-hidden />
            </ModeButton>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
        {data.isPending ? (
          <div className="flex flex-col gap-3" aria-label={tr('加载中')}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-20 rounded-lg" />
            ))}
          </div>
        ) : data.error ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="text-small text-fg-muted">
              {tr('线程没加载出来：{message}', { message: data.error.message })}
            </p>
            <Button size="sm" variant="secondary" onClick={data.refetch}>
              {tr('重试')}
            </Button>
          </div>
        ) : data.rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <Split size={20} strokeWidth={1.75} aria-hidden className="text-fg-subtle" />
            <p className="text-body text-fg">{tr('还没有线程')}</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-small text-fg-muted">
            <SearchX size={20} strokeWidth={1.75} aria-hidden className="text-fg-subtle" />
            {tr('这个标签下没有线程')}
          </div>
        ) : mode === 'group' ? (
          <div className="flex flex-col gap-3">
            {groups.map((g) => (
              <GroupCard
                key={g.label || '__none'}
                group={g}
                animated={animated}
                rowProps={rowProps}
              />
            ))}
          </div>
        ) : (
          <div className="bg-surface">
            <ul aria-label={tr('线程')} className="flex flex-col">
              {flat.active.map((r) => (
                <ThreadPanelRow
                  key={r.thread.id}
                  row={r}
                  animateDot={animated.has(r.thread.id)}
                  {...rowProps}
                />
              ))}
            </ul>
            <ResolvedRows rows={flat.resolved} rowProps={rowProps} />
          </div>
        )}
      </div>
    </div>
  );
}

type RowProps = Omit<Parameters<typeof ThreadPanelRow>[0], 'row' | 'animateDot'>;

function GroupCard({
  group,
  animated,
  rowProps,
}: {
  group: PanelGroup;
  animated: Set<string>;
  rowProps: RowProps;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cn('border-b border-line bg-surface')}>
      <header className="flex items-center gap-2 px-3.5 pt-2.5 pb-1">
        <LabelDot label={group.label} />
        <h3 id={headingId} className="min-w-0 truncate text-small font-semibold text-fg">
          {group.label || tr('未分类')}
        </h3>
        <span className="text-caption font-normal text-fg-subtle tabular-nums">
          {group.active.length}
        </span>
        <span className="ml-auto flex items-center gap-2 text-caption font-normal text-fg-subtle tabular-nums">
          {group.tally.map((t) => (
            <span key={t.kind}>
              {t.count} {t.label}
            </span>
          ))}
        </span>
      </header>
      {group.active.length > 0 && (
        <ul
          aria-label={tr('{value}的线程', { value: group.label || tr('未分类') })}
          className="flex flex-col px-1 pb-1"
        >
          {group.active.map((r) => (
            <ThreadPanelRow
              key={r.thread.id}
              row={r}
              animateDot={animated.has(r.thread.id)}
              {...rowProps}
            />
          ))}
        </ul>
      )}
      <ResolvedRows rows={group.resolved} rowProps={rowProps} />
    </section>
  );
}

function ResolvedRows({ rows, rowProps }: { rows: PanelThread[]; rowProps: RowProps }) {
  const [open, setOpen] = useState(false);
  const { variants } = useMotionPreset();
  const listId = useId();
  if (rows.length === 0) return null;
  return (
    <div className="px-1 pb-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md bg-subtle px-2.5 py-1.5 text-left text-small text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          size={14}
          strokeWidth={1.75}
          aria-hidden
          className={cn('transition-transform duration-(--dur-fast)', open && 'rotate-90')}
        />
        {tr('已解决')}
        <span className="text-fg-subtle tabular-nums">{rows.length}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            id={listId}
            aria-label={tr('已解决的线程')}
            variants={variants.fadeIn}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="mt-1 flex flex-col"
          >
            {rows.map((r) => (
              <ThreadPanelRow key={r.thread.id} row={r} animateDot={false} {...rowProps} />
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}

function Chip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'press inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-small transition-colors duration-(--dur-fast)',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        pressed
          ? 'border-accent/40 bg-accent-soft text-accent-text'
          : 'border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

function ModeButton({
  pressed,
  label,
  onClick,
  children,
}: {
  pressed: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'grid size-6 cursor-pointer place-items-center rounded-sm transition-colors duration-(--dur-fast)',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        pressed ? 'bg-subtle text-fg' : 'text-fg-subtle hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}
