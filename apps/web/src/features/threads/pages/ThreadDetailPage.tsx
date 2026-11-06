import { clearSubmittedDraft, useConversationDraft } from '@/components/chat/conversation-drafts';
import { useMemo, useState } from 'react';
import { Navigate, useLocation, useParams, useSearchParams } from 'react-router';
import { motion } from 'motion/react';
import { ListChecks, FolderOpen, MessagesSquare, SearchX } from 'lucide-react';
import type { Thread } from '@srh/shared';
import { AgentHaltedBanner } from '@/components/chat/AgentHaltedBanner';
import { EmptyState, Skeleton, Tabs, toast } from '@/components/ui';
import { HarnessComposer } from '@/features/harness';
import { stopResultTitle } from '@/features/harness/stop';
import { MessageFeed } from '@/components/chat/MessageFeed';
import { Page } from '@/components/layout/Page';
import { projectPath } from '@/components/layout/nav-items';
import { ApiRequestError } from '@/lib/api';
import { useMessageFeed, useSendMessage } from '@/lib/messages';
import { useMotionPreset } from '@/lib/motion';
import {
  canWrite,
  isAgentBusy,
  useMembers,
  useMyRole,
  useProjectId,
  useThread,
  useThreadAgent,
} from '@/lib/project';
import { useTypingReporter } from '@/lib/realtime';
import { useDraftsFor } from '@/lib/realtime-store';
import { useMeUser } from '@/lib/session';
import { threadDisplay } from '@/lib/status';
import { AgentLiveActivity } from '../components/AgentLiveActivity';
import { AgentStepsView } from '../components/AgentStepsView';
import { ThreadAgentCard, ThreadChecklistCard, ThreadDecisions } from '../components/ThreadAside';
import { ThreadHeader } from '../components/ThreadHeader';
import { ThreadOutputs } from '../components/ThreadOutputs';
import { ThreadReviewPanel } from '../components/ThreadReviewPanel';
import { ErrorCard, LinkButton } from '../components/ThreadStates';
import { useAgentSteps, useStopAgent } from '../thread-api';
import { collectChanges, collectOutputs } from '../thread-utils';
import { tr } from '@/lib/i18n';

type DetailTab = 'chat' | 'steps' | 'outputs';

function isDetailTab(v: string | null): v is DetailTab {
  return v === 'chat' || v === 'steps' || v === 'outputs';
}

/** 与讨论保持一致的阅读宽度。 */
const LAYOUT_WIDTH = 'max-w-(--feed-max)';

function DetailSkeleton() {
  return (
    <Page width="full" className={LAYOUT_WIDTH} aria-busy="true" aria-label={tr('加载中')}>
      <Skeleton className="mb-3 h-4 w-20" />
      <Skeleton className="h-8 w-3/4 max-w-lg" />
      <div className="mt-3 flex gap-3">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-28" />
      </div>
      <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-10 w-full" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-3.5 w-full" />
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-32 rounded-lg" />
        </div>
      </div>
    </Page>
  );
}

