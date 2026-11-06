import type * as Y from 'yjs';
import { IndexeddbPersistence, clearDocument } from 'y-indexeddb';

/**
 * 协同文档的本机缓存（IndexedDB，y-indexeddb）。
 *
 * - 每次本地修改都会立即写进 IndexedDB；断网时的修改在刷新 / 关闭页面后仍在，
 *   下次打开时先从本机载入，连上服务端后由 Yjs 自动补发、合并。
 * - 库名按「用户 + 文档」区分：同一浏览器换了账号，看不到上一个人的缓存。
 * - 握手被拒（4401 / 4403 / 4404）时删除这篇文档的缓存。
 */
const PREFIX = 'srh-doc';

export function localCacheName(userId: string, docId: string): string {
  return `${PREFIX}:${userId}:${docId}`;
}

export function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

export interface LocalCache {
  /** 本机缓存已读完（读不到 / 不支持时也会 resolve） */
  whenLoaded: Promise<{ hadContent: boolean }>;
  destroy(): void;
  /** 删掉这篇文档的本机缓存 */
  clear(): Promise<void>;
}

export function openLocalCache(name: string, doc: Y.Doc): LocalCache | null {
  if (!hasIndexedDb()) return null;
  let persistence: IndexeddbPersistence;
  try {
    persistence = new IndexeddbPersistence(name, doc);
  } catch {
    return null;
  }
  // 缓存里有没有内容（决定断网时能不能直接显示）：载入时 y-indexeddb 以自己为 origin 应用更新
  let hadContent = false;
  const onUpdate = (_u: Uint8Array, origin: unknown) => {
    if (origin === persistence) hadContent = true;
  };
  doc.on('update', onUpdate);
  const whenLoaded = persistence.whenSynced.then(
    () => {
      doc.off('update', onUpdate);
      return { hadContent };
    },
    () => ({ hadContent: false }),
  );
  let destroyed = false;
  return {
    whenLoaded,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      void persistence.destroy().catch(() => undefined);
    },
    async clear() {
      destroyed = true;
      try {
        await persistence.clearData();
      } catch {
        await clearLocalCache(name);
      }
    },
  };
}

export async function clearLocalCache(name: string): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await clearDocument(name);
  } catch {
    // 删除失败不影响使用
  }
}

/** 删掉本机所有协同文档缓存（退出登录时可以调用） */
export async function clearAllLocalCaches(): Promise<void> {
  if (!hasIndexedDb() || typeof indexedDB.databases !== 'function') return;
  try {
    const dbs = await indexedDB.databases();
    await Promise.all(
      dbs
        .map((d) => d.name)
        .filter((n): n is string => !!n && n.startsWith(`${PREFIX}:`))
        .map((n) => clearLocalCache(n)),
    );
  } catch {
    // 忽略
  }
}
