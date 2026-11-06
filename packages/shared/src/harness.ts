import { z } from 'zod';
import { ActorRef } from './entities';
import { tr } from './i18n';

/**
 * Agent harness 能力（ARCHITECTURE.md §7.6，API.md §2.13）：模型与推理强度、MCP 服务器、
 * Skill、斜杠指令、科研 profile。归属：harness 线程（modules/harness、agents/harness、agents/llm/registry、agents/mcp）。
 *
 * 作用域：
 * - builtin：随代码发布（只读，可在项目里「复制后编辑」覆盖同 slug）
 * - project：项目成员共享（owner/advisor 可管理）
 * - personal：只对创建者本人的个人会话生效，别人看不到
 * 同 slug 的优先级：personal > project > builtin。
 */
const Iso = z.string();

export const HarnessScope = z.enum(['builtin', 'project', 'personal']);
export type HarnessScope = z.infer<typeof HarnessScope>;

/** 可写作用域（builtin 只读） */
export const WritableScope = z.enum(['project', 'personal']);
export type WritableScope = z.infer<typeof WritableScope>;

/** slug：小写字母数字与连字符，作为 skill / 指令 / profile 的名字（/slug） */
export const Slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/u, tr('只能用小写字母、数字和连字符，最长 40 位'));

// ---------------------------------------------------------------- 模型与推理强度

/**
 * 推理强度。DeepSeek：off / low / high / max（medium 按 high 发）；
 * OpenAI 兼容：low / medium / high（max 按 high 发，off 不发 reasoning_effort）。
 */
export const ReasoningEffort = z.enum(['off', 'low', 'medium', 'high', 'max']);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

export const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  off: tr('不思考'),
  low: tr('低'),
  medium: tr('中'),
  high: tr('高'),
  max: tr('最高'),
};

/**
 * provider 的请求格式：
 * - deepseek：`thinking:{type}` + `reasoning_effort`（DeepSeek 官方接口）
 * - openai：`reasoning_effort`（OpenAI / 多数兼容网关）
 * - none：不发任何推理参数（只支持 off）
 * - openrouter：`reasoning:{effort}`（OpenRouter 统一推理参数）
 */
export const ThinkingFormat = z.enum(['deepseek', 'openai', 'none', 'openrouter']);
export type ThinkingFormat = z.infer<typeof ThinkingFormat>;

export const ModelInfo = z.object({
  /** 全局唯一 id：`<providerId>/<model>` */
  id: z.string(),
  providerId: z.string(),
  /** 发给接口的模型名 */
  model: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  efforts: z.array(ReasoningEffort),
  defaultEffort: ReasoningEffort,
  /** 选择器分组：cn = 国内模型，intl = 国外模型；不填 = 不分组 */
  group: z.enum(['cn', 'intl']).optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

export const ProviderSource = z.enum(['env', 'project']);
export type ProviderSource = z.infer<typeof ProviderSource>;

export const LlmProvider = z.object({
  /** env 来源为配置里的 id（如 deepseek）；项目来源为 llm_… */
  id: z.string(),
  projectId: z.string().nullable(),
  source: ProviderSource,
  name: z.string(),
  baseUrl: z.string(),
  thinkingFormat: ThinkingFormat,
  /** 只回显是否配置了 key，key 本身永不返回 */
  hasApiKey: z.boolean(),
  models: z.array(ModelInfo),
  enabled: z.boolean(),
  createdAt: Iso.nullable(),
});
export type LlmProvider = z.infer<typeof LlmProvider>;

/** GET P/models：本项目可选的全部模型 */
export interface ModelCatalog {
  /** 默认模型 id 与强度（新会话用） */
  defaultModel: string;
  defaultEffort: ReasoningEffort;
  providers: LlmProvider[];
}

export const ProviderModelInput = z.object({
  model: z.string().trim().min(1).max(120),
  name: z.string().trim().max(80).optional(),
  description: z.string().max(200).optional(),
  efforts: z.array(ReasoningEffort).min(1).optional(),
  defaultEffort: ReasoningEffort.optional(),
});
export type ProviderModelInput = z.infer<typeof ProviderModelInput>;

export const ProviderCreateInput = z.object({
  name: z.string().trim().min(1).max(60),
  baseUrl: z.url().max(300),
  apiKey: z.string().max(400).default(''),
  thinkingFormat: ThinkingFormat.default('openai'),
  models: z.array(ProviderModelInput).min(1).max(40),
  enabled: z.boolean().default(true),
});
export const ProviderUpdateInput = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  baseUrl: z.url().max(300).optional(),
  /** 不传 = 不改；空串 = 清除 */
  apiKey: z.string().max(400).optional(),
  thinkingFormat: ThinkingFormat.optional(),
  models: z.array(ProviderModelInput).min(1).max(40).optional(),
  enabled: z.boolean().optional(),
});

