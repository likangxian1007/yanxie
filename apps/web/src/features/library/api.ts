import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  DocumentMeta,
  LibraryCiteToDocResult,
  LibraryHit,
  LibraryQaFrame,
  LibraryStatus,
  LibraryTranslationInput,
  LibraryTranslationModels,
  LibraryTranslationResult,
  Paper,
  PaperDetail,
  PaperImportResult,
  PaperPublishInput,
  PaperPublishResult,
  PaperUpdateWithVersionsInput,
} from '@srh/shared';
import { api, ApiRequestError, resolveApiUrl } from '@/lib/api';
import { keepViewerFields } from '@/features/sharing/viewer-fields';
import { realtime, useProjectEvent } from '@/lib/realtime';
import { ck } from '@/features/collab-kit/keys';
import { isWorking } from './lib/format';
import {
  libraryBase as base,
  libraryEnabled,
  libraryKey,
  isPersonalLibrary,
  type LibraryScope,
  type PersonalLibrary,
} from './lib/scope';
import { tr } from '@/lib/i18n';

/**
 * 文献库的数据层：列表、详情、导入、实时进度、PDF、问答流、BibTeX、插入引用。
 * 项目键保留 ['p', pid, …]；个人键使用 ['u', userId, …]，不跨账号复用。
 */
export const lk = {
  papers: (pid: LibraryScope) => [...libraryKey(pid), 'papers'] as const,
  paper: (pid: LibraryScope, id: string) => [...libraryKey(pid), 'paper', id] as const,
  status: (pid: LibraryScope) => [...libraryKey(pid), 'status'] as const,
  pdf: (pid: LibraryScope, id: string, fileId: string | null) =>
    [...libraryKey(pid), 'pdf', id, fileId] as const,
};

export function usePapers(pid: LibraryScope) {
  return useQuery({
    queryKey: lk.papers(pid),
    queryFn: ({ signal }) => api.get<Paper[]>(`${base(pid)}/papers`, { signal }),
    enabled: libraryEnabled(pid),
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
    refetchInterval: (query) =>
      isPersonalLibrary(pid) &&
      !query.state.error &&
      query.state.data?.some((p) => isWorking(p.status))
        ? 2000
        : false,
  });
}

export function usePaper(pid: LibraryScope, id: string) {
  return useQuery({
    queryKey: lk.paper(pid, id),
    queryFn: ({ signal }) => api.get<PaperDetail>(`${base(pid)}/papers/${id}`, { signal }),
    enabled: libraryEnabled(pid) && Boolean(id),
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
    refetchInterval: (query) =>
      isPersonalLibrary(pid) &&
      !query.state.error &&
      query.state.data &&
      isWorking(query.state.data.status)
        ? 2000
        : false,
  });
}

