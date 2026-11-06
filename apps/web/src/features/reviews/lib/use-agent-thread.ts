import type { ActorRef } from '@srh/shared';
import { useAgents, useProjectId, useThreads } from '@/lib/project';

/** agent 作者所在线程的标题（agent id = 会话 id → 会话的 threadId）；不是 agent 或找不到时为 null */
export function useAgentThreadTitle(actor: ActorRef): string | null {
  const pid = useProjectId();
  const agents = useAgents(pid);
  const threads = useThreads(pid);
  if (actor.kind !== 'agent' || !actor.id) return null;
  const session = agents.data?.find((a) => a.id === actor.id);
  if (!session?.threadId) return null;
  return threads.data?.find((t) => t.id === session.threadId)?.title ?? null;
}
