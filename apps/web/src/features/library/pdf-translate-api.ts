import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PdfTranslateInput, PdfTranslateJob, PdfTranslateKind } from '@srh/shared';
import { api, ApiRequestError, resolveApiUrl } from '@/lib/api';
import { tr } from '@/lib/i18n';
import { libraryBase, libraryKey, type LibraryScope } from './lib/scope';

/** 整篇 PDF 保版式翻译（服务端 modules/pdf-translate） */
const base = (scope: LibraryScope, paperId: string) =>
  `${libraryBase(scope)}/papers/${paperId}/pdf-translate`;
const jobKey = (scope: LibraryScope, paperId: string) => [
  ...libraryKey(scope),
  'pdf-translate',
  paperId,
];

export const pdfTranslateFileUrl = (
  scope: LibraryScope,
  paperId: string,
  kind: PdfTranslateKind,
  download = false,
) => resolveApiUrl(`${base(scope, paperId)}/file`, { kind, download: download ? 1 : undefined });

/** 任务状态；进行中每 2 秒刷新一次 */
export function usePdfTranslateJob(scope: LibraryScope, paperId: string, enabled: boolean) {
  return useQuery({
    queryKey: jobKey(scope, paperId),
    queryFn: ({ signal }) => api.get<PdfTranslateJob>(base(scope, paperId), { signal }),
    enabled,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'queued' || s === 'running' ? 2000 : false;
    },
  });
}

export function useStartPdfTranslate(scope: LibraryScope, paperId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<PdfTranslateInput>) =>
      api.post<PdfTranslateJob>(base(scope, paperId), body),
    onSuccess: (job) => qc.setQueryData(jobKey(scope, paperId), job),
  });
}

/** 译文 PDF 字节（鉴权流 → Uint8Array，交给 PDF.js） */
export function usePdfTranslateBytes(
  scope: LibraryScope,
  paperId: string,
  kind: PdfTranslateKind | null,
  version: string | null,
) {
  return useQuery({
    queryKey: [...jobKey(scope, paperId), 'bytes', kind, version],
    queryFn: async ({ signal }) => {
      const res = await fetch(pdfTranslateFileUrl(scope, paperId, kind!), {
        credentials: 'include',
        signal,
      });
      if (!res.ok)
        throw new ApiRequestError({
          status: res.status,
          code: `http_${res.status}`,
          message: tr('译文 PDF 加载失败，请稍后重试'),
        });
      return new Uint8Array(await res.arrayBuffer());
    },
    enabled: Boolean(kind && version),
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
}
