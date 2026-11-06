import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ChangeProposal,
  HunkDecision,
  ProposalMergeInput,
  ProposalTargetKind,
  Version,
  VersionContent,
  VersionDetail,
  VersioningSettings,
  VersioningSettingsInput,
  VersionRestoreResult,
  VersionTargetKind,
} from '@srh/shared';
import { api } from '@/lib/api';
import { useProjectEvent } from '@/lib/realtime';

/** 版本管理（API.md §2.18）的查询与写入。查询键都以 ['p', pid] 开头，/ws 重连时整体刷新。 */
export const vk = {
  versions: (pid: string, kind: VersionTargetKind, id: string) =>
    ['p', pid, 'versions', kind, id] as const,
  version: (pid: string, versionId: string) => ['p', pid, 'version', versionId] as const,
  current: (pid: string, kind: VersionTargetKind, id: string) =>
    ['p', pid, 'versions', kind, id, 'current'] as const,
  proposals: (pid: string) => ['p', pid, 'proposals'] as const,
  proposalsOf: (pid: string, kind: ProposalTargetKind, id: string) =>
    ['p', pid, 'proposals', kind, id] as const,
  proposal: (pid: string, id: string) => ['p', pid, 'proposal', id] as const,
  settings: (pid: string) => ['p', pid, 'versioning', 'settings'] as const,
};

const P = (pid: string) => `/projects/${pid}`;

export function useVersions(pid: string, kind: VersionTargetKind, id: string, enabled = true) {
  return useQuery({
    queryKey: vk.versions(pid, kind, id),
    queryFn: ({ signal }) =>
      api.get<Version[]>(
        `${P(pid)}/versions?targetKind=${kind}&targetId=${encodeURIComponent(id)}`,
        { signal },
      ),
    enabled: enabled && Boolean(pid && id),
  });
}

export function useVersionContent(pid: string, versionId: string | null) {
  return useQuery({
    queryKey: vk.version(pid, versionId ?? ''),
    queryFn: ({ signal }) => api.get<VersionDetail>(`${P(pid)}/versions/${versionId}`, { signal }),
    enabled: Boolean(pid && versionId),
    // 版本内容不会变
    staleTime: Infinity,
  });
}

export function useCurrentContent(
  pid: string,
  kind: VersionTargetKind,
  id: string,
  enabled = true,
) {
  return useQuery({
    queryKey: vk.current(pid, kind, id),
    queryFn: ({ signal }) =>
      api.get<VersionContent>(
        `${P(pid)}/versions/current?targetKind=${kind}&targetId=${encodeURIComponent(id)}`,
        { signal },
      ),
    enabled: enabled && Boolean(pid && id),
    staleTime: 0,
  });
}

export function useSaveVersion(pid: string, kind: VersionTargetKind, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (note: string) =>
      api.post<Version>(`${P(pid)}/versions`, { targetKind: kind, targetId: id, note }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: vk.versions(pid, kind, id) }),
  });
}

export function useRestoreVersion(pid: string, kind: VersionTargetKind, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) =>
      api.post<VersionRestoreResult>(`${P(pid)}/versions/${versionId}/restore`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: vk.versions(pid, kind, id) }),
  });
}

// ---------------------------------------------------------------- 改动提案

export function useProposalsOf(pid: string, kind: ProposalTargetKind, id: string, enabled = true) {
  return useQuery({
    queryKey: vk.proposalsOf(pid, kind, id),
    queryFn: ({ signal }) =>
      api.get<ChangeProposal[]>(
        `${P(pid)}/proposals?targetKind=${kind}&targetId=${encodeURIComponent(id)}&status=open`,
        { signal },
      ),
    enabled: enabled && Boolean(pid && id),
  });
}

export function useProposal(pid: string, id: string) {
  return useQuery({
    queryKey: vk.proposal(pid, id),
    queryFn: ({ signal }) => api.get<ChangeProposal>(`${P(pid)}/proposals/${id}`, { signal }),
    enabled: Boolean(pid && id),
  });
}

