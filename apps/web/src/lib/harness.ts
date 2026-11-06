import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  AgentProfile,
  AgentSession,
  CommandRunInput,
  CommandRunResult,
  HarnessSummary,
  LlmProvider,
  McpServer,
  ModelCatalog,
  ProviderModelInput,
  ReasoningEffort,
  SessionSettingsInput,
  Skill,
  SlashCommand,
  ThinkingFormat,
  WritableScope,
} from '@srh/shared';
import { api } from './api';
import { qk } from './query-keys';

/**
 * Agent harness 的数据层（模型与推理强度、MCP、Skill、斜杠指令、科研 profile）。
 * 查询键都在 ['p', pid, 'harness', …] 下：项目事件（provider.* / mcp.* / skill.* / command.* /
 * profile.*）到达时由 lib/apply-event 整体失效；个人作用域的写入不广播，所以每次写完也整体失效。
 */
export const harnessKeys = {
  root: (pid: string) => ['p', pid, 'harness'] as const,
  summary: (pid: string) => ['p', pid, 'harness', 'summary'] as const,
  models: (pid: string) => ['p', pid, 'harness', 'models'] as const,
  mcp: (pid: string) => ['p', pid, 'harness', 'mcp'] as const,
  skills: (pid: string) => ['p', pid, 'harness', 'skills'] as const,
  commands: (pid: string) => ['p', pid, 'harness', 'commands'] as const,
  profiles: (pid: string) => ['p', pid, 'harness', 'profiles'] as const,
};

export function invalidateHarness(qc: QueryClient, pid: string) {
  return qc.invalidateQueries({ queryKey: harnessKeys.root(pid) });
}

// ---------------------------------------------------------------- 查询

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/**
 * 接口形状不对（后端还没部署 harness、测试里的兜底响应）时当作没有数据，
 * 而不是让输入框整个崩掉：缺 catalog 返回 null，列表缺失按空数组。
 */
export function normalizeSummary(raw: unknown): HarnessSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<HarnessSummary>;
  if (!r.catalog || typeof r.catalog !== 'object') return null;
  return {
    catalog: { ...r.catalog, providers: arr<LlmProvider>(r.catalog.providers) },
    commands: arr<SlashCommand>(r.commands),
    skills: arr<Skill>(r.skills),
    profiles: arr<AgentProfile>(r.profiles),
  };
}

/** 输入框一次取齐：模型目录、指令、skill、profile（内置 + 项目 + 我的个人）。 */
export function useHarness(pid: string, enabled = true) {
  return useQuery({
    queryKey: harnessKeys.summary(pid),
    queryFn: async ({ signal }) =>
      normalizeSummary(await api.get<unknown>(`/projects/${pid}/harness`, { signal })),
    enabled: Boolean(pid) && enabled,
    staleTime: 5 * 60_000,
  });
}

export function useModelCatalog(pid: string) {
  return useQuery({
    queryKey: harnessKeys.models(pid),
    queryFn: ({ signal }) => api.get<ModelCatalog>(`/projects/${pid}/models`, { signal }),
    enabled: Boolean(pid),
  });
}

export function useMcpServers(pid: string) {
  return useQuery({
    queryKey: harnessKeys.mcp(pid),
    queryFn: ({ signal }) => api.get<McpServer[]>(`/projects/${pid}/mcp-servers`, { signal }),
    enabled: Boolean(pid),
  });
}

export function useSkills(pid: string) {
  return useQuery({
    queryKey: harnessKeys.skills(pid),
    queryFn: ({ signal }) => api.get<Skill[]>(`/projects/${pid}/skills`, { signal }),
    enabled: Boolean(pid),
  });
}

export function useSlashCommands(pid: string) {
  return useQuery({
    queryKey: harnessKeys.commands(pid),
    queryFn: ({ signal }) => api.get<SlashCommand[]>(`/projects/${pid}/commands`, { signal }),
    enabled: Boolean(pid),
  });
}

