import { clientId } from '@/lib/client-id';
import { clearSubmittedAttachments } from '@/components/chat/conversation-attachments';
import { useMemo } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Message, MessageMention, Page, User } from '@srh/shared';
import { api } from './api';
import { removeMessageCaches, updateMessageCaches } from './apply-event';
import { qk, type MessageChannel } from './query-keys';
import { tr } from '@/lib/i18n';

/**
 * 消息流：时间线（threadId 为空）或某线程的消息。接口按新→旧分页，这里转成旧→新给界面用。
 */
export function useMessageFeed(
  pid: string,
  threadId: string | null,
  channel: MessageChannel = 'all',
) {
  const key = threadId ? qk.threadMessages(pid, threadId, channel) : qk.timeline(pid, channel);
  const path = threadId
    ? `/projects/${pid}/threads/${threadId}/messages`
    : `/projects/${pid}/timeline`;
  const query = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) =>
      api.get<Page<Message>>(path, {
        signal,
        query: { cursor: pageParam ?? undefined, limit: 50, channel },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(pid),
    staleTime: Infinity,
  });
  const messages = useMemo(() => {
    const all = query.data?.pages.flatMap((p) => p.items) ?? [];
    const seen = new Set<string>();
    const out: Message[] = [];
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const m = all[i];
      if (!m || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
    return out;
  }, [query.data]);
  return { ...query, messages };
}

export interface SendMessageInput {
  mentions?: MessageMention[];
  body: string;
  agentVisible: boolean;
  fileIds?: string[];
}

/** 发消息：先乐观插入一条 tmp_ 消息，服务端返回或事件到达时替换。 */
export function useSendMessage(pid: string, threadId: string | null, me: User | null) {
  const qc = useQueryClient();
  const key = threadId ? qk.threadMessages(pid, threadId) : qk.timeline(pid);
  const path = threadId
    ? `/projects/${pid}/threads/${threadId}/messages`
    : `/projects/${pid}/timeline`;
  return useMutation({
    mutationFn: (input: SendMessageInput) => api.post<Message>(path, { fileIds: [], ...input }),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: key });
      const tmp: Message = {
        id: `tmp_${clientId()}`,
        projectId: pid,
        threadId,
        author: { kind: 'user', id: me?.id ?? null, name: me?.name ?? tr('我') },
        kind: 'text',
        body: input.body,
        meta: { pending: true, mentions: input.mentions ?? [] },
        agentVisible: input.agentVisible,
        reactions: [],
        outputs: [],
        rootOfThreadId: null,
        editedAt: null,
        createdAt: new Date().toISOString(),
      };
      updateMessageCaches(qc, tmp);
      return { tmpId: tmp.id };
    },
    onSuccess: (msg, _input, ctx) => {
      updateMessageCaches(qc, msg, ctx.tmpId);
      clearSubmittedAttachments(
        me?.id,
        pid,
        threadId,
        _input.agentVisible ? 'agent' : 'team',
        _input.fileIds ?? [],
      );
    },
    onError: (_err, _input, ctx) => {
      if (ctx) removeMessageCaches(qc, pid, threadId, ctx.tmpId);
    },
  });
}

/** 反应：已点过则取消。 */
export function useToggleReaction(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ message, emoji, mine }: { message: Message; emoji: string; mine: boolean }) =>
      mine
        ? api.delete<Message>(
            `/projects/${pid}/messages/${message.id}/reactions/${encodeURIComponent(emoji)}`,
          )
        : api.put<Message>(`/projects/${pid}/messages/${message.id}/reactions`, { emoji }),
    onSuccess: (msg) => {
      if (!msg) return;
      updateMessageCaches(qc, msg);
    },
  });
}

export function useEditMessage(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      body,
      mentions,
    }: {
      id: string;
      body: string;
      mentions?: MessageMention[];
    }) => api.patch<Message>(`/projects/${pid}/messages/${id}`, { body, mentions }),
    onSuccess: (msg) => {
      updateMessageCaches(qc, msg);
    },
  });
}

export function useDeleteMessage(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (m: Message) => api.delete(`/projects/${pid}/messages/${m.id}`),
    onSuccess: (_r, m) => {
      removeMessageCaches(qc, pid, m.threadId, m.id);
    },
  });
}
