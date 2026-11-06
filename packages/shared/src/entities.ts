import { z } from 'zod';
import {
  AgentRole,
  AgentStatus,
  AgentStepKind,
  AuthorKind,
  ClaimMode,
  ClaimResourceKind,
  ClaimStatus,
  DecisionState,
  InboxKind,
  MemoryType,
  MessageKind,
  OutputKind,
  ProjectRole,
  ProjectVisibility,
  StatusBucket,
  ThreadKind,
} from './enums';
import { tr } from './i18n';

/**
 * 实体 DTO：REST 响应与 WS 事件 payload 里出现的对象形状。
 * 约定：时间一律 ISO 8601 字符串（UTC），可空字段用 null 而不是省略。
 * 数据库行 → DTO 的转换写在服务端各模块的 `serialize.ts` 里。
 */
const Iso = z.string().describe(tr('ISO 8601 时间'));
const Id = z.string();

/** 消息/事件的作者引用。agent 作者用 sessionId，展示名由服务端填好。 */
export const ActorRef = z.object({
  kind: AuthorKind,
  id: Id.nullable(),
  name: z.string(),
});
export type ActorRef = z.infer<typeof ActorRef>;

// ---------------------------------------------------------------- 用户与项目

export const User = z.object({
  id: Id,
  email: z.string(),
  name: z.string(),
  /** 头像底色（STYLE.md 的 avatar 色板序号 0–7） */
  avatarColor: z.number().int().min(0).max(7),
  avatarUrl: z.string().nullable(),
  createdAt: Iso,
  /** 站点管理员（反馈与运维后台，feat/feedback-center）；服务端总会给出，旧数据按 false */
  isAdmin: z.boolean().optional(),
});
export type User = z.infer<typeof User>;

export const Project = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  /** 一个 emoji 或短字符 */
  icon: z.string(),
  /** STYLE.md 项目色板序号 0–7 */
  color: z.number().int().min(0).max(7),
  /** 项目级 agent 指令（相当于 CLAUDE.md） */
  instructions: z.string(),
  visibility: ProjectVisibility,
  researchDomains: z.array(z.string()),
  /** @deprecated 常用研究方法已移除；兼容字段不再持久化，响应始终为空。 */
  preferredResearchMethods: z.array(z.string()),
  createdBy: Id,
  createdAt: Iso,
  updatedAt: Iso,
  archivedAt: Iso.nullable(),
});
export type Project = z.infer<typeof Project>;

export const ProjectMember = z.object({
  projectId: Id,
  user: User.pick({ id: true, name: true, email: true, avatarColor: true, avatarUrl: true }),
  role: ProjectRole,
  joinedAt: Iso,
});
export type ProjectMember = z.infer<typeof ProjectMember>;

export const Invite = z.object({
  id: Id,
  projectId: Id,
  email: z.string().nullable(),
  role: ProjectRole,
  token: z.string(),
  expiresAt: Iso,
  acceptedAt: Iso.nullable(),
  createdBy: Id,
  createdAt: Iso,
});
export type Invite = z.infer<typeof Invite>;

// ---------------------------------------------------------------- 会话：消息、线程、agent

export const Reaction = z.object({
  emoji: z.string(),
  actors: z.array(ActorRef),
});
export type Reaction = z.infer<typeof Reaction>;

export const OutputRef = z.object({
  id: Id,
  kind: OutputKind,
  /** file: 文件 id；link: URL；document/experiment/report: 对象 id */
  ref: z.string(),
  title: z.string(),
});
export type OutputRef = z.infer<typeof OutputRef>;

