import {
  DOC_IMPORT_MAX_BYTES,
  type DocumentKind,
  type DocumentMeta,
  type FileObject,
  type ResourceSpace,
} from '@srh/shared';
import { ApiRequestError } from '@/lib/api';
import {
  deleteProjectFile,
  postImportedDoc,
  projectFileUrl,
  uploadProjectFile,
  type ImportDocRequest,
} from './api';
import { routeImport } from './registry';
import { fileBaseName, formatSize } from './text';
import { ImportError, type ImportContext } from './types';
import { tr } from '@/lib/i18n';

/**
 * 一个文件的完整导入流程（列表页上传、文档页导入共用）：
 *   检查类型 / 大小 → 按需加载导入器 → 解析进一个全新的本地 Y.Doc（图片随解析上传）
 *   → POST P/docs/import 把整份状态和文档一起原子建好（断网、5xx 自动重试，幂等键防重复）。
 * 任何一步失败：删掉这次已上传的素材，不留下空文档或半成品；错误信息都是给用户看的中文。
 */

export type ImportStage = 'parsing' | 'uploading' | 'saving';

export interface ImportProgress {
  stage: ImportStage;
  /** 0–1；未知时省略 */
  fraction?: number;
  /** uploading：已上传 / 共几个素材 */
  uploaded?: number;
}

export interface ImportDeps {
  upload: (pid: string, path: string, blob: Blob, signal?: AbortSignal) => Promise<FileObject>;
  remove: (pid: string, fileId: string) => Promise<void>;
  post: (req: ImportDocRequest) => Promise<DocumentMeta>;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: ImportDeps = {
  upload: uploadProjectFile,
  remove: deleteProjectFile,
  post: postImportedDoc,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface RunImportOptions {
  pid: string;
  file: File;
  /** 导入到哪个父文档下（null = 顶层） */
  parentId?: string | null;
  /** personal = 导入到自己的个人空间 */
  space?: ResourceSpace;
  /** 只接受某一类（文档页里导入） */
  onlyKind?: DocumentKind;
  /** 幂等键：同一个文件重试时沿用 */
  importId: string;
  onProgress?: (p: ImportProgress) => void;
  signal?: AbortSignal;
  deps?: Partial<ImportDeps>;
}

export interface RunImportResult {
  meta: DocumentMeta;
  warnings: string[];
}

export function newImportId(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/gu, '')
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `imp_${rand.slice(0, 24)}`;
}

/** 项目文件路径的一段：去掉文件系统不认的字符 */
function safeSegment(seg: string): string {
  const s = seg
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\u0000-\u001f\u007f]+/gu, '_')
    .replace(/[. ]+$/u, '')
    .trim()
    .slice(0, 80);
  return s || 'file';
}

export function assetPath(folder: string, name: string): string {
  const segs = name
    .replace(/\\/gu, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .map(safeSegment);
  return ['imports', folder, ...(segs.length ? segs : ['file'])].join('/');
}

const hasCjk = (s: string) => /[\u3400-\u9fff]/u.test(s);

/** 任意错误 → 给用户看的中文 */
export function importErrorMessage(err: unknown): string {
  if (err instanceof ImportError || err instanceof ApiRequestError) return err.message;
  if (err instanceof Error && hasCjk(err.message)) return err.message;
  return tr('文件解析失败，可能已损坏，或者用了暂不支持的格式');
}

function isRetryable(err: unknown): boolean {
  return (
    err instanceof ApiRequestError && (err.status === 0 || err.status === 429 || err.status >= 500)
  );
}

const RETRY_DELAYS = [800, 2000, 5000];

export async function runImport(opts: RunImportOptions): Promise<RunImportResult> {
  const deps = { ...defaultDeps, ...opts.deps };
  const { pid, file, signal } = opts;
  const route = routeImport(file, opts.onlyKind);
  if (!route.ok) throw new ImportError(route.error);

  opts.onProgress?.({ stage: 'parsing' });
  // 列表和导入队列本身不需要 Yjs；实际开始导入时再与解析器并行下载。
  const [importer, Y] = await Promise.all([route.format.load(), import('yjs')]);
  const ydoc = new Y.Doc();
  const uploaded: string[] = [];
  const folder = `${safeSegment(fileBaseName(file.name)).slice(0, 40)}-${opts.importId.slice(-8)}`;
  const ctx: ImportContext = {
    projectId: pid,
    uploadFile: async (blob, name) => {
      signal?.throwIfAborted();
      opts.onProgress?.({ stage: 'uploading', uploaded: uploaded.length });
      const f = await deps.upload(pid, assetPath(folder, name), blob, signal);
      uploaded.push(f.id);
      opts.onProgress?.({ stage: 'uploading', uploaded: uploaded.length });
      return { id: f.id, url: projectFileUrl(pid, f.id) };
    },
  };

  try {
    let result: { title: string; warnings?: string[] };
    try {
      result = await importer(file, ydoc, ctx);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      // 上传素材时的网络 / 服务端错误原样抛出（可以重试）；其余都是解析失败（重试也一样）
      if (err instanceof ApiRequestError) throw err;
      throw new ImportError(importErrorMessage(err));
    }
    signal?.throwIfAborted();
    const state = Y.encodeStateAsUpdate(ydoc);
    if (state.byteLength > DOC_IMPORT_MAX_BYTES) {
      throw new ImportError(
        tr('内容太多了（{value}），一份文档最多 {value2}，可以拆成几个文件导入', {
          value: formatSize(state.byteLength),
          value2: formatSize(DOC_IMPORT_MAX_BYTES),
        }),
      );
    }
    const title = fileBaseName(file.name) || result.title.trim() || tr('未命名文档');
    opts.onProgress?.({ stage: 'saving', fraction: 0 });
    let meta: DocumentMeta | null = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        meta = await deps.post({
          pid,
          kind: route.kind,
          title,
          parentId: opts.parentId ?? null,
          ...(opts.space ? { space: opts.space } : {}),
          importId: opts.importId,
          state,
          onProgress: (fraction) => opts.onProgress?.({ stage: 'saving', fraction }),
          ...(signal ? { signal } : {}),
        });
        break;
      } catch (err) {
        const delay = RETRY_DELAYS[attempt];
        if (!isRetryable(err) || delay === undefined || signal?.aborted) throw err;
        await deps.sleep(delay);
      }
    }
    return { meta, warnings: result.warnings ?? [] };
  } catch (err) {
    // 失败：清理这次上传的素材（尽力而为）
    await Promise.all(uploaded.map((id) => deps.remove(pid, id).catch(() => undefined)));
    throw err;
  } finally {
    ydoc.destroy();
  }
}
