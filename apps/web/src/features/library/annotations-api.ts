import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PaperAnnotation,
  PaperAnnotationCreateInput,
  PaperAnnotationUpdateInput,
  PaperNote,
} from '@srh/shared';
import { api } from '@/lib/api';
import { realtime, useProjectEvent } from '@/lib/realtime';
import { isPersonalLibrary, libraryBase, libraryKey, type LibraryScope } from './lib/scope';
import { tr } from '@/lib/i18n';

export const annotationsKey = (scope: LibraryScope, paperId: string) => [
  ...libraryKey(scope),
  'annotations',
  paperId,
];
const base = (scope: LibraryScope, paperId: string) =>
  `${libraryBase(scope)}/papers/${paperId}/annotations`;
export const annotationApi = {
  brief: (scope: LibraryScope, a: PaperAnnotation) =>
    api.post<PaperNote>(`${base(scope, a.paperId)}/${a.id}/brief`, {
      title: tr('{value} · 说明稿', {
        value: (a.label || tr('第 {page} 页标注', { page: a.page })).slice(0, 140),
      }),
      sourceVersion: a.version,
    }),
  create: (scope: LibraryScope, paperId: string, input: PaperAnnotationCreateInput) =>
    api.post<PaperAnnotation>(base(scope, paperId), input),
  update: (scope: LibraryScope, paperId: string, id: string, input: PaperAnnotationUpdateInput) =>
    api.patch<PaperAnnotation>(`${base(scope, paperId)}/${id}`, input),
  flush: (scope: LibraryScope, paperId: string, id: string) =>
    api.post<PaperAnnotation>(`${base(scope, paperId)}/${id}/flush`),
  trash: (scope: LibraryScope, annotation: PaperAnnotation) =>
    api.post<void>(`${base(scope, annotation.paperId)}/${annotation.id}/trash`, {
      baseVersion: annotation.version,
    }),
  restore: (scope: LibraryScope, annotation: PaperAnnotation) =>
    api.post<PaperAnnotation>(`${base(scope, annotation.paperId)}/${annotation.id}/restore`, {
      baseVersion: annotation.version,
    }),
};
export function usePaperAnnotations(scope: LibraryScope, paperId: string, enabled = true) {
  const qc = useQueryClient();
  const pid = isPersonalLibrary(scope) ? undefined : scope;
  useProjectEvent(pid, (event) => {
    if (
      (event.type === 'paper.annotations.changed' && event.payload.paperId === paperId) ||
      (event.type === 'paper.updated' && event.payload.id === paperId)
    )
      void qc.invalidateQueries({ queryKey: annotationsKey(scope, paperId) });
  });
  useEffect(() => {
    if (!pid) return;
    return realtime.on('subscribed', (frame) => {
      if (frame.projectId === pid)
        void qc.invalidateQueries({ queryKey: annotationsKey(pid, paperId) });
    });
  }, [pid, paperId, qc]);
  return useQuery({
    queryKey: annotationsKey(scope, paperId),
    queryFn: ({ signal }) =>
      api.get<PaperAnnotation[]>(`${base(scope, paperId)}?includeDeleted=true`, { signal }),
    enabled,
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
    refetchInterval: enabled && isPersonalLibrary(scope) ? 5000 : false,
  });
}
