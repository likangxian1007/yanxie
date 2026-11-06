import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { InboxItem } from '@srh/shared';
import { toast } from '@/components/ui';
import { qk } from '@/lib/query-keys';
import {
  applyPatch,
  findCachedItem,
  patchInboxItem,
  placeItem,
  type InboxPatch,
} from './inbox-api';
import { tr } from '@/lib/i18n';

export interface InboxPatchVars {
  /** 触发操作时手上的条目；onMutate 会优先取缓存里的最新版本 */
  item: InboxItem;
  patch: InboxPatch;
}

interface PatchContext {
  previous: InboxItem;
}

function errorText(err: unknown): string | undefined {
  return err instanceof Error && err.message ? err.message : undefined;
}

function failureTitle(patch: InboxPatch): string {
  if (patch.done === true) return tr('没能标为完成');
  if (patch.done === false) return tr('没能移回待处理');
  if (patch.read === false) return tr('没能标为未读');
  return tr('没能标为已读');
}

/**
 * 单条 PATCH：乐观改写 qk.inbox(pid,false) 与 qk.inbox(pid,true) 两份缓存，
 * 失败时只把这一条恢复成操作前的样子（不会覆盖同时进行的其它操作），并提示。
 * 这些回调写在 useMutation 上，组件卸载（例如点开条目跳走）后依然会执行。
 */
export function useInboxPatch(pid: string) {
  const qc = useQueryClient();
  return useMutation<InboxItem, unknown, InboxPatchVars, PatchContext>({
    mutationFn: ({ item, patch }) => patchInboxItem(item.id, patch),
    onMutate: async ({ item, patch }) => {
      await qc.cancelQueries({ queryKey: qk.inboxRoot(pid) });
      const previous = findCachedItem(qc, pid, item.id) ?? item;
      placeItem(qc, pid, applyPatch(previous, patch, new Date().toISOString()));
      return { previous };
    },
    onSuccess: (server) => {
      if (server?.id) placeItem(qc, pid, server);
    },
    onError: (err, { patch }, ctx) => {
      if (ctx) placeItem(qc, pid, ctx.previous);
      toast.error(failureTitle(patch), errorText(err) ?? tr('请检查网络后重试。'));
    },
  });
}

interface MarkAllResult {
  updated: InboxItem[];
  failed: InboxItem[];
}

/** 全部标为已读：对每条未读条目 PATCH {read:true}，乐观更新，部分失败时恢复失败的那些。 */
export function useMarkAllRead(pid: string) {
  const qc = useQueryClient();
  return useMutation<MarkAllResult, unknown, InboxItem[], { previous: InboxItem[] }>({
    mutationFn: async (items) => {
      const results = await Promise.allSettled(
        items.map((item) => patchInboxItem(item.id, { read: true })),
      );
      const updated: InboxItem[] = [];
      const failed: InboxItem[] = [];
      results.forEach((r, i) => {
        const item = items[i];
        if (!item) return;
        if (r.status === 'fulfilled') updated.push(r.value?.id ? r.value : item);
        else failed.push(item);
      });
      return { updated, failed };
    },
    onMutate: async (items) => {
      await qc.cancelQueries({ queryKey: qk.inboxRoot(pid) });
      const now = new Date().toISOString();
      const previous = items.map((item) => findCachedItem(qc, pid, item.id) ?? item);
      for (const item of previous) placeItem(qc, pid, applyPatch(item, { read: true }, now));
      return { previous };
    },
    onSuccess: ({ updated, failed }, _items, ctx) => {
      for (const item of updated) placeItem(qc, pid, item);
      if (failed.length === 0) return;
      const ids = new Set(failed.map((x) => x.id));
      for (const item of ctx?.previous ?? []) if (ids.has(item.id)) placeItem(qc, pid, item);
      toast.error(
        tr('有 {count} 条没能标为已读', { count: failed.length }),
        tr('其余已经处理好了，可以稍后再试一次。'),
      );
    },
    onError: (err, _items, ctx) => {
      for (const item of ctx?.previous ?? []) placeItem(qc, pid, item);
      toast.error(tr('没能全部标为已读'), errorText(err) ?? tr('请检查网络后重试。'));
    },
  });
}