export function useProposalDecisions(pid: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (decisions: Record<string, HunkDecision>) =>
      api.patch<ChangeProposal>(`${P(pid)}/proposals/${id}/decisions`, { decisions }),
    onMutate: async (decisions) => {
      // 乐观更新：按钮点下去立刻变
      await qc.cancelQueries({ queryKey: vk.proposal(pid, id) });
      const prev = qc.getQueryData<ChangeProposal>(vk.proposal(pid, id));
      if (prev) {
        qc.setQueryData<ChangeProposal>(vk.proposal(pid, id), {
          ...prev,
          hunks: prev.hunks.map((h) =>
            decisions[h.id] ? { ...h, decision: decisions[h.id]! } : h,
          ),
        });
      }
      return { prev };
    },
    onError: (_err, _vars, c) => {
      if (c?.prev) qc.setQueryData(vk.proposal(pid, id), c.prev);
    },
    onSuccess: (p) => qc.setQueryData(vk.proposal(pid, id), p),
  });
}

export function useMergeProposal(pid: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ProposalMergeInput) =>
      api.post<ChangeProposal>(`${P(pid)}/proposals/${id}/merge`, input),
    onSuccess: (p) => {
      qc.setQueryData(vk.proposal(pid, id), p);
      void qc.invalidateQueries({ queryKey: vk.proposals(pid) });
      // 合入 / 关闭提案会顺带关闭它的审阅（事件也会到，这里不等）
      if (p.reviewId) {
        void qc.invalidateQueries({ queryKey: ['p', pid, 'review', p.reviewId] });
        void qc.invalidateQueries({ queryKey: ['p', pid, 'reviews'] });
      }
    },
  });
}

export function useCloseProposal(pid: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<ChangeProposal>(`${P(pid)}/proposals/${id}/close`, {}),
    onSuccess: (p) => {
      qc.setQueryData(vk.proposal(pid, id), p);
      void qc.invalidateQueries({ queryKey: vk.proposals(pid) });
      // 合入 / 关闭提案会顺带关闭它的审阅（事件也会到，这里不等）
      if (p.reviewId) {
        void qc.invalidateQueries({ queryKey: ['p', pid, 'review', p.reviewId] });
        void qc.invalidateQueries({ queryKey: ['p', pid, 'reviews'] });
      }
    },
  });
}

// ---------------------------------------------------------------- 设置

export function useVersioningSettings(pid: string) {
  return useQuery({
    queryKey: vk.settings(pid),
    queryFn: ({ signal }) =>
      api.get<VersioningSettings>(`${P(pid)}/versioning/settings`, { signal }),
    enabled: Boolean(pid),
  });
}

export function useUpdateVersioningSettings(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: VersioningSettingsInput) =>
      api.patch<VersioningSettings>(`${P(pid)}/versioning/settings`, input),
    onSuccess: (s) => qc.setQueryData(vk.settings(pid), s),
  });
}

export interface GithubTestResult {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  url: string;
  canPush: boolean;
}

export function useTestGithub(pid: string) {
  return useMutation({
    mutationFn: () => api.post<GithubTestResult>(`${P(pid)}/versioning/github/test`, {}),
  });
}

// ---------------------------------------------------------------- 实时

/** version.* / proposal.* 事件 → 缓存 */
export function useVersioningEvents(pid: string) {
  const qc = useQueryClient();
  useProjectEvent(pid, (event) => {
    switch (event.type) {
      case 'version.created': {
        const v = event.payload;
        void qc.invalidateQueries({ queryKey: vk.versions(pid, v.targetKind, v.targetId) });
        break;
      }
      case 'proposal.created':
      case 'proposal.updated': {
        const p = event.payload;
        qc.setQueryData(vk.proposal(pid, p.id), p);
        void qc.invalidateQueries({ queryKey: vk.proposals(pid) });
        break;
      }
      case 'versioning.settings_updated':
        qc.setQueryData(vk.settings(pid), event.payload);
        break;
      case 'document.updated':
      case 'notebook.updated': {
        // 正文变了：开放提案的冲突要重新算
        const id = (event.payload as { id: string }).id;
        void qc.invalidateQueries({
          predicate: (q) => {
            const k = q.queryKey;
            if (k[0] !== 'p' || k[1] !== pid) return false;
            if (k[2] === 'proposal') return true;
            return k[2] === 'versions' && k[4] === id && k[5] === 'current';
          },
        });
        break;
      }
      default:
        break;
    }
  });
}
