import type { DocumentKind, DocumentMeta, FileObject, ResourceSpace } from '@srh/shared';
import { ApiRequestError, api, resolveApiUrl } from '@/lib/api';
import { tr } from '@/lib/i18n';

/** 导入用到的请求：上传素材、带初始状态新建文档（POST P/docs/import）、清理素材 */

function errorFromXhr(xhr: XMLHttpRequest, fallback: string): ApiRequestError {
  type ErrorBody = { error?: { code?: string; message?: string } };
  let body: ErrorBody | null;
  try {
    body = JSON.parse(xhr.responseText) as ErrorBody | null;
  } catch {
    body = null;
  }
  const status = xhr.status;
  const message =
    body?.error?.message ??
    (status === 413
      ? tr('文件内容太大了，服务器收不下')
      : status === 403
        ? tr('你没有在这个项目里新建文档的权限')
        : status >= 500
          ? tr('服务器出了点问题，请稍后重试')
          : fallback);
  return new ApiRequestError({
    status,
    code: body?.error?.code ?? `http_${status}`,
    message,
  });
}

interface XhrOptions {
  body: XMLHttpRequestBodyInit;
  contentType?: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  fallback: string;
  networkMessage: string;
}

function xhrPost<T>(url: string, opts: XhrOptions): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    if (opts.contentType) xhr.setRequestHeader('Content-Type', opts.contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve({ status: xhr.status, body: JSON.parse(xhr.responseText) as T });
        } catch {
          reject(
            new ApiRequestError({
              status: xhr.status,
              code: 'invalid_json',
              message: tr('服务器返回了无法识别的数据'),
            }),
          );
        }
        return;
      }
      reject(errorFromXhr(xhr, opts.fallback));
    };
    xhr.onerror = () =>
      reject(
        new ApiRequestError({ status: 0, code: 'network_error', message: opts.networkMessage }),
      );
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    if (opts.signal) {
      if (opts.signal.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      opts.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(opts.body);
  });
}

/** 上传到项目文件夹（明确路径：同一次导入用独立目录，不会覆盖别人的文件） */
export async function uploadProjectFile(
  pid: string,
  path: string,
  blob: Blob,
  signal?: AbortSignal,
): Promise<FileObject> {
  const form = new FormData();
  form.append('path', path);
  form.append('file', blob, path.split('/').pop() ?? path);
  const res = await xhrPost<FileObject>(resolveApiUrl(`/projects/${pid}/files`), {
    body: form,
    fallback: tr('文件上传失败，请重试'),
    networkMessage: tr('网络断了，文件没有上传'),
    ...(signal ? { signal } : {}),
  });
  return res.body;
}

export function projectFileUrl(pid: string, fileId: string): string {
  return resolveApiUrl(`/projects/${pid}/files/${fileId}`);
}

export async function deleteProjectFile(pid: string, fileId: string): Promise<void> {
  await api.delete(`/projects/${pid}/files/${fileId}`);
}

export interface ImportDocRequest {
  pid: string;
  kind: DocumentKind;
  title: string;
  parentId?: string | null;
  /** personal = 导入到自己的个人空间（§2.19） */
  space?: ResourceSpace;
  /** 幂等键：重试同一次导入用同一个值 */
  importId: string;
  state: Uint8Array;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** POST P/docs/import：文档与初始 Yjs 状态一起原子建好 */
export async function postImportedDoc(req: ImportDocRequest): Promise<DocumentMeta> {
  const query: Record<string, string> = {
    kind: req.kind,
    title: req.title,
    importId: req.importId,
  };
  if (req.parentId) query.parentId = req.parentId;
  if (req.space) query.space = req.space;
  const res = await xhrPost<DocumentMeta>(
    resolveApiUrl(`/projects/${req.pid}/docs/import`, query),
    {
      body: new Blob([req.state.slice()], { type: 'application/octet-stream' }),
      contentType: 'application/octet-stream',
      fallback: tr('新建文档失败，请重试'),
      networkMessage: tr('网络断了，文档还没建好'),
      ...(req.onProgress ? { onProgress: req.onProgress } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    },
  );
  return res.body;
}
