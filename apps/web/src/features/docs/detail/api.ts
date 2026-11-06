import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentContent, DocumentMeta, DocumentVersion } from '@srh/shared';
import { api } from '@/lib/api';
import { useProjectEvent } from '@/lib/realtime';
import { ck } from '@/features/collab-kit/keys';
import { keepViewerFields } from '@/features/sharing/viewer-fields';

/** 文档详情页的数据：元信息、版本列表与实时更新 */
export function useDocMeta(pid: string, docId: string) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ck.doc(pid, docId),
    queryFn: () => api.get<DocumentMeta>(`/projects/${pid}/docs/${docId}`),
    retry: (count, err) => count < 2 && (err as { status?: number }).status !== 404,
  });
  useProjectEvent(pid, (ev) => {
    if (ev.type === 'document.updated') {
      const meta = ev.payload as DocumentMeta;
      if (meta.id === docId)
        qc.setQueryData<DocumentMeta>(ck.doc(pid, docId), (prev) => keepViewerFields(prev, meta));
    } else if (ev.type === 'document.deleted') {
      if ((ev.payload as { id: string }).id === docId) {
        void qc.invalidateQueries({ queryKey: ck.doc(pid, docId) });
      }
    } else if (ev.type === 'document.version_created') {
      const v = ev.payload as DocumentVersion;
      if (v.documentId === docId)
        void qc.invalidateQueries({ queryKey: ck.docVersions(pid, docId) });
    }
  });
  return query;
}

export function usePatchDoc(pid: string, docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: { title?: string; archived?: boolean }) =>
      api.patch<DocumentMeta>(`/projects/${pid}/docs/${docId}`, patch),
    onSuccess: (meta) => {
      qc.setQueryData(ck.doc(pid, docId), meta);
      void qc.invalidateQueries({ queryKey: ck.docs(pid) });
    },
  });
}

export function useDocVersions(pid: string, docId: string, enabled: boolean) {
  return useQuery({
    queryKey: ck.docVersions(pid, docId),
    queryFn: () => api.get<DocumentVersion[]>(`/projects/${pid}/docs/${docId}/versions`),
    enabled,
  });
}

export function fetchDocMarkdown(pid: string, docId: string) {
  return api.get<DocumentContent>(`/projects/${pid}/docs/${docId}/markdown`);
}

export function fetchVersion(pid: string, docId: string, versionId: string) {
  return api.get<{ version: DocumentVersion; markdown: string }>(
    `/projects/${pid}/docs/${docId}/versions/${versionId}`,
  );
}
