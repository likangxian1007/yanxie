import { DiscussionButton } from '@/features/discussion/DiscussionButton';
import { useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowLeft,
  ChevronDown,
  CloudOff,
  MessagesSquare,
  SquareArrowOutUpRight,
} from 'lucide-react';
import { parseChecklist } from '@srh/shared';
import { AgentHaltedBanner } from '@/components/chat/AgentHaltedBanner';
import { HarnessComposer } from '@/features/harness';
import { clearSubmittedDraft, useConversationDraft } from '@/components/chat/conversation-drafts';
import { MessageFeed } from '@/components/chat/MessageFeed';
import { Button, IconButton, StatusDot, Tabs, toast } from '@/components/ui';
import { projectPath } from '@/components/layout/nav-items';
import { ThreadActionsMenu } from '@/features/threads/components/ThreadActions';
import { EditablePlan } from '@/features/threads/components/EditablePlan';
import { summarizePlan } from '@/features/threads/components/plan-summary';
import { useAgentSteps, useStopAgent } from '@/features/threads/thread-api';
import { AgentStepsView } from '@/features/threads/components/AgentStepsView';
import { AgentLiveActivity } from '@/features/threads/components/AgentLiveActivity';
import { ThreadOutputs } from '@/features/threads/components/ThreadOutputs';
import { ThreadReviewPanel } from '@/features/threads/components/ThreadReviewPanel';
import { ThreadAgentCard, ThreadDecisions } from '@/features/threads/components/ThreadAside';
import { collectChanges, collectOutputs } from '@/features/threads/thread-utils';
import { cn } from '@/lib/cn';
import { LabelDot } from '@/lib/label-dot';
import { useMessageFeed, useSendMessage } from '@/lib/messages';
import { useMotionPreset } from '@/lib/motion';
import {
  canWrite,
  isAgentBusy,
  useMembers,
  useMyRole,
  useThread,
  useThreadAgent,
} from '@/lib/project';
import { useTypingReporter } from '@/lib/realtime';
import { useMeUser } from '@/lib/session';
import { threadDisplay } from '@/lib/status';
import { panelStatus, statusText, type PanelThread } from '../thread-panel';
import { tr } from '@/lib/i18n';

export interface ThreadPanelDetailProps {
  projectId: string;
  threadId: string;
  /** 面板列表里这一行的数据（状态含在等谁）；直接从地址栏打开时可能还没有 */
  row?: PanelThread | undefined;
  nameOf?: (userId: string) => string | undefined;
  onBack: () => void;
}

/**
 * 辅助面板与完整页共享讨论、产出、执行记录三个入口。
 */
