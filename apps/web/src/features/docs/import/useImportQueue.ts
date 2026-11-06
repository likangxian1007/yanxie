import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { DocumentKind, DocumentMeta, ResourceSpace } from '@srh/shared';
import { ck } from '@/features/collab-kit/keys';
import { upsertDoc } from '../list/doc-tree';
import { ImportError, routeImport } from './registry';
import {
  importErrorMessage,
  newImportId,
  runImport,
  type ImportProgress,
  type RunImportOptions,
} from './run';

/**
 * 多文件导入队列：每个文件一行状态（排队 / 解析 / 上传素材 / 保存 / 完成 / 失败），
 * 同时最多处理 2 个；失败可以重试（沿用同一个幂等键），不支持的类型直接标出原因。
 *
 * 队列放在模块里（按 key 区分，例如“某项目的文档列表”），不跟组件同生共死：
 * 关掉对话框、切到别的页面，导入都会继续跑完；回来时还能看到结果。
 */

export type ImportItemStatus = 'queued' | 'running' | 'done' | 'error';

export interface ImportItem {
  id: string;
  file: File;
  kind: DocumentKind | null;
  status: ImportItemStatus;
  progress: ImportProgress | null;
  error: string | null;
  /** 类型 / 大小不对的文件重试也没用 */
  retryable: boolean;
  warnings: string[];
  meta: DocumentMeta | null;
}

export const IMPORT_CONCURRENCY = 2;

export interface ImportQueueConfig {
  pid: string;
  parentId?: string | null;
  space?: ResourceSpace;
  onlyKind?: DocumentKind;
  /** 测试注入 */
  run?: (opts: RunImportOptions) => ReturnType<typeof runImport>;
}

type DoneListener = (item: ImportItem & { meta: DocumentMeta }) => void;

export interface ImportController {
  getItems: () => ImportItem[];
  subscribe: (fn: () => void) => () => void;
  onDone: (fn: DoneListener) => () => void;
  add: (files: File[]) => ImportItem[];
  retry: (id: string) => void;
  remove: (id: string) => void;
  clearFinished: () => void;
}

export function createImportController(
  config: ImportQueueConfig,
  qc: QueryClient | null,
): ImportController {
  let list: ImportItem[] = [];
  const running = new Map<string, AbortController>();
  const listeners = new Set<() => void>();
  const doneListeners = new Set<DoneListener>();
  const run = config.run ?? runImport;

  const commit = (next: ImportItem[]) => {
    list = next;
    for (const fn of listeners) fn();
  };
  const patch = (id: string, p: Partial<ImportItem>) =>
    commit(list.map((it) => (it.id === id ? { ...it, ...p } : it)));

  const start = (item: ImportItem) => {
    const ac = new AbortController();
    running.set(item.id, ac);
    patch(item.id, { status: 'running', progress: { stage: 'parsing' }, error: null });
    run({
      pid: config.pid,
      file: item.file,
      parentId: config.parentId ?? null,
      ...(config.space ? { space: config.space } : {}),
      ...(config.onlyKind ? { onlyKind: config.onlyKind } : {}),
      importId: item.id,
      signal: ac.signal,
      onProgress: (progress) => {
        if (running.get(item.id) === ac) patch(item.id, { progress });
      },
    })
      .then(({ meta, warnings }) => {
        if (running.get(item.id) !== ac) return;
        qc?.setQueryData<DocumentMeta[]>(ck.docs(config.pid), (l) => upsertDoc(l, meta, false));
        patch(item.id, { status: 'done', progress: null, meta, warnings });
        for (const fn of doneListeners) fn({ ...item, status: 'done', meta, warnings });
      })
      .catch((err: unknown) => {
        if (running.get(item.id) !== ac) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        patch(item.id, {
          status: 'error',
          progress: null,
          error: importErrorMessage(err),
          // 文件本身解析不了（ImportError）重试也没用；网络、服务器的问题可以重试
          retryable: !(err instanceof ImportError),
        });
      })
      .finally(() => {
        if (running.get(item.id) === ac) running.delete(item.id);
        pump();
      });
  };

  const pump = () => {
    for (const it of list) {
      if (running.size >= IMPORT_CONCURRENCY) break;
      if (it.status === 'queued' && !running.has(it.id)) start(it);
    }
  };

  return {
    getItems: () => list,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onDone(fn) {
      doneListeners.add(fn);
      return () => doneListeners.delete(fn);
    },
    add(files) {
      const added: ImportItem[] = files.map((file) => {
        const route = routeImport(file, config.onlyKind);
        return {
          id: newImportId(),
          file,
          kind: route.ok ? route.kind : null,
          status: route.ok ? 'queued' : 'error',
          progress: null,
          error: route.ok ? null : route.error,
          retryable: route.ok,
          warnings: [],
          meta: null,
        };
      });
      commit([...list, ...added]);
      pump();
      return added;
    },
    retry(id) {
      const it = list.find((x) => x.id === id);
      if (!it || it.status !== 'error' || !it.retryable) return;
      patch(id, { status: 'queued', error: null });
      pump();
    },
    remove(id) {
      const ac = running.get(id);
      running.delete(id);
      ac?.abort();
      commit(list.filter((it) => it.id !== id));
      pump();
    },
    clearFinished() {
      commit(list.filter((it) => it.status === 'queued' || it.status === 'running'));
    },
  };
}

const controllers = new Map<string, ImportController>();

/**
 * 订阅一个导入队列。key 相同的组件共享同一个队列（例如文档列表页 `list:<pid>`）。
 * onDone 只在组件挂载期间回调（用来跳转到新文档）。
 */
export function useImportQueue(key: string, config: ImportQueueConfig, onDone?: DoneListener) {
  const qc = useQueryClient();
  let controller = controllers.get(key);
  if (!controller) {
    controller = createImportController(config, qc);
    controllers.set(key, controller);
  }
  const c = controller;
  const items = useSyncExternalStore(c.subscribe, c.getItems, c.getItems);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });
  useEffect(() => c.onDone((item) => onDoneRef.current?.(item)), [c]);

  const busy = items.some((it) => it.status === 'queued' || it.status === 'running');
  return {
    items,
    busy,
    add: c.add,
    retry: c.retry,
    remove: c.remove,
    clearFinished: c.clearFinished,
  };
}

export type ImportQueue = ReturnType<typeof useImportQueue>;
