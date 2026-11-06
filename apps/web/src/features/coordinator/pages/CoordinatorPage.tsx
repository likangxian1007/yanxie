import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { toast } from '@/components/ui';
import { HarnessComposer } from '@/features/harness';
import { clearSubmittedDraft, useConversationDraft } from '@/components/chat/conversation-drafts';
import { MessageFeed } from '@/components/chat/MessageFeed';
import { Page } from '@/components/layout/Page';
import { projectPath } from '@/components/layout/nav-items';
import { api } from '@/lib/api';
import { useSendMessage } from '@/lib/messages';
import {
  canWrite,
  isAgentBusy,
  useCoordinator,
  useMyRole,
  useProjectId,
  useThreads,
} from '@/lib/project';
import { useTypingReporter } from '@/lib/realtime';
import { useMeUser } from '@/lib/session';
import { AgentLiveActivity } from '@/features/threads/components/AgentLiveActivity';
import { TimelineEmpty } from '../components/TimelineEmpty';
import { tr } from '@/lib/i18n';

/** 协作台保留完整对话，线程由外壳的统一辅助面板承载。 */
export function CoordinatorPage() {
  const projectId = useProjectId();
  const me = useMeUser();
  const role = useMyRole(projectId);
  const writable = canWrite(role);
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useConversationDraft(projectId, null, me?.id);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const threads = useThreads(projectId, { kind: 'project' });
  const coordinator = useCoordinator(projectId);
  const send = useSendMessage(projectId, null, me);
  const onTyping = useTypingReporter(projectId);
  const stop = useMutation({
    mutationFn: (sid: string) => api.post(`/projects/${projectId}/agents/${sid}/stop`),
    onError: (e) => toast.error(tr('没能停止'), e.message),
  });

  // ?draft= 由“协调冲突”等入口带进来：放进输入框后从地址栏去掉
  useEffect(() => {
    const d = params.get('draft');
    if (d === null) return;
    setDraft(d);
    const next = new URLSearchParams(params);
    next.delete('draft');
    setParams(next, { replace: true });
    composerRef.current?.focus();
  }, [params, setParams, setDraft]);

  const threadsById = useMemo(
    () => new Map((threads.data ?? []).map((t) => [t.id, t])),
    [threads.data],
  );

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <Page width="feed" className="flex-1 pb-4">
        <MessageFeed
          projectId={projectId}
          threadId={null}
          me={me}
          readOnly={!writable}
          threadsById={threadsById}
          threadHref={(t) => `${projectPath(projectId, '')}?thread=${encodeURIComponent(t.id)}`}
          empty={
            <TimelineEmpty
              onPick={(text) => {
                setDraft(text);
                composerRef.current?.focus();
              }}
            />
          }
        />
        <AgentLiveActivity
          projectId={projectId}
          threadId={null}
          agent={coordinator}
          sentAt={sentAt}
          writable={writable}
        />
      </Page>
      <HarnessComposer
        ref={composerRef}
        projectId={projectId}
        threadId={null}
        agent={coordinator}
        writable={writable}
        value={draft}
        onChange={setDraft}
        onTyping={onTyping}
        disabled={!writable}
        placeholder={writable ? tr('向协调者描述需求…') : tr('访客只能查看，不能发言')}
        onStop={
          writable && coordinator && isAgentBusy(coordinator)
            ? () => stop.mutate(coordinator.id)
            : undefined
        }
        sendDisabled={send.isPending}
        onSubmit={(m) => {
          const submitted = draft;
          send.mutate(m, {
            onSuccess: () => {
              clearSubmittedDraft(projectId, null, me?.id, 'agent', submitted);
              if (m.agentVisible) setSentAt(Date.now());
            },
            onError: (e) => {
              toast.error(tr('消息没发出去'), e.message);
            },
          });
        }}
      />
    </div>
  );
}
