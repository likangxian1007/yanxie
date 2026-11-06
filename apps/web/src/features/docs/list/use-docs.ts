import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentCreateInput, DocumentMeta } from '@srh/shared';
import { api } from '@/lib/api';
import { useProjectEvent } from '@/lib/realtime';
import { ck } from '@/features/collab-kit/keys';
import { removeDoc, upsertDoc } from './doc-tree';

/** 已归档文档的列表键（挂在 ck.docs 之下，resync / invalidate 时一起刷新） */
export const archivedDocsKey = (pid: string) => [...ck.docs(pid), 'archived'] as const;

/** 项目内全部未归档文档（GET P/docs，树由 parentId 在前端组装） */
export function useDocs(pid: string) {
  return useQuery({
    queryKey: ck.docs(pid),
    queryFn: ({ signal }) => api.get<DocumentMeta[]>(`/projects/${pid}/docs`, { signal }),
    enabled: Boolean(pid),
  });
}

export function useArchivedDocs(pid: string, enabled: boolean) {
  return useQuery({
    queryKey: archivedDocsKey(pid),
    queryFn: ({ signal }) =>
      api.get<DocumentMeta[]>(`/projects/${pid}/docs`, { signal, query: { archived: true } }),
    enabled: Boolean(pid) && enabled,
  });
}

/** document.created / updated / deleted → 更新两份列表缓存 */
export function useDocsRealtime(pid: string) {
  const qc = useQueryClient();
  useProjectEvent(pid, (event) => {
    switch (event.type) {
      case 'document.created':
      case 'document.updated': {
        const doc = event.payload;
        qc.setQueryData<DocumentMeta[]>(ck.docs(pid), (l) => upsertDoc(l, doc, false));
        qc.setQueryData<DocumentMeta[]>(archivedDocsKey(pid), (l) => upsertDoc(l, doc, true));
        break;
      }
      case 'document.deleted': {
        const { id } = event.payload;
        qc.setQueryData<DocumentMeta[]>(ck.docs(pid), (l) => removeDoc(l, id));
        qc.setQueryData<DocumentMeta[]>(archivedDocsKey(pid), (l) => removeDoc(l, id));
        break;
      }
      default:
        break;
    }
  });
}

function writeDoc(qc: ReturnType<typeof useQueryClient>, pid: string, doc: DocumentMeta) {
  qc.setQueryData<DocumentMeta[]>(ck.docs(pid), (l) => upsertDoc(l, doc, false));
  qc.setQueryData<DocumentMeta[]>(archivedDocsKey(pid), (l) => upsertDoc(l, doc, true));
}

export function useCreateDoc(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DocumentCreateInput) =>
      api.post<DocumentMeta>(`/projects/${pid}/docs`, input),
    onSuccess: (doc) => writeDoc(qc, pid, doc),
  });
}

export interface DocPatch {
  title?: string;
  parentId?: string | null;
  archived?: boolean;
}

export function useUpdateDoc(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: DocPatch }) =>
      api.patch<DocumentMeta>(`/projects/${pid}/docs/${id}`, patch),
    onSuccess: (doc) => writeDoc(qc, pid, doc),
  });
}
