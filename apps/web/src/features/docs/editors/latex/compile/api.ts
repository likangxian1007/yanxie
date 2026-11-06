import { useQuery } from '@tanstack/react-query';
import type { FileObject, LatexCapability, LatexCompileResult } from '@srh/shared';
import { ApiRequestError, api, resolveApiUrl } from '@/lib/api';
import { tr } from '@/lib/i18n';

/** LaTeX 编译相关的请求（端点见 API.md §2.7.5） */

export const latexKeys = {
  capability: (pid: string) => ['latex', 'capability', pid] as const,
};

/** 服务器能不能编译：不可用（或请求失败）时编辑器只显示草稿预览 */
export function useLatexCapability(pid: string) {
  return useQuery({
    queryKey: latexKeys.capability(pid),
    queryFn: () => api.get<LatexCapability>(`/projects/${pid}/docs/latex/capability`),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function requestCompile(
  pid: string,
  docId: string,
  force: boolean,
  signal?: AbortSignal,
): Promise<LatexCompileResult> {
  return api.post<LatexCompileResult>(
    `/projects/${pid}/docs/${docId}/latex/compile`,
    { force },
    signal ? { signal } : undefined,
  );
}

export function pdfUrl(pid: string, docId: string, pdfId: string, download = false): string {
  return resolveApiUrl(
    `/projects/${pid}/docs/${docId}/latex/pdf/${encodeURIComponent(pdfId)}`,
    download ? { download: 1 } : undefined,
  );
}

export async function fetchPdf(
  pid: string,
  docId: string,
  pdfId: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const res = await fetch(pdfUrl(pid, docId, pdfId), {
    credentials: 'include',
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    throw new ApiRequestError({
      status: res.status,
      code: `http_${res.status}`,
      message: res.status === 404 ? tr('PDF 已过期，请重新编译') : tr('下载 PDF 失败，请重试'),
    });
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** 上传图片到项目文件夹（latex/<docId>/<name>），返回文件对象 */
export async function uploadAsset(
  pid: string,
  docId: string,
  name: string,
  file: Blob,
): Promise<FileObject> {
  const form = new FormData();
  form.append('path', `latex/${docId}/${name}`);
  form.append('file', file, name.split('/').pop() ?? name);
  let res: Response;
  try {
    res = await fetch(resolveApiUrl(`/projects/${pid}/files`), {
      method: 'POST',
      body: form,
      credentials: 'include',
    });
  } catch {
    throw new ApiRequestError({
      status: 0,
      code: 'network_error',
      message: tr('无法连接到服务器，图片没有上传。'),
    });
  }
  if (!res.ok) {
    let message = tr('图片上传失败，请重试');
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // 忽略
    }
    throw new ApiRequestError({ status: res.status, code: `http_${res.status}`, message });
  }
  return (await res.json()) as FileObject;
}

export function assetUrl(pid: string, fileId: string): string {
  return resolveApiUrl(`/projects/${pid}/files/${fileId}`);
}
