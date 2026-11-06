import { clearSubmittedDraft, useConversationDraft } from '@/components/chat/conversation-drafts';
import { useState } from 'react';
import { Navigate, useNavigate, useLocation } from 'react-router';
import { CloudOff, MessagesSquare, SearchX } from 'lucide-react';
import { Button, EmptyState, Skeleton, toast } from '@/components/ui';
import { HarnessComposer } from '@/features/harness';
import { AgentHaltedBanner } from '@/components/chat/AgentHaltedBanner';
import { MessageFeed } from '@/components/chat/MessageFeed';
import { BackLink } from '@/components/layout/BackLink';
import { Page } from '@/components/layout/Page';
import { projectPath } from '@/components/layout/nav-items';
import { ApiRequestError } from '@/lib/api';
import { useSendMessage } from '@/lib/messages';
import { isAgentBusy, useThread, useThreadAgent } from '@/lib/project';
import { useMeUser } from '@/lib/session';
import { useStopAgent } from '../workspace-api';
import { ForwardDialog } from './ForwardDialog';
import { SessionHeader } from './SessionHeader';
import { SessionPlan } from './SessionPlan';
import { tr } from '@/lib/i18n';

export interface SessionViewProps {
  projectId: string;
  threadId: string;
  writable: boolean;
}

function HeaderSkeleton() {
  return (
    <div className="mb-6 flex flex-col gap-3 border-b border-line pb-4" aria-label={tr('加载中')}>
      <div className="flex items-start gap-3">
        <div className="flex flex-1 flex-col gap-2.5">
          <Skeleton className="h-6 w-2/3 max-w-80" />
          <Skeleton className="h-3.5 w-40" />
        </div>
        <Skeleton className="h-8 w-28" />
      </div>
    </div>
  );
}

function FeedSkeleton() {
  return (
    <div className="flex flex-col gap-6 py-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3.5 w-full max-w-lg" />
            <Skeleton className="h-3.5 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 一个个人会话：页头 + 消息流 + 吸底输入框。 */
export function SessionView({ projectId, threadId, writable }: SessionViewProps) {
  const me = useMeUser();
  const location = useLocation();
  const listParams = new URLSearchParams(location.search);
  listParams.delete('new');
  const listHref = `${projectPath(projectId, 'workspace')}?${listParams}`;
  const query = useThread(projectId, threadId);
  const thread = query.data;
  const agent = useThreadAgent(projectId, thread);
  const busy = isAgentBusy(agent);
  const send = useSendMessage(projectId, threadId, me);
  const stop = useStopAgent(projectId);
  const [draft, setDraft] = useConversationDraft(projectId, threadId, me?.id);
  const [forwardOpen, setForwardOpen] = useState(false);
  const navigate = useNavigate();
  const backLink = (
    <div className="mb-4 lg:hidden">
      <BackLink to={listHref}>{tr('全部会话')}</BackLink>
    </div>
  );

  if (query.isPending) {
    return (
      <Page width="feed">
        {backLink}
        <HeaderSkeleton />
        <FeedSkeleton />
      </Page>
    );
  }

  if (query.isError) {
    const notFound = query.error instanceof ApiRequestError && query.error.status === 404;
    return (
      <Page width="feed" className="justify-center">
        {backLink}
        {notFound ? (
          <EmptyState
            icon={SearchX}
            title={tr('找不到这个会话')}
            description={tr('它可能已经被删除，或者不属于你。个人会话只有主人自己能打开。')}
            action={
              <Button size="sm" variant="secondary" onClick={() => void navigate(listHref)}>
                {tr('回到我的工作区')}
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={CloudOff}
            title={tr('会话没加载出来')}
            description={query.error.message}
            action={
              <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
                {tr('重试')}
              </Button>
            }
          />
        )}
      </Page>
    );
  }

  if (!thread) return null;

  // 项目线程不属于工作区：交给线程页
  if (thread.kind === 'project') {
    return <Navigate to={projectPath(projectId, `threads/${thread.id}`)} replace />;
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <Page width="feed" className="flex-1 pb-4">
        {backLink}
        <SessionHeader
          projectId={projectId}
          thread={thread}
          agent={agent}
          writable={writable}
          onForward={() => setForwardOpen(true)}
        />
        <AgentHaltedBanner
          projectId={projectId}
          thread={thread}
          agent={agent}
          writable={writable}
          className="mb-4"
        />
        <SessionPlan thread={thread} agent={agent} className="mb-5" />
        <MessageFeed
          channel="all"
          projectId={projectId}
          threadId={thread.id}
          me={me}
          readOnly={!writable}
          empty={
            <EmptyState
              icon={MessagesSquare}
              title={tr('还没有消息')}
              description={tr('仅自己可见。')}
            />
          }
        />
      </Page>
      <HarnessComposer
        projectId={projectId}
        threadId={thread.id}
        agent={agent}
        personal
        writable={writable}
        onForward={() => setForwardOpen(true)}
        value={draft}
        onChange={setDraft}
        label={tr('给个人助手的消息')}
        placeholder={writable ? tr('和个人助手讨论…') : tr('访客只能查看，不能发言')}
        disabled={!writable}
        onStop={
          writable && agent && busy
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
            onSuccess: () => clearSubmittedDraft(projectId, thread.id, me?.id, 'agent', submitted),
            onError: (e) => {
              toast.error(tr('消息没发出去'), e.message);
            },
          });
        }}
      />
      {writable && (
        <ForwardDialog
          projectId={projectId}
          thread={thread}
          open={forwardOpen}
          onOpenChange={setForwardOpen}
        />
      )}
    </div>
  );
}
