import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PaperNote, PaperNoteCreateInput } from '@srh/shared';
import { api } from '@/lib/api';
import { realtime, useProjectEvent } from '@/lib/realtime';
import { libraryBase, libraryKey, isPersonalLibrary, type LibraryScope } from './lib/scope';
import { tr } from '@/lib/i18n';

export const notesKey = (scope: LibraryScope, paperId: string) => [
  ...libraryKey(scope),
  'notes',
  paperId,
];
const base = (scope: LibraryScope, paperId: string) =>
  `${libraryBase(scope)}/papers/${paperId}/notes`;
export const noteApi = {
  create: (scope: LibraryScope, paperId: string, body: PaperNoteCreateInput) =>
    api.post<PaperNote>(base(scope, paperId), body),
  flush: (scope: LibraryScope, paperId: string, id: string) =>
    api.post<PaperNote>(`${base(scope, paperId)}/${id}/flush`),
  rename: (scope: LibraryScope, paperId: string, note: PaperNote, title: string) =>
    api.patch<PaperNote>(`${base(scope, paperId)}/${note.id}`, {
      title,
      baseVersion: note.version,
    }),
  remove: (scope: LibraryScope, paperId: string, id: string) =>
    api.delete(`${base(scope, paperId)}/${id}`),
  brief: (scope: LibraryScope, paperId: string, note: PaperNote) =>
    api.post<PaperNote>(`${base(scope, paperId)}/${note.id}/brief`, {
      title: tr('{title} · 团队说明稿', { title: note.title.slice(0, 150) }),
      sourceVersion: note.version,
    }),
};
export function usePaperNotes(scope: LibraryScope, paperId: string, enabled = true) {
  const qc = useQueryClient();
  const projectId = isPersonalLibrary(scope) ? undefined : scope;
  useProjectEvent(projectId, (event) => {
    if (event.type === 'paper.notes.changed' && event.payload.paperId === paperId)
      void qc.invalidateQueries({ queryKey: notesKey(scope, paperId) });
  });
  useEffect(() => {
    if (!projectId) return;
    return realtime.on('subscribed', (frame) => {
      if (frame.projectId === projectId)
        void qc.invalidateQueries({ queryKey: notesKey(projectId, paperId) });
    });
  }, [projectId, paperId, qc]);
  return useQuery({
    queryKey: notesKey(scope, paperId),
    queryFn: ({ signal }) => api.get<PaperNote[]>(base(scope, paperId), { signal }),
    enabled,
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
    refetchInterval: enabled && isPersonalLibrary(scope) ? 5000 : false,
  });
}
