import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  BasisProposal,
  BasisProposalCreate,
  BasisProposalDecision,
  BasisProposalPatch,
  ExplorationCreate,
  ExplorationPatch,
  OfficialPlanInit,
  PersonalMemory,
  PersonalMemoryInput,
  Plan,
  PlanContentInput,
  PlanVersion,
  PlansOverview,
  TeamBasis,
  TeamBasisReview,
} from '@srh/shared';
import { api } from '@/lib/api';
import { useProjectEvent } from '@/lib/realtime';

/**
 * 方案与依据的数据层（唯一的 API 客户端）：路径全部集中在 `paths` 里，后端路径变化只改这里。
 * 所有路径相对 `/api`，以 `/projects/:pid/plans` 开头。
 */
const root = (pid: string) => `/projects/${pid}/plans`;
export const paths = {
  overview: (pid: string) => root(pid),
  official: (pid: string) => `${root(pid)}/official`,
  versions: (pid: string, planId: string) => `${root(pid)}/${planId}/versions`,
  content: (pid: string, planId: string) => `${root(pid)}/${planId}/content`,
  explorations: (pid: string) => `${root(pid)}/explorations`,
  plan: (pid: string, planId: string) => `${root(pid)}/${planId}`,
  archive: (pid: string, planId: string) => `${root(pid)}/${planId}/archive`,
  proposals: (pid: string) => `${root(pid)}/proposals`,
  proposal: (pid: string, id: string) => `${root(pid)}/proposals/${id}`,
  memories: (pid: string) => `${root(pid)}/memory`,
  memory: (pid: string, memoryId: string) => `${root(pid)}/memory/${memoryId}`,
  basis: (pid: string) => `${root(pid)}/basis`,
  basisReview: (pid: string, id: string) => `${root(pid)}/basis/${id}/review`,
};

/** 查询键：都以 ['p', pid] 开头，ws resync 时随项目整体失效。 */
export const planKeys = {
  overview: (pid: string) => ['p', pid, 'plans'] as const,
  versions: (pid: string, planId: string) => ['p', pid, 'plans', 'versions', planId] as const,
  memory: (pid: string, userId: string) => ['p', pid, 'plans', 'memory', userId] as const,
};

/** 带默认值的字段在调用时可省略 */
export type ProposalCreateInput = Omit<
  BasisProposalCreate,
  'content' | 'rationale' | 'impact' | 'conditions' | 'evidence' | 'submit'
> &
  Partial<
    Pick<
      BasisProposalCreate,
      'content' | 'rationale' | 'impact' | 'conditions' | 'evidence' | 'submit'
    >
  >;

// ---------------------------------------------------------------- 缓存写入

function upsert<T extends { id: string }>(list: T[], item: T, front = true): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return front ? [item, ...list] : [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function newer<T extends { id: string; version: number }>(list: T[], item: T): boolean {
  const cur = list.find((x) => x.id === item.id);
  return !cur || item.version >= cur.version;
}

function patchOverview(qc: QueryClient, pid: string, fn: (o: PlansOverview) => PlansOverview) {
  qc.setQueryData<PlansOverview>(planKeys.overview(pid), (o) => (o ? fn(o) : o));
}

export function writePlan(qc: QueryClient, pid: string, plan: Plan) {
  patchOverview(qc, pid, (o) => {
    if (plan.kind === 'official') {
      if (o.official && o.official.id === plan.id && plan.version < o.official.version) return o;
      return { ...o, official: plan };
    }
    if (!newer(o.explorations, plan)) return o;
    return { ...o, explorations: upsert(o.explorations, plan) };
  });
}

export function writeProposal(qc: QueryClient, pid: string, p: BasisProposal) {
  patchOverview(qc, pid, (o) =>
    newer(o.proposals, p) ? { ...o, proposals: upsert(o.proposals, p) } : o,
  );
}

export function writeBasis(qc: QueryClient, pid: string, b: TeamBasis) {
  patchOverview(qc, pid, (o) => {
    const cur = o.basis.find((x) => x.id === b.id);
    if (cur && b.updatedAt < cur.updatedAt) return o;
    return { ...o, basis: upsert(o.basis, b) };
  });
}

function writeVersion(qc: QueryClient, pid: string, v: PlanVersion) {
  qc.setQueryData<PlanVersion[]>(planKeys.versions(pid, v.planId), (list) =>
    list ? upsert(list, v).sort((a, b) => b.version - a.version) : list,
  );
}

// ---------------------------------------------------------------- 查询

export function plansOverviewQueryOptions(pid: string) {
  return queryOptions({
    queryKey: planKeys.overview(pid),
    queryFn: ({ signal }) => api.get<PlansOverview>(paths.overview(pid), { signal }),
    enabled: Boolean(pid),
  });
}

export function usePlansOverview(pid: string) {
  return useQuery(plansOverviewQueryOptions(pid));
}

/** 版本按版本号倒序 */
export function usePlanVersions(pid: string, planId: string | undefined) {
  return useQuery({
    queryKey: planKeys.versions(pid, planId ?? ''),
    queryFn: async ({ signal }) =>
      (await api.get<PlanVersion[]>(paths.versions(pid, planId!), { signal }))
        .slice()
        .sort((a, b) => b.version - a.version),
    enabled: Boolean(pid && planId),
  });
}

/** 个人记忆：后端返回列表，页面只编辑最近更新的一份；还没有时为 null */
export function usePersonalMemory(pid: string, userId: string | undefined) {
  return useQuery({
    queryKey: planKeys.memory(pid, userId ?? ''),
    queryFn: async ({ signal }) => {
      const list = await api.get<PersonalMemory[]>(paths.memories(pid), {
        signal,
        query: { userId },
      });
      return list.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
    },
    enabled: Boolean(pid && userId),
  });
}

// ---------------------------------------------------------------- 写操作

export function useInitOfficialPlan(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<OfficialPlanInit> & { content: string }) =>
      api.post<Plan>(paths.official(pid), input),
    onSuccess: (plan) => writePlan(qc, pid, plan),
  });
}

