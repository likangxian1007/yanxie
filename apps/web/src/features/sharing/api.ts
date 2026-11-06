import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AccessLevel,
  DocumentMeta,
  LinkScope,
  Paper,
  ResourceSpace,
  ShareGrantInput,
  ShareLevel,
  ShareResolveResult,
  ShareResourceKind,
  ShareSettings,
  SpaceFilter,
} from '@srh/shared';
import { accessAtLeast } from '@srh/shared';
import { api } from '@/lib/api';
import { absoluteUrl } from '@/lib/base-path';
import { useProjectEvent } from '@/lib/realtime';
import { ck } from '@/features/collab-kit/keys';

/**
 * 个人 / 团队空间与分享的数据层（API.md §2.19）。
 * 查询键以 ['p', pid, …] 开头，/ws 重连 resync 时一起失效。
 */
export const sk = {
  settings: (pid: string, kind: ShareResourceKind, id: string) =>
    ['p', pid, 'share', kind, id] as const,
};

const base = (pid: string, kind: ShareResourceKind, id: string) =>
  `/projects/${pid}/shares/${kind}/${id}`;

export function useShareSettings(
  pid: string,
  kind: ShareResourceKind,
  id: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: sk.settings(pid, kind, id ?? ''),
    queryFn: ({ signal }) => api.get<ShareSettings>(base(pid, kind, id!), { signal }),
    enabled: Boolean(pid && id) && enabled,
  });
}

/** 分享设置的写操作：每个都返回最新设置，直接写回缓存 */
export function useShareMutations(pid: string, kind: ShareResourceKind, id: string) {
  const qc = useQueryClient();
  const write = (s: ShareSettings) => {
    qc.setQueryData(sk.settings(pid, kind, id), s);
    // 列表上的「已分享」标记
    void qc.invalidateQueries({ queryKey: listKey(pid, kind) });
  };
  return {
    link: useMutation({
      mutationFn: (input: { scope?: LinkScope; level?: ShareLevel }) =>
        api.patch<ShareSettings>(`${base(pid, kind, id)}/link`, input),
      onSuccess: write,
    }),
    reset: useMutation({
      mutationFn: () => api.post<ShareSettings>(`${base(pid, kind, id)}/link/reset`),
      onSuccess: write,
    }),
    invite: useMutation({
      mutationFn: (input: ShareGrantInput) =>
        api.post<ShareSettings>(`${base(pid, kind, id)}/grants`, input),
      onSuccess: write,
    }),
    setLevel: useMutation({
      mutationFn: ({ userId, level }: { userId: string; level: ShareLevel }) =>
        api.patch<ShareSettings>(`${base(pid, kind, id)}/grants/${userId}`, { level }),
      onSuccess: write,
    }),
    remove: useMutation({
      mutationFn: (userId: string) =>
        api.delete<ShareSettings>(`${base(pid, kind, id)}/grants/${userId}`),
      onSuccess: write,
    }),
  };
}

const listKey = (pid: string, kind: ShareResourceKind) =>
  kind === 'document' ? ck.docs(pid) : (['p', pid, 'library', 'papers'] as const);

/** 在团队空间和个人空间之间移动 */
export function useMoveSpace(pid: string, kind: ShareResourceKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      space,
    }: {
      id: string;
      space: ResourceSpace;
    }): Promise<DocumentMeta | Paper> =>
      kind === 'document'
        ? api.post<DocumentMeta>(`/projects/${pid}/docs/${id}/move`, { space })
        : api.post<Paper>(`/projects/${pid}/library/papers/${id}/move`, { space }),
    onSuccess: (_r, { id }) => {
      void qc.invalidateQueries({ queryKey: listKey(pid, kind) });
      void qc.invalidateQueries({ queryKey: sk.settings(pid, kind, id) });
      void qc.invalidateQueries({
        queryKey:
          kind === 'document' ? ck.doc(pid, id) : (['p', pid, 'library', 'paper', id] as const),
      });
    },
  });
}

/**
 * share.updated（只带 id）：分享设置变了、或资源换了空间。新获得 / 失去权限的人都要刷新，
 * 所以列表、详情、分享设置一起重新拉。
 */
export function useShareEvents(pid: string) {
  const qc = useQueryClient();
  useProjectEvent(pid, (event) => {
    if (event.type !== 'share.updated') return;
    const { resourceKind: kind, resourceId: id } = event.payload;
    void qc.invalidateQueries({ queryKey: listKey(pid, kind) });
    void qc.invalidateQueries({ queryKey: sk.settings(pid, kind, id) });
    void qc.invalidateQueries({
      queryKey:
        kind === 'document' ? ck.doc(pid, id) : (['p', pid, 'library', 'paper', id] as const),
    });
  });
}

export function resolveShareLink(token: string) {
  return api.post<ShareResolveResult>(`/share/${encodeURIComponent(token)}`);
}

/** 分享链接的完整地址 */
export const shareUrl = (token: string) => absoluteUrl(`/s/${token}`);

// ---------------------------------------------------------------- 空间筛选

export type SpaceTab = Exclude<SpaceFilter, 'all'>;

export const SPACE_TABS: SpaceTab[] = ['team', 'personal', 'shared'];

export function readSpaceTab(v: string): SpaceTab {
  return (SPACE_TABS as string[]).includes(v) ? (v as SpaceTab) : 'team';
}

interface Spaced {
  space?: ResourceSpace | undefined;
  ownerUserId?: string | null | undefined;
}

/** 资源属于哪个标签：团队空间 / 我的空间 / 与我共享 */
export function spaceTabOf(r: Spaced, me: string | null): SpaceTab {
  if ((r.space ?? 'team') === 'team') return 'team';
  return r.ownerUserId && r.ownerUserId === me ? 'personal' : 'shared';
}

export function countBySpace(rows: Spaced[], me: string | null): Record<SpaceTab, number> {
  const out: Record<SpaceTab, number> = { team: 0, personal: 0, shared: 0 };
  for (const r of rows) out[spaceTabOf(r, me)] += 1;
  return out;
}

/** 没有 access（旧服务端 / 缓存）时按角色兜底 */
export function effectiveAccess(
  access: AccessLevel | undefined,
  roleCanWrite: boolean,
): AccessLevel {
  return access ?? (roleCanWrite ? 'edit' : 'view');
}

export const canEditAccess = (a: AccessLevel) => accessAtLeast(a, 'edit');
export const canCommentAccess = (a: AccessLevel) => accessAtLeast(a, 'comment');
