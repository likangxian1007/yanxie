import { useMemo } from 'react';
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  DocumentMeta,
  Report,
  Review,
  ReviewComment,
  ReviewCreateInput,
  ReviewTargetKind,
  ReviewVerdict,
} from '@srh/shared';
import type { SelectOption } from '@/components/ui';
import { api, resolveApiUrl } from '@/lib/api';
import { researchApi } from '@/features/research/data';
import { useThreads } from '@/lib/project';
import { useProjectEvent } from '@/lib/realtime';
import { ck } from '@/features/collab-kit/keys';
import { planDocumentId } from './lib/target';
import { tr } from '@/lib/i18n';

/** GET P/reviews/:id 的响应 */
export type ReviewDetail = Review & { comments: ReviewComment[] };

const base = (pid: string) => `/projects/${pid}/reviews`;

export function useReviews(pid: string) {
  return useQuery(reviewsQueryOptions(pid));
}

export function reviewsQueryOptions(pid: string) {
  return queryOptions({
    queryKey: ck.reviews(pid),
    queryFn: ({ signal }) => api.get<Review[]>(base(pid), { signal }),
    enabled: Boolean(pid),
  });
}

export function useReview(pid: string, id: string) {
  return useQuery({
    queryKey: ck.review(pid, id),
    queryFn: ({ signal }) => api.get<ReviewDetail>(`${base(pid)}/${id}`, { signal }),
    enabled: Boolean(pid && id),
  });
}

// ---------------------------------------------------------------- 缓存

export function upsertReviewCache(qc: QueryClient, pid: string, review: Review) {
  qc.setQueryData<Review[]>(ck.reviews(pid), (list) => {
    if (!list) return list;
    const i = list.findIndex((r) => r.id === review.id);
    const next = i === -1 ? [review, ...list] : list.map((r) => (r.id === review.id ? review : r));
    return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });
  qc.setQueryData<ReviewDetail>(ck.review(pid, review.id), (cur) => {
    if (!cur) return cur;
    // 只带 Review 字段时保留已加载的评论
    const comments = 'comments' in review ? (review as ReviewDetail).comments : cur.comments;
    return { ...cur, ...review, comments };
  });
}

export function upsertCommentCache(qc: QueryClient, pid: string, comment: ReviewComment) {
  let added = false;
  qc.setQueryData<ReviewDetail>(ck.review(pid, comment.reviewId), (cur) => {
    if (!cur) return cur;
    const i = cur.comments.findIndex((c) => c.id === comment.id);
    if (i !== -1) {
      const comments = cur.comments.slice();
      comments[i] = comment;
      return { ...cur, comments };
    }
    added = true;
    return { ...cur, comments: [...cur.comments, comment], commentCount: cur.commentCount + 1 };
  });
  if (added) {
    qc.setQueryData<Review[]>(ck.reviews(pid), (list) =>
      list?.map((r) =>
        r.id === comment.reviewId ? { ...r, commentCount: r.commentCount + 1 } : r,
      ),
    );
  }
}

/** review.* 事件 → 列表与详情缓存 */
export function useReviewEvents(pid: string) {
  const qc = useQueryClient();
  useProjectEvent(pid, (event) => {
    switch (event.type) {
      case 'review.created':
      case 'review.updated':
        upsertReviewCache(qc, pid, event.payload);
        break;
      case 'review.comment_created':
      case 'review.comment_updated':
        upsertCommentCache(qc, pid, event.payload);
        break;
      default:
        break;
    }
  });
}

// ---------------------------------------------------------------- 写入

export function useCreateReview(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReviewCreateInput) => api.post<Review>(base(pid), input),
    onSuccess: (review) => upsertReviewCache(qc, pid, review),
  });
}

export interface VerdictSubmit {
  verdict: Exclude<ReviewVerdict, 'pending'>;
  comment?: string;
}

export function useSubmitVerdict(pid: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: VerdictSubmit) => api.post<Review>(`${base(pid)}/${id}/verdict`, input),
    onSuccess: (review) => {
      upsertReviewCache(qc, pid, review);
      // 结论评论由服务端生成，拉一次详情拿到它
      void qc.invalidateQueries({ queryKey: ck.review(pid, id), exact: true });
    },
  });
}

export function useAddReviewComment(pid: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { body: string; anchor: Record<string, unknown> | null }) =>
      api.post<ReviewComment>(`${base(pid)}/${id}/comments`, input),
    onSuccess: (comment) => upsertCommentCache(qc, pid, comment),
  });
}

export function useResolveComment(pid: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, resolved }: { commentId: string; resolved: boolean }) =>
      api.patch<ReviewComment>(`${base(pid)}/${id}/comments/${commentId}`, { resolved }),
    onMutate: ({ commentId, resolved }) => {
      qc.setQueryData<ReviewDetail>(ck.review(pid, id), (cur) =>
        cur
          ? {
              ...cur,
              comments: cur.comments.map((c) => (c.id === commentId ? { ...c, resolved } : c)),
            }
          : cur,
      );
    },
    onSuccess: (comment) => upsertCommentCache(qc, pid, comment),
    onError: () => void qc.invalidateQueries({ queryKey: ck.review(pid, id), exact: true }),
  });
}

export function useCloseReview(pid: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<Review>(`${base(pid)}/${id}/close`),
    onSuccess: (review) => upsertReviewCache(qc, pid, review),
  });
}

// ---------------------------------------------------------------- 审阅目标

