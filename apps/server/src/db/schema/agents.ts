/**
 * 会话与 agent 表：时间线消息、线程、agent 会话与步骤、决策卡、反应、产出、
 * 项目记忆、认领（冲突预警）、定时任务、事件日志。
 * 归属：后端线程（apps/server/src/modules/{timeline,threads,agents,memory,claims,routines}
 * 与 apps/server/src/agents/）。
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type {
  ActorRef,
  AgentRole,
  AgentStatus,
  AgentStepKind,
  AuthorKind,
  ClaimMode,
  ClaimResourceKind,
  ClaimStatus,
  DecisionOption,
  DecisionState,
  EventType,
  MemoryType,
  MessageKind,
  OutputKind,
  StatusBucket,
  ThreadKind,
} from '@srh/shared';
import { actor, createdAt, id, jsonObject, ts, updatedAt } from './_helpers';
import { projects, users } from './core';

export const messages = pgTable(
  'messages',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** null = 项目时间线顶层消息；personal 线程的根消息也带 threadId（不上时间线） */
    threadId: text('thread_id'),
    authorKind: text('author_kind').$type<AuthorKind>().notNull(),
    /** user id 或 agent session id；system 为 null */
    authorId: text('author_id'),
    authorName: text('author_name').notNull(),
    kind: text('kind').$type<MessageKind>().notNull().default('text'),
    body: text('body').notNull(),
    meta: jsonObject('meta'),
    agentVisible: boolean('agent_visible').notNull().default(true),
    editedAt: ts('edited_at'),
    deletedAt: ts('deleted_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('messages_timeline_idx').on(t.projectId, t.threadId, t.id),
    index('messages_thread_idx').on(t.threadId, t.id),
  ],
);

export const threads = pgTable(
  'threads',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ThreadKind>().notNull().default('project'),
    rootMessageId: text('root_message_id').notNull(),
    title: text('title').notNull(),
    label: text('label'),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    statusBucket: text('status_bucket').$type<StatusBucket>().notNull().default('idle'),
    statusText: text('status_text').notNull().default(''),
    resolved: boolean('resolved').notNull().default(false),
    forwardedAt: ts('forwarded_at'),
    lastActivityAt: ts('last_activity_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    /** 幂等创建：同一条根消息只能有一个线程 */
    uniqueIndex('threads_root_uq').on(t.rootMessageId),
    index('threads_project_idx').on(t.projectId, t.kind, t.lastActivityAt),
  ],
);

export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(() => threads.id, { onDelete: 'cascade' }),
    role: text('role').$type<AgentRole>().notNull(),
    status: text('status').$type<AgentStatus>().notNull().default('idle'),
    model: text('model').notNull(),
    /** 推理强度 off/low/medium/high/max；null = 跟随模型默认（harness 线程） */
    effort: text('effort'),
    /** 选用的科研 profile slug（harness 线程） */
    profile: text('profile'),
    /** /goal 设定的持续目标；null = 无（harness 线程） */
    goal: text('goal'),
    activity: text('activity'),
    workingForUserId: text('working_for_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** 已消费到的事件 seq（唤醒时只取比它新的事件） */
    lastEventSeq: integer('last_event_seq').notNull().default(0),
    /** 压缩后的上下文摘要 */
    contextSummary: text('context_summary').notNull().default(''),
    /** 摘要覆盖到的最后一个 turn（之后的 turn 以原始步骤重放进上下文）；null = 尚未压缩 */
    summaryThroughTurnId: text('summary_through_turn_id'),
    /** 正在运行的 turn（stop 端点据此中止） */
    currentTurnId: text('current_turn_id'),
    tokenUsage: jsonb('token_usage')
      .$type<{ input: number; output: number; cached: number }>()
      .notNull()
      .default(sql`'{"input":0,"output":0,"cached":0}'::jsonb`),
    /** 运行锁：持有者实例 id + 过期时间，防止同一会话并发跑两个 turn */
    lockedBy: text('locked_by'),
    lockedUntil: ts('locked_until'),
    lastActivityAt: ts('last_activity_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index('agent_sessions_project_idx').on(t.projectId),
    /** 每个线程最多一个 agent 会话 */
    uniqueIndex('agent_sessions_thread_uq').on(t.threadId),
    /** 每个项目只有一个协调者会话 */
    uniqueIndex('agent_sessions_coordinator_uq')
      .on(t.projectId)
      .where(sql`${t.role} = 'coordinator'`),
  ],
);

