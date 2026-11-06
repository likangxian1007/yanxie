import { useMemo } from 'react';
import { useParams } from 'react-router';
import { queryOptions, useQuery } from '@tanstack/react-query';
import type {
  AgentSession,
  Project,
  ProjectMember,
  ProjectRole,
  Thread,
  WorkClaim,
} from '@srh/shared';
import { api } from './api';
import { qk, type ThreadListFilter } from './query-keys';
import { useMe } from './session';
import { tr } from '@/lib/i18n';

/** 当前路由里的项目 id（/p/:projectId 之内）。 */
export function useProjectId(): string {
  const { projectId } = useParams();
  return projectId ?? '';
}

export function useProject(pid: string) {
  return useQuery({
    queryKey: qk.project(pid),
    queryFn: ({ signal }) => api.get<Project>(`/projects/${pid}`, { signal }),
    enabled: Boolean(pid),
  });
}

export function useMembers(pid: string) {
  return useQuery({
    queryKey: qk.members(pid),
    queryFn: ({ signal }) => api.get<ProjectMember[]>(`/projects/${pid}/members`, { signal }),
    enabled: Boolean(pid),
    staleTime: 5 * 60_000,
  });
}

/** userId → 成员（找不到时返回 undefined，调用方用 ActorRef 里的名字兜底）。 */
export function useMemberMap(pid: string): Map<string, ProjectMember> {
  const { data } = useMembers(pid);
  return useMemo(() => new Map((data ?? []).map((m) => [m.user.id, m])), [data]);
}

export function useMyRole(pid: string): ProjectRole | null {
  const { data } = useMe();
  return data?.projects.find((p) => p.id === pid)?.role ?? null;
}

/** 项目设置、成员与邀请、项目指令、记忆编辑（ARCHITECTURE §9） */
export function canManage(role: ProjectRole | null): boolean {
  return role === 'owner' || role === 'advisor';
}

/** 发言、编辑、审阅（guest 只读） */
export function canWrite(role: ProjectRole | null): boolean {
  return role !== null && role !== 'guest';
}

export const ROLE_LABEL: Record<ProjectRole, string> = {
  owner: tr('负责人'),
  advisor: tr('导师 / 师兄'),
  member: tr('成员'),
  guest: tr('访客'),
};

/** 指派选择器列出的线程：进行中的项目线程（看板、待办、实验共用同一个查询键） */
export const ACTIVE_PROJECT_THREADS = { kind: 'project', resolved: false } as const;

export function useThreads(pid: string, filter: ThreadListFilter = {}) {
  return useQuery(threadsQueryOptions(pid, filter));
}

/** 与 useThreads 同一份查询；页面预取直接写进这份缓存。 */
export function threadsQueryOptions(pid: string, filter: ThreadListFilter = {}) {
  return queryOptions({
    queryKey: qk.threads(pid, filter),
    queryFn: async ({ signal }) => {
      const page = await api.get<{ items: Thread[] }>(`/projects/${pid}/threads`, {
        signal,
        query: {
          kind: filter.kind,
          bucket: filter.bucket,
          resolved: filter.resolved,
          limit: 100,
        },
      });
      return page.items;
    },
    enabled: Boolean(pid),
  });
}

export function useThread(pid: string, tid: string | undefined) {
  return useQuery({
    queryKey: qk.thread(pid, tid ?? ''),
    queryFn: ({ signal }) => api.get<Thread>(`/projects/${pid}/threads/${tid}`, { signal }),
    enabled: Boolean(pid && tid),
  });
}

export function useAgents(pid: string) {
  return useQuery(agentsQueryOptions(pid));
}

export function agentsQueryOptions(pid: string) {
  return queryOptions({
    queryKey: qk.agents(pid),
    queryFn: ({ signal }) => api.get<AgentSession[]>(`/projects/${pid}/agents`, { signal }),
    enabled: Boolean(pid),
  });
}

/** 协调者会话（每项目一个）。 */
export function useCoordinator(pid: string): AgentSession | null {
  const { data } = useAgents(pid);
  return data?.find((a) => a.role === 'coordinator') ?? null;
}

/** 线程对应的 agent 会话。 */
export function useThreadAgent(pid: string, thread: Thread | undefined): AgentSession | null {
  const { data } = useAgents(pid);
  if (!thread) return null;
  return (
    data?.find((a) => a.id === thread.agentSessionId) ??
    data?.find((a) => a.threadId === thread.id) ??
    null
  );
}

export function isAgentBusy(a: AgentSession | null | undefined): boolean {
  return a?.status === 'running' || a?.status === 'queued';
}

/** 当前有效的认领（右侧面板、文档页的冲突预警用）。 */
export function useClaims(pid: string) {
  return useQuery({
    queryKey: qk.claims(pid),
    queryFn: async ({ signal }) => {
      const list = await api.get<WorkClaim[]>(`/projects/${pid}/claims`, {
        signal,
        query: { status: 'active' },
      });
      return list.filter((c) => c.status === 'active');
    },
    enabled: Boolean(pid),
  });
}
