import { useQuery } from '@tanstack/react-query';
import type { Decision } from '@srh/shared';
import { qk } from '@/lib/query-keys';

/** 决策：优先读缓存（decision.* 事件会写进来），否则用消息 meta 里带的快照。 */
export function useDecision(pid: string, id: string | undefined, snapshot: Decision | undefined) {
  return useQuery({
    queryKey: qk.decision(pid, id ?? ''),
    queryFn: () => snapshot as Decision,
    enabled: Boolean(id && snapshot),
    initialData: snapshot,
    staleTime: Infinity,
  });
}
