import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BillingOverview,
  CreditWallet,
  PayOrderView,
  ProjectBillingView,
  TopupCheckout,
  TurnCredits,
} from '@srh/shared';
import { api } from '@/lib/api';

/** 余额与充值（API.md §2.24）：个人积分是账号级数据，团队积分按项目。 */
export const billingKeys = {
  me: ['billing', 'me'] as const,
  order: (ref: string) => ['billing', 'order', ref] as const,
  project: (id: string) => ['billing', 'project', id] as const,
  turns: (id: string, ids: string) => ['billing', 'turns', id, ids] as const,
};

export function useBilling(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: billingKeys.me,
    queryFn: ({ signal }) => api.get<BillingOverview>('/billing/me', { signal }),
    staleTime: 30_000,
    enabled: options.enabled ?? true,
  });
}

/** 某个项目的团队积分 + 下一次会扣哪个钱包（聊天框的余额提示用） */
export function useProjectBilling(projectId: string | null | undefined) {
  return useQuery({
    queryKey: billingKeys.project(projectId ?? ''),
    queryFn: ({ signal }) =>
      api.get<ProjectBillingView>(`/billing/projects/${encodeURIComponent(projectId!)}`, {
        signal,
      }),
    staleTime: 30_000,
    enabled: !!projectId,
  });
}

/** 每轮 agent 消耗的积分（turnId → 积分） */
export function useTurnCredits(projectId: string | null | undefined, turnIds: string[]) {
  const ids = [...new Set(turnIds)].sort().join(',');
  return useQuery({
    queryKey: billingKeys.turns(projectId ?? '', ids),
    queryFn: async ({ signal }) => {
      const rows = await api.get<TurnCredits[]>(
        `/billing/projects/${encodeURIComponent(projectId!)}/turns?ids=${encodeURIComponent(ids)}`,
        { signal },
      );
      return new Map(rows.map((r) => [r.turnId, r]));
    },
    staleTime: 60_000,
    enabled: !!projectId && ids.length > 0,
  });
}

export function useInvalidateBilling() {
  const qc = useQueryClient();
  return useCallback(() => void qc.invalidateQueries({ queryKey: ['billing'] }), [qc]);
}

export function useStartTopup() {
  return useMutation({
    mutationFn: (input: string | { sku: string; wallet?: CreditWallet; projectId?: string }) =>
      api.post<TopupCheckout>('/billing/topup', typeof input === 'string' ? { sku: input } : input),
  });
}

export function useTransferToTeam(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (credits: number) =>
      api.post<{ personalBalance: number; teamBalance: number }>(
        `/billing/projects/${encodeURIComponent(projectId)}/transfer`,
        { credits },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['billing'] }),
  });
}

export function useSetMemberCap(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; monthlyCap: number | null }) =>
      api.put<{ userId: string; monthlyCap: number | null }>(
        `/billing/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(input.userId)}/cap`,
        { monthlyCap: input.monthlyCap },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['billing'] }),
  });
}

/** 从支付页回来后轮询订单状态（服务端会向 KyrenPay 核实，绝不凭回跳地址入账）。 */
export function useTopupOrder(ref: string | null) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: billingKeys.order(ref ?? ''),
    queryFn: async ({ signal }) => {
      const order = await api.get<PayOrderView>(`/billing/orders/${encodeURIComponent(ref!)}`, {
        signal,
      });
      if (order.status !== 'created') void qc.invalidateQueries({ queryKey: ['billing'] });
      return order;
    },
    enabled: !!ref,
    // 约 2 分钟后停止轮询（webhook 迟到时用户可以手动刷新）
    refetchInterval: (q) =>
      (q.state.data && q.state.data.status !== 'created') || q.state.dataUpdateCount > 40
        ? false
        : 3_000,
  });
}