export function useLibraryStatus(pid: LibraryScope) {
  return useQuery({
    queryKey: lk.status(pid),
    queryFn: ({ signal }) => api.get<LibraryStatus>(`${base(pid)}/status`, { signal }),
    enabled: libraryEnabled(pid),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** PDF 字节（鉴权流 → Uint8Array，交给 PDF.js） */
export function usePaperPdf(pid: LibraryScope, paper: Pick<Paper, 'id' | 'fileId'> | undefined) {
  return useQuery({
    queryKey: lk.pdf(pid, paper?.id ?? '', paper?.fileId ?? null),
    queryFn: async ({ signal }) => {
      const res = await fetch(resolveApiUrl(`${base(pid)}/papers/${paper!.id}/pdf`), {
        credentials: 'include',
        signal,
      });
      if (!res.ok) {
        throw new ApiRequestError({
          status: res.status,
          code: `http_${res.status}`,
          message: res.status === 404 ? tr('这篇论文还没有 PDF') : tr('PDF 加载失败，请稍后重试'),
        });
      }
      return new Uint8Array(await res.arrayBuffer());
    },
    enabled: libraryEnabled(pid) && Boolean(paper?.id && paper.fileId),
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
}

// ---------------------------------------------------------------- 缓存

export function upsertPaperCache(qc: QueryClient, pid: LibraryScope, p: Paper) {
  qc.setQueryData<Paper[]>(lk.papers(pid), (list) => {
    if (!list) return list;
    const i = list.findIndex((x) => x.id === p.id);
    if (p.archivedAt) return i < 0 ? list : list.filter((x) => x.id !== p.id);
    if (i < 0) return [p, ...list];
    const next = list.slice();
    next[i] = keepViewerFields(list[i]!, p);
    return next;
  });
  qc.setQueryData<PaperDetail>(lk.paper(pid, p.id), (cur) =>
    cur ? { ...cur, ...keepViewerFields(cur, p), structure: cur.structure } : cur,
  );
}

/** 订阅 paper.* 事件：解析进度实时更新；解析完成时重新拉详情（结构） */
export function useLibraryEvents(pid: LibraryScope) {
  const qc = useQueryClient();
  const projectId = isPersonalLibrary(pid) ? undefined : pid;
  useEffect(() => {
    if (!projectId) return;
    return realtime.on('subscribed', (frame) => {
      if (frame.projectId !== projectId) return;
      void qc.invalidateQueries({ queryKey: lk.papers(projectId) });
      void qc.invalidateQueries({ queryKey: [...libraryKey(projectId), 'paper'] });
    });
  }, [projectId, qc]);
  useProjectEvent(isPersonalLibrary(pid) ? undefined : pid, (event) => {
    if (
      event.type !== 'paper.created' &&
      event.type !== 'paper.updated' &&
      event.type !== 'paper.deleted'
    )
      return;
    // REST 快照可能早于刚收到的事件。终止旧请求并重取完整列表，避免旧响应
    // 覆盖新事件；重连时尤其不能仅保留局部事件而丢掉离线期间的其他变化。
    const interrupted = [lk.papers(pid), lk.paper(pid, event.payload.id)].filter(
      (queryKey) => qc.getQueryState(queryKey)?.fetchStatus === 'fetching',
    );
    for (const queryKey of interrupted) void qc.cancelQueries({ queryKey, exact: true });
    switch (event.type) {
      case 'paper.created':
      case 'paper.updated': {
        const p = event.payload;
        const prev = qc.getQueryData<PaperDetail>(lk.paper(pid, p.id));
        upsertPaperCache(qc, pid, p);
        if (
          prev &&
          (prev.status !== p.status || prev.fileId !== p.fileId) &&
          p.status === 'ready'
        ) {
          void qc.invalidateQueries({ queryKey: lk.paper(pid, p.id) });
        }
        break;
      }
      case 'paper.deleted':
        qc.setQueryData<Paper[]>(lk.papers(pid), (l) =>
          l?.filter((x) => x.id !== event.payload.id),
        );
        // removeQueries 不会让已有 observer 撤下数据；重置并重取才能让正在
        // 阅读的成员看到“已删除”，而不是继续显示旧论文与 PDF。
        void qc.resetQueries({ queryKey: lk.paper(pid, event.payload.id), exact: true });
        qc.removeQueries({ queryKey: [...libraryKey(pid), 'pdf', event.payload.id] });
        break;
      default:
        break;
    }
    for (const queryKey of interrupted) {
      if (event.type === 'paper.deleted' && queryKey[queryKey.length - 2] === 'paper') continue;
      void qc.invalidateQueries({ queryKey, exact: true });
    }
  });
}

// ---------------------------------------------------------------- 写

async function postMultipart<T>(path: string, form: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(resolveApiUrl(path), {
      method: 'POST',
      body: form,
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new ApiRequestError({
      status: 0,
      code: 'network_error',
      message: tr('无法连接到服务器，PDF 没有上传。'),
    });
  }
  if (!res.ok) {
    let message = tr('PDF 上传失败，请稍后再试');
    let code = `http_${res.status}`;
    try {
      const j = (await res.json()) as { error?: { message?: string; code?: string } };
      message = j.error?.message ?? message;
      code = j.error?.code ?? code;
    } catch {
      // 不是 JSON
    }
    throw new ApiRequestError({ status: res.status, code, message });
  }
  return (await res.json()) as T;
}

export type ImportInput =
  | { kind: 'upload'; file: File; tags?: string[] }
  | { kind: 'doi'; value: string; tags?: string[] }
  | { kind: 'arxiv'; value: string; tags?: string[] }
  | { kind: 'url'; value: string; tags?: string[] };

/** 网页的新导入只进入当前账号个人库，包括项目页和参考文献中的导入。 */
export function useImportPaper(pid: PersonalLibrary) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ImportInput) => {
      if (input.kind === 'upload') {
        const form = new FormData();
        if (input.tags?.length) form.append('tags', input.tags.join(','));
        form.append('file', input.file);
        return postMultipart<PaperImportResult<Paper>>(`${base(pid)}/papers`, form);
      }
      return api.post<PaperImportResult<Paper>>(`${base(pid)}/papers`, {
        [input.kind]: input.value,
        ...(input.tags?.length ? { tags: input.tags } : {}),
      });
    },
    onSuccess: (r) => {
      upsertPaperCache(qc, pid, r.paper);
      void qc.invalidateQueries({ queryKey: lk.papers(pid) });
      void qc.invalidateQueries({ queryKey: lk.paper(pid, r.paper.id) });
    },
  });
}

export function useAttachPdf(pid: LibraryScope, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return postMultipart<Paper>(`${base(pid)}/papers/${id}/pdf`, form);
    },
    onSuccess: (p) => upsertPaperCache(qc, pid, p),
  });
}

