import { useCallback, useMemo } from 'react';
import { useAgents, useMemberMap, useThreads } from '@/lib/project';
import { usePresence } from '@/lib/realtime-store';
import { useMeUser } from '@/lib/session';
import { buildPanelThreads, waitingOnMeCount, type PanelThread } from './thread-panel';
import { useThreadSummaries } from './thread-panel-api';
import { tr } from '@/lib/i18n';

export interface PanelThreadsState {
  rows: PanelThread[];
  waitingOnMe: number;
  isPending: boolean;
  error: Error | null;
  refetch: () => void;
  /** userId → 成员名字 / 色号（在等谁、谁在看） */
  nameOf: (userId: string) => string | undefined;
  colorOf: (userId: string) => number | undefined;
}

/** 协作台线程面板的数据：项目线程 + agent 会话 + 服务端汇总 + 在线状态，整理成一行一线程。 */
export function usePanelThreads(projectId: string): PanelThreadsState {
  const me = useMeUser();
  const threads = useThreads(projectId, { kind: 'project' });
  const agents = useAgents(projectId);
  const summaries = useThreadSummaries(projectId);
  const presence = usePresence(projectId);
  const members = useMemberMap(projectId);

  const rows = useMemo(
    () =>
      buildPanelThreads({
        threads: threads.data ?? [],
        agents: agents.data ?? [],
        summaries: summaries.data ?? undefined,
        presence,
        meId: me?.id ?? null,
      }),
    [threads.data, agents.data, summaries.data, presence, me?.id],
  );

  const nameOf = useCallback(
    (userId: string) => (userId === me?.id ? tr('你') : members.get(userId)?.user.name),
    [members, me?.id],
  );
  const colorOf = useCallback((userId: string) => members.get(userId)?.user.avatarColor, [members]);

  return {
    rows,
    waitingOnMe: waitingOnMeCount(rows),
    isPending: threads.isPending,
    error: threads.error,
    refetch: () => void threads.refetch(),
    nameOf,
    colorOf,
  };
}