export function useAgentProfiles(pid: string) {
  return useQuery({
    queryKey: harnessKeys.profiles(pid),
    queryFn: ({ signal }) => api.get<AgentProfile[]>(`/projects/${pid}/profiles`, { signal }),
    enabled: Boolean(pid),
  });
}

// ---------------------------------------------------------------- 写入（输入类型按 shared 的 zod 输入手写，默认值可省）

export interface ProviderCreateBody {
  name: string;
  baseUrl: string;
  apiKey?: string;
  thinkingFormat?: ThinkingFormat;
  models: ProviderModelInput[];
  enabled?: boolean;
}
export type ProviderUpdateBody = Partial<ProviderCreateBody>;

export interface McpServerCreateBody {
  scope?: WritableScope;
  name: string;
  description?: string;
  transport: McpServer['transport'];
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  roles?: McpServer['roles'];
}
export type McpServerUpdateBody = Partial<
  Omit<McpServerCreateBody, 'scope' | 'transport'> & { disabledTools: string[] }
>;

export interface SkillCreateBody {
  scope?: WritableScope;
  slug: string;
  name: string;
  description: string;
  body: string;
  enabled?: boolean;
  userInvocable?: boolean;
  modelInvocable?: boolean;
}
export type SkillUpdateBody = Partial<Omit<SkillCreateBody, 'scope' | 'slug'>>;
export interface SkillImportBody {
  scope?: WritableScope;
  markdown: string;
  slug?: string;
}

export interface CommandCreateBody {
  scope?: WritableScope;
  name: string;
  description: string;
  argumentHint?: string;
  template: string;
}
export type CommandUpdateBody = Partial<Omit<CommandCreateBody, 'scope' | 'name'>>;

export interface ProfileCreateBody {
  scope?: WritableScope;
  slug: string;
  name: string;
  description?: string;
  icon?: string;
  prompt: string;
  skills?: string[];
  starters?: string[];
  effort?: ReasoningEffort | null;
}
export type ProfileUpdateBody = Partial<Omit<ProfileCreateBody, 'scope' | 'slug'>>;

/** 通用的「写完整体失效」mutation：成功后刷新 harness 下的所有查询。 */
function useHarnessWrite<TVars, TResult>(pid: string, fn: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => invalidateHarness(qc, pid),
  });
}

const P = (pid: string) => `/projects/${pid}`;

export function useCreateProvider(pid: string) {
  return useHarnessWrite(pid, (body: ProviderCreateBody) =>
    api.post<LlmProvider>(`${P(pid)}/providers`, body),
  );
}
export function useUpdateProvider(pid: string) {
  return useHarnessWrite(pid, ({ id, patch }: { id: string; patch: ProviderUpdateBody }) =>
    api.patch<LlmProvider>(`${P(pid)}/providers/${id}`, patch),
  );
}
export function useDeleteProvider(pid: string) {
  return useHarnessWrite(pid, (id: string) => api.delete(`${P(pid)}/providers/${id}`));
}
export interface ProviderTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
}
export function useTestProvider(pid: string) {
  return useMutation({
    mutationFn: (id: string) => api.post<ProviderTestResult>(`${P(pid)}/providers/${id}/test`),
  });
}

export function useCreateMcpServer(pid: string) {
  return useHarnessWrite(pid, (body: McpServerCreateBody) =>
    api.post<McpServer>(`${P(pid)}/mcp-servers`, body),
  );
}
export function useUpdateMcpServer(pid: string) {
  return useHarnessWrite(pid, ({ id, patch }: { id: string; patch: McpServerUpdateBody }) =>
    api.patch<McpServer>(`${P(pid)}/mcp-servers/${id}`, patch),
  );
}
export function useDeleteMcpServer(pid: string) {
  return useHarnessWrite(pid, (id: string) => api.delete(`${P(pid)}/mcp-servers/${id}`));
}
export function useRefreshMcpServer(pid: string) {
  return useHarnessWrite(pid, (id: string) =>
    api.post<McpServer>(`${P(pid)}/mcp-servers/${id}/refresh`),
  );
}

