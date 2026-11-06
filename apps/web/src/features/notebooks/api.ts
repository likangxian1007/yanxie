import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  KernelStatus,
  Notebook,
  NotebookCreateInput,
  NotebookExportFormat,
  NotebookRun,
  NotebookVariable,
} from '@srh/shared';
import { api, resolveApiUrl } from '@/lib/api';

/**
 * Notebook 的 REST 层。单元格内容走 /collab/:notebookId（Y.Doc），这里只有元数据和内核控制。
 */

const base = (pid: string) => `/projects/${pid}/notebooks`;

export const nbKeys = {
  list: (pid: string, experimentId?: string) =>
    ['p', pid, 'notebooks', experimentId ?? null] as const,
  one: (pid: string, id: string) => ['p', pid, 'notebook', id] as const,
  vars: (pid: string, id: string) => ['p', pid, 'notebook', id, 'vars'] as const,
};

export function useNotebooks(pid: string, experimentId?: string) {
  return useQuery({
    queryKey: nbKeys.list(pid, experimentId),
    queryFn: ({ signal }) =>
      api.get<Notebook[]>(base(pid), { signal, query: experimentId ? { experimentId } : {} }),
    enabled: Boolean(pid),
  });
}

export type NotebookDetail = Notebook & { kernel: { status: KernelStatus } };

export function useNotebook(pid: string, id: string) {
  return useQuery({
    queryKey: nbKeys.one(pid, id),
    queryFn: ({ signal }) => api.get<NotebookDetail>(`${base(pid)}/${id}`, { signal }),
    enabled: Boolean(pid && id),
  });
}

export function useCreateNotebook(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: NotebookCreateInput) => api.post<Notebook>(base(pid), input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['p', pid, 'notebooks'] }),
  });
}

export function useRenameNotebook(pid: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title: string) => api.patch<Notebook>(`${base(pid)}/${id}`, { title }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['p', pid, 'notebooks'] });
      void qc.invalidateQueries({ queryKey: nbKeys.one(pid, id) });
    },
  });
}

/** 内核控制：执行 / 中断 / 重启 / 关闭 / 导入 */
export function notebookActions(pid: string, id: string) {
  const u = `${base(pid)}/${id}`;
  return {
    execute: (cellIds: string[]) => api.post<{ runs: NotebookRun[] }>(`${u}/execute`, { cellIds }),
    interrupt: () => api.post<{ ok: true }>(`${u}/interrupt`, {}),
    restart: (opts: { runAll?: boolean; clearOutputs?: boolean } = {}) =>
      api.post<{ ok: true }>(`${u}/restart`, {
        runAll: opts.runAll ?? false,
        clearOutputs: opts.clearOutputs ?? false,
      }),
    shutdown: () => api.post<{ ok: true }>(`${u}/shutdown`, {}),
    importIpynb: (ipynb: string) => api.post<Notebook>(`${u}/import`, { ipynb }),
    complete: (code: string, cursorPos: number) =>
      api.post<{ matches: string[]; cursor_start: number; cursor_end: number }>(`${u}/complete`, {
        code,
        cursorPos,
      }),
    inspect: (code: string, cursorPos: number) =>
      api.post<{ found: boolean; data: Record<string, unknown> }>(`${u}/inspect`, {
        code,
        cursorPos,
      }),
  };
}

export function useNotebookVariables(pid: string, id: string, enabled: boolean) {
  return useQuery({
    queryKey: nbKeys.vars(pid, id),
    queryFn: ({ signal }) =>
      api.get<{ variables: NotebookVariable[] }>(`${base(pid)}/${id}/variables`, { signal }),
    enabled: Boolean(pid && id && enabled),
    select: (r) => r.variables,
  });
}

export function exportUrl(pid: string, id: string, format: NotebookExportFormat): string {
  return resolveApiUrl(`${base(pid)}/${id}/export`, { format });
}
