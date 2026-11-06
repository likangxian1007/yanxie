import { z } from 'zod';
import { tr } from './i18n';

/**
 * 反馈与运维（feat/feedback-center）。归属：`modules/feedback`、`modules/admin`。
 *
 * - 工单（ticket）：用户在任何页面提交 bug / 建议 / 问题，编号 YX-<no>，管理员回复、改状态；
 *   建议（idea）对所有登录用户公开，可投票，按 roadmap 分组展示（建议墙）。
 * - 更新日志（changelog）：管理员发布；关联的工单自动置为已完成并通知提交人。
 * - 站内通知（user notification）：不挂项目的个人通知（inbox_items 是项目级的，不能复用）。
 * - 运维事件（ops event）：服务端 500、agent 回合失败、前端报错，按指纹合并计数。
 * - 管理后台：只有 users.is_admin = true 的账号能访问（ADMIN_EMAILS 里的邮箱登录时自动设为管理员）。
 *
 * 时间一律 ISO 8601 字符串；可空字段给 null。没有实时推送，前端轮询。
 */

// ---------------------------------------------------------------- 枚举

export const TicketKind = z.enum(['bug', 'idea', 'question']);
export type TicketKind = z.infer<typeof TicketKind>;

export const TicketStatus = z.enum(['open', 'doing', 'done', 'closed']);
export type TicketStatus = z.infer<typeof TicketStatus>;

export const TicketPriority = z.enum(['low', 'normal', 'high', 'urgent']);
export type TicketPriority = z.infer<typeof TicketPriority>;

/** 建议墙分组：none = 还没排期 */
export const TicketRoadmap = z.enum(['none', 'planned', 'building', 'shipped']);
export type TicketRoadmap = z.infer<typeof TicketRoadmap>;

/** feedback = 用户提交；manual = 管理员手建；ops = 从运维事件转来 */
export const TicketSource = z.enum(['feedback', 'manual', 'ops']);
export type TicketSource = z.infer<typeof TicketSource>;

/** 最后一条回复来自哪一方：user = 提交人一方，admin = 管理员一方 */
export const TicketReplySide = z.enum(['user', 'admin']);
export type TicketReplySide = z.infer<typeof TicketReplySide>;

export const ChangelogTag = z.enum(['feature', 'improve', 'fix']);
export type ChangelogTag = z.infer<typeof ChangelogTag>;

export const OpsLevel = z.enum(['error', 'warn', 'info']);
export type OpsLevel = z.infer<typeof OpsLevel>;

export const OpsSource = z.enum(['server', 'agent', 'web']);
export type OpsSource = z.infer<typeof OpsSource>;

export const UserNotificationKind = z.enum([
  /** 管理员回复了我的工单 */
  'ticket_reply',
  /** 我的工单状态变了 */
  'ticket_status',
  /** （管理员）有新工单 */
  'ticket_new',
  /** （管理员）提交人回复了工单 */
  'ticket_user_reply',
  /** （管理员）工单指派给了我 */
  'ticket_assigned',
  /** 我反馈的问题随某个版本上线了 */
  'changelog',
]);
export type UserNotificationKind = z.infer<typeof UserNotificationKind>;

export const TICKET_KIND_LABEL: Record<TicketKind, string> = {
  bug: tr('问题反馈'),
  idea: tr('功能建议'),
  question: tr('使用咨询'),
};
export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  open: tr('待处理'),
  doing: tr('处理中'),
  done: tr('已完成'),
  closed: tr('已关闭'),
};
export const TICKET_PRIORITY_LABEL: Record<TicketPriority, string> = {
  low: tr('低'),
  normal: tr('普通'),
  high: tr('高'),
  urgent: tr('紧急'),
};
export const TICKET_ROADMAP_LABEL: Record<TicketRoadmap, string> = {
  none: tr('待评估'),
  planned: tr('已计划'),
  building: tr('开发中'),
  shipped: tr('已上线'),
};
export const CHANGELOG_TAG_LABEL: Record<ChangelogTag, string> = {
  feature: tr('新功能'),
  improve: tr('改进'),
  fix: tr('修复'),
};

/** 附件限制：最多 5 张图，每张 ≤ 8 MB，只收 png / jpeg / gif / webp */
export const FEEDBACK_MAX_ATTACHMENTS = 5;
export const FEEDBACK_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const FEEDBACK_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
/** 诊断日志：纯文本（不含 NUL），最多 3 份，每份 ≤ 1 MB；只有提交人与管理员能下载 */
export const FEEDBACK_MAX_LOGS = 3;
export const FEEDBACK_MAX_LOG_BYTES = 1024 * 1024;
export const TICKET_TITLE_MAX = 120;
export const TICKET_BODY_MAX = 10_000;