export const Message = z.object({
  id: Id,
  projectId: Id,
  /** null = 项目时间线上的顶层消息 */
  threadId: Id.nullable(),
  author: ActorRef,
  kind: MessageKind,
  /** markdown 正文 */
  body: z.string(),
  /** kind 相关的附加数据（决策卡 id、转发来源、审阅 id 等） */
  meta: z.record(z.string(), z.unknown()),
  /** false = 只给人看的旁聊，agent 读不到（来自 claude-share 的 side chat） */
  agentVisible: z.boolean(),
  reactions: z.array(Reaction),
  outputs: z.array(OutputRef),
  /** 若本消息是某线程的根消息，给出线程 id */
  rootOfThreadId: Id.nullable(),
  editedAt: Iso.nullable(),
  createdAt: Iso,
});
export type Message = z.infer<typeof Message>;

export const Thread = z.object({
  id: Id,
  projectId: Id,
  kind: ThreadKind,
  rootMessageId: Id,
  title: z.string(),
  label: z.string().nullable(),
  /** personal 线程的主人；project 线程为发起人 */
  ownerUserId: Id.nullable(),
  statusBucket: StatusBucket,
  /** 状态清单原文（STYLE.md / ARCHITECTURE.md 规定的 ✓ ✱ ○ 格式） */
  statusText: z.string(),
  resolved: z.boolean(),
  replyCount: z.number().int(),
  /** 个人会话被转发给 coordinator 的时间 */
  forwardedAt: Iso.nullable(),
  agentSessionId: Id.nullable(),
  lastActivityAt: Iso,
  createdAt: Iso,
});
export type Thread = z.infer<typeof Thread>;

export const AgentSession = z.object({
  id: Id,
  /** 网页中的会话位置；需要人工决定时由人进入处理。 */
  webUrl: z.string().optional(),
  projectId: Id,
  threadId: Id.nullable(),
  role: AgentRole,
  status: AgentStatus,
  model: z.string(),
  /** 当前一句话动态，如“正在检索 2023 年后的相关工作” */
  activity: z.string().nullable(),
  /** 为哪位成员工作（claude-share 的“working for X”） */
  workingForUserId: Id.nullable(),
  tokenUsage: z.object({ input: z.number(), output: z.number(), cached: z.number() }),
  /** 推理强度（harness.ts ReasoningEffort）；null = 跟随模型默认 */
  effort: z.string().nullable(),
  /** 选用的科研 profile slug */
  profile: z.string().nullable(),
  /** /goal 设定的持续目标 */
  goal: z.string().nullable(),
  lastActivityAt: Iso,
  createdAt: Iso,
});
export type AgentSession = z.infer<typeof AgentSession>;

/** agent 的一步（思路、工具调用、结果），供导师查看“coordinator 里的思路”。 */
export const AgentStep = z.object({
  id: Id,
  sessionId: Id,
  turnId: z.string(),
  index: z.number().int(),
  kind: AgentStepKind,
  name: z.string().nullable(),
  /** 给人看的完整内容；给 agent 的上下文另行截断 */
  content: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: Iso,
});
export type AgentStep = z.infer<typeof AgentStep>;

export const DecisionOption = z.object({
  label: z.string().max(40),
  consequence: z.string().max(200),
});
export type DecisionOption = z.infer<typeof DecisionOption>;

export const Decision = z.object({
  id: Id,
  messageId: Id,
  threadId: Id.nullable(),
  question: z.string(),
  context: z.string().nullable(),
  options: z.array(DecisionOption).min(2).max(4),
  recommended: z.number().int(),
  reason: z.string().nullable(),
  state: DecisionState,
  chosen: z.number().int().nullable(),
  chosenBy: ActorRef.nullable(),
  answeredAt: Iso.nullable(),
  createdAt: Iso,
});
export type Decision = z.infer<typeof Decision>;

export const MemoryFile = z.object({
  id: Id,
  projectId: Id,
  path: z.string(),
  description: z.string(),
  type: MemoryType.nullable(),
  content: z.string(),
  version: z.number().int(),
  updatedBy: ActorRef,
  updatedAt: Iso,
});
export type MemoryFile = z.infer<typeof MemoryFile>;

