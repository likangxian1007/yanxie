import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PaperQaSession,
  PaperQaTurn,
  PaperQaAskInput,
  PaperQaRevision,
  PaperQaPublishSelection,
  PaperQaPublishPreview,
  PaperNote,
} from '@srh/shared';
import { api } from '@/lib/api';
import { realtime, useProjectEvent } from '@/lib/realtime';
import { libraryBase, libraryKey, isPersonalLibrary, type LibraryScope } from './lib/scope';
import { tr } from '@/lib/i18n';
export const qaKey = (s: LibraryScope, p: string) => [...libraryKey(s), 'qa', p];
const base = (s: LibraryScope, p: string) => `${libraryBase(s)}/papers/${p}/qa`;
export const qaActive = (status: string) => ['queued', 'retrieving', 'generating'].includes(status);
export const qaApi = {
  sessions: (s: LibraryScope, p: string) => api.get<PaperQaSession[]>(`${base(s, p)}/sessions`),
  create: (s: LibraryScope, p: string, title: string) =>
    api.post<PaperQaSession>(`${base(s, p)}/sessions`, { title }),
  rename: (s: LibraryScope, p: string, session: PaperQaSession, title: string) =>
    api.patch<PaperQaSession>(`${base(s, p)}/sessions/${session.id}`, {
      title,
      baseVersion: session.version,
    }),
  remove: (s: LibraryScope, p: string, session: PaperQaSession) =>
    api.post(`${base(s, p)}/sessions/${session.id}/trash`, { baseVersion: session.version }),
  turns: (s: LibraryScope, p: string, id: string) =>
    api.get<PaperQaTurn[]>(`${base(s, p)}/sessions/${id}/turns`),
  ask: (s: LibraryScope, p: string, id: string, input: PaperQaAskInput) =>
    api.post<PaperQaTurn>(`${base(s, p)}/sessions/${id}/turns`, input),
  stop: (s: LibraryScope, p: string, id: string) =>
    api.post<PaperQaTurn>(`${base(s, p)}/turns/${id}/stop`),
  flush: (s: LibraryScope, p: string, id: string) =>
    api.post<PaperQaTurn>(`${base(s, p)}/turns/${id}/flush`),
  revisions: (s: LibraryScope, p: string, id: string, before?: number) =>
    api.get<PaperQaRevision[]>(`${base(s, p)}/turns/${id}/revisions`, { query: { before } }),
  preview: (
    s: LibraryScope,
    p: string,
    projectId: string,
    selections: PaperQaPublishSelection[],
    targetPaperId?: string,
  ) =>
    api.post<PaperQaPublishPreview>(`${base(s, p)}/publication-preview`, {
      projectId,
      selections,
      ...(targetPaperId ? { targetPaperId } : {}),
    }),
  brief: (s: LibraryScope, p: string, t: PaperQaTurn) =>
    api.post<PaperNote>(`${base(s, p)}/turns/${t.id}/brief`, {
      title: tr('{question} · 说明稿', { question: t.question.slice(0, 140) }),
      sourceVersion: t.version,
    }),
};
export function useQaSessions(scope: LibraryScope, paperId: string) {
  const qc = useQueryClient(),
    projectId = isPersonalLibrary(scope) ? undefined : scope;
  useProjectEvent(projectId, (e) => {
    if (e.type === 'paper.qa.changed' && e.payload.paperId === paperId)
      void qc.invalidateQueries({ queryKey: qaKey(scope, paperId) });
  });
  useEffect(() => {
    if (!projectId) return;
    return realtime.on('subscribed', (f) => {
      if (f.projectId === projectId)
        void qc.invalidateQueries({ queryKey: qaKey(projectId, paperId) });
    });
  }, [qc, projectId, paperId]);
  return useQuery({
    queryKey: [...qaKey(scope, paperId), 'sessions'],
    queryFn: () => qaApi.sessions(scope, paperId),
    refetchInterval: 5000,
    refetchOnMount: 'always',
  });
}
export function useQaTurns(scope: LibraryScope, paperId: string, sessionId: string) {
  return useQuery({
    queryKey: [...qaKey(scope, paperId), 'turns', sessionId],
    queryFn: () => qaApi.turns(scope, paperId, sessionId),
    enabled: Boolean(sessionId),
    refetchInterval: (q) => (q.state.data?.some((t) => qaActive(t.status)) ? 750 : 5000),
    refetchOnMount: 'always',
  });
}
