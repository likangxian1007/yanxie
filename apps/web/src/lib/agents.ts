import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentSession } from '@srh/shared';
import { api } from './api';
import { qk } from './query-keys';

function writeAgent(list: AgentSession[] | undefined, a: AgentSession) {
  return list?.map((x) => (x.id === a.id ? a : x));
}

/**
 * 让停下的 agent 继续（POST P/agents/:id/resume）：会话变 queued，agent 收到「成员要求继续」的唤醒。
 * 接口还没部署（404）时，调用方提示在线程里回一句话，效果相同。
 */
export function useResumeAgent(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sid: string) => api.post<AgentSession>(`/projects/${pid}/agents/${sid}/resume`),
    onSuccess: (a) => {
      if (!a?.id) return;
      qc.setQueryData<AgentSession[]>(qk.agents(pid), (list) => writeAgent(list, a));
    },
  });
}
