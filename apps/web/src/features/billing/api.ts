import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BillingOverview, PayOrderView, TopupCheckout } from '@srh/shared';
import { api } from '@/lib/api';

/** 余额与充值（API.md §2.24），账号级数据。 */
export const billingKeys = {
  me: ['billing', 'me'] as const,
  order: (ref: string) => ['billing', 'order', ref] as const,
};

export function useBilling(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: billingKeys.me,
    queryFn: ({ signal }) => api.get<BillingOverview>('/billing/me', { signal }),
    staleTime: 30_000,
    enabled: options.enabled ?? true,
  });
}

export function useStartTopup() {
  return useMutation({
    mutationFn: (sku: string) => api.post<TopupCheckout>('/billing/topup', { sku }),
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
      if (order.status !== 'created') void qc.invalidateQueries({ queryKey: billingKeys.me });
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
