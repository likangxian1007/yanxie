import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ThreadSummary } from '@srh/shared';
import { api, ApiRequestError } from '@/lib/api';
import { useProjectEvent } from '@/lib/realtime';

export const threadSummariesKey = (pid: string) => ['p', pid, 'thread-summaries'] as const;

/** 这些事件可能改变产出数、未答决策或“在等谁”，到达时重新拉汇总 */
const REFRESH_ON =
  /^(decision\.|thread\.|inbox\.|review|message\.(created|updated|deleted)|claim\.conflict)/;

/**
 * GET P/thread-summaries：每个项目线程的产出数、未答决策、在等哪些成员。
 * 老版本后端没有这个接口（404）时返回 undefined，面板退回到只用线程和 agent 状态推断。
 */
export function useThreadSummaries(pid: string) {
  const qc = useQueryClient();
  useProjectEvent(pid, (event) => {
    if (REFRESH_ON.test(event.type)) {
      void qc.invalidateQueries({ queryKey: threadSummariesKey(pid) });
    }
  });
  return useQuery({
    queryKey: threadSummariesKey(pid),
    queryFn: async ({ signal }) => {
      try {
        const res = await api.get<unknown>(`/projects/${pid}/thread-summaries`, { signal });
        // 只认数组；别的形状（老后端、代理错误页）当作没有汇总
        return Array.isArray(res) ? (res as ThreadSummary[]) : null;
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) return null;
        throw err;
      }
    },
    enabled: Boolean(pid),
    staleTime: 15_000,
    retry: false,
  });
}
