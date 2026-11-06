import { useCallback, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { PresenceState } from '@srh/shared';
import type { AvatarStackMember } from '@/components/ui';
import { useLocation } from 'react-router';
import { ck } from '@/features/collab-kit/keys';
import { presenceMembers } from '@/lib/presence-members';
import { qk } from '@/lib/query-keys';
import { presenceFromPath, VIEW_LABEL } from '@/lib/realtime';
import { usePresence } from '@/lib/realtime-store';
import { useMeUser } from '@/lib/session';
import { tr } from '@/lib/i18n';

const ACTIVITY_VERB = {
  viewing: tr('正在看'),
  typing: tr('正在输入 ·'),
  editing: tr('正在编辑'),
} as const;

/** 只读取已加载的本课题资源，在线名单不会发起额外请求。 */
export function knownResourceTitle(qc: QueryClient, projectId: string, p: PresenceState) {
  if (!p.objectId) return undefined;
  const id = p.objectId;
  const keys: Record<string, { detail: readonly unknown[]; list: readonly unknown[] }> = {
    thread: { detail: qk.thread(projectId, id), list: qk.threadsRoot(projectId) },
    document: { detail: ck.doc(projectId, id), list: ck.docs(projectId) },
    paper: {
      detail: ['p', projectId, 'library', 'paper', id],
      list: ['p', projectId, 'library', 'papers'],
    },
    notebook: { detail: ['p', projectId, 'notebook', id], list: ['p', projectId, 'notebooks'] },
    review: { detail: ck.review(projectId, id), list: ck.reviews(projectId) },
    proposal: {
      detail: ['p', projectId, 'proposal', id],
      list: ['p', projectId, 'proposals'],
    },
    report: { detail: ck.report(projectId, id), list: ck.reports(projectId) },
  };
  if (!Object.hasOwn(keys, p.view)) return undefined;
  const { detail, list } = keys[p.view]!;
  const titleOf = (value: unknown) => {
    if (!value || typeof value !== 'object' || !('id' in value) || !('title' in value)) return;
    if (value.id !== id || typeof value.title !== 'string') return;
    return value.title.trim() || undefined;
  };
  const detailTitle = titleOf(qc.getQueryData(detail));
  if (detailTitle) return detailTitle;
  for (const [, value] of qc.getQueriesData({ queryKey: list })) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const title = titleOf(item);
      if (title) return title;
    }
  }
  return undefined;
}

export function presenceActivity(p: PresenceState, title?: string): string {
  if (!Object.hasOwn(VIEW_LABEL, p.view) || !Object.hasOwn(ACTIVITY_VERB, p.activity))
    return tr('在线');
  return `${ACTIVITY_VERB[p.activity]} ${VIEW_LABEL[p.view]}${title ? tr('《{title}》', { title }) : ''}`;
}

/** 在线名单按人去重、排除自己，当前位置的活动优先展示。 */
export function usePresenceMembers(projectId: string): AvatarStackMember[] {
  const presence = usePresence(projectId);
  const me = useMeUser();
  const { pathname, search } = useLocation();
  const qc = useQueryClient();
  const subscribe = useCallback(
    (notify: () => void) =>
      qc.getQueryCache().subscribe((event) => {
        const key = event.query.queryKey;
        if (key[0] === 'p' && key[1] === projectId) notify();
      }),
    [qc, projectId],
  );
  const snapshot = useCallback(
    () =>
      JSON.stringify(
        qc
          .getQueryCache()
          .findAll({ queryKey: ['p', projectId] })
          .map((query) => [query.queryHash, query.state.dataUpdateCount]),
      ),
    [qc, projectId],
  );
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const thread = new URLSearchParams(search).get('thread');
  const target = thread ? { view: 'thread', objectId: thread } : presenceFromPath(pathname);
  return presenceMembers(presence, me?.id, target).map((p) => ({
    id: p.userId,
    name: p.name,
    color: p.avatarColor,
    activity: presenceActivity(p, knownResourceTitle(qc, projectId, p)),
  }));
}