/** YX-12 ↔ 12 */
export function ticketCode(no: number): string {
  return `YX-${no}`;
}
export function parseTicketCode(code: string): number | null {
  const m = /^(?:YX-)?(\d{1,9})$/iu.exec(code.trim());
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------- DTO

/** 提交时页面自动带上的现场信息（全部可选，前端尽量填） */
export const FeedbackContext = z
  .object({
    /** 当前页面地址（不含 query 里的敏感参数，前端自行裁剪） */
    url: z.string().max(2000).optional(),
    /** 前端路由名 / 路径模板 */
    route: z.string().max(300).optional(),
    projectId: z.string().max(64).optional(),
    threadId: z.string().max(64).optional(),
    userAgent: z.string().max(500).optional(),
    /** 例如 1440x900 */
    viewport: z.string().max(40).optional(),
    /** 前端构建版本 */
    appVersion: z.string().max(80).optional(),
    /** 最近的前端报错摘要（最多 10 条） */
    recentErrors: z.array(z.string().max(1000)).max(10).optional(),
  })
  .strict();
export type FeedbackContext = z.infer<typeof FeedbackContext>;

export const FeedbackUserRef = z.object({
  id: z.string(),
  name: z.string(),
  avatarColor: z.number().int(),
  avatarUrl: z.string().nullable(),
});
export type FeedbackUserRef = z.infer<typeof FeedbackUserRef>;

export const TicketAttachmentKind = z.enum(['image', 'log']);
export type TicketAttachmentKind = z.infer<typeof TicketAttachmentKind>;

/**
 * 附件；url 是需要登录的 GET 完整路径（/api/v1/feedback/…，前端直接用作 img src / 下载链接）。
 * 日志附件对非提交人、非管理员不返回（只在 hiddenLogCount 里计数）。
 */
export const TicketAttachment = z.object({
  id: z.string(),
  kind: TicketAttachmentKind,
  name: z.string(),
  mime: z.string(),
  size: z.number().int(),
  url: z.string(),
});
export type TicketAttachment = z.infer<typeof TicketAttachment>;

export const TicketMessage = z.object({
  id: z.string(),
  ticketId: z.string(),
  /** 系统消息（状态变更、版本上线）为 null */
  author: FeedbackUserRef.nullable(),
  /** 管理员一方发的 */
  isStaff: z.boolean(),
  /** 系统自动生成的说明 */
  isSystem: z.boolean(),
  body: z.string(),
  attachments: z.array(TicketAttachment),
  createdAt: z.string(),
});
export type TicketMessage = z.infer<typeof TicketMessage>;

export const TicketSummary = z.object({
  id: z.string(),
  no: z.number().int(),
  /** YX-<no> */
  code: z.string(),
  kind: TicketKind,
  title: z.string(),
  status: TicketStatus,
  priority: TicketPriority,
  roadmap: TicketRoadmap,
  source: TicketSource,
  reporter: FeedbackUserRef.nullable(),
  assignee: FeedbackUserRef.nullable(),
  projectId: z.string().nullable(),
  voteCount: z.number().int(),
  /** 当前用户是否投过票 */
  voted: z.boolean(),
  lastReplyBy: TicketReplySide,
  lastReplyAt: z.string(),
  /** 对方有我没看过的新回复 */
  unread: z.boolean(),
  /** 等我回复：最后一条来自对方且未完成/关闭（管理员看用户一方，提交人看管理员一方） */
  waiting: z.boolean(),
  /** 当前用户是否是提交人 */
  mine: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
});
export type TicketSummary = z.infer<typeof TicketSummary>;

export const TicketDetail = TicketSummary.extend({
  body: z.string(),
  /** 只有提交人和管理员能看到；其他人看到 null */
  context: FeedbackContext.nullable(),
  attachments: z.array(TicketAttachment),
  /** 当前用户看不到的诊断日志份数（「附带了 N 份诊断日志，只有管理员和提交人能看」） */
  hiddenLogCount: z.number().int(),
  messages: z.array(TicketMessage),
  /** 对方（提交人看管理员一方、管理员看提交人）最后读到的时间，用于「已读 / 已送达」回执 */
  peerReadAt: z.string().nullable(),
  /** 关联的运维事件（source=ops 时） */
  opsEventId: z.string().nullable(),
});
export type TicketDetail = z.infer<typeof TicketDetail>;

export const TicketVoteResponse = z.object({ voteCount: z.number().int(), voted: z.boolean() });
export type TicketVoteResponse = z.infer<typeof TicketVoteResponse>;

export const ChangelogTicketRef = z.object({
  id: z.string(),
  no: z.number().int(),
  code: z.string(),
  title: z.string(),
  kind: TicketKind,
});
export type ChangelogTicketRef = z.infer<typeof ChangelogTicketRef>;

export const ChangelogEntry = z.object({
  id: z.string(),
  version: z.string(),
  title: z.string(),
  /** Markdown */
  body: z.string(),
  tags: z.array(ChangelogTag),
  tickets: z.array(ChangelogTicketRef),
  prUrl: z.string().nullable(),
  /** null = 草稿（只有管理员看得到） */
  publishedAt: z.string().nullable(),
  author: FeedbackUserRef.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChangelogEntry = z.infer<typeof ChangelogEntry>;

export const UserNotification = z.object({
  id: z.string(),
  kind: UserNotificationKind,
  title: z.string(),
  href: z.string(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type UserNotification = z.infer<typeof UserNotification>;

export const UserNotificationList = z.object({
  items: z.array(UserNotification),
  unread: z.number().int(),
});
export type UserNotificationList = z.infer<typeof UserNotificationList>;

export const OpsEvent = z.object({
  id: z.string(),
  level: OpsLevel,
  source: OpsSource,
  message: z.string(),
  detail: z.record(z.string(), z.unknown()),
  fingerprint: z.string(),
  /** 合并后的累计次数 */
  count: z.number().int(),
  firstAt: z.string(),
  lastAt: z.string(),
  ticketId: z.string().nullable(),
  ticketNo: z.number().int().nullable(),
});
export type OpsEvent = z.infer<typeof OpsEvent>;

export interface AgentWindowStats {
  /** 窗口内跑过的回合数（按 agent_steps.turn_id 去重） */
  turns: number;
  /** 窗口内出错停下的回合数 */
  failures: number;
  /**
   * token 用量估算：窗口内有活动的 agent 会话的累计用量（input + output）。
   * 会话用量是累计值，没有逐回合记录，所以这是上界估算。
   */
  tokens: number;
}

export interface AdminOverview {
  server: {
    version: string;
    uptimeSec: number;
    nodeVersion: string;
    platform: string;
    cpus: number;
    /** 1 / 5 / 15 分钟负载（Windows 上恒为 0） */
    loadavg: number[];
    totalmem: number;
    freemem: number;
    /** 本进程内存（字节） */
    memory: { rss: number; heapUsed: number; heapTotal: number };
  };
  /** STORAGE_DIR 所在磁盘；取不到时 null */
  disk: { path: string; totalBytes: number; freeBytes: number } | null;
  db: { driver: string; ok: boolean; latencyMs: number | null; sizeBytes: number | null };
  llm: { configured: boolean; defaultModel: string };
  agents: { last24h: AgentWindowStats; last7d: AgentWindowStats };
  counts: {
    users: number;
    /** 7 天内登录过的用户数（按登录会话创建时间） */
    activeUsers7d: number;
    projects: number;
    ticketsOpen: number;
    ticketsDoing: number;
    /** 24 小时内有发生的运维事件条数（合并后） */
    opsEvents24h: number;
  };
  time: string;
}

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  avatarColor: number;
  avatarUrl: string | null;
  isAdmin: boolean;
  /** 是否由 ADMIN_EMAILS 配置强制为管理员（不能在界面上撤销） */
  adminByConfig: boolean;
  projectCount: number;
  ticketCount: number;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AdminProjectRow {
  id: string;
  name: string;
  icon: string;
  archived: boolean;
  memberCount: number;
  threadCount: number;
  lastActivityAt: string | null;
  /** 项目下所有 agent 会话累计用量 */
  tokens: { input: number; output: number; cached: number };
  createdAt: string;
}

// ---------------------------------------------------------------- 请求

/**
 * POST /feedback/tickets：JSON 或 multipart。
 * multipart 时：字段 kind / title / body / projectId / context（JSON 字符串）；
 * 截图文件字段名 files（可多个，≤5×8MB），诊断日志文件字段名 logs（纯文本，≤3×1MB）。
 */
export const CreateTicketInput = z.object({
  kind: TicketKind,
  title: z.string().trim().min(1, tr('请填写标题')).max(TICKET_TITLE_MAX, tr('标题太长了')),
  body: z.string().max(TICKET_BODY_MAX, tr('内容太长了')).default(''),
  projectId: z.string().max(64).nullish(),
  context: FeedbackContext.optional(),
  /** 只有管理员可以设；默认 normal */
  priority: TicketPriority.optional(),
});
export type CreateTicketInput = z.infer<typeof CreateTicketInput>;

export const TicketScope = z.enum(['mine', 'waiting', 'all']);
export type TicketScope = z.infer<typeof TicketScope>;

export const TicketListQuery = z.object({
  /** mine = 我提交的；waiting = 等我回复；all = 我能看到的全部（非管理员：自己的 + 所有建议） */
  scope: TicketScope.default('all'),
  /** 可逗号分隔多个 */
  status: z.string().max(60).optional(),
  kind: TicketKind.optional(),
  roadmap: TicketRoadmap.optional(),
  /** 标题/正文关键字，或 YX-12 / 12 */
  q: z.string().max(200).optional(),
  /** me | none | <userId>（管理员用） */
  assignee: z.string().max(64).optional(),
  /** recent = 最近更新在前；votes = 票数多的在前（建议墙） */
  sort: z.enum(['recent', 'votes']).default('recent'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type TicketListQuery = z.infer<typeof TicketListQuery>;

/** PATCH /feedback/tickets/:no —— 管理员可改全部；提交人只能 {status:'closed'} */
export const UpdateTicketInput = z
  .object({
    status: TicketStatus.optional(),
    priority: TicketPriority.optional(),
    roadmap: TicketRoadmap.optional(),
    assigneeUserId: z.string().max(64).nullable().optional(),
    title: z.string().trim().min(1).max(TICKET_TITLE_MAX).optional(),
    kind: TicketKind.optional(),
  })
  .strict();
export type UpdateTicketInput = z.infer<typeof UpdateTicketInput>;

/** POST /feedback/tickets/:no/messages：JSON 或 multipart（字段 body，文件 files） */
export const CreateTicketMessageInput = z.object({
  body: z.string().trim().min(1, tr('回复内容不能为空')).max(TICKET_BODY_MAX, tr('内容太长了')),
});
export type CreateTicketMessageInput = z.infer<typeof CreateTicketMessageInput>;

export const CreateChangelogInput = z.object({
  version: z.string().trim().min(1, tr('请填写版本号')).max(40),
  title: z.string().trim().min(1, tr('请填写标题')).max(200),
  body: z.string().max(50_000).default(''),
  tags: z.array(ChangelogTag).max(3).default([]),
  /** 关联工单编号（YX-<no> 里的数字） */
  ticketNos: z.array(z.number().int().positive()).max(100).default([]),
  prUrl: z.string().url().max(500).nullish(),
  /** 是否立即发布（默认 true；false 存为草稿） */
  publish: z.boolean().default(true),
});
export type CreateChangelogInput = z.infer<typeof CreateChangelogInput>;

/** PATCH /changelog/:id；publish:true 发布草稿（已发布的不能撤回为草稿） */
export const UpdateChangelogInput = z
  .object({
    version: z.string().trim().min(1).max(40).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(50_000).optional(),
    tags: z.array(ChangelogTag).max(3).optional(),
    ticketNos: z.array(z.number().int().positive()).max(100).optional(),
    prUrl: z.string().url().max(500).nullable().optional(),
    publish: z.literal(true).optional(),
  })
  .strict();
export type UpdateChangelogInput = z.infer<typeof UpdateChangelogInput>;

export const UserNotificationQuery = z.object({
  unread: z.enum(['1', '0', 'true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type UserNotificationQuery = z.infer<typeof UserNotificationQuery>;

/** POST /me/notifications/read：给 ids 标这些；不给（或 all:true）标全部 */
export const MarkNotificationsReadInput = z.object({
  ids: z.array(z.string().max(64)).max(500).optional(),
  all: z.boolean().optional(),
});
export type MarkNotificationsReadInput = z.infer<typeof MarkNotificationsReadInput>;

export const AdminUpdateUserInput = z.object({ isAdmin: z.boolean() }).strict();
export type AdminUpdateUserInput = z.infer<typeof AdminUpdateUserInput>;

export const OpsEventListQuery = z.object({
  level: OpsLevel.optional(),
  source: OpsSource.optional(),
  q: z.string().max(200).optional(),
  /** 只看还没转成工单的 */
  open: z.enum(['1', '0', 'true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type OpsEventListQuery = z.infer<typeof OpsEventListQuery>;

/** POST /feedback/client-errors：前端 window.onerror / unhandledrejection 上报 */
export const ClientErrorInput = z.object({
  message: z.string().trim().min(1).max(2000),
  stack: z.string().max(8000).optional(),
  url: z.string().max(2000).optional(),
  route: z.string().max(300).optional(),
  userAgent: z.string().max(500).optional(),
  appVersion: z.string().max(80).optional(),
  level: OpsLevel.default('error'),
});
export type ClientErrorInput = z.infer<typeof ClientErrorInput>;
