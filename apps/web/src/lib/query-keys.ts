/**
 * TanStack Query 的查询键，集中定义，实时事件（lib/apply-event.ts）按同一套键更新缓存。
 *
 * 约定：项目内的数据一律以 `['p', projectId, …]` 开头，`resync` 时整体失效即可；
 * 协作功能（文档、看板……）在自己的 feature 里定义键，但也请以 `['p', projectId, '<域>']` 开头。
 */

export type MessageChannel = 'all' | 'agent' | 'team';

export interface ThreadListFilter {
  kind?: 'project' | 'personal';
  bucket?: string;
  resolved?: boolean;
}

export const qk = {
  health: ['health'] as const,
  me: ['me'] as const,
  projects: ['projects'] as const,

  projectRoot: (pid: string) => ['p', pid] as const,
  project: (pid: string) => ['p', pid, 'project'] as const,
  members: (pid: string) => ['p', pid, 'members'] as const,
  invites: (pid: string) => ['p', pid, 'invites'] as const,

  timeline: (pid: string, channel: MessageChannel = 'all') =>
    channel === 'all'
      ? (['p', pid, 'timeline'] as const)
      : (['p', pid, 'timeline', channel] as const),
  threadsRoot: (pid: string) => ['p', pid, 'threads'] as const,
  threads: (pid: string, filter: ThreadListFilter = {}) => ['p', pid, 'threads', filter] as const,
  thread: (pid: string, tid: string) => ['p', pid, 'thread', tid] as const,
  threadMessages: (pid: string, tid: string, channel: MessageChannel = 'all') =>
    channel === 'all'
      ? (['p', pid, 'thread', tid, 'messages'] as const)
      : (['p', pid, 'thread', tid, 'messages', channel] as const),
  decision: (pid: string, id: string) => ['p', pid, 'decision', id] as const,

  agents: (pid: string) => ['p', pid, 'agents'] as const,
  agentSteps: (pid: string, sid: string) => ['p', pid, 'agent-steps', sid] as const,

  memory: (pid: string) => ['p', pid, 'memory'] as const,
  memoryFile: (pid: string, path: string) => ['p', pid, 'memory-file', path] as const,
  claims: (pid: string) => ['p', pid, 'claims'] as const,
  routines: (pid: string) => ['p', pid, 'routines'] as const,
  files: (pid: string) => ['p', pid, 'files'] as const,
  outputs: (pid: string) => ['p', pid, 'outputs'] as const,

  inbox: (pid: string, done: boolean) => ['inbox', pid, { done }] as const,
  inboxRoot: (pid: string) => ['inbox', pid] as const,

  /** 我的 API 令牌（跟账号走，不属于某个项目） */
  apiTokens: ['api-tokens'] as const,
  /** 我的通知订阅（跟账号走，不属于某个项目） */
  notify: ['notify'] as const,
  notifyDeliveries: (id: string) => ['notify', 'deliveries', id] as const,
};
