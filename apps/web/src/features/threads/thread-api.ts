import { useMemo } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import type {
  AgentSession,
  AgentStep,
  AgentStopResult,
  Page,
  Review,
  Thread,
  ReviewVerdict,
} from '@srh/shared';
import { api, ApiRequestError } from '@/lib/api';
import { removeThread, upsertThread } from '@/lib/apply-event';
import { qk } from '@/lib/query-keys';
import { useProjectEvent } from '@/lib/realtime';
import { flattenSteps, reviewBelongsToThread, reviewsForThread } from './thread-utils';

/** 线程页自己的查询键（以 ['p', pid, …] 开头，resync 时随项目一起失效）。 */
export const threadKeys = {
  reviews: (pid: string, tid: string) =>
    ['p', pid, 'reviews', { targetKind: 'thread', targetId: tid }] as const,
};

// ---------------------------------------------------------------- 线程

export type ThreadPatch = {
  title?: string;
  label?: string | null;
  resolved?: boolean;
  /** 计划（状态清单原文）：成员在计划卡上直接改 */
  statusText?: string;
};

/** PATCH 线程：先乐观改详情缓存，成功后按事件同样的方式写进列表缓存。 */
export function useUpdateThread(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ThreadPatch }) =>
      api.patch<Thread>(`/projects/${pid}/threads/${id}`, patch),
    onMutate: async ({ id, patch }) => {
      const key = qk.thread(pid, id);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Thread>(key);
      if (prev) qc.setQueryData<Thread>(key, { ...prev, ...patch });
      return { prev };
    },
    onSuccess: (t) => upsertThread(qc, pid, t),
    onError: (_e, { id }, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.thread(pid, id), ctx.prev);
    },
  });
}

/** 删除自己的个人会话（项目线程不能删，只能归档）。 */
export function useDeleteThread(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/projects/${pid}/threads/${id}`),
    onSuccess: (_r, id) => removeThread(qc, pid, id),
  });
}

/** 中止 agent 当前这一轮。 */
export function useStopAgent(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    // 服务端也会取消排队中、还没开始的一轮（stopped 说明停掉了什么）
    mutationFn: (sid: string) => api.post<AgentStopResult>(`/projects/${pid}/agents/${sid}/stop`),
    onSuccess: (a) => {
      if (!a?.id) return;
      qc.setQueryData<AgentSession[]>(qk.agents(pid), (list) =>
        list?.map((x) => (x.id === a.id ? a : x)),
      );
    },
  });
}

// ---------------------------------------------------------------- agent 思路

export type StepPages = InfiniteData<Page<AgentStep>, string | null>;

/**
 * agent 的步骤：按 order=desc 分页（每页新→旧），和 apply-event 把新步骤插到第一页最前一致；
 * 返回的 steps 已经转成旧→新。
 */
export function useAgentSteps(pid: string, sid: string | null | undefined) {
  const query = useInfiniteQuery({
    queryKey: qk.agentSteps(pid, sid ?? ''),
    queryFn: ({ pageParam, signal }) =>
      api.get<Page<AgentStep>>(`/projects/${pid}/agents/${sid}/steps`, {
        signal,
        query: { order: 'desc', limit: 50, cursor: pageParam ?? undefined },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(pid && sid),
    staleTime: 30_000,
  });
  const steps = useMemo(() => flattenSteps(query.data?.pages), [query.data]);
  return { ...query, steps };
}

// ---------------------------------------------------------------- 审阅

function upsertReview(list: Review[] | undefined, r: Review): Review[] | undefined {
  if (!list) return list;
  const i = list.findIndex((x) => x.id === r.id);
  if (i === -1) return [r, ...list];
  const next = list.slice();
  next[i] = r;
  return next;
}

/**
 * 属于这个线程的审阅（新→旧）：直接审阅线程的，以及线程 agent 发起、审阅计划或文档的
 *（后者 targetKind 不是 thread，但带 threadId）。列表接口没有 threadId 过滤，取全项目后在前端筛。
 * review.* 事件到达时就地更新。
 */
export function useThreadReviews(pid: string, tid: string) {
  const qc = useQueryClient();
  const key = threadKeys.reviews(pid, tid);
  useProjectEvent(pid, (event) => {
    if (event.type !== 'review.created' && event.type !== 'review.updated') return;
    const r = event.payload;
    if (!reviewBelongsToThread(r, tid)) return;
    qc.setQueryData<Review[]>(key, (list) => upsertReview(list, r));
  });
  return useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      try {
        const data = await api.get<Review[] | Page<Review>>(`/projects/${pid}/reviews`, {
          signal,
        });
        return reviewsForThread(data, tid);
      } catch (e) {
        // 审阅模块还没部署（路由 404）时当作暂无审阅
        if (e instanceof ApiRequestError && e.status === 404) return [];
        throw e;
      }
    },
    enabled: Boolean(pid && tid),
  });
}

export interface ReviewCreate {
  title: string;
  summary: string;
  reviewerIds: string[];
}

export function useCreateReview(pid: string, tid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewCreate) =>
      api.post<Review>(`/projects/${pid}/reviews`, {
        targetKind: 'thread',
        targetId: tid,
        threadId: tid,
        ...input,
      }),
    onSuccess: (r) =>
      qc.setQueryData<Review[]>(threadKeys.reviews(pid, tid), (list) => upsertReview(list, r)),
  });
}

export type VerdictValue = Exclude<ReviewVerdict, 'pending'>;

export function useReviewVerdict(pid: string, tid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      reviewId,
      verdict,
      comment,
    }: {
      reviewId: string;
      verdict: VerdictValue;
      comment?: string | undefined;
    }) =>
      api.post<Review>(`/projects/${pid}/reviews/${reviewId}/verdict`, {
        verdict,
        ...(comment ? { comment } : {}),
      }),
    onSuccess: (r) =>
      qc.setQueryData<Review[]>(threadKeys.reviews(pid, tid), (list) => upsertReview(list, r)),
  });
}
