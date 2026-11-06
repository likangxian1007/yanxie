import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { INBOX_PRIORITY, type InboxItem } from '@srh/shared';
import { api } from '@/lib/api';
import { qk } from '@/lib/query-keys';

/**
 * 待我处理（API.md §2.6）：
 * - GET   /inbox?projectId=&done=   → InboxItem[]
 * - PATCH /inbox/:itemId { read?, done? } → InboxItem
 *
 * 缓存键用 qk.inbox(pid, done)：lib/apply-event.ts 收到 inbox.created / inbox.updated
 * 时按同一套键 upsert，所以这里的乐观更新与实时事件写的是同一份数据。
 */

export interface InboxPatch {
  read?: boolean;
  done?: boolean;
}

export function fetchInbox(pid: string, done: boolean, signal?: AbortSignal) {
  return api.get<InboxItem[]>('/inbox', { query: { projectId: pid, done }, signal });
}

export function patchInboxItem(itemId: string, patch: InboxPatch) {
  return api.patch<InboxItem>(`/inbox/${encodeURIComponent(itemId)}`, patch);
}

export function inboxQueryOptions(pid: string, done: boolean) {
  return queryOptions({
    queryKey: qk.inbox(pid, done),
    queryFn: ({ signal }) => fetchInbox(pid, done, signal),
    enabled: Boolean(pid),
  });
}

// ---------------------------------------------------------------- 排序

/** 待处理：按 INBOX_PRIORITY（小的在前），同级按创建时间新→旧。 */
export function sortPending(items: InboxItem[]): InboxItem[] {
  return [...items].sort(
    (a, b) =>
      INBOX_PRIORITY[a.kind] - INBOX_PRIORITY[b.kind] || b.createdAt.localeCompare(a.createdAt),
  );
}

/** 已完成：最近完成的在前（没有 doneAt 时退回 createdAt）。 */
export function sortDone(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) =>
    (b.doneAt ?? b.createdAt).localeCompare(a.doneAt ?? a.createdAt),
  );
}

// ---------------------------------------------------------------- 缓存读写

/** 在两份缓存（待处理 / 已完成）里找条目的最新版本。 */
export function findCachedItem(qc: QueryClient, pid: string, id: string): InboxItem | undefined {
  for (const done of [false, true]) {
    const hit = qc.getQueryData<InboxItem[]>(qk.inbox(pid, done))?.find((x) => x.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * 把条目放进它应在的那份缓存（按 doneAt 判断），并从另一份里移除。
 * 与 apply-event.ts 的 inbox.* 处理保持一致；没加载过的列表不动（打开时会自己拉）。
 */
export function placeItem(qc: QueryClient, pid: string, item: InboxItem) {
  for (const done of [false, true]) {
    qc.setQueryData<InboxItem[]>(qk.inbox(pid, done), (list) => {
      if (!list) return list;
      const belongs = Boolean(item.doneAt) === done;
      const i = list.findIndex((x) => x.id === item.id);
      if (!belongs) return i === -1 ? list : list.filter((x) => x.id !== item.id);
      if (i === -1) return [item, ...list];
      const next = list.slice();
      next[i] = item;
      return next;
    });
  }
}

/** 按 patch 算出乐观版本的条目。 */
export function applyPatch(item: InboxItem, patch: InboxPatch, nowIso: string): InboxItem {
  let { readAt, doneAt } = item;
  if (patch.read === true) readAt = readAt ?? nowIso;
  if (patch.read === false) readAt = null;
  if (patch.done === true) {
    doneAt = doneAt ?? nowIso;
    // 完成即视为已读
    readAt = readAt ?? nowIso;
  }
  if (patch.done === false) doneAt = null;
  return { ...item, readAt, doneAt };
}
