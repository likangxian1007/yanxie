import { useMutation, useQuery } from '@tanstack/react-query';
import type { HybridRedactPreview, HybridStatus } from '@srh/shared';
import { api } from '@/lib/api';

/** 混合 AI 状态（本地模型探活、分流规则、调用统计）。看板页 5 秒刷新一次 */
export function useHybridStatus(opts: { live?: boolean } = {}) {
  return useQuery({
    queryKey: ['hybrid', 'status'],
    queryFn: ({ signal }) => api.get<HybridStatus>('/hybrid/status', { signal }),
    refetchInterval: opts.live ? 5000 : false,
    staleTime: 15_000,
  });
}

export function useRedactPreview() {
  return useMutation({
    mutationFn: (text: string) => api.post<HybridRedactPreview>('/hybrid/redact-preview', { text }),
  });
}