export interface TargetOptionsResult {
  options: SelectOption[];
  isLoading: boolean;
  isError: boolean;
}

/** 按目标类型拉可选列表：文档 / 实验 / 汇报 / 线程 */
export function useTargetOptions(pid: string, kind: ReviewTargetKind, enabled: boolean) {
  const docs = useQuery({
    queryKey: [...ck.docs(pid), 'picker'] as const,
    queryFn: ({ signal }) => api.get<DocumentMeta[]>(`/projects/${pid}/docs`, { signal }),
    enabled: enabled && kind === 'document' && Boolean(pid),
  });
  const researchRecords = useQuery({
    queryKey: ['p', pid, 'research', 'records', 'review-picker'] as const,
    queryFn: ({ signal }) => researchApi.records(pid, signal),
    enabled: enabled && kind === 'research_record' && Boolean(pid),
  });
  const reports = useQuery({
    queryKey: [...ck.reports(pid), 'picker'] as const,
    queryFn: ({ signal }) => api.get<Report[]>(`/projects/${pid}/reports`, { signal }),
    enabled: enabled && kind === 'report' && Boolean(pid),
  });
  const threads = useThreads(pid, { kind: 'project' });

  return useMemo<TargetOptionsResult>(() => {
    switch (kind) {
      case 'document':
        return {
          options: (docs.data ?? [])
            .filter((d) => !d.archivedAt)
            .map((d) => ({ value: d.id, label: d.title || tr('未命名文档') })),
          isLoading: docs.isPending && docs.fetchStatus !== 'idle',
          isError: docs.isError,
        };
      case 'experiment':
        return { options: [], isLoading: false, isError: false };
      case 'research_record':
        return {
          options: (researchRecords.data ?? []).map((record) => ({
            value: record.id,
            label: record.title,
          })),
          isLoading: researchRecords.isPending && researchRecords.fetchStatus !== 'idle',
          isError: researchRecords.isError,
        };
      case 'report':
        return {
          options: (reports.data ?? []).map((r) => ({ value: r.id, label: r.title })),
          isLoading: reports.isPending && reports.fetchStatus !== 'idle',
          isError: reports.isError,
        };
      case 'thread':
        return {
          options: (threads.data ?? []).map((t) => ({ value: t.id, label: t.title })),
          isLoading: threads.isPending && threads.fetchStatus !== 'idle',
          isError: threads.isError,
        };
      default:
        return { options: [], isLoading: false, isError: false };
    }
  }, [
    kind,
    docs.data,
    docs.isPending,
    docs.fetchStatus,
    docs.isError,
    researchRecords.data,
    researchRecords.isPending,
    researchRecords.fetchStatus,
    researchRecords.isError,
    reports.data,
    reports.isPending,
    reports.fetchStatus,
    reports.isError,
    threads.data,
    threads.isPending,
    threads.fetchStatus,
    threads.isError,
  ]);
}

/** 计划目标（doc_…）的文档标题；其他目标不请求 */
export function usePlanDocumentTitle(pid: string, kind: ReviewTargetKind, id: string) {
  const docId = planDocumentId(kind, id);
  return useQuery({
    queryKey: ck.doc(pid, docId ?? ''),
    enabled: Boolean(pid && docId),
    queryFn: ({ signal }) => api.get<DocumentMeta>(`/projects/${pid}/docs/${docId}`, { signal }),
    select: (doc) => doc.title,
    retry: false,
  });
}

/**
 * 同一目标的上一轮审阅（被本审阅取代的那一轮），用来显示两轮快照之间的差异。
 * 来自 GET P/reviews?targetKind=&targetId=，找 supersededById === 本审阅 的那条。
 */
export function usePreviousRound(pid: string, review: Review) {
  return useQuery({
    queryKey: ['p', pid, 'review-rounds', review.targetKind, review.targetId] as const,
    enabled: Boolean(pid),
    queryFn: ({ signal }) =>
      api.get<Review[]>(base(pid), {
        signal,
        query: { targetKind: review.targetKind, targetId: review.targetId },
      }),
    select: (list) => list.find((r) => r.supersededById === review.id) ?? null,
  });
}

/** 目标的“当前版本”markdown（文档 / 实验 / 汇报），用来与发起时的快照对比 */
export function useCurrentTargetContent(
  pid: string,
  rawKind: ReviewTargetKind,
  id: string,
  enabled: boolean,
) {
  // 计划存成文档（doc_…）时按文档取当前内容
  const kind: ReviewTargetKind = planDocumentId(rawKind, id) ? 'document' : rawKind;
  return useQuery({
    queryKey: ['p', pid, 'review-target', kind, id] as const,
    enabled: enabled && Boolean(pid && id),
    queryFn: async ({ signal }): Promise<string> => {
      if (kind === 'document') {
        const res = await api.get<{ markdown: string }>(`/projects/${pid}/docs/${id}/markdown`, {
          signal,
        });
        return res.markdown;
      }
      if (kind === 'experiment') return tr('内容已移除');
      if (kind === 'research_record') {
        const res = await fetch(
          resolveApiUrl(`/projects/${pid}/research/records/${id}/export`, { format: 'markdown' }),
          { credentials: 'include', signal },
        );
        if (!res.ok) throw new Error(tr('研究空间没有加载出来，请稍后重试。'));
        return res.text();
      }
      if (kind === 'report') {
        const report = await api.get<Report>(`/projects/${pid}/reports/${id}`, { signal });
        return report.content;
      }
      return '';
    },
  });
}