/** PATCH P/agents/:sessionId/settings：会话级模型、强度、profile */
export const SessionSettingsInput = z.object({
  /** 模型 id `<provider>/<model>`；null = 回到项目默认 */
  model: z.string().max(200).nullable().optional(),
  effort: ReasoningEffort.nullable().optional(),
  /** profile slug；null = 不用 profile */
  profile: Slug.nullable().optional(),
});
export type SessionSettingsInput = z.infer<typeof SessionSettingsInput>;

// ---------------------------------------------------------------- MCP

/** http = Streamable HTTP（新规范）；sse = 旧版 HTTP+SSE；stdio = 本机子进程（需部署方开启 MCP_ALLOW_STDIO） */
export const McpTransport = z.enum(['stdio', 'http', 'sse']);
export type McpTransport = z.infer<typeof McpTransport>;

export const McpState = z.enum(['disabled', 'idle', 'connecting', 'ready', 'error']);
export type McpState = z.infer<typeof McpState>;

export const McpToolInfo = z.object({
  /** 服务器给的原名 */
  name: z.string(),
  /** 给模型看的名字：mcp__<server>__<tool> */
  exposedName: z.string(),
  description: z.string(),
  enabled: z.boolean(),
});
export type McpToolInfo = z.infer<typeof McpToolInfo>;

/** 服务器名：agent 看到的工具前缀 mcp__<name>__ */
export const McpServerName = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/u, tr('只能用字母、数字、下划线和连字符，最长 32 位'));

export const McpServer = z.object({
  id: z.string(),
  projectId: z.string(),
  scope: WritableScope,
  /** personal 作用域的主人 */
  ownerUserId: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  transport: McpTransport,
  command: z.string(),
  args: z.array(z.string()),
  /** 环境变量 / 请求头只回显键名，值永不返回 */
  envKeys: z.array(z.string()),
  url: z.string(),
  headerKeys: z.array(z.string()),
  enabled: z.boolean(),
  /** 被停用的工具原名 */
  disabledTools: z.array(z.string()),
  /** 哪些角色的 agent 能用（personal 作用域固定 ['personal']） */
  roles: z.array(z.enum(['coordinator', 'thread', 'personal'])),
  state: McpState,
  error: z.string().nullable(),
  tools: z.array(McpToolInfo),
  createdBy: ActorRef,
  createdAt: Iso,
  updatedAt: Iso,
});
export type McpServer = z.infer<typeof McpServer>;

const KeyValues = z.record(z.string().regex(/^[\w.-]{1,80}$/u), z.string().max(4000));

export const McpServerCreateInput = z.object({
  scope: WritableScope.default('project'),
  name: McpServerName,
  description: z.string().max(300).default(''),
  transport: McpTransport,
  command: z.string().max(400).default(''),
  args: z.array(z.string().max(1000)).max(40).default([]),
  env: KeyValues.default({}),
  url: z.string().max(500).default(''),
  headers: KeyValues.default({}),
  enabled: z.boolean().default(true),
  roles: z
    .array(z.enum(['coordinator', 'thread', 'personal']))
    .min(1)
    .optional(),
});
export const McpServerUpdateInput = z.object({
  name: McpServerName.optional(),
  description: z.string().max(300).optional(),
  command: z.string().max(400).optional(),
  args: z.array(z.string().max(1000)).max(40).optional(),
  /** 整体替换；值为空串的键表示「保留原值」 */
  env: KeyValues.optional(),
  url: z.string().max(500).optional(),
  headers: KeyValues.optional(),
  enabled: z.boolean().optional(),
  disabledTools: z.array(z.string().max(200)).max(500).optional(),
  roles: z
    .array(z.enum(['coordinator', 'thread', 'personal']))
    .min(1)
    .optional(),
});

// ---------------------------------------------------------------- Skill

export const SkillAttachment = z.object({
  /** 相对路径，如 templates/report.md */
  path: z.string().regex(/^[\w\-./]{1,200}$/u),
  content: z.string().max(100_000),
});
export type SkillAttachment = z.infer<typeof SkillAttachment>;

export const Skill = z.object({
  /** builtin 为 builtin:<slug> */
  id: z.string(),
  projectId: z.string().nullable(),
  scope: HarnessScope,
  ownerUserId: z.string().nullable(),
  slug: z.string(),
  name: z.string(),
  /** 何时该用（agent 只看到 slug + description 的目录，按需调用 load_skill 读正文） */
  description: z.string(),
  body: z.string(),
  attachments: z.array(SkillAttachment.pick({ path: true }).extend({ size: z.number() })),
  enabled: z.boolean(),
  /** 允许成员用 /slug 点名 */
  userInvocable: z.boolean(),
  /** 允许 agent 自己按描述加载 */
  modelInvocable: z.boolean(),
  updatedBy: ActorRef.nullable(),
  updatedAt: Iso.nullable(),
});
export type Skill = z.infer<typeof Skill>;

