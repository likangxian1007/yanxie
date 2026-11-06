import { z } from 'zod';
import {
  type ActorRef,
  AgentSession,
  AgentStep,
  Decision,
  FileObject,
  InboxItem,
  MemoryFile,
  Message,
  Project,
  ProjectMember,
  Routine,
  Thread,
  WorkClaim,
} from './entities';
import { COLLAB_EVENT_PAYLOADS } from './events-collab';
import { Notebook } from './notebooks';
import { DESKTOP_EPHEMERAL_PAYLOADS } from './desktop';
import { LIBRARY_EVENT_PAYLOADS } from './events-library';
import { VERSIONING_EVENT_PAYLOADS } from './versioning';
import { SHARING_EVENT_PAYLOADS } from './sharing';
import { AgentProfile, LlmProvider, McpServer, Skill, SlashCommand } from './harness';
import { RESEARCH_EVENT_PAYLOADS } from './events-research';
import { RESEARCH_WORKSPACE_EVENT_PAYLOADS } from './events-research-workspace';
import { RESEARCH_EXECUTION_EVENT_PAYLOADS } from './events-research-execution';

/**
 * 项目事件：所有写操作都会产生一条事件，落库（events 表）并经 WS 推给订阅了该项目的客户端；
 * agent 的唤醒也从同一张表读。seq 为**项目内**连续递增序号（projects.event_seq 计数器，见 ARCHITECTURE.md §5.1）。
 *
 * 规则：
 * - payload 携带“变更后的完整对象”（不是 diff），客户端直接替换缓存。
 * - 删除类事件只带 id。
 * - 新增事件：后端线程在本文件 CORE_EVENT_PAYLOADS 追加，协作线程在 events-collab.ts 追加，
 *   并在 API.md §4 登记。只追加，不改名不删除。
 */
const IdOnly = z.object({ id: z.string() });

export const CORE_EVENT_PAYLOADS = {
  // 项目与成员
  'project.updated': Project,
  'member.joined': ProjectMember,
  'member.updated': ProjectMember,
  'member.removed': z.object({ userId: z.string() }),

  // 时间线与线程
  'message.created': Message,
  'message.updated': Message,
  'message.deleted': IdOnly,
  'thread.created': Thread,
  'thread.updated': Thread,
  /** 个人会话被主人删除（只推给主人） */
  'thread.deleted': IdOnly,
  'decision.created': Decision,
  'decision.updated': Decision,

  // agent
  'agent.updated': AgentSession,
  'agent.step': AgentStep,
  'memory.updated': MemoryFile,
  'memory.deleted': z.object({ path: z.string() }),
  'claim.created': WorkClaim,
  'claim.updated': WorkClaim,
  /** 冲突预警：新的认领与已有认领重叠 */
  'claim.conflict': z.object({ claim: WorkClaim, conflictsWith: z.array(WorkClaim) }),
  'routine.created': Routine,
  'routine.updated': Routine,
  'routine.deleted': IdOnly,

  // 文件与收件箱
  'file.created': FileObject,
  /** 覆盖写入已有路径（agent 的 write_file、同路径重新上传） */
  'file.updated': FileObject,
  'file.deleted': IdOnly,
  'inbox.created': InboxItem,
  'inbox.updated': InboxItem,

  // notebook（内容走 /collab；这里只有元信息变化，供列表刷新）
  'notebook.created': Notebook,
  'notebook.updated': Notebook,
  'notebook.deleted': IdOnly,
  // harness（只发项目作用域的变更；个人作用域不广播，客户端写后自行刷新）
  'provider.updated': LlmProvider,
  'provider.deleted': IdOnly,
  'mcp.updated': McpServer,
  'mcp.deleted': IdOnly,
  'skill.updated': Skill,
  'skill.deleted': IdOnly,
  'command.updated': SlashCommand,
  'command.deleted': IdOnly,
  'profile.updated': AgentProfile,
  'profile.deleted': IdOnly,
} as const;

export const EVENT_PAYLOADS = {
  ...CORE_EVENT_PAYLOADS,
  ...COLLAB_EVENT_PAYLOADS,
  ...LIBRARY_EVENT_PAYLOADS,
  ...VERSIONING_EVENT_PAYLOADS,
  ...RESEARCH_EVENT_PAYLOADS,
  ...SHARING_EVENT_PAYLOADS,
  ...RESEARCH_WORKSPACE_EVENT_PAYLOADS,
  ...RESEARCH_EXECUTION_EVENT_PAYLOADS,
} as const;

export type EventType = keyof typeof EVENT_PAYLOADS;
export const EVENT_TYPES = Object.keys(EVENT_PAYLOADS) as EventType[];
export const EventTypeSchema = z.enum(EVENT_TYPES as [EventType, ...EventType[]]);

export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_PAYLOADS)[T]>;

/** 一条已落库的项目事件。 */
export interface ProjectEvent<T extends EventType = EventType> {
  /** 项目内连续递增序号（客户端断线重连用 afterSeq 补齐） */
  seq: number;
  projectId: string;
  /** 相关线程（用于把事件路由给线程 agent） */
  threadId: string | null;
  type: T;
  payload: EventPayload<T>;
  actor: ActorRef;
  createdAt: string;
}

export type AnyProjectEvent = { [K in EventType]: ProjectEvent<K> }[EventType];

/**
 * 瞬时事件：不落库、无 seq，只推给在线客户端。
 * - agent.delta：agent 流式输出的增量文字（“正在输入”动画）
 * 在线状态走单独的 presence 帧（见 ws.ts）。
 */
export const EPHEMERAL_PAYLOADS = {
  'agent.delta': z.object({
    sessionId: z.string(),
    threadId: z.string().nullable(),
    turnId: z.string(),
    /** 追加到当前草稿末尾的文字 */
    delta: z.string(),
  }),
  // 共享云电脑（desktop.ts）
  ...DESKTOP_EPHEMERAL_PAYLOADS,
} as const;
export type EphemeralType = keyof typeof EPHEMERAL_PAYLOADS;
export type EphemeralPayload<T extends EphemeralType> = z.infer<(typeof EPHEMERAL_PAYLOADS)[T]>;

/** 校验某事件 payload（服务端发布前、测试中用）。 */
export function parseEventPayload<T extends EventType>(type: T, payload: unknown): EventPayload<T> {
  return EVENT_PAYLOADS[type].parse(payload) as EventPayload<T>;
}
