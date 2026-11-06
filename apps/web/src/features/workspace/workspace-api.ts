import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Message, SessionSettingsInput, Thread } from '@srh/shared';
import { api } from '@/lib/api';
import { upsertMessage, upsertThread, type MessagePages } from '@/lib/apply-event';
import { useThreads } from '@/lib/project';
import { qk } from '@/lib/query-keys';

/**
 * 我的工作区的数据层：个人会话 = kind 为 personal 的线程，只有主人自己能看到。
 * 实时事件（thread.created / thread.updated）由 lib/apply-event 统一写进同一套缓存。
 */

const PERSONAL = { kind: 'personal' } as const;

/** 我的个人会话（服务端按最近活动倒序）。 */
export function usePersonalThreads(pid: string) {
  return useThreads(pid, PERSONAL);
}

/** 新建个人会话：第一句话就是根消息，个人 agent 会马上开始回复。 */
export function useCreatePersonalThread(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    /** 明确选择的模型、强度和角色随首条消息一起创建。 */
    mutationFn: (input: { body: string; title?: string } & SessionSettingsInput) =>
      api.post<Thread>(`/projects/${pid}/threads`, input),
    onSuccess: (thread) => upsertThread(qc, pid, thread),
  });
}

export interface ThreadPatch {
  title?: string;
  resolved?: boolean;
}

/** 改标题 / 标为已解决：先乐观写缓存，失败回滚。 */
export function useUpdatePersonalThread(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ thread, patch }: { thread: Thread; patch: ThreadPatch }) =>
      api.patch<Thread>(`/projects/${pid}/threads/${thread.id}`, patch),
    onMutate: ({ thread, patch }) => {
      const previous = qc.getQueryData<Thread>(qk.thread(pid, thread.id)) ?? thread;
      upsertThread(qc, pid, { ...previous, ...patch });
      return { previous };
    },
    onSuccess: (thread) => upsertThread(qc, pid, thread),
    onError: (_err, _vars, ctx) => {
      if (ctx) upsertThread(qc, pid, ctx.previous);
    },
  });
}

/** 转给协调者：时间线上出现转发卡片，线程记下 forwardedAt。 */
export function useForwardThread(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ thread, note }: { thread: Thread; note: string }) =>
      api.post<Message>(`/projects/${pid}/threads/${thread.id}/forward`, { note }),
    onSuccess: (msg, { thread }) => {
      const current = qc.getQueryData<Thread>(qk.thread(pid, thread.id)) ?? thread;
      upsertThread(qc, pid, {
        ...current,
        forwardedAt: current.forwardedAt ?? msg.createdAt,
        lastActivityAt: msg.createdAt,
      });
      qc.setQueryData<MessagePages>(qk.timeline(pid), (d) => upsertMessage(d, msg));
    },
  });
}

/** 停止个人 agent 当前这一轮回复。 */
export function useStopAgent(pid: string) {
  return useMutation({
    mutationFn: (sessionId: string) => api.post(`/projects/${pid}/agents/${sessionId}/stop`),
  });
}
