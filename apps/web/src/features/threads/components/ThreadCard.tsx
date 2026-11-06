import { forwardRef, useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';
import { motion } from 'motion/react';
import { CircleCheck, MessageSquare, Pin, SquareArrowOutUpRight } from 'lucide-react';
import { checklistProgress, parseChecklist, type AgentSession, type Thread } from '@srh/shared';
import {
  AgentThinking,
  Avatar,
  Badge,
  Card,
  RelativeTime,
  StatusDot,
  type CardProps,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { paletteFromString } from '@/lib/palette';
import { displayTextClass, STATUS_DOT_CLASS, threadDisplay } from '@/lib/status';
import { ChecklistView } from './ChecklistView';
import { ThreadActionsMenu } from './ThreadActions';
import { useThreadContextMenu } from './thread-actions';
import { tr } from '@/lib/i18n';

export interface ThreadCardOwner {
  name: string;
  color?: number | undefined;
}

export interface ThreadCardProps extends Omit<CardProps, 'children'> {
  thread: Thread;
  href: string;
  fullHref?: string;
  returnHref?: string;
  /** 发起人（来自成员表；找不到时不显示） */
  owner?: ThreadCardOwner | null | undefined;
  /** 线程 agent 当前的一句话动态 */
  activity?: string | null | undefined;
  /** 线程 agent 会话（用来如实显示停工、出错） */
  agent?: AgentSession | null | undefined;
  /**
   * 是否允许循环动画（状态点光环、思考中扫光）。同屏循环动画 ≤ 3：列表里只给最靠前的工作中线程开。
   */
  animate?: boolean;
  /** compact：看板列里用，不展开清单，只显示进度条 */
  density?: 'default' | 'compact';
  pinned?: boolean;
  /** 传了就带右键菜单和「⋯」操作按钮 */
  projectId?: string | undefined;
}

/** 不带循环动画的状态点（给超出动画名额的卡片用） */
function StaticDot({ status, label }: { status: Thread['statusBucket']; label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      data-status={status}
      className={cn('inline-flex size-2 shrink-0 rounded-full', STATUS_DOT_CLASS[status])}
    />
  );
}

/**
 * 线程卡片（STYLE §6 ThreadCard）：标题 + 标签 + 状态点 + 当前一步 + 回复数 + 相对时间；
 * agent 工作中时底部显示 agent 动态行。整张卡片可点（拉伸链接）。
 */
export const ThreadCard = forwardRef<HTMLDivElement, ThreadCardProps>(function ThreadCard(
  {
    thread,
    href,
    fullHref,
    returnHref,
    owner,
    activity,
    agent,
    animate = true,
    density = 'default',
    pinned,
    projectId,
    className,
    ...props
  },
  ref,
) {
  if (projectId) {
    return (
      <ThreadCardWithActions
        ref={ref}
        thread={thread}
        href={href}
        fullHref={fullHref}
        returnHref={returnHref}
        owner={owner}
        activity={activity}
        agent={agent}
        animate={animate}
        density={density}
        pinned={pinned}
        projectId={projectId}
        className={className}
        {...props}
      />
    );
  }
  return (
    <ThreadCardBody
      ref={ref}
      thread={thread}
      href={href}
      fullHref={fullHref}
      returnHref={returnHref}
      owner={owner}
      activity={activity}
      agent={agent}
      animate={animate}
      density={density}
      pinned={pinned}
      className={className}
      {...props}
    />
  );
});

/** 带右键菜单的卡片：菜单挂在整张卡片上，「⋯」在标题行右侧，悬停或聚焦时出现。 */
const ThreadCardWithActions = forwardRef<HTMLDivElement, ThreadCardProps & { projectId: string }>(
  function ThreadCardWithActions({ projectId, ...props }, ref) {
    const { handlers, menu } = useThreadContextMenu(props.thread, projectId);
    return (
      <>
        <ThreadCardBody
          ref={ref}
          {...props}
          {...handlers}
          actions={<ThreadActionsMenu thread={props.thread} projectId={projectId} />}
        />
        {menu}
      </>
    );
  },
);

const ThreadCardBody = forwardRef<
  HTMLDivElement,
  Omit<ThreadCardProps, 'projectId'> & { actions?: ReactNode }
>(function ThreadCardBody(
  {
    thread,
    href,
    fullHref,
    returnHref,
    owner,
    activity,
    agent,
    animate = true,
    density = 'default',
    pinned,
    actions,
    className,
    ...props
  },
  ref,
) {
  const checklist = useMemo(() => parseChecklist(thread.statusText), [thread.statusText]);
  const current =
    checklist.lines.find((l) => l.mark === 'active') ?? checklist.lines[checklist.lines.length - 1];
  const display = threadDisplay(thread, agent);
  const working = display.kind === 'working';
  const compact = density === 'compact';
  const progress = checklistProgress(checklist);
  const total = checklist.lines.length;
  const done = checklist.lines.filter((l) => l.mark === 'done').length;

  if (!compact)
    return (
      <motion.div
        ref={ref}
        className={cn(
          'group relative grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 bg-surface px-4 py-3 hover:bg-subtle lg:grid-cols-[minmax(0,1fr)_112px_112px_80px_60px]',
          className,
        )}
        {...props}
      >
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="min-w-0 truncate text-body font-medium text-fg">
              <Link
                to={href}
                className="outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
              >
                {thread.title}
              </Link>
            </h3>
            {pinned && (
              <Pin size={12} aria-label={tr('已置顶')} className="shrink-0 text-fg-subtle" />
            )}
            {thread.label && (
              <span className="hidden max-w-24 truncate rounded-sm bg-subtle px-1.5 py-0.5 text-caption font-normal text-fg-muted lg:inline">
                {thread.label}
              </span>
            )}
          </div>
          <p className="mt-0.5 flex min-w-0 items-center gap-2 truncate text-small text-fg-subtle">
            {current && <span className="truncate">{current.text}</span>}
            <span className="shrink-0">
              {tr('{replyCount} 条回复', { replyCount: thread.replyCount })}
            </span>
            {working &&
              (animate ? (
                <AgentThinking
                  label={activity ?? tr('正在推进')}
                  className="hidden sm:inline-flex"
                />
              ) : (
                <span className="hidden truncate sm:inline">{activity ?? tr('正在推进')}</span>
              ))}
          </p>
        </div>
        <span className="inline-flex min-w-0 items-center gap-1.5 text-small text-fg-muted">
          {animate ? (
            <StatusDot status={display.dot} label={display.label} />
          ) : (
            <StaticDot status={display.dot} label={display.label} />
          )}
          <span className={cn('truncate', displayTextClass(display.kind))}>
            {thread.resolved ? tr('已解决') : display.label}
          </span>
        </span>
        <span className="col-start-1 row-start-2 flex min-w-0 items-center gap-3 lg:contents">
          <span className="inline-flex min-w-0 items-center gap-1.5 text-small text-fg-muted lg:col-start-3 lg:row-start-1">
            {owner ? (
              <>
                <Avatar name={owner.name} color={owner.color} size={20} />
                <span className="truncate">{owner.name}</span>
              </>
            ) : (
              tr('未分配')
            )}
          </span>
          <RelativeTime
            iso={thread.lastActivityAt}
            className="shrink-0 text-caption font-normal text-fg-subtle tabular-nums lg:col-start-4 lg:row-start-1"
          />
        </span>
        <span className="relative z-10 col-start-2 row-start-2 flex items-center justify-end lg:col-start-5 lg:row-start-1">
          {fullHref && (
            <Link
              to={fullHref}
              state={{ threadsHref: returnHref }}
              aria-label={tr('在完整页面打开：{title}', { title: thread.title })}
              title={tr('在完整页面打开')}
              className="inline-grid size-7 place-items-center rounded-sm text-fg-subtle hover:bg-muted hover:text-fg max-md:size-11"
            >
              <SquareArrowOutUpRight size={14} strokeWidth={1.75} aria-hidden />
            </Link>
          )}
          {actions}
        </span>
      </motion.div>
    );

  return (
    <Card ref={ref} interactive padding="none" className={cn('group', className)} {...props}>
      <div className={compact ? 'p-3' : 'p-4'}>
        <div className="flex items-start gap-3">
          <span className="flex h-5.5 items-center">
            {animate ? (
              <StatusDot status={display.dot} label={display.label} />
            ) : (
              <StaticDot status={display.dot} label={display.label} />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3
                className={cn(
                  'min-w-0 text-h3 text-fg',
                  compact ? 'line-clamp-2 break-words' : 'truncate',
                )}
              >
                <Link
                  to={href}
                  className="outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-accent"
                >
                  {thread.title}
                </Link>
              </h3>
              {pinned && (
                <Pin
                  size={13}
                  strokeWidth={1.75}
                  aria-label={tr('已置顶')}
                  className="shrink-0 text-fg-subtle"
                />
              )}
              {thread.label && !compact && (
                <Badge color={paletteFromString(thread.label)} className="hidden sm:inline-flex">
                  {thread.label}
                </Badge>
              )}
              {!compact && (
                <RelativeTime
                  iso={thread.lastActivityAt}
                  className="ml-auto shrink-0 pl-2 text-caption font-normal text-fg-subtle"
                />
              )}
              {actions && (
                <span
                  className={cn(
                    'relative z-10 -my-1 shrink-0',
                    compact && 'ml-auto',
                    'opacity-0 transition-opacity duration-(--dur-fast) group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100',
                  )}
                >
                  {actions}
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-small text-fg-muted">
              <span className={displayTextClass(display.kind)}>{display.label}</span>
              {thread.resolved && (
                <span className="text-fg-subtle">
                  {' · '}
                  <CircleCheck
                    size={12}
                    strokeWidth={1.75}
                    aria-hidden
                    className="inline align-[-2px]"
                  />{' '}
                  {tr('已解决')}
                </span>
              )}
              {current && <span> · {current.text}</span>}
            </p>
          </div>
        </div>

        {compact ? (
          total > 0 && (
            <div className="mt-2.5 flex items-center gap-2">
              <span
                role="progressbar"
                aria-label={tr('清单进度')}
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={done}
                className="relative h-1 flex-1 overflow-hidden rounded-full bg-muted"
              >
                <span
                  className="absolute inset-0 origin-left rounded-full bg-success transition-transform duration-(--dur-slow) ease-(--ease-out)"
                  style={{ transform: `scaleX(${progress})` }}
                />
              </span>
              <span className="text-caption font-normal text-fg-subtle tabular-nums">
                {done}/{total}
              </span>
            </div>
          )
        ) : (
          <ChecklistView
            checklist={checklist}
            showTitle={false}
            animateActive={false}
            className="mt-3 -mx-1.5 sm:mr-0 sm:ml-3.5"
          />
        )}

        <div
          className={cn(
            'flex items-center text-caption font-normal whitespace-nowrap text-fg-subtle',
            compact ? 'mt-2.5 gap-3' : 'mt-3 gap-4 sm:pl-5',
          )}
        >
          <span
            className="inline-flex items-center gap-1.5 tabular-nums"
            aria-label={
              compact ? tr('{replyCount} 条回复', { replyCount: thread.replyCount }) : undefined
            }
          >
            <MessageSquare size={14} strokeWidth={1.75} aria-hidden />
            {compact ? (
              <span aria-hidden>{thread.replyCount}</span>
            ) : (
              tr('{replyCount} 条回复', { replyCount: thread.replyCount })
            )}
          </span>
          {compact && <RelativeTime iso={thread.lastActivityAt} className="truncate" />}
          {owner && (
            <span className="ml-auto inline-flex min-w-0 items-center gap-1.5">
              <Avatar name={owner.name} color={owner.color} size={20} />
              <span className={cn('truncate', compact ? 'sr-only' : 'hidden sm:inline')}>
                {tr('{name} 发起', { name: owner.name })}
              </span>
            </span>
          )}
        </div>
      </div>

      {working && (
        <div className="flex items-center gap-2 rounded-b-lg border-t border-line bg-agent-soft/40 px-4 py-2.5">
          <Avatar kind="agent" name={tr('线程 agent')} size={20} />
          {animate ? (
            <AgentThinking label={activity ?? tr('思考中')} className="min-w-0" />
          ) : (
            <span className="min-w-0 truncate text-small font-medium text-agent-text">
              {activity ?? tr('工作中')}
            </span>
          )}
        </div>
      )}
    </Card>
  );
});