export function useUpdatePaper(pid: LibraryScope, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: PaperUpdateWithVersionsInput) =>
      api.patch<Paper>(`${base(pid)}/papers/${id}`, patch),
    onSuccess: (p) => upsertPaperCache(qc, pid, p),
  });
}

export function usePublishPaper(scope: PersonalLibrary, paperId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PaperPublishInput) =>
      api.post<PaperPublishResult<Paper>>(`${base(scope)}/papers/${paperId}/publish`, input),
    onSuccess: ({ paper }) => {
      void qc.invalidateQueries({ queryKey: ['publication-targets', scope.userId, paperId] });
      if (!paper.projectId) return;
      upsertPaperCache(qc, paper.projectId, paper);
      void qc.invalidateQueries({ queryKey: lk.papers(paper.projectId) });
    },
  });
}

export function useReparse(pid: LibraryScope, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<Paper>(`${base(pid)}/papers/${id}/reparse`),
    onSuccess: (p) => upsertPaperCache(qc, pid, p),
  });
}

export function useDeletePaper(pid: LibraryScope) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${base(pid)}/papers/${id}`),
    onSuccess: (_r, id) => {
      qc.setQueryData<Paper[]>(lk.papers(pid), (l) => l?.filter((x) => x.id !== id));
      qc.removeQueries({ queryKey: lk.paper(pid, id) });
      qc.removeQueries({ queryKey: [...libraryKey(pid), 'pdf', id] });
    },
  });
}

/** BibTeX 文本：单篇、选中、全部 */
export async function fetchBibtex(pid: LibraryScope, ids?: string[]): Promise<string> {
  const res = await fetch(resolveApiUrl(`${base(pid)}/bibtex`), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ids?.length ? { paperIds: ids } : {}),
  });
  if (!res.ok) throw new Error(tr('BibTeX 导出失败，请稍后重试'));
  return res.text();
}

export function downloadText(name: string, text: string, mime = 'text/x-bibtex') {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useLatexDocs(pid: string, enabled: boolean) {
  return useQuery({
    queryKey: [...ck.docs(pid), 'library-latex'] as const,
    queryFn: ({ signal }) => api.get<DocumentMeta[]>(`/projects/${pid}/docs`, { signal }),
    enabled: Boolean(pid) && enabled,
    select: (docs) => docs.filter((d) => d.kind === 'latex' && !d.archivedAt),
  });
}

export function useCiteToDoc(pid: string) {
  return useMutation({
    mutationFn: (input: { docId: string; paperIds: string[]; bibFile?: string }) =>
      api.post<LibraryCiteToDocResult>(`${base(pid)}/cite`, input),
  });
}

export function searchLibrary(
  pid: LibraryScope,
  q: string,
  paperId?: string,
  signal?: AbortSignal,
) {
  return api.get<LibraryHit[]>(`${base(pid)}/search`, { query: { q, paperId, limit: 10 }, signal });
}

export function useTranslationModels(scope: LibraryScope, enabled: boolean) {
  return useQuery({
    queryKey: [...libraryKey(scope), 'translation-models'],
    queryFn: ({ signal }) =>
      api.get<LibraryTranslationModels>(`${base(scope)}/translation-models`, { signal }),
    enabled: libraryEnabled(scope) && enabled,
    staleTime: 30_000,
  });
}

export function translatePaperSelection(
  scope: LibraryScope,
  paperId: string,
  input: LibraryTranslationInput,
  signal: AbortSignal,
) {
  return api.post<LibraryTranslationResult>(`${base(scope)}/papers/${paperId}/translate`, input, {
    signal,
  });
}

// ---------------------------------------------------------------- 问答流

export interface QaTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** POST P/library/qa，逐行解析 NDJSON */
export async function streamQa(
  pid: LibraryScope,
  body: { question: string; paperId?: string; history: QaTurn[] },
  onFrame: (f: LibraryQaFrame) => void,
  signal: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(resolveApiUrl(`${base(pid)}/qa`), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal.aborted) return;
    throw new ApiRequestError({
      status: 0,
      code: 'network_error',
      message: tr('无法连接到服务器'),
    });
    void err;
  }
  if (!res.ok || !res.body) {
    let message = tr('问答暂时不可用，请稍后重试');
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      message = j.error?.message ?? message;
    } catch {
      // 不是 JSON
    }
    throw new ApiRequestError({ status: res.status, code: `http_${res.status}`, message });
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onFrame(JSON.parse(line) as LibraryQaFrame);
      nl = buf.indexOf('\n');
    }
  }
  if (buf.trim()) onFrame(JSON.parse(buf) as LibraryQaFrame);
}
