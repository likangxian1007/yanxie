import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EvidenceExcerpt,
  Page,
  ResearchCode,
  ResearchCoding,
  ResearchFinding,
  ResearchListItem,
  ResearchRecord,
  ResearchItem,
  ResearchItemSummary,
  ResearchRecordDetail,
  ResearchUnifiedSearchHit,
  ResearchSnapshot,
  ResearchSource,
  ResearchSourceAvailability,
} from '@srh/shared';
import { api, resolveApiUrl, type QueryParams } from '@/lib/api';
import { useProjectEvent } from '@/lib/realtime';

export const root = (pid: string) => `/projects/${pid}/research`;
export const recordRoot = (pid: string, id: string) => `${root(pid)}/records/${id}`;
export const researchKey = (pid: string, ...parts: unknown[]) =>
  ['p', pid, 'research', ...parts] as const;

async function allPages<T>(path: string, signal?: AbortSignal, query?: QueryParams): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<T> = await api.get<Page<T>>(path, {
      signal,
      query: { ...query, cursor, limit: 100 },
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

export const researchApi = {
  list: (pid: string, signal?: AbortSignal) => allPages<ResearchListItem>(root(pid), signal),
  search: (pid: string, q: string, signal?: AbortSignal) =>
    api.get<Page<ResearchUnifiedSearchHit>>(`${root(pid)}/search`, {
      signal,
      query: { q, limit: 24 },
    }),
  records: (pid: string, signal?: AbortSignal) =>
    allPages<ResearchRecord>(`${root(pid)}/records`, signal),
  record: (pid: string, id: string, signal?: AbortSignal) =>
    api.get<ResearchRecordDetail>(recordRoot(pid, id), { signal }),
  updateRecord: (pid: string, id: string, input: unknown) =>
    api.patch<ResearchRecord>(recordRoot(pid, id), input),
  sources: (pid: string, signal?: AbortSignal, recordId?: string) =>
    allPages<ResearchSource>(`${root(pid)}/sources`, signal, { recordId }),
  createSource: (pid: string, input: unknown) =>
    api.post<ResearchSource>(`${root(pid)}/sources`, input),
  createSourceForRecord: (pid: string, recordId: string, input: unknown) =>
    api.post<ResearchSource>(`${recordRoot(pid, recordId)}/sources`, input),
  updateSource: (pid: string, id: string, input: unknown) =>
    api.patch<ResearchSource>(`${root(pid)}/sources/${id}`, input),
  availability: (pid: string, id: string, signal?: AbortSignal) =>
    api.get<ResearchSourceAvailability>(`${root(pid)}/sources/${id}/availability`, { signal }),
  snapshots: (pid: string, id: string, signal?: AbortSignal) =>
    allPages<ResearchSnapshot>(`${root(pid)}/sources/${id}/snapshots`, signal),
  createSnapshot: (pid: string, id: string, input: unknown) =>
    api.post<ResearchSnapshot>(`${root(pid)}/sources/${id}/snapshots`, input),
  excerpts: (pid: string, id: string, signal?: AbortSignal) =>
    allPages<EvidenceExcerpt>(`${recordRoot(pid, id)}/excerpts`, signal),
  createExcerpt: (pid: string, id: string, input: unknown) =>
    api.post<EvidenceExcerpt>(`${recordRoot(pid, id)}/excerpts`, input),
  codes: (pid: string, id: string, signal?: AbortSignal) =>
    allPages<ResearchCode>(`${recordRoot(pid, id)}/codes`, signal),
  createCode: (pid: string, id: string, input: unknown) =>
    api.post<ResearchCode>(`${recordRoot(pid, id)}/codes`, input),
  updateCode: (pid: string, id: string, input: unknown) =>
    api.patch<ResearchCode>(`${root(pid)}/codes/${id}`, input),
  codings: (pid: string, id: string, signal?: AbortSignal, caseId?: string) =>
    allPages<ResearchCoding>(`${recordRoot(pid, id)}/codings`, signal, { caseId }),
  createCoding: (pid: string, id: string, input: unknown) =>
    api.post<ResearchCoding>(`${recordRoot(pid, id)}/codings`, input),
  findings: (pid: string, id: string, signal?: AbortSignal) =>
    allPages<ResearchFinding>(`${recordRoot(pid, id)}/findings`, signal),
  createFinding: (pid: string, id: string, input: unknown) =>
    api.post<ResearchFinding>(`${recordRoot(pid, id)}/findings`, input),
  updateFinding: (pid: string, id: string, input: unknown) =>
    api.patch<ResearchFinding>(`${root(pid)}/findings/${id}`, input),
  finding: (pid: string, id: string, signal?: AbortSignal) =>
    api.get<ResearchFinding>(`${root(pid)}/findings/${id}`, { signal }),
  exportUrl: (pid: string, id: string, format: 'markdown' | 'json' | 'csv') =>
    resolveApiUrl(`${recordRoot(pid, id)}/export`, { format }),
  snapshotUrl: (pid: string, id: string) =>
    resolveApiUrl(`${root(pid)}/snapshots/${id}/download`, { download: 1 }),
};

export function useResearchList(pid: string) {
  return useQuery({
    queryKey: researchKey(pid, 'list'),
    queryFn: ({ signal }) => researchApi.list(pid, signal),
    enabled: !!pid,
  });
}
export function useResearchRecords(pid: string) {
  return useQuery({
    queryKey: researchKey(pid, 'records'),
    queryFn: ({ signal }) => researchApi.records(pid, signal),
    enabled: !!pid,
  });
}
export function useResearchSources(pid: string) {
  return useQuery({
    queryKey: researchKey(pid, 'sources'),
    queryFn: ({ signal }) => researchApi.sources(pid, signal),
    enabled: !!pid,
  });
}
export function useResearchRecord(pid: string, id: string, active = true) {
  return useQuery({
    queryKey: researchKey(pid, 'record', id),
    queryFn: ({ signal }) => researchApi.record(pid, id, signal),
    enabled: !!pid && !!id && active,
  });
}
export function useResearchRows<T>(
  pid: string,
  id: string,
  name: string,
  fn: (signal: AbortSignal) => Promise<T[]>,
  enabled = true,
) {
  return useQuery({
    queryKey: researchKey(pid, 'record', id, name),
    queryFn: ({ signal }) => fn(signal),
    enabled: !!pid && !!id && enabled,
  });
}

/** 布局事件只合并位置；内容与产物变更才使相关视图重新读取。 */
export function useResearchEvents(pid: string) {
  const qc = useQueryClient();
  useProjectEvent(pid, (event) => {
    if (event.type === 'research.item.updated') {
      const item = event.payload as ResearchItem;
      const key = researchKey(pid, 'workspace', item.recordId);
      const old = qc.getQueryData<{ items: ResearchItemSummary[] }>(key);
      const previous = old?.items.find((entry) => entry.id === item.id);
      if (previous) {
        if (item.positionVersion > previous.positionVersion)
          qc.setQueryData(key, {
            ...old,
            items: old!.items.map((entry) =>
              entry.id === item.id
                ? {
                    ...entry,
                    position: item.position,
                    positionVersion: item.positionVersion,
                  }
                : entry,
            ),
          });
        if (previous.version >= item.version) return;
      }
    }
    if (event.type === 'document.updated') {
      void qc.invalidateQueries({
        queryKey: researchKey(pid),
        predicate: (query) =>
          query.queryKey.includes('table') || query.queryKey.includes('table-columns'),
      });
    }
    if (event.type.startsWith('research.')) {
      void qc.invalidateQueries({ queryKey: researchKey(pid) });
      void qc.invalidateQueries({ queryKey: ['p', pid, 'outputs'] });
      void qc.invalidateQueries({ queryKey: ['p', pid, 'reviews'] });
    }
  });
}