function ThreadDetail({ pid, thread }: { pid: string; thread: Thread }) {
  const me = useMeUser();
  const role = useMyRole(pid);
  const writable = canWrite(role);
  const members = useMembers(pid).data ?? [];
  const owner = members.find((m) => m.user.id === thread.ownerUserId);
  const agent = useThreadAgent(pid, thread);
  const busy = isAgentBusy(agent);
  const display = threadDisplay(thread, agent);
  const working = display.kind === 'working';
  const { variants } = useMotionPreset();

  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const tabParam = params.get('tab');
  const tab: DetailTab = isDetailTab(tabParam) ? tabParam : 'chat';
  const setTab = (v: DetailTab) => {
    const next = new URLSearchParams(params);
    if (v === 'chat') next.delete('tab');
    else next.set('tab', v);
    setParams(next, { state: location.state });
  };

  const feed = useMessageFeed(pid, thread.id, 'agent');
  const steps = useAgentSteps(pid, agent?.id);
  const outputs = useMemo(() => collectOutputs(feed.messages), [feed.messages]);
  const changes = useMemo(() => collectChanges(steps.steps), [steps.steps]);

  const [draft, setDraft] = useConversationDraft(pid, thread.id, me?.id);
  const send = useSendMessage(pid, thread.id, me);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const onTyping = useTypingReporter(pid);
  const stop = useStopAgent(pid);
  const stopAgent = () => {
    if (!agent) return;
    stop.mutate(agent.id, {
      onSuccess: (r) =>
        toast({
          title: stopResultTitle(r),
          description: r.stopped === 'none' ? undefined : tr('回复线程可以让它接着做。'),
        }),
      onError: (e) => toast.error(tr('没能停止'), e.message),
    });
  };

  // 同屏循环动画 ≤ 3：状态点光环 + 清单 ✱ + agent 思考中；对话里有流式输出（光标闪烁）时先停掉 ✱
  const streaming = useDraftsFor(thread.id).length > 0 && tab === 'chat';
  const animateChecklist = working && !streaming;

  return (
    <Page width="full" className={LAYOUT_WIDTH}>
      <ThreadHeader
        projectId={pid}
        thread={thread}
        owner={owner}
        agent={agent}
        writable={writable}
        animateDot={working}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <AgentHaltedBanner
          projectId={pid}
          thread={thread}
          agent={agent}
          writable={writable}
          onShowSteps={tab === 'steps' ? undefined : () => setTab('steps')}
          className="mb-4"
        />
        <Tabs<DetailTab>
          value={tab}
          onValueChange={setTab}
          aria-label={tr('线程内容')}
          layoutId="thread-detail-tabs"
          idPrefix="thread-detail"
          className="mb-4"
          items={[
            {
              value: 'chat',
              label: tr('讨论'),
              icon: <MessagesSquare strokeWidth={1.75} aria-hidden />,
            },
            {
              value: 'outputs',
              label: tr('产出'),
              icon: <FolderOpen strokeWidth={1.75} aria-hidden />,
              count: outputs.length + changes.length || undefined,
            },
            {
              value: 'steps',
              label: tr('执行记录'),
              icon: <ListChecks strokeWidth={1.75} aria-hidden />,
              count: steps.steps.length || undefined,
            },
          ]}
        />

        <motion.div
          key={tab}
          id={`thread-detail-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`thread-detail-tab-${tab}`}
          variants={variants.fadeIn}
          initial="hidden"
          animate="visible"
          exit="exit"
          className="flex min-w-0 flex-1 flex-col"
        >
          {tab === 'chat' && (
            <>
              <div className="flex-1">
                <MessageFeed
                  projectId={pid}
                  threadId={thread.id}
                  me={me}
                  readOnly={!writable}
                  empty={<EmptyState icon={MessagesSquare} title={tr('线程里还没有消息')} />}
                />
                <AgentLiveActivity
                  projectId={pid}
                  threadId={thread.id}
                  agent={agent}
                  sentAt={sentAt}
                  writable={writable}
                  haltedHandled
                />
              </div>
              <div className="sticky bottom-0 z-sticky -mx-1 bg-linear-to-t from-canvas from-60% to-transparent px-1 pt-6 pb-[max(var(--safe-bottom),0.75rem)] md:pb-6">
                <HarnessComposer
                  projectId={pid}
                  threadId={thread.id}
                  agent={agent}
                  writable={writable}
                  inline
                  value={draft}
                  onChange={setDraft}
                  onTyping={onTyping}
                  disabled={!writable || thread.resolved}
                  label={tr('回复线程')}
                  placeholder={
                    !writable
                      ? tr('访客只能查看，不能发言')
                      : thread.resolved
                        ? tr('线程已解决，重新打开后才能回复')
                        : tr('回复线程…')
                  }
                  onStop={busy && writable ? stopAgent : undefined}
                  sendDisabled={send.isPending}
                  onSubmit={(m) => {
                    const submitted = draft;
                    send.mutate(m, {
                      onSuccess: () => {
                        clearSubmittedDraft(pid, thread.id, me?.id, 'agent', submitted);
                        if (m.agentVisible) setSentAt(Date.now());
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
          {tab === 'steps' && (
            <div className="flex min-w-0 flex-col gap-6">
              <div className="grid min-w-0 gap-6 md:grid-cols-2">
                <ThreadChecklistCard
                  thread={thread}
                  animate={animateChecklist}
                  writable={writable}
                />
                <ThreadAgentCard
                  agent={agent}
                  animate={busy}
                  canStop={writable}
                  stopping={stop.isPending}
                  onStop={stopAgent}
                />
              </div>
              <AgentStepsView
                projectId={pid}
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
          {tab === 'outputs' && (
            <div className="flex min-w-0 flex-col gap-6">
              <ThreadOutputs
                projectId={pid}
                outputs={outputs}
                changes={changes}
                loadingMessages={feed.isPending}
                loadingSteps={Boolean(agent) && steps.isPending}
              />
              <ThreadDecisions projectId={pid} messages={feed.messages} readOnly={!writable} />
              <ThreadReviewPanel
                projectId={pid}
                thread={thread}
                me={me}
                members={members}
                writable={writable}
              />
            </div>
          )}
        </motion.div>
      </div>
    </Page>
  );
}

/**
 * 线程详情：讨论、产出与审阅、执行记录与计划。个人会话转到我的工作区。
 */
export function ThreadDetailPage() {
  const pid = useProjectId();
  const { threadId } = useParams();
  const thread = useThread(pid, threadId);

  if (thread.isPending) return <DetailSkeleton />;

  if (thread.isError) {
    const notFound = thread.error instanceof ApiRequestError && thread.error.status === 404;
    return (
      <Page width="feed">
        {notFound ? (
          <EmptyState
            framed
            icon={SearchX}
            title={tr('线程不存在或已被删除')}
            description={tr('链接可能已经失效，或者你没有查看这个线程的权限。')}
            action={<LinkButton to={projectPath(pid, 'threads')}>{tr('返回全部线程')}</LinkButton>}
          />
        ) : (
          <ErrorCard
            title={tr('线程没加载出来')}
            message={thread.error.message}
            retrying={thread.isFetching}
            onRetry={() => void thread.refetch()}
          />
        )}
      </Page>
    );
  }

  if (thread.data.kind === 'personal') {
    return <Navigate to={projectPath(pid, `workspace/${thread.data.id}`)} replace />;
  }

  return <ThreadDetail key={thread.data.id} pid={pid} thread={thread.data} />;
}
