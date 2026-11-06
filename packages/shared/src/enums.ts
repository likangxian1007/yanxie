import { z } from 'zod';

/**
 * 所有枚举只在这里定义一次。数据库用 text 存，校验与类型都从这里来。
 * 新增取值：先改这里，再改 ARCHITECTURE.md 对应表格。
 */

/** 项目成员角色。advisor = 导师/师兄，默认只读 + 审阅权。 */
export const ProjectRole = z.enum(['owner', 'advisor', 'member', 'guest']);
export type ProjectRole = z.infer<typeof ProjectRole>;

export const ProjectVisibility = z.enum(['private', 'team']);
export type ProjectVisibility = z.infer<typeof ProjectVisibility>;

/** 线程类型：project = 挂在项目时间线上的协作线程；personal = 个人工作区里的私有会话。 */
export const ThreadKind = z.enum(['project', 'personal']);
export type ThreadKind = z.infer<typeof ThreadKind>;

/** 线程看板分栏（由服务端按规则计算，不由 agent 自报）。 */
export const StatusBucket = z.enum([
  'idle',
  'working',
  'blocked',
  'review_ready',
  'completed',
  'failed',
]);
export type StatusBucket = z.infer<typeof StatusBucket>;

export const AuthorKind = z.enum(['user', 'agent', 'system']);
export type AuthorKind = z.infer<typeof AuthorKind>;

export const MessageKind = z.enum([
  'text', // 普通消息（markdown）
  'decision', // 决策卡
  'activity', // 系统活动行（成员加入、线程创建……）
  'forward', // 个人会话转发给 coordinator 的卡片
  'review', // 审阅请求 / 结论卡
  'widget', // agent 发出的内联可视化
]);
export type MessageKind = z.infer<typeof MessageKind>;

export const AgentRole = z.enum(['coordinator', 'thread', 'personal']);
export type AgentRole = z.infer<typeof AgentRole>;

export const AgentStatus = z.enum(['idle', 'queued', 'running', 'waiting', 'failed', 'stopped']);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AgentStepKind = z.enum(['thinking', 'text', 'tool_call', 'tool_result', 'note']);
export type AgentStepKind = z.infer<typeof AgentStepKind>;

export const DecisionState = z.enum(['open', 'answered', 'withdrawn']);
export type DecisionState = z.infer<typeof DecisionState>;

export const OutputKind = z.enum(['file', 'link', 'document', 'experiment', 'report', 'research']);
export type OutputKind = z.infer<typeof OutputKind>;

export const MemoryType = z.enum(['user', 'feedback', 'project', 'reference']);
export type MemoryType = z.infer<typeof MemoryType>;

/** 认领（冲突预警）的资源类型。resourceRef 的格式见 ARCHITECTURE.md §5。 */
export const ClaimResourceKind = z.enum([
  'document',
  'doc_section',
  'file',
  'experiment',
  'card',
  'topic',
  'research',
]);
export type ClaimResourceKind = z.infer<typeof ClaimResourceKind>;

export const ClaimMode = z.enum(['exclusive', 'shared']);
export type ClaimMode = z.infer<typeof ClaimMode>;

export const ClaimStatus = z.enum(['active', 'released', 'expired']);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

export const TodoPriority = z.enum(['low', 'normal', 'high', 'urgent']);
export type TodoPriority = z.infer<typeof TodoPriority>;

export const ExperimentStatus = z.enum(['planned', 'running', 'done', 'failed', 'abandoned']);
export type ExperimentStatus = z.infer<typeof ExperimentStatus>;

export const ReviewTargetKind = z.enum([
  'thread',
  'message',
  'plan',
  'document',
  'experiment',
  'report',
  'output',
  'proposal',
  'research_record',
  'research_finding',
]);
export type ReviewTargetKind = z.infer<typeof ReviewTargetKind>;

export const ReviewStatus = z.enum(['open', 'approved', 'changes_requested', 'closed']);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

export const ReviewVerdict = z.enum(['pending', 'lgtm', 'changes_requested', 'commented']);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

export const ReportStatus = z.enum(['draft', 'generating', 'final']);
export type ReportStatus = z.infer<typeof ReportStatus>;

/** “等你处理”收件箱条目类型，按优先级从高到低。 */
export const InboxKind = z.enum([
  'decision', // agent 等你拍板
  'review', // 有人请你审阅 / LGTM
  'mention', // 有人 @ 了你
  'conflict', // 冲突预警需要人决定
  'assignment', // 指派给你的待办 / 卡片
  'finished', // 你发起的线程完成了
  'recheck', // 团队依据所依赖的方案或来源变了，需要复核
]);
export type InboxKind = z.infer<typeof InboxKind>;

/** 优先级：数字越小越靠前。 */
export const INBOX_PRIORITY: Record<InboxKind, number> = {
  decision: 0,
  review: 1,
  conflict: 2,
  mention: 3,
  assignment: 4,
  finished: 5,
  recheck: 3,
};
