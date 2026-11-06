import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type { DocumentMeta, Report, ReportCreateInput } from '@srh/shared';
import { api } from '@/lib/api';
import { useProjectEvent } from '@/lib/realtime';
import { useMeUser } from '@/lib/session';
import { ck } from '@/features/collab-kit/keys';
import {
  getFieldSync,
  peekFieldSync,
  versionConflictCurrent,
} from '@/features/collab-kit/conflict/use-field-sync';

/** 组会汇报的数据层：列表、详情、写操作与 report.* 事件。 */

const base = (pid: string) => `/projects/${pid}/reports`;

export function sortReports(list: Report[]): Report[] {
  return list.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function writeReport(qc: QueryClient, pid: string, report: Report) {
  qc.setQueryData(ck.report(pid, report.id), report);
  qc.setQueryData<Report[]>(ck.reports(pid), (list) => {
    if (!list) return list;
    const i = list.findIndex((r) => r.id === report.id);
    if (i === -1) return sortReports([report, ...list]);
    const next = list.slice();
    next[i] = report;
    return next;
  });
}

export function useReports(pid: string) {
  return useQuery(reportsQueryOptions(pid));
}

export function reportsQueryOptions(pid: string) {
  return queryOptions({
    queryKey: ck.reports(pid),
    queryFn: async ({ signal }) => sortReports(await api.get<Report[]>(base(pid), { signal })),
    enabled: Boolean(pid),
  });
}

export function useReport(pid: string, id: string) {
  const qc = useQueryClient();
  return useQuery<Report>({
    queryKey: ck.report(pid, id),
    queryFn: ({ signal }) => api.get<Report>(`${base(pid)}/${id}`, { signal }),
    enabled: Boolean(pid && id),
    // 从列表进来时先用列表里的那份，详情请求回来后替换
    placeholderData: (): Report | undefined =>
      qc.getQueryData<Report[]>(ck.reports(pid))?.find((r) => r.id === id),
  });
}

/** report.created / updated / deleted → 列表与详情缓存 */
export function useReportsRealtime(pid: string) {
  const qc = useQueryClient();
  const me = useMeUser();
  useProjectEvent(pid, (event) => {
    if (event.type === 'report.created' || event.type === 'report.updated') {
      const sync = peekFieldSync(qc, reportSyncKey(pid, event.payload.id));
      if (sync && event.actor.id !== me?.id) sync.remoteActor = event.actor.name;
      const cur = qc.getQueryData<Report>(ck.report(pid, event.payload.id));
      // 事件可能晚于自己的保存结果到达：旧版本不覆盖新版本
      if (cur && event.payload.version < cur.version) return;
      writeReport(qc, pid, event.payload);
    } else if (event.type === 'report.deleted') {
      const { id } = event.payload;
      qc.setQueryData<Report[]>(ck.reports(pid), (list) => list?.filter((r) => r.id !== id));
      void qc.invalidateQueries({ queryKey: ck.report(pid, id) });
    }
  });
}

export function useCreateReport(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReportCreateInput) => api.post<Report>(base(pid), input),
    onSuccess: (r) => writeReport(qc, pid, r),
  });
}

export interface ReportPatch {
  title?: string;
  content?: string;
  status?: 'draft' | 'final';
}

export function useUpdateReport(pid: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: ReportPatch) => api.patch<Report>(`${base(pid)}/${id}`, patch),
    onSuccess: (r) => writeReport(qc, pid, r),
  });
}

export const reportSyncKey = (pid: string, id: string) => `report:${pid}:${id}`;

/**
 * 汇报正文的同步器：与卡片、实验记录同一套乐观并发（草稿基线版本 + 409 合并视图）。
 * 正文选了「版本号 + 409 + 合并」而不是实时协同：汇报是一个人主写、偶尔有人补充的草稿，
 * 定稿后可另存为真正的协同文档。
 */
export function reportSync(qc: QueryClient, pid: string, id: string) {
  return getFieldSync<Report>(qc, reportSyncKey(pid, id), () => ({
    delay: 1000,
    getServer: () => qc.getQueryData<Report>(ck.report(pid, id)),
    send: (patch, baseVersion) =>
      api.patch<Report>(`${base(pid)}/${id}`, {
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        baseVersion,
      }),
    conflictCurrent: versionConflictCurrent<Report>(id),
    onServer: (report, force) => {
      const cur = qc.getQueryData<Report>(ck.report(pid, id));
      if (force || !cur || report.version >= cur.version) writeReport(qc, pid, report);
    },
  }));
}

export function useRegenerateReport(pid: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (instructions: string) =>
      api.post<Report>(`${base(pid)}/${id}/regenerate`, { instructions }),
    onSuccess: (r) => writeReport(qc, pid, r),
  });
}

export function useDeleteReport(pid: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(`${base(pid)}/${id}`),
    onSuccess: () => {
      qc.setQueryData<Report[]>(ck.reports(pid), (list) => list?.filter((r) => r.id !== id));
      qc.removeQueries({ queryKey: ck.report(pid, id) });
    },
  });
}

/** 存为协同文档：POST P/reports/:id/document → { report, document } */
export function useSaveReportAsDocument(pid: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ report: Report; document: DocumentMeta }>(`${base(pid)}/${id}/document`),
    onSuccess: ({ report }) => writeReport(qc, pid, report),
  });
}

export interface PlanTodoItem {
  title: string;
  assigneeId: string | null;
}

/** 拆成待办：POST P/reports/:id/todos { items } → 新建的待办（数组，或 { todos }） */
export function useCreateReportTodos(pid: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (items: PlanTodoItem[]) => {
      const res = await api.post<unknown>(`${base(pid)}/${id}/todos`, { items });
      if (Array.isArray(res)) return res.length;
      if (res && typeof res === 'object' && 'todos' in res && Array.isArray(res.todos)) {
        return res.todos.length;
      }
      return items.length;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ck.todos(pid) }),
  });
}
