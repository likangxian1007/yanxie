import { useQuery } from '@tanstack/react-query';
import type {
  Page,
  ResearchItem,
  ResearchItemContent,
  ResearchItemCreateInput,
  ResearchItemPositionInput,
  ResearchItemSummary,
  ResearchItemUpdateInput,
  ResearchRelation,
  ResearchRelationCreateInput,
  ResearchWorkspace,
  ResearchWorkspaceCreateInput,
  ResearchRecord,
  ResearchLayoutUpdateInput,
} from '@srh/shared';
import { api } from '@/lib/api';
import { recordRoot, root, researchKey } from './data';

const itemsRoot = (pid: string, recordId: string) => `${recordRoot(pid, recordId)}/items`;
const relationsRoot = (pid: string, recordId: string) => `${recordRoot(pid, recordId)}/relations`;

async function pages<T>(path: string, signal?: AbortSignal): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<T> = await api.get(path, { signal, query: { cursor, limit: 100 } });
    rows.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
}

export type WorkspaceSnapshot = {
  record: ResearchRecord;
  items: ResearchItemSummary[];
  relations: ResearchRelation[];
};
export const workspaceApi = {
  create: (pid: string, input: ResearchWorkspaceCreateInput) =>
    api.post<ResearchRecord>(`${root(pid)}/workspaces`, input),
  load: async (pid: string, recordId: string, signal?: AbortSignal): Promise<WorkspaceSnapshot> => {
    const workspace = await api.get<ResearchWorkspace>(`${recordRoot(pid, recordId)}/workspace`, {
      signal,
    });
    const [items, relations] = await Promise.all([
      workspace.items.nextCursor
        ? pages<ResearchItemSummary>(itemsRoot(pid, recordId), signal)
        : Promise.resolve(workspace.items.items),
      workspace.relations.nextCursor
        ? pages<ResearchRelation>(relationsRoot(pid, recordId), signal)
        : Promise.resolve(workspace.relations.items),
    ]);
    return { record: workspace.record, items, relations };
  },
  item: (pid: string, recordId: string, id: string, signal?: AbortSignal) =>
    api.get<ResearchItem>(`${itemsRoot(pid, recordId)}/${id}`, { signal }),
  content: (pid: string, recordId: string, id: string, offset = 0, signal?: AbortSignal) =>
    api.get<ResearchItemContent>(`${itemsRoot(pid, recordId)}/${id}/content`, {
      signal,
      query: { offset },
    }),
  createItem: (pid: string, recordId: string, input: ResearchItemCreateInput) =>
    api.post<ResearchItem>(itemsRoot(pid, recordId), input),
  updateItem: (pid: string, recordId: string, id: string, input: ResearchItemUpdateInput) =>
    api.patch<ResearchItem>(`${itemsRoot(pid, recordId)}/${id}`, input),
  layout: (pid: string, recordId: string, input: ResearchLayoutUpdateInput) =>
    api.patch<{ items: ResearchItem[] }>(`${recordRoot(pid, recordId)}/layout`, input),
  position: (pid: string, recordId: string, id: string, input: ResearchItemPositionInput) =>
    api.patch<ResearchItem>(`${itemsRoot(pid, recordId)}/${id}/position`, input),
  archiveItem: (pid: string, recordId: string, id: string, baseVersion: number) =>
    api.delete<void>(`${itemsRoot(pid, recordId)}/${id}`, { query: { baseVersion } }),
  createRelation: (pid: string, recordId: string, input: ResearchRelationCreateInput) =>
    api.post<ResearchRelation>(relationsRoot(pid, recordId), input),
  archiveRelation: (pid: string, recordId: string, id: string, baseVersion: number) =>
    api.delete<void>(`${relationsRoot(pid, recordId)}/${id}`, { query: { baseVersion } }),
};
export const workspaceKey = (pid: string, recordId: string) =>
  researchKey(pid, 'workspace', recordId);
export const itemKey = (pid: string, recordId: string, id: string) =>
  researchKey(pid, 'workspace', recordId, 'item', id);

export function useWorkspace(pid: string, recordId: string, userId: string | undefined) {
  return useQuery({
    queryKey: workspaceKey(pid, recordId),
    queryFn: async ({ signal }) => {
      try {
        const data = await workspaceApi.load(pid, recordId, signal);
        if (userId) writeLocal(workspaceStorageKey(userId, pid, recordId), data);
        return { ...data, offline: false };
      } catch (error) {
        if (signal.aborted) throw error;
        const cached = userId
          ? readLocal<WorkspaceSnapshot>(workspaceStorageKey(userId, pid, recordId))
          : null;
        if (cached && error instanceof Error && 'status' in error && error.status === 0)
          return { ...cached, offline: true };
        throw error;
      }
    },
    enabled: !!pid && !!recordId && !!userId,
  });
}

export function workspaceStorageKey(user: string, pid: string, recordId: string) {
  return `srh:research-workspace:${user}:${pid}:${recordId}`;
}
export function readLocal<T>(key: string): T | null {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
}
export function writeLocal(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
