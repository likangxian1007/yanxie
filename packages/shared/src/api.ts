import { MessageMentions } from './mentions';
import { z } from 'zod';
import { ClaimMode, ClaimResourceKind, MemoryType, ProjectRole, ProjectVisibility } from './enums';
import { DecisionOption, type AgentSession } from './entities';
import { SessionSettingsInput, Slug } from './harness';
import { tr } from './i18n';

/**
 * REST 请求体 / 查询参数的 zod 定义。端点清单见 API.md。
 * 命名：<资源><动作>Input，例如 ProjectCreateInput。
 * 服务端用它们做校验；前端用 z.input<> 类型构造请求。
 */

export const API_PREFIX = '/api/v1';

// ---------------------------------------------------------------- 通用

/** 游标分页：cursor 不透明，原样传回即可。 */
export const PageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PageQuery = z.infer<typeof PageQuery>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  uptimeSec: number;
  time: string;
  db: { ok: boolean; driver: 'postgres' | 'pglite'; latencyMs: number | null; error?: string };
  llm: { configured: boolean; model: string };
}

// ---------------------------------------------------------------- 认证

/**
 * 邮箱先去掉首尾空格和零宽字符（从聊天软件复制时常带）再校验；大小写由服务端统一转小写。
 * 每个字段都给出中文原因，前端按 details.issues[].path 显示在对应输入框下。
 */
const EmailInput = z
  .string({ error: tr('请填写邮箱') })
  .transform((s) => s.replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '').trim())
  .pipe(
    z
      .string()
      .min(1, { error: tr('请填写邮箱') })
      .pipe(z.email({ error: tr('邮箱格式不对，应类似 you@lab.edu.cn') })),
  );

/** 注册密码规则（前端提前显示同一句话） */
export const PASSWORD_RULE_HINT = tr('至少 8 位，不能全是数字或同一个字符');

/** 密码不合规时返回中文原因，合规返回 null（前后端共用） */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return tr('密码至少 8 位（现在 {count} 位）', { count: pw.length });
  if (pw.length > 200) return tr('密码最多 200 位');
  if (/^\d+$/u.test(pw)) return tr('密码太简单：不能全是数字，请加上字母或符号');
  if (/^(.)\1*$/su.test(pw)) return tr('密码太简单：不能全是同一个字符');
  return null;
}

/** 设置新密码（注册与找回密码共用同一套规则） */
const NewPasswordInput = z.string({ error: tr('请填写密码') }).superRefine((pw, ctx) => {
  const problem = passwordProblem(pw);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

export const RegisterInput = z.object({
  email: EmailInput,
  name: z
    .string({ error: tr('请填写姓名') })
    .trim()
    .min(1, { error: tr('请填写姓名') })
    .max(40, { error: tr('姓名最多 40 个字') }),
  password: NewPasswordInput,
  /** 通过邀请链接注册时带上 */
  inviteToken: z.string().optional(),
});
export const LoginInput = z.object({
  email: EmailInput,
  password: z.string({ error: tr('请填写密码') }).min(1, { error: tr('请填写密码') }),
});
/** 找回密码：申请发重置邮件 */
export const PasswordResetRequestInput = z.object({ email: EmailInput });
/** 找回密码：凭邮件里的令牌设新密码 */
export const PasswordResetInput = z.object({
  token: z
    .string({ error: tr('重置链接无效或已过期') })
    .min(1, { error: tr('重置链接无效或已过期') })
    .max(200, { error: tr('重置链接无效或已过期') }),
  password: NewPasswordInput,
});
export const UpdateMeInput = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  avatarColor: z.number().int().min(0).max(7).optional(),
});

/** 置顶（跟账号走）：PUT /auth/me/pins/:projectId，整组替换，越靠前越新 */
export const PinsUpdateInput = z.object({
  ids: z.array(z.string().trim().min(1).max(64)).max(50),
});
export type PinsUpdateInput = z.infer<typeof PinsUpdateInput>;
/** GET /auth/me/pins：{ [projectId]: 置顶的 id 列表 } */
export type MyPins = Record<string, string[]>;

// ---------------------------------------------------------------- 项目与成员

export const ProjectCreateInput = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(500).default(''),
  icon: z.string().max(8).default('🔬'),
  color: z.number().int().min(0).max(7).default(0),
  visibility: ProjectVisibility.default('team'),
  researchDomains: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  /** @deprecated 常用研究方法已移除；兼容字段不再持久化，响应始终为空。 */
  preferredResearchMethods: z
    .array(
      z.enum([
        'general',
        'computational',
        'experimental',
        'observational',
        'qualitative',
        'literature',
        'theoretical',
      ]),
    )
    .max(7)
    .default([]),
});
/** 注意：zod 4 的 .partial() 仍会套用内部 default，PATCH 用的 schema 必须单独写、不带 default */
export const ProjectUpdateInput = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().max(500).optional(),
  icon: z.string().max(8).optional(),
  color: z.number().int().min(0).max(7).optional(),
  visibility: ProjectVisibility.optional(),
  instructions: z.string().max(20_000).optional(),
  researchDomains: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  /** @deprecated 常用研究方法已移除；兼容字段不再持久化，响应始终为空。 */
  preferredResearchMethods: z
    .array(
      z.enum([
        'general',
        'computational',
        'experimental',
        'observational',
        'qualitative',
        'literature',
        'theoretical',
      ]),
    )
    .max(7)
    .optional(),
});
export const InviteCreateInput = z.object({
  email: z.email().optional(),
  role: ProjectRole.exclude(['owner']).default('member'),
});
export const MemberUpdateInput = z.object({ role: ProjectRole });

// ---------------------------------------------------------------- 时间线、线程、消息

