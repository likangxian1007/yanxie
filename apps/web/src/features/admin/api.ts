import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminOverview,
  AdminProjectRow,
  AdminUserRow,
  OpsEvent,
  OpsLevel,
  OpsSource,
  TicketDetail,
} from '@srh/shared';
import { api } from '@/lib/api';
import { usePageVisible } from '@/features/feedback/use-page-visible';
import { feedbackKeys } from '@/features/feedback/api';

export const adminKeys = {
  root: ['admin'] as const,
  overview: ['admin', 'overview'] as const,
  users: (q: string) => ['admin', 'users', q] as const,
  usersRoot: ['admin', 'users'] as const,
  projects: ['admin', 'projects'] as const,
  ops: (p: OpsParams) => ['admin', 'ops', p] as const,
  opsRoot: ['admin', 'ops'] as const,
};

export const OVERVIEW_POLL_MS = 15_000;

export function useAdminOverview(enabled = true) {
  const visible = usePageVisible();
  return useQuery({
    queryKey: adminKeys.overview,
    queryFn: ({ signal }) => api.get<AdminOverview>('/admin/overview', { signal }),
    enabled,
    refetchInterval: visible ? OVERVIEW_POLL_MS : false,
    staleTime: 5_000,
  });
}

export function useAdminUsers(q = '', enabled = true) {
  return useQuery({
    queryKey: adminKeys.users(q),
    queryFn: ({ signal }) =>
      api.get<AdminUserRow[]>('/admin/users', { query: { q: q || undefined }, signal }),
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useSetAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isAdmin }: { id: string; isAdmin: boolean }) =>
      api.patch<AdminUserRow>(`/admin/users/${id}`, { isAdmin }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.usersRoot }),
  });
}

export function useAdminProjects(enabled = true) {
  return useQuery({
    queryKey: adminKeys.projects,
    queryFn: ({ signal }) => api.get<AdminProjectRow[]>('/admin/projects', { signal }),
    enabled,
  });
}

export interface OpsParams {
  level?: OpsLevel | undefined;
  source?: OpsSource | undefined;
  q?: string | undefined;
  open?: boolean | undefined;
}

export function useOpsEvents(p: OpsParams) {
  const visible = usePageVisible();
  return useQuery({
    queryKey: adminKeys.ops(p),
    queryFn: ({ signal }) =>
      api.get<OpsEvent[]>('/admin/ops-events', {
        query: {
          level: p.level,
          source: p.source,
          q: p.q || undefined,
          open: p.open ? 1 : undefined,
          limit: 200,
        },
        signal,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: visible ? 30_000 : false,
  });
}

export function useDeleteOpsEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/admin/ops-events/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.opsRoot }),
  });
}

export function useOpsToTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<TicketDetail>(`/admin/ops-events/${id}/ticket`),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: adminKeys.opsRoot });
      void qc.invalidateQueries({ queryKey: feedbackKeys.ticketsRoot });
    },
  });
}