export function useSavePlanContent(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ planId, ...input }: PlanContentInput & { planId: string }) =>
      api.put<Plan>(paths.content(pid, planId), input),
    onSuccess: (plan) => {
      writePlan(qc, pid, plan);
      void qc.invalidateQueries({ queryKey: planKeys.versions(pid, plan.id) });
    },
  });
}

export function useCreateExploration(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ExplorationCreate) => api.post<Plan>(paths.explorations(pid), input),
    onSuccess: (plan) => writePlan(qc, pid, plan),
  });
}

export function usePatchExploration(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: ExplorationPatch & { id: string }) =>
      api.patch<Plan>(paths.plan(pid, id), input),
    onSuccess: (plan) => writePlan(qc, pid, plan),
  });
}

export function useArchivePlan(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) => api.post<Plan>(paths.archive(pid, planId), {}),
    onSuccess: (plan) => writePlan(qc, pid, plan),
  });
}

export function useCreateProposal(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ProposalCreateInput) =>
      api.post<BasisProposal>(paths.proposals(pid), input),
    onSuccess: (p) => writeProposal(qc, pid, p),
  });
}

export function usePatchProposal(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: BasisProposalPatch & { id: string }) =>
      api.patch<BasisProposal>(paths.proposal(pid, id), input),
    onSuccess: (p) => writeProposal(qc, pid, p),
  });
}

/** 提交 / 撤回草稿 */
export function useProposalAction(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'submit' | 'withdraw' }) =>
      api.post<BasisProposal>(`${paths.proposal(pid, id)}/${action}`, {}),
    onSuccess: (p) => writeProposal(qc, pid, p),
  });
}

/** 负责人采纳 / 不采纳；采纳会产生新的正式版本或团队依据，整体刷新总览 */
export function useDecideProposal(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: BasisProposalDecision & { id: string }) =>
      api.post<BasisProposal>(`${paths.proposal(pid, id)}/decide`, input),
    onSuccess: (p) => {
      writeProposal(qc, pid, p);
      void qc.invalidateQueries({ queryKey: planKeys.overview(pid) });
    },
  });
}

export function useReviewBasis(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: TeamBasisReview & { id: string }) =>
      api.post<TeamBasis>(paths.basisReview(pid, id), input),
    onSuccess: (b) => writeBasis(qc, pid, b),
  });
}

/** 没有 memoryId 时新建（baseVersion 0），否则按 baseVersion 覆盖 */
export function useSaveMemory(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ memoryId, ...input }: PersonalMemoryInput & { memoryId: string | null }) =>
      memoryId
        ? api.put<PersonalMemory>(paths.memory(pid, memoryId), input)
        : api.post<PersonalMemory>(paths.memories(pid), { ...input, baseVersion: 0 }),
    onSuccess: (m) => qc.setQueryData(planKeys.memory(pid, m.userId), m),
  });
}

// ---------------------------------------------------------------- 实时

/** plan.* / basis_proposal.* / team_basis.* → 总览与版本缓存（个人记忆不广播） */
export function usePlansRealtime(pid: string) {
  const qc = useQueryClient();
  useProjectEvent(pid, (event) => {
    switch (event.type) {
      case 'plan.created':
      case 'plan.updated':
        writePlan(qc, pid, event.payload);
        break;
      case 'plan.version_created':
        writeVersion(qc, pid, event.payload);
        break;
      case 'basis_proposal.created':
      case 'basis_proposal.updated':
        writeProposal(qc, pid, event.payload);
        break;
      case 'basis_proposal.deleted': {
        const { id } = event.payload;
        patchOverview(qc, pid, (o) => ({
          ...o,
          proposals: o.proposals.filter((p) => p.id !== id),
        }));
        break;
      }
      case 'team_basis.created':
      case 'team_basis.updated':
        writeBasis(qc, pid, event.payload);
        break;
    }
  });
}