export function ThreadPanelDetail({
  projectId,
  threadId,
  row,
  nameOf,
  onBack,
}: ThreadPanelDetailProps) {
  const me = useMeUser();
  const writable = canWrite(useMyRole(projectId));
  const query = useThread(projectId, threadId);
  const thread = query.data;
  const agent = useThreadAgent(projectId, thread);
  const busy = isAgentBusy(agent);
  const feed = useMessageFeed(projectId, threadId, 'agent');
  const steps = useAgentSteps(projectId, agent?.id);
  const members = useMembers(projectId).data ?? [];
  const outputs = useMemo(() => collectOutputs(feed.messages), [feed.messages]);
  const changes = useMemo(() => collectChanges(steps.steps), [steps.steps]);
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get('threadTab');
  const tab = requestedTab === 'outputs' || requestedTab === 'steps' ? requestedTab : 'chat';
  const setTab = (value: 'chat' | 'outputs' | 'steps') => {
    const next = new URLSearchParams(params);
    if (value === 'chat') next.delete('threadTab');
    else next.set('threadTab', value);
    setParams(next, { state: location.state });
  };
  const send = useSendMessage(projectId, threadId, me);
  const stop = useStopAgent(projectId);
  const onTyping = useTypingReporter(projectId);
  const { variants } = useMotionPreset();
  const [draft, setDraft] = useConversationDraft(projectId, threadId, me?.id);
  const [planOpen, setPlanOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sent, setSent] = useState<{ threadId: string; at: number } | null>(null);
  const location = useLocation();
  const sourceParams = new URLSearchParams(params);
  sourceParams.delete('thread');
  sourceParams.delete('threadTab');
  const returnHref = location.pathname.endsWith('/threads')
    ? `${location.pathname}${sourceParams.size ? `?${sourceParams}` : ''}`
    : undefined;
  const fullHref = `${projectPath(projectId, `threads/${threadId}`)}${tab !== 'chat' ? `?tab=${tab}` : ''}`;

  const checklist = useMemo(() => parseChecklist(thread?.statusText ?? ''), [thread?.statusText]);
  const plan = summarizePlan(checklist);
  const status = row?.status ?? (thread ? panelStatus(threadDisplay(thread, agent)) : null);
  const statusLabel = row && nameOf ? statusText(row, nameOf) : status?.label;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-2">
        <DiscussionButton threadId={threadId} />
        <IconButton label={tr('返回线程列表')} size="sm" onClick={onBack}>
          <ArrowLeft strokeWidth={1.75} />
        </IconButton>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="truncate text-body font-semibold text-fg">
            {thread?.title ?? (query.isPending ? tr('加载中…') : tr('线程'))}
          </h2>
          {thread && status && (
            <p className="flex min-w-0 items-center gap-1.5 text-caption font-normal text-fg-subtle">
              <StatusDot status={status.dot} label={status.label} />
              <span className={status.textClass}>{statusLabel}</span>
              {thread.label && (
                <>
                  <span aria-hidden>·</span>
                  <LabelDot label={thread.label} size="sm" />
                  <span className="truncate">{thread.label}</span>
                </>
              )}
            </p>
          )}
        </div>
        <Link
          to={fullHref}
          state={{ threadsHref: returnHref }}
          aria-label={tr('在完整页面打开')}
          title={tr('在完整页面打开')}
          className="press inline-flex h-7 shrink-0 items-center gap-1 rounded-sm px-2 text-small text-fg-muted hover:bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SquareArrowOutUpRight size={14} strokeWidth={1.75} aria-hidden />
          {/* 窄屏抽屉里只留图标，给标题和「⋯」让位 */}
          <span className="hidden sm:inline">{tr('在完整页面打开')}</span>
        </Link>
        {thread && <ThreadActionsMenu thread={thread} projectId={projectId} />}
      </header>

      {query.isError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <CloudOff size={20} strokeWidth={1.75} aria-hidden className="text-fg-subtle" />
          <p className="text-body text-fg">{tr('这个线程打不开')}</p>
          <p className="text-small text-fg-muted">{tr('它可能已被删除，或者你没有查看权限。')}</p>
          <Button size="sm" variant="secondary" onClick={onBack}>
            {tr('返回线程列表')}
          </Button>
        </div>
      ) : (
        <>
          <Tabs<'chat' | 'outputs' | 'steps'>
            value={tab}
            onValueChange={setTab}
            aria-label={tr('线程内容')}
            layoutId="panel-thread-tabs"
            className="shrink-0 px-3"
            items={[
              { value: 'chat', label: tr('讨论') },
              {
                value: 'outputs',
                label: tr('产出'),
                count: outputs.length + changes.length || undefined,
              },
              { value: 'steps', label: tr('执行记录'), count: steps.steps.length || undefined },
            ]}
          />
          {thread && checklist.lines.length > 0 && (
            <section className="shrink-0 border-b border-line">
              <button
                type="button"
                aria-expanded={planOpen}
                aria-controls="panel-thread-plan"
                onClick={() => setPlanOpen((v) => !v)}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-small text-fg-muted hover:bg-subtle"
              >
                <span className="font-medium text-fg">{tr('计划')}</span>
                <span className="tabular-nums">
                  {plan.done}/{plan.total}
                </span>
                <span className="min-w-0 flex-1 truncate">· {plan.label}</span>
                <ChevronDown
                  size={16}
                  strokeWidth={1.75}
                  aria-hidden
                  className={cn(
                    'shrink-0 text-fg-subtle transition-transform duration-(--dur-fast)',
                    planOpen && 'rotate-180',
                  )}
                />
              </button>
              <AnimatePresence initial={false}>
                {planOpen && (
                  <motion.div
                    id="panel-thread-plan"
                    variants={variants.fadeIn}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                    className="max-h-64 overflow-y-auto px-3 pb-3"
                  >
                    <EditablePlan
                      thread={thread}
                      canEdit={writable}
                      agent={agent}
                      hideGoal
                      animate={busy}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          )}

          <div
            ref={scrollRef}
            hidden={tab !== 'chat'}
            className={cn(
              'min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2',
              tab !== 'chat' && 'hidden',
            )}
          >
            {thread && (
              <AgentHaltedBanner
                projectId={projectId}
                thread={thread}
                agent={agent}
                writable={writable}
                className="mt-3"
              />
            )}
            <MessageFeed
              projectId={projectId}
              threadId={threadId}
              me={me}
              readOnly={!writable}
              scrollRef={scrollRef}
              empty={
                <div className="flex flex-col items-center gap-2 py-12 text-center text-small text-fg-muted">
                  <MessagesSquare
                    size={20}
                    strokeWidth={1.75}
                    aria-hidden
                    className="text-fg-subtle"
                  />
                  {tr('线程里还没有消息')}
                </div>
              }
            />
            <AgentLiveActivity
              projectId={projectId}
              threadId={threadId}
              agent={agent}
              sentAt={sent?.threadId === threadId ? sent.at : null}
              writable={writable}
              haltedHandled
            />
          </div>

          {tab !== 'chat' && (
            <div
              role="tabpanel"
              aria-label={tab === 'outputs' ? tr('产出') : tr('执行记录')}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4"
            >
              {tab === 'outputs' ? (
                <div className="flex min-w-0 flex-col gap-6">
                  <ThreadOutputs
                    projectId={projectId}
                    outputs={outputs}
                    changes={changes}
                    loadingMessages={feed.isPending}
                    loadingSteps={Boolean(agent) && steps.isPending}
                  />
                  <ThreadDecisions
                    projectId={projectId}
                    messages={feed.messages}
                    readOnly={!writable}
                  />
                  {thread && (
                    <ThreadReviewPanel
                      projectId={projectId}
                      thread={thread}
                      me={me}
                      members={members}
                      writable={writable}
                    />
                  )}
                </div>
              ) : (
                <div className="flex min-w-0 flex-col gap-6">
                  <ThreadAgentCard
                    agent={agent}
                    animate={busy}
                    canStop={writable}
                    stopping={stop.isPending}
                    onStop={() =>
                      agent &&
                      stop.mutate(agent.id, {
                        onError: (e) => toast.error(tr('没能停止'), e.message),
                      })
                    }
                  />
                  <AgentStepsView
                    projectId={projectId}
                    steps={steps.steps}
                    noSession={!agent}
                    isPending={Boolean(agent) && steps.isPending}
                    error={steps.error}
                    retrying={steps.isFetching}
                    onRetry={() => void steps.refetch()}
                    hasOlder={steps.hasNextPage}
                    loadingOlder={steps.isFetchingNextPage}
                    onLoadOlder={() => void steps.fetchNextPage()}
                  />
                </div>
              )}
            </div>
          )}
          <div
            hidden={tab !== 'chat'}
            className={cn(
              'shrink-0 border-t border-line px-2 pt-2 pb-[max(env(safe-area-inset-bottom),0.5rem)]',
              tab !== 'chat' && 'hidden',
            )}
          >
            <HarnessComposer
              projectId={projectId}
              threadId={threadId}
              agent={agent}
              writable={writable}
              inline
              value={draft}
              onChange={setDraft}
              onTyping={onTyping}
              disabled={!writable || !thread || thread.resolved}
              label={tr('回复线程')}
              placeholder={
                !writable
                  ? tr('访客只能查看，不能发言')
                  : thread?.resolved
                    ? tr('线程已解决，重新打开后才能回复')
                    : tr('回复线程…')
              }
              onStop={
                busy && writable && agent
                  ? () =>
                      stop.mutate(agent.id, {
                        onError: (e) => toast.error(tr('没能停止'), e.message),
                      })
                  : undefined
              }
              sendDisabled={send.isPending}
              onSubmit={(m) => {
                const submitted = draft;
                send.mutate(m, {
                  onSuccess: () => {
                    clearSubmittedDraft(projectId, threadId, me?.id, 'agent', submitted);
                    if (m.agentVisible) setSent({ threadId, at: Date.now() });
                  },
                  onError: (e) => {
                    toast.error(tr('消息没发出去'), e.message);
                  },
                });
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