export function useCreateSkill(pid: string) {
  return useHarnessWrite(pid, (body: SkillCreateBody) => api.post<Skill>(`${P(pid)}/skills`, body));
}
export function useImportSkill(pid: string) {
  return useHarnessWrite(pid, (body: SkillImportBody) =>
    api.post<Skill>(`${P(pid)}/skills/import`, body),
  );
}
export function useUpdateSkill(pid: string) {
  return useHarnessWrite(pid, ({ id, patch }: { id: string; patch: SkillUpdateBody }) =>
    api.patch<Skill>(`${P(pid)}/skills/${encodeURIComponent(id)}`, patch),
  );
}
export function useDeleteSkill(pid: string) {
  return useHarnessWrite(pid, (id: string) =>
    api.delete(`${P(pid)}/skills/${encodeURIComponent(id)}`),
  );
}

export function useCreateCommand(pid: string) {
  return useHarnessWrite(pid, (body: CommandCreateBody) =>
    api.post<SlashCommand>(`${P(pid)}/commands`, body),
  );
}
export function useUpdateCommand(pid: string) {
  return useHarnessWrite(pid, ({ id, patch }: { id: string; patch: CommandUpdateBody }) =>
    api.patch<SlashCommand>(`${P(pid)}/commands/${encodeURIComponent(id)}`, patch),
  );
}
export function useDeleteCommand(pid: string) {
  return useHarnessWrite(pid, (id: string) =>
    api.delete(`${P(pid)}/commands/${encodeURIComponent(id)}`),
  );
}

export function useCreateProfile(pid: string) {
  return useHarnessWrite(pid, (body: ProfileCreateBody) =>
    api.post<AgentProfile>(`${P(pid)}/profiles`, body),
  );
}
export function useUpdateProfile(pid: string) {
  return useHarnessWrite(pid, ({ id, patch }: { id: string; patch: ProfileUpdateBody }) =>
    api.patch<AgentProfile>(`${P(pid)}/profiles/${encodeURIComponent(id)}`, patch),
  );
}
export function useDeleteProfile(pid: string) {
  return useHarnessWrite(pid, (id: string) =>
    api.delete(`${P(pid)}/profiles/${encodeURIComponent(id)}`),
  );
}

// ---------------------------------------------------------------- 会话设置与指令

function patchSession(list: AgentSession[] | undefined, id: string, patch: Partial<AgentSession>) {
  return list?.map((a) => (a.id === id ? { ...a, ...patch } : a));
}

/** 改会话的模型 / 强度 / profile：先乐观写 agents 缓存，失败回滚。 */
export function useSessionSettings(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, input }: { sessionId: string; input: SessionSettingsInput }) =>
      api.patch<AgentSession>(`${P(pid)}/agents/${sessionId}/settings`, input),
    onMutate: async ({ sessionId, input }) => {
      await qc.cancelQueries({ queryKey: qk.agents(pid) });
      const previous = qc.getQueryData<AgentSession[]>(qk.agents(pid));
      const patch: Partial<AgentSession> = {};
      if (input.model !== undefined && input.model !== null) patch.model = input.model;
      if (input.effort !== undefined) patch.effort = input.effort;
      if (input.profile !== undefined) patch.profile = input.profile;
      qc.setQueryData<AgentSession[]>(qk.agents(pid), (list) =>
        patchSession(list, sessionId, patch),
      );
      return { previous };
    },
    onSuccess: (a) => {
      if (!a?.id) return;
      qc.setQueryData<AgentSession[]>(qk.agents(pid), (list) =>
        list?.map((x) => (x.id === a.id ? a : x)),
      );
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.agents(pid), ctx.previous);
    },
  });
}

/** POST P/commands/run：session 类指令（clear、compact、goal clear）。 */
export function useRunCommand(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CommandRunInput) =>
      api.post<CommandRunResult>(`${P(pid)}/commands/run`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.agents(pid) }),
  });
}