export const MessageCreateInput = z.object({
  mentions: MessageMentions.optional(),
  body: z.string().trim().min(1).max(50_000),
  /** false = 旁聊，agent 读不到 */
  agentVisible: z.boolean().default(true),
  /** 附件：已上传文件 id */
  fileIds: z.array(z.string()).max(20).default([]),
});
export const MessageUpdateInput = z.object({
  body: z.string().trim().min(1).max(50_000),
  mentions: MessageMentions.optional(),
});
export const ReactionInput = z.object({ emoji: z.string().min(1).max(32) });

export const PersonalThreadCreateInput = z.object({
  /** 个人工作区的第一句话 */
  body: z.string().trim().min(1).max(50_000),
  title: z.string().max(80).optional(),
  /** 一开始就用的 profile slug：建会话时一起写入，第一轮就生效 */
  profile: Slug.nullable().optional(),
  /** 首轮会话的模型与强度，校验和会话设置一致 */
  model: SessionSettingsInput.shape.model,
  effort: SessionSettingsInput.shape.effort,
});
export const ThreadUpdateInput = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  label: z.string().max(40).nullable().optional(),
  resolved: z.boolean().optional(),
  /** 成员在计划卡上直接改计划（状态清单原文，格式同 update_status） */
  statusText: z.string().max(4000).optional(),
});
/** 把个人会话转发给 coordinator */
export const ThreadForwardInput = z.object({
  /** 给 coordinator 的附言 */
  note: z.string().max(5000).default(''),
});
export const DecisionAnswerInput = z.object({ chosen: z.number().int().min(0).max(3) });

/** agent 侧（工具层）创建决策卡用；人类前端不直接调用 */
export const DecisionCreateInput = z.object({
  question: z.string().max(300),
  context: z.string().max(1200).optional(),
  options: z.array(DecisionOption).min(2).max(4),
  recommended: z.number().int().min(0).max(3),
  reason: z.string().max(200).optional(),
});

// ---------------------------------------------------------------- 记忆、认领、定时

export const MemoryWriteInput = z.object({
  path: z.string().regex(/^[\w\-./]+\.md$/u, tr('路径须以 .md 结尾')),
  content: z.string().max(16_000),
  description: z.string().max(200).default(''),
  type: MemoryType.nullable().default(null),
  /** 乐观并发：读到的版本，新文件传 0 */
  baseVersion: z.number().int().min(0),
});
export const ClaimCreateInput = z.object({
  resourceKind: ClaimResourceKind,
  resourceRef: z.string().min(1).max(500),
  mode: ClaimMode.default('exclusive'),
  intent: z.string().max(300),
  /** 有效期（秒），到期自动失效；持有者可续期 */
  ttlSec: z.number().int().min(60).max(86_400).default(1800),
  threadId: z.string().optional(),
});
export const RoutineCreateInput = z.object({
  title: z.string().max(80),
  schedule: z.string().max(100),
  prompt: z.string().max(10_000),
  targetThreadId: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
});
export const RoutineUpdateInput = z.object({
  title: z.string().max(80).optional(),
  schedule: z.string().max(100).optional(),
  prompt: z.string().max(10_000).optional(),
  targetThreadId: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});
export const ClaimRenewInput = z.object({
  ttlSec: z.number().int().min(60).max(86_400).optional(),
});

// ---------------------------------------------------------------- 查询参数（后端线程追加）

/** 时间线 / 线程消息：默认新到旧，order=asc 反向 */
export const MessageListQuery = PageQuery.extend({
  order: z.enum(['asc', 'desc']).default('desc'),
  channel: z.enum(['all', 'agent', 'team']).default('all'),
});
const boolParam = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');
export const ThreadListQuery = PageQuery.extend({
  kind: z.enum(['project', 'personal']).optional(),
  bucket: z.enum(['idle', 'working', 'blocked', 'review_ready', 'completed', 'failed']).optional(),
  resolved: boolParam.optional(),
});
export const ClaimListQuery = z.object({
  status: z.enum(['active', 'released', 'expired']).optional(),
  resourceKind: ClaimResourceKind.optional(),
  resourceRef: z.string().optional(),
  threadId: z.string().optional(),
});
export const AgentStepsQuery = PageQuery.extend({
  turnId: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
});
/**
 * POST P/agents/:id/stop 的返回：会话本身 + 这次停掉了什么。
 * turn = 中止了正在跑的一轮；queued = 取消了排队、还没开始的一轮；none = 本来就没事可停
 */
export type AgentStopResult = AgentSession & { stopped: 'turn' | 'queued' | 'none' };
export const OutputListQuery = PageQuery.extend({
  kind: z.enum(['file', 'link', 'document', 'experiment', 'report']).optional(),
});
export const InboxQuery = z.object({
  projectId: z.string().optional(),
  done: boolParam.default(false),
});
export const InboxUpdateInput = z.object({
  read: z.boolean().optional(),
  done: z.boolean().optional(),
});
export const EventsQuery = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
export const FileListQuery = z.object({ dir: z.string().max(500).optional() });

// ---------------------------------------------------------------- 线程面板摘要（前端线程追加）

/** 某个线程在等哪位成员：来自该成员未处理的收件箱条目（拍板、审阅、冲突、@）。 */
export interface ThreadWaiting {
  userId: string;
  kind: 'decision' | 'review' | 'mention' | 'conflict';
  /** 条目创建时间（等了多久） */
  since: string;
}

/** GET P/thread-summaries：协作台线程面板用的每线程汇总（只含项目线程）。 */
export interface ThreadSummary {
  threadId: string;
  /** 挂在线程消息上的产出数 */
  outputs: number;
  /** 还没回答的决策卡数 */
  openDecisions: number;
  /** 在等谁（同一成员同一类只出现一次，按时间先后） */
  waitingOn: ThreadWaiting[];
}