export const SkillCreateInput = z.object({
  scope: WritableScope.default('project'),
  slug: Slug,
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(500),
  body: z.string().max(60_000),
  attachments: z.array(SkillAttachment).max(20).default([]),
  enabled: z.boolean().default(true),
  userInvocable: z.boolean().default(true),
  modelInvocable: z.boolean().default(true),
});
export const SkillUpdateInput = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().min(1).max(500).optional(),
  body: z.string().max(60_000).optional(),
  attachments: z.array(SkillAttachment).max(20).optional(),
  enabled: z.boolean().optional(),
  userInvocable: z.boolean().optional(),
  modelInvocable: z.boolean().optional(),
});
/**
 * 导入：SKILL.md 文本（YAML frontmatter：name / description / disable-model-invocation /
 * user-invocable），可附带同目录下的其他文本文件。
 */
export const SkillImportInput = z.object({
  scope: WritableScope.default('project'),
  markdown: z.string().min(1).max(60_000),
  /** 不传则从 frontmatter 的 name 推导 */
  slug: Slug.optional(),
  attachments: z.array(SkillAttachment).max(20).default([]),
});

// ---------------------------------------------------------------- 斜杠指令

/**
 * 指令种类：
 * - client：前端直接执行（切模型、切强度、换 profile、转给协调者、停止、帮助）
 * - session：调 POST P/commands/run 改会话状态（clear、goal 清除）
 * - prompt：作为一条消息发给 agent，服务端在唤醒时按指令展开（goal、plan、skill、自定义模板）
 */
export const CommandKind = z.enum(['client', 'session', 'prompt']);
export type CommandKind = z.infer<typeof CommandKind>;

export const SlashCommand = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  scope: HarnessScope,
  ownerUserId: z.string().nullable(),
  /** 不带斜杠 */
  name: z.string(),
  description: z.string(),
  /** 参数提示，如「<目标>」 */
  argumentHint: z.string(),
  kind: CommandKind,
  /** 自定义指令的模板，$ARGUMENTS 替换为参数 */
  template: z.string(),
  updatedAt: Iso.nullable(),
});
export type SlashCommand = z.infer<typeof SlashCommand>;

export const SlashCommandCreateInput = z.object({
  scope: WritableScope.default('project'),
  name: Slug,
  description: z.string().trim().min(1).max(200),
  argumentHint: z.string().max(60).default(''),
  template: z.string().min(1).max(20_000),
});
export const SlashCommandUpdateInput = z.object({
  description: z.string().trim().min(1).max(200).optional(),
  argumentHint: z.string().max(60).optional(),
  template: z.string().min(1).max(20_000).optional(),
});

/** 内置指令名（不可被自定义覆盖） */
export const BUILTIN_COMMAND_NAMES = [
  'help',
  'model',
  'effort',
  'profile',
  'skill',
  'clear',
  'compact',
  'forward',
  'goal',
  'plan',
  'stop',
] as const;

/** POST P/commands/run：执行一条 session / prompt 类指令 */
export const CommandRunInput = z.object({
  /** null = 项目协调者（时间线） */
  threadId: z.string().nullable(),
  name: z.string().min(1).max(40),
  args: z.string().max(50_000).default(''),
});
export type CommandRunInput = z.infer<typeof CommandRunInput>;

export interface CommandRunResult {
  ok: boolean;
  /** 给人看的一句话结果 */
  text: string;
  /** prompt 类指令发出的消息 id */
  messageId: string | null;
}

/** 消息 meta.command：由指令发出的消息（服务端唤醒 agent 时据此展开） */
export interface CommandMessageMeta {
  command: { name: string; args: string };
}

// ---------------------------------------------------------------- 科研 profile

export const AgentProfile = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  scope: HarnessScope,
  ownerUserId: z.string().nullable(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  /** lucide 图标名 */
  icon: z.string(),
  /** 角色提示词：拼进 system prompt 的 <profile> 段 */
  prompt: z.string(),
  /** 默认挂上的 skill slug（目录里置顶、正文预加载提示） */
  skills: z.array(z.string()),
  /** 开场引导：可点选的第一句话 */
  starters: z.array(z.string()),
  /** 建议强度（选用 profile 时若会话没设强度则用它） */
  effort: ReasoningEffort.nullable(),
  updatedAt: Iso.nullable(),
});
export type AgentProfile = z.infer<typeof AgentProfile>;

export const ProfileCreateInput = z.object({
  scope: WritableScope.default('project'),
  slug: Slug,
  name: z.string().trim().min(1).max(40),
  description: z.string().max(200).default(''),
  icon: z.string().max(40).default('Sparkles'),
  prompt: z.string().max(20_000),
  skills: z.array(Slug).max(20).default([]),
  starters: z.array(z.string().max(200)).max(6).default([]),
  effort: ReasoningEffort.nullable().default(null),
});
export const ProfileUpdateInput = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  description: z.string().max(200).optional(),
  icon: z.string().max(40).optional(),
  prompt: z.string().max(20_000).optional(),
  skills: z.array(Slug).max(20).optional(),
  starters: z.array(z.string().max(200)).max(6).optional(),
  effort: ReasoningEffort.nullable().optional(),
});

/** GET P/harness：输入框一次取齐（指令菜单、选择器） */
export interface HarnessSummary {
  catalog: ModelCatalog;
  commands: SlashCommand[];
  skills: Skill[];
  profiles: AgentProfile[];
}
