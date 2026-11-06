import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ChangelogEntry,
  CreateChangelogInput,
  TicketDetail,
  TicketStatus,
  TicketSummary,
  TicketVoteResponse,
  UpdateChangelogInput,
  UpdateTicketInput,
  UserNotificationList,
} from '@srh/shared';
import { api, type QueryParams } from '@/lib/api';
import { usePageVisible } from './use-page-visible';

/** 反馈中心的查询键（与项目无关，账号级数据）。 */
export const feedbackKeys = {
  root: ['feedback'] as const,
  tickets: (params: TicketListParams) => ['feedback', 'tickets', params] as const,
  ticketsRoot: ['feedback', 'tickets'] as const,
  ticket: (no: string | number) => ['feedback', 'ticket', String(no)] as const,
  changelog: ['feedback', 'changelog'] as const,
  notifications: (unread: boolean) =>
    ['feedback', 'notifications', unread ? 'unread' : 'all'] as const,
  notificationsRoot: ['feedback', 'notifications'] as const,
};

export const TICKET_POLL_MS = 15_000;
export const DETAIL_POLL_MS = 5_000;
export const NOTIFICATION_POLL_MS = 30_000;

export interface TicketListParams {
  scope?: 'all' | 'mine' | 'waiting';
  status?: string;
  kind?: 'bug' | 'idea' | 'question';
  roadmap?: string;
  q?: string;
  assignee?: string;
  sort?: 'recent' | 'votes';
  limit?: number;
}

function toQuery(params: TicketListParams): QueryParams {
  const q: QueryParams = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q[k] = v as string;
  return q;
}

export function useTickets(params: TicketListParams, options: { poll?: boolean } = {}) {
  const visible = usePageVisible();
  return useQuery({
    queryKey: feedbackKeys.tickets(params),
    queryFn: ({ signal }) =>
      api.get<TicketSummary[]>('/feedback/tickets', { query: toQuery(params), signal }),
    placeholderData: keepPreviousData,
    refetchInterval: options.poll !== false && visible ? TICKET_POLL_MS : false,
    staleTime: 5_000,
  });
}

export function useTicket(no: string) {
  const visible = usePageVisible();
  return useQuery({
    queryKey: feedbackKeys.ticket(no),
    queryFn: ({ signal }) =>
      api.get<TicketDetail>(`/feedback/tickets/${encodeURIComponent(no)}`, { signal }),
    refetchInterval: visible ? DETAIL_POLL_MS : false,
    staleTime: 2_000,
    enabled: !!no,
  });
}

export function markTicketRead(no: string | number) {
  return api.post<void>(`/feedback/tickets/${encodeURIComponent(String(no))}/read`);
}

export function useUpdateTicket(no: string | number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateTicketInput) =>
      api.patch<TicketDetail>(`/feedback/tickets/${encodeURIComponent(String(no))}`, patch),
    onSuccess: (detail) => {
      qc.setQueryData(feedbackKeys.ticket(String(no)), detail);
      void qc.invalidateQueries({ queryKey: feedbackKeys.ticketsRoot });
    },
  });
}

/** 看板拖动：乐观更新所有列表缓存，失败回滚。 */
export function useMoveTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ no, status }: { no: number; status: TicketStatus }) =>
      api.patch<TicketDetail>(`/feedback/tickets/${no}`, { status }),
    onMutate: async ({ no, status }) => {
      await qc.cancelQueries({ queryKey: feedbackKeys.ticketsRoot });
      const snapshot = qc.getQueriesData<TicketSummary[]>({ queryKey: feedbackKeys.ticketsRoot });
      qc.setQueriesData<TicketSummary[]>({ queryKey: feedbackKeys.ticketsRoot }, (list) =>
        list?.map((t) => (t.no === no ? { ...t, status } : t)),
      );
      return { snapshot };
    },
    onError: (_err, _vars, ctx) => {
      for (const [key, data] of ctx?.snapshot ?? []) qc.setQueryData(key, data);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: feedbackKeys.ticketsRoot }),
  });
}

export function useSendMessage(no: string | number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ body, files }: { body: string; files: File[] }) => {
      const path = `/feedback/tickets/${encodeURIComponent(String(no))}/messages`;
      if (files.length === 0) return api.post<unknown>(path, { body });
      const form = new FormData();
      form.append('body', body);
      for (const f of files) form.append('files', f, f.name);
      return api.post<unknown>(path, form);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: feedbackKeys.ticket(String(no)) });
      void qc.invalidateQueries({ queryKey: feedbackKeys.ticketsRoot });
    },
  });
}

export function useVote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ no, voted }: { no: number; voted: boolean }) =>
      voted
        ? api.delete<TicketVoteResponse>(`/feedback/tickets/${no}/vote`)
        : api.post<TicketVoteResponse>(`/feedback/tickets/${no}/vote`),
    onMutate: async ({ no, voted }) => {
      await qc.cancelQueries({ queryKey: feedbackKeys.ticketsRoot });
      const snapshot = qc.getQueriesData<TicketSummary[]>({ queryKey: feedbackKeys.ticketsRoot });
      qc.setQueriesData<TicketSummary[]>({ queryKey: feedbackKeys.ticketsRoot }, (list) =>
        list?.map((t) =>
          t.no === no ? { ...t, voted: !voted, voteCount: t.voteCount + (voted ? -1 : 1) } : t,
        ),
      );
      return { snapshot };
    },
    onError: (_e, _v, ctx) => {
      for (const [key, data] of ctx?.snapshot ?? []) qc.setQueryData(key, data);
    },
    onSuccess: (res, { no }) => {
      qc.setQueriesData<TicketSummary[]>({ queryKey: feedbackKeys.ticketsRoot }, (list) =>
        list?.map((t) => (t.no === no ? { ...t, ...res } : t)),
      );
    },
  });
}

export function useChangelog() {
  return useQuery({
    queryKey: feedbackKeys.changelog,
    queryFn: ({ signal }) => api.get<ChangelogEntry[]>('/changelog', { signal }),
    staleTime: 60_000,
  });
}

export function useSaveChangelog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id?: string | undefined;
      input: Partial<CreateChangelogInput> | UpdateChangelogInput;
    }) =>
      id
        ? api.patch<ChangelogEntry>(`/changelog/${id}`, input)
        : api.post<ChangelogEntry>('/changelog', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: feedbackKeys.changelog });
      void qc.invalidateQueries({ queryKey: feedbackKeys.ticketsRoot });
    },
  });
}

export function useDeleteChangelog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/changelog/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: feedbackKeys.changelog }),
  });
}

export function useNotifications(unreadOnly: boolean, enabled = true) {
  const visible = usePageVisible();
  return useQuery({
    queryKey: feedbackKeys.notifications(unreadOnly),
    queryFn: ({ signal }) =>
      api.get<UserNotificationList>('/me/notifications', {
        query: { limit: 30, ...(unreadOnly ? { unread: 1 } : {}) },
        signal,
      }),
    refetchInterval: visible ? NOTIFICATION_POLL_MS : false,
    staleTime: 10_000,
    enabled,
    retry: false,
  });
}

export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { ids: string[] } | { all: true }) =>
      api.post<void>('/me/notifications/read', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: feedbackKeys.notificationsRoot }),
  });
}
