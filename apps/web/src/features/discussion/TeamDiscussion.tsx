import {
  ConversationAttachmentButton,
  ConversationAttachmentList,
} from '@/components/chat/ConversationAttachments';
import { useConversationAttachments } from '@/components/chat/conversation-attachments';
import { useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import type { Message } from '@srh/shared';
import { MessageFeed } from '@/components/chat/MessageFeed';
import { Composer } from '@/components/chat/Composer';
import {
  appendAgentDraft,
  clearSubmittedDraft,
  useConversationDraft,
} from '@/components/chat/conversation-drafts';
import { Button } from '@/components/ui';
import { canWrite, useMyRole, useThread } from '@/lib/project';
import { useMeUser } from '@/lib/session';
import { useSendMessage } from '@/lib/messages';
import { useLayoutStore } from '@/components/layout/layout-store';
import { tr, trServer } from '@/lib/i18n';

export function TeamDiscussion({ projectId, scope }: { projectId: string; scope: string }) {
  const threadId = scope === 'project' ? null : scope;
  const thread = useThread(projectId, threadId ?? undefined);
  const me = useMeUser();
  const writable = canWrite(useMyRole(projectId));
  const [draft, setDraft] = useConversationDraft(projectId, threadId, me?.id, 'team');
  const attachments = useConversationAttachments(me?.id, projectId, threadId, 'team');
  const send = useSendMessage(projectId, threadId, me);
  const scrollRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const setOpen = useLayoutStore((s) => s.setRightPanelOpen);
  const quote = (message: Message) => {
    const source = `/p/${projectId}${threadId ? `/threads/${threadId}` : ''}?discussion=${scope}#${message.id}`;
    appendAgentDraft(
      projectId,
      threadId,
      me?.id,
      tr('引用 {name}：\n{value}\n\n[查看原讨论]({source})', {
        name: trServer(message.author.name),
        value: message.body
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n'),
        source,
      }),
    );
    setOpen(false);
    void Promise.resolve(navigate(`/p/${projectId}${threadId ? `/threads/${threadId}` : ''}`)).then(
      () => {
        requestAnimationFrame(() =>
          document.querySelector<HTMLTextAreaElement>('#app-scroll textarea')?.focus(),
        );
      },
    );
  };
  if (threadId && thread.isPending)
    return <p className="p-4 text-small text-fg-muted">{tr('加载讨论…')}</p>;
  if (threadId && (thread.isError || thread.data?.kind !== 'project'))
    return (
      <div className="p-4 text-small">
        <p>{tr('无法打开此线程的团队讨论')}</p>
        {thread.error && <p>{thread.error.message}</p>}
        <Button onClick={() => void thread.refetch()}>{tr('重试')}</Button>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      {threadId && (
        <div className="flex min-w-0 items-center gap-2 border-b border-line px-3 py-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const next = new URLSearchParams(params);
              next.delete('discussion');
              next.set('thread', threadId);
              setParams(next, { state: location.state });
            }}
          >
            {tr('返回线程')}
          </Button>
          <span className="truncate text-small text-fg-muted">{thread.data?.title}</span>
        </div>
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-2">
        <MessageFeed
          projectId={projectId}
          threadId={threadId}
          me={me}
          readOnly={!writable}
          channel="team"
          scrollRef={scrollRef}
          onQuote={writable ? quote : undefined}
          empty={<p className="py-8 text-center text-small text-fg-muted">{tr('暂无讨论')}</p>}
        />
      </div>
      {send.isError && (
        <div role="alert" className="px-4 py-2 text-small text-danger">
          {tr('发送失败：')}
          {send.error.message}
          <Button size="sm" variant="ghost" onClick={() => send.reset()}>
            {tr('继续编辑')}
          </Button>
        </div>
      )}
      <Composer
        mentionProjectId={projectId}
        mentionDraftKey={
          me?.id
            ? `srh-mention-draft:v1:${me.id}:${projectId}:${threadId ?? 'project'}:team`
            : undefined
        }
        inline
        toolbar={
          <ConversationAttachmentButton
            attachments={attachments}
            disabled={!writable || send.isPending}
          />
        }
        menu={
          <ConversationAttachmentList
            attachments={attachments}
            disabled={!writable || send.isPending}
          />
        }
        sendDisabled={attachments.isUploading || attachments.hasErrors}
        channel="team"
        className="shrink-0 p-3"
        value={draft}
        onChange={setDraft}
        label={tr('发送到团队讨论')}
        placeholder={writable ? tr('发送到团队讨论…') : tr('访客只能查看')}
        disabled={!writable || send.isPending}
        onSubmit={(input) => {
          const submitted = draft;
          send.mutate(
            { ...input, fileIds: attachments.fileIds },
            {
              onSuccess: () => {
                clearSubmittedDraft(projectId, threadId, me?.id, 'team', submitted);
              },
            },
          );
        }}
      />
    </div>
  );
}