/** 认领：agent/人声明“我正在改这个”，用于冲突预警。 */
export const WorkClaim = z.object({
  id: Id,
  projectId: Id,
  threadId: Id.nullable(),
  holder: ActorRef,
  /** 代表哪位成员（agent 认领时为线程发起人） */
  onBehalfOfUserId: Id.nullable(),
  resourceKind: ClaimResourceKind,
  resourceRef: z.string(),
  mode: ClaimMode,
  intent: z.string(),
  status: ClaimStatus,
  expiresAt: Iso,
  createdAt: Iso,
});
export type WorkClaim = z.infer<typeof WorkClaim>;

export const Routine = z.object({
  id: Id,
  projectId: Id,
  title: z.string(),
  /** 5 段 cron（项目时区）或 every:<ms> 或 at:<ISO> */
  schedule: z.string(),
  prompt: z.string(),
  targetThreadId: Id.nullable(),
  enabled: z.boolean(),
  lastRunAt: Iso.nullable(),
  nextRunAt: Iso.nullable(),
  createdBy: Id,
  createdAt: Iso,
});
export type Routine = z.infer<typeof Routine>;

export const FileObject = z.object({
  id: Id,
  projectId: Id,
  name: z.string(),
  /** 项目共享文件夹内的相对路径 */
  path: z.string(),
  mime: z.string(),
  size: z.number().int(),
  uploadedBy: ActorRef,
  createdAt: Iso,
});
export type FileObject = z.infer<typeof FileObject>;

export const InboxItem = z.object({
  id: Id,
  projectId: Id,
  userId: Id,
  kind: InboxKind,
  title: z.string(),
  /** 前端跳转目标，如 /p/prj_x/threads/thr_y */
  href: z.string(),
  sourceId: Id,
  readAt: Iso.nullable(),
  doneAt: Iso.nullable(),
  createdAt: Iso,
});
export type InboxItem = z.infer<typeof InboxItem>;

/** 在线状态（只走 WS，不落库）。 */
export const PresenceState = z.object({
  userId: Id,
  name: z.string(),
  avatarColor: z.number().int(),
  /** 当前所在页面，如 "timeline" | "thread" | "document" | "board" */
  view: z.string(),
  /** 页面内对象，如线程 id、文档 id */
  objectId: Id.nullable(),
  /** 正在输入 / 正在编辑 */
  activity: z.enum(['viewing', 'typing', 'editing']).default('viewing'),
  lastSeenAt: Iso,
});
export type PresenceState = z.infer<typeof PresenceState>;

// ---------------------------------------------------------------- 组合响应（后端线程追加）

/**
 * GET /projects 与 GET /auth/me 里的项目条目。
 * eventSeq：读取时该项目最新的事件 seq，前端订阅 /ws 时当补发下界（见 ws.ts subscribe.replay）。
 */
export type ProjectWithRole = Project & { role: ProjectRole; unread: number; eventSeq?: number };

export interface MeResponse {
  user: User;
  projects: ProjectWithRole[];
  /** 当前用户是否是站点管理员（反馈与运维后台，feat/feedback-center）；旧服务端不返回时按 false */
  isAdmin?: boolean;
}

/** 资料库条目（GET P/outputs） */
export type OutputItem = OutputRef & {
  threadId: string | null;
  messageId: string | null;
  createdAt: string;
};

/**
 * Message.meta 的约定（按 kind）：
 * - decision：{ decision: Decision }（回答后随 message.updated 更新）
 * - forward：{ threadId, threadTitle, summary, forwardedBy: ActorRef }（summary 是服务器摘录的会话最近 6 条，“姓名：内容”每行一条）
 * - text：附件 { fileIds: string[] }；agent 消息 { agentSessionId }；协调者开线程时的一行回执另有 { ackFor: threadId }
 */
export type DecisionMessageMeta = { decision: Decision };
export type ForwardMessageMeta = {
  threadId: string;
  threadTitle: string;
  summary: string;
  forwardedBy: ActorRef;
};
