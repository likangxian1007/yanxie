import { useQuery } from '@tanstack/react-query';
import type { Invite, MemoryFile, Routine } from '@srh/shared';
import { api } from '@/lib/api';
import { useThreads } from '@/lib/project';
import { qk, type ThreadListFilter } from '@/lib/query-keys';
import { memoryFileUrl } from './lib';

export type MemoryMeta = Omit<MemoryFile, 'content'>;

export function useInvites(pid: string, enabled = true) {
  return useQuery({
    queryKey: qk.invites(pid),
    queryFn: ({ signal }) => api.get<Invite[]>(`/projects/${pid}/invites`, { signal }),
    enabled: Boolean(pid) && enabled,
  });
}

export function useMemoryList(pid: string) {
  return useQuery({
    queryKey: qk.memory(pid),
    queryFn: async ({ signal }) => {
      const list = await api.get<MemoryMeta[]>(`/projects/${pid}/memory`, { signal });
      return [...list].sort((a, b) => a.path.localeCompare(b.path));
    },
    enabled: Boolean(pid),
  });
}

export function useMemoryFile(pid: string, path: string | null) {
  return useQuery({
    queryKey: qk.memoryFile(pid, path ?? ''),
    queryFn: ({ signal }) => api.get<MemoryFile>(memoryFileUrl(pid, path ?? ''), { signal }),
    enabled: Boolean(pid && path),
  });
}

/** 项目线程（与侧栏等处共用同一份 `kind=project` 缓存），定时任务的“唤醒线程”从这里选 */
const PROJECT_THREADS: ThreadListFilter = { kind: 'project' };

export function useProjectThreads(pid: string) {
  return useThreads(pid, PROJECT_THREADS);
}

export function useRoutines(pid: string) {
  return useQuery({
    queryKey: qk.routines(pid),
    queryFn: ({ signal }) => api.get<Routine[]>(`/projects/${pid}/routines`, { signal }),
    enabled: Boolean(pid),
  });
}