/** agent 的每一步：思路、文字、工具调用与结果。导师“看 coordinator 里的思路”就读它。 */
export const agentSteps = pgTable(
  'agent_steps',
  {
    id: id(),
    sessionId: text('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    turnId: text('turn_id').notNull(),
    index: integer('index').notNull(),
    kind: text('kind').$type<AgentStepKind>().notNull(),
    name: text('name'),
    content: text('content').notNull().default(''),
    data: jsonObject('data'),
    createdAt: createdAt(),
  },
  (t) => [index('agent_steps_session_idx').on(t.sessionId, t.id)],
);

export const decisions = pgTable(
  'decisions',
  {
    id: id(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    threadId: text('thread_id'),
    question: text('question').notNull(),
    context: text('context'),
    options: jsonb('options').$type<DecisionOption[]>().notNull(),
    recommended: integer('recommended').notNull(),
    reason: text('reason'),
    state: text('state').$type<DecisionState>().notNull().default('open'),
    chosen: integer('chosen'),
    chosenBy: jsonb('chosen_by').$type<ActorRef>(),
    answeredAt: ts('answered_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('decisions_message_uq').on(t.messageId)],
);

export const reactions = pgTable(
  'reactions',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    actorKind: text('actor_kind').$type<AuthorKind>().notNull(),
    actorId: text('actor_id').notNull(),
    actorName: text('actor_name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.emoji, t.actorId] })],
);

/** 消息上挂的产出（文件、链接、文档、实验、汇报），汇总成项目“资料库”。 */
export const outputs = pgTable(
  'outputs',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    threadId: text('thread_id'),
    messageId: text('message_id').references(() => messages.id, { onDelete: 'set null' }),
    kind: text('kind').$type<OutputKind>().notNull(),
    ref: text('ref').notNull(),
    title: text('title').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('outputs_project_ref_uq').on(t.projectId, t.kind, t.ref)],
);

/** 项目记忆：一主题一文件，乐观并发（version）。MEMORY.md 是索引。 */
export const memoryFiles = pgTable(
  'memory_files',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    description: text('description').notNull().default(''),
    type: text('type').$type<MemoryType>(),
    content: text('content').notNull(),
    version: integer('version').notNull().default(1),
    updatedBy: actor('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('memory_project_path_uq').on(t.projectId, t.path)],
);

/** 认领：声明“我正在改这个”，冲突在开工前预警。 */
export const workClaims = pgTable(
  'work_claims',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    threadId: text('thread_id'),
    holder: actor('holder'),
    onBehalfOfUserId: text('on_behalf_of_user_id'),
    resourceKind: text('resource_kind').$type<ClaimResourceKind>().notNull(),
    resourceRef: text('resource_ref').notNull(),
    mode: text('mode').$type<ClaimMode>().notNull().default('exclusive'),
    intent: text('intent').notNull().default(''),
    status: text('status').$type<ClaimStatus>().notNull().default('active'),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('claims_active_idx').on(t.projectId, t.status, t.resourceKind)],
);

export const routines = pgTable('routines', {
  id: id(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  schedule: text('schedule').notNull(),
  prompt: text('prompt').notNull(),
  targetThreadId: text('target_thread_id'),
  enabled: boolean('enabled').notNull().default(true),
  lastRunAt: ts('last_run_at'),
  nextRunAt: ts('next_run_at'),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
});

/**
 * 事件日志：所有写操作的唯一出口（realtime/bus.ts 的 publish）。
 * seq 是项目内连续递增序号（由 projects.event_seq 计数器在同一事务里分配，行锁保证
 * 同一项目的事件按提交顺序编号、无空洞）；客户端与 agent 都按 (project_id, seq) 增量消费。
 */
export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    threadId: text('thread_id'),
    type: text('type').$type<EventType>().notNull(),
    payload: jsonb('payload').notNull(),
    actor: actor('actor'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('events_project_seq_uq').on(t.projectId, t.seq)],
);

/**
 * agent 会话的待处理唤醒（路由器写、调度器消费）。一行 = 一个要放进下一个 <wake> 信封的条目：
 * 新消息、协调者转达、决策卡回答、审阅结论、认领冲突、定时任务……
 * wakes=false 的条目只为知情（如线程动态送达协调者），不单独触发 turn，随下一次唤醒一起送达。
 * 落库是为了进程重启后不丢唤醒。
 */
export const agentWakeups = pgTable(
  'agent_wakeups',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    wakes: boolean('wakes').notNull().default(true),
    /** 信封条目内容（见 agents/runtime/wake.ts 的 WakeItem） */
    item: jsonb('item').$type<Record<string, unknown>>().notNull(),
    consumedAt: ts('consumed_at'),
    consumedTurnId: text('consumed_turn_id'),
    createdAt: createdAt(),
  },
  (t) => [index('agent_wakeups_pending_idx').on(t.sessionId, t.consumedAt)],
);
