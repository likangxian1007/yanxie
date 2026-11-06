import type { FileObject } from '@srh/shared';
import { ApiRequestError, resolveApiUrl } from '@/lib/api';
import { tr } from '@/lib/i18n';

/**
 * 富文本里的图片 / 附件上传：走文件模块的 POST P/files（multipart，字段 file），
 * 用 XHR 拿上传进度。上传后的地址是 GET P/files/:fileId（图片内联显示，附件加 ?download=1）。
 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export function fileUrl(pid: string, fileId: string, download = false): string {
  return resolveApiUrl(`/projects/${pid}/files/${fileId}`, download ? { download: 1 } : undefined);
}

export function isImageFile(file: { type: string; name: string }): boolean {
  if (file.type.startsWith('image/')) return file.type !== 'image/svg+xml';
  return /\.(png|jpe?g|gif|webp|bmp|avif)$/iu.test(file.name);
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 上传前的检查：返回给用户看的错误，没问题返回 null */
export function uploadProblem(file: { size: number }): string | null {
  if (file.size > MAX_UPLOAD_BYTES) return tr('文件不能超过 20 MB');
  if (file.size === 0) return tr('这个文件是空的');
  return null;
}

export interface UploadHandle {
  promise: Promise<FileObject>;
  abort: () => void;
}

export function uploadFile(
  pid: string,
  file: File,
  onProgress?: (fraction: number) => void,
): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<FileObject>((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    xhr.open('POST', resolveApiUrl(`/projects/${pid}/files`));
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && body) {
        resolve(body as FileObject);
        return;
      }
      const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
      reject(
        new ApiRequestError({
          status: xhr.status,
          code: err?.code ?? `http_${xhr.status}`,
          message:
            err?.message ??
            (xhr.status === 403 ? tr('你没有上传文件的权限') : tr('上传失败，请稍后再试')),
        }),
      );
    };
    xhr.onerror = () =>
      reject(
        new ApiRequestError({
          status: 0,
          code: 'network_error',
          message: tr('网络断了，文件没有上传'),
        }),
      );
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}
