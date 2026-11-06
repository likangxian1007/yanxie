import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentSession, AgentStopResult } from '@srh/shared';
import { api } from '@/lib/api';
import { qk } from '@/lib/query-keys';
import { tr } from '@/lib/i18n';

/**
 * /stop：不管界面上 agent 看起来是不是空闲，都调一次 stop。
 * 成员刚发完消息时 agent 可能还显示空闲，但这一轮已经排上队了；服务端会把排队的唤醒一起取消，
 * 并在 stopped 里说清停掉了什么。
 */
export function stopResultTitle(
  r: Pick<AgentStopResult, 'status'> & Partial<Pick<AgentStopResult, 'stopped'>>,
): string {
  // 旧服务端没有 stopped 字段：按状态猜
  const what = r.stopped ?? (r.status === 'stopped' ? 'turn' : 'none');
  if (what === 'turn') return tr('已停下');
  if (what === 'queued') return tr('已取消排队中的这一轮');
  return tr('agent 现在没在回复');
}

export function useStopTurn(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      api.post<AgentStopResult>(`/projects/${pid}/agents/${sessionId}/stop`),
    onSuccess: (r) => {
      // 不等 agent.updated，先把状态写进缓存
      qc.setQueryData<AgentSession[]>(qk.agents(pid), (list) =>
        list?.map((a) =>
          a.id === r.id
            ? { ...a, status: r.status, activity: r.activity, lastActivityAt: r.lastActivityAt }
            : a,
        ),
      );
    },
  });
}
