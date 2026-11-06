/**
 * 协作功能（文档、看板、待办、实验、审阅、汇报）的查询键。
 * 都以 ['p', projectId, …] 开头：/ws resync 时前端外壳会整体 invalidate ['p', pid]。
 */
export const ck = {
  docs: (pid: string) => ['p', pid, 'docs'] as const,
  doc: (pid: string, id: string) => ['p', pid, 'doc', id] as const,
  docVersions: (pid: string, id: string) => ['p', pid, 'doc', id, 'versions'] as const,

  boards: (pid: string) => ['p', pid, 'boards'] as const,
  board: (pid: string, id: string) => ['p', pid, 'board', id] as const,

  todos: (pid: string) => ['p', pid, 'todos'] as const,

  experiments: (pid: string) => ['p', pid, 'experiments'] as const,
  experiment: (pid: string, id: string) => ['p', pid, 'experiment', id] as const,
  experimentLogs: (pid: string, id: string) => ['p', pid, 'experiment', id, 'logs'] as const,

  reviews: (pid: string) => ['p', pid, 'reviews'] as const,
  review: (pid: string, id: string) => ['p', pid, 'review', id] as const,

  reports: (pid: string) => ['p', pid, 'reports'] as const,
  report: (pid: string, id: string) => ['p', pid, 'report', id] as const,
};
