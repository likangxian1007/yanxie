import type { Todo, TodoPriority } from '@srh/shared';
import { dueBucket, type DueBucket } from '@/features/board/lib/due';
import { positionBetween, sortByPosition } from '@/features/board/lib/position';
import { tr } from '@/lib/i18n';

export type TodoTab = 'all' | 'mine' | 'done';
export type TodoGrouping = 'order' | 'due';

export const PRIORITY_LABEL: Record<TodoPriority, string> = {
  urgent: tr('紧急'),
  high: tr('高'),
  normal: tr('普通'),
  low: tr('低'),
};

export const PRIORITY_OPTIONS: { value: TodoPriority; label: string }[] = [
  { value: 'urgent', label: tr('紧急') },
  { value: 'high', label: tr('高') },
  { value: 'normal', label: tr('普通') },
  { value: 'low', label: tr('低') },
];

/** 指派给我，或是我的个人待办 */
export function isMine(todo: Todo, meId: string | null): boolean {
  return meId !== null && (todo.assigneeId === meId || todo.ownerUserId === meId);
}

/** 别人的个人待办不该出现在我这里（实时事件兜底过滤） */
export function isVisibleTo(todo: Todo, meId: string | null): boolean {
  return todo.ownerUserId === null || todo.ownerUserId === meId;
}

/**
 * 进行中的列表（按位置排序）。`keep` 里的 id 即使已完成也暂时留在原处
 * （勾选后的完成动画播完再移走）。
 */
export function activeTodos(
  todos: readonly Todo[],
  tab: Exclude<TodoTab, 'done'>,
  meId: string | null,
  keep: ReadonlySet<string> = new Set(),
): Todo[] {
  return sortByPosition(
    todos.filter((t) => (!t.done || keep.has(t.id)) && (tab === 'all' || isMine(t, meId))),
  );
}

/** 已完成：最近完成的在前 */
export function completedTodos(
  todos: readonly Todo[],
  meId: string | null,
  onlyMine = false,
): Todo[] {
  return todos
    .filter((t) => t.done && (!onlyMine || isMine(t, meId)))
    .sort(
      (a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '') || (a.id < b.id ? -1 : 1),
    );
}

export interface DueGroup {
  key: DueBucket;
  label: string;
  todos: Todo[];
}

const DUE_GROUPS: { key: DueBucket; label: string }[] = [
  { key: 'overdue', label: tr('已过期') },
  { key: 'today', label: tr('今天') },
  { key: 'week', label: tr('本周') },
  { key: 'later', label: tr('以后') },
  { key: 'none', label: tr('无日期') },
];

/** 按截止日期分组（组内保持原顺序），只返回非空分组 */
export function groupByDue(todos: readonly Todo[], now: Date = new Date()): DueGroup[] {
  const buckets = new Map<DueBucket, Todo[]>(DUE_GROUPS.map((g) => [g.key, []]));
  for (const t of todos) buckets.get(dueBucket(t.dueAt, now))?.push(t);
  return DUE_GROUPS.map((g) => ({ ...g, todos: buckets.get(g.key) ?? [] })).filter(
    (g) => g.todos.length > 0,
  );
}

export interface TodoMove {
  todos: Todo[];
  position: string;
  changed: boolean;
}

/** 拖动排序：插在 afterId 之后（null = 最前），与服务端 afterTodoId 语义一致 */
export function moveTodoAfter(
  todos: readonly Todo[],
  id: string,
  afterId: string | null,
): TodoMove | null {
  const todo = todos.find((t) => t.id === id);
  if (!todo) return null;
  const sorted = sortByPosition(todos);
  const rest = sorted.filter((t) => t.id !== id);
  const at = afterId === null ? 0 : rest.findIndex((t) => t.id === afterId) + 1;
  const index = afterId !== null && at === 0 ? rest.length : at;
  if (sorted.findIndex((t) => t.id === id) === index) {
    return { todos: [...todos], position: todo.position, changed: false };
  }
  const position = positionBetween(
    rest[index - 1]?.position ?? null,
    rest[index]?.position ?? null,
  );
  return {
    todos: todos.map((t) => (t.id === id ? { ...t, position } : t)),
    position,
    changed: true,
  };
}

export function upsertTodo(list: readonly Todo[], todo: Todo): Todo[] {
  return list.some((t) => t.id === todo.id)
    ? list.map((t) => (t.id === todo.id ? todo : t))
    : [...list, todo];
}

export function removeTodo(list: readonly Todo[], id: string): Todo[] {
  return list.filter((t) => t.id !== id);
}

/** 合并两次列表请求（未完成 + 已完成），按 id 去重 */
export function mergeTodos(...lists: readonly Todo[][]): Todo[] {
  const map = new Map<string, Todo>();
  for (const list of lists) for (const t of list) map.set(t.id, t);
  return [...map.values()];
}
