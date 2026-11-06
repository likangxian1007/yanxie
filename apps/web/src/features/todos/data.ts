import { useMemo } from 'react';
import { queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Todo, TodoCreateInput, TodoUpdateInput } from '@srh/shared';
import { toast } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api';
import { useProjectEvent } from '@/lib/realtime';
import { useMeUser } from '@/lib/session';
import { ck } from '@/features/collab-kit/keys';
import { isVisibleTo, mergeTodos, moveTodoAfter, removeTodo, upsertTodo } from './lib/todo-list';
import { tr } from '@/lib/i18n';

function toList(res: Todo[] | { items: Todo[] } | null | undefined): Todo[] {
  if (Array.isArray(res)) return res;
  return res?.items ?? [];
}

function errorText(err: unknown): string {
  return err instanceof ApiRequestError ? err.message : tr('请稍后再试。');
}

/**
 * 我能看到的全部待办（项目共享 + 我的个人待办），未完成与已完成各取一次再合并，
 * 页面上的“全部 / 我的 / 已完成”都在本地筛。
 */
export function useTodos(pid: string) {
  return useQuery(todosQueryOptions(pid));
}

export function todosQueryOptions(pid: string) {
  return queryOptions({
    queryKey: ck.todos(pid),
    queryFn: async ({ signal }) => {
      const path = `/projects/${pid}/todos`;
      const [open, done] = await Promise.all([
        api.get<Todo[]>(path, { signal, query: { done: false } }),
        api.get<Todo[]>(path, { signal, query: { done: true } }),
      ]);
      return mergeTodos(toList(open), toList(done));
    },
    enabled: Boolean(pid),
  });
}

/** todo.* 事件写进缓存（别人的个人待办不显示） */
export function useTodoRealtime(pid: string) {
  const qc = useQueryClient();
  const me = useMeUser();
  useProjectEvent(pid, (event) => {
    if (event.type === 'todo.created' || event.type === 'todo.updated') {
      const todo = event.payload;
      qc.setQueryData<Todo[]>(ck.todos(pid), (list) => {
        if (!list) return list;
        return isVisibleTo(todo, me?.id ?? null)
          ? upsertTodo(list, todo)
          : removeTodo(list, todo.id);
      });
    } else if (event.type === 'todo.deleted') {
      const { id } = event.payload;
      qc.setQueryData<Todo[]>(ck.todos(pid), (list) => (list ? removeTodo(list, id) : list));
    }
  });
}

export type TodoPatch = Omit<TodoUpdateInput, 'afterTodoId'>;

function createActions(qc: QueryClient, pid: string, meId: string | null) {
  const key = ck.todos(pid);
  const get = () => qc.getQueryData<Todo[]>(key) ?? [];
  const set = (fn: (list: Todo[]) => Todo[]) =>
    qc.setQueryData<Todo[]>(key, (list) => (list ? fn(list) : list));
  const find = (id: string) => get().find((t) => t.id === id);
  const restore = (todo: Todo) => set((list) => upsertTodo(list, todo));

  const onError = (err: unknown, before: Todo, title: string) => {
    if (err instanceof ApiRequestError && err.status === 404) {
      set((list) => removeTodo(list, before.id));
      toast({ title: tr('这条待办已被删除'), tone: 'warning' });
      return;
    }
    restore(before);
    toast.error(title, errorText(err));
  };

  return {
    async createTodo(input: TodoCreateInput): Promise<Todo | null> {
      try {
        const todo = await api.post<Todo>(`/projects/${pid}/todos`, input);
        set((list) => upsertTodo(list, todo));
        return todo;
      } catch (err) {
        toast.error(tr('没能添加待办'), errorText(err));
        return null;
      }
    },

    async updateTodo(id: string, patch: TodoPatch): Promise<Todo | null> {
      const before = find(id);
      if (!before) return null;
      const optimistic: Todo = { ...before };
      if (patch.title !== undefined) optimistic.title = patch.title;
      if (patch.notes !== undefined) optimistic.notes = patch.notes;
      if (patch.assigneeId !== undefined) optimistic.assigneeId = patch.assigneeId;
      if (patch.priority !== undefined) optimistic.priority = patch.priority;
      if (patch.dueAt !== undefined) optimistic.dueAt = patch.dueAt;
      if (patch.personal !== undefined) optimistic.ownerUserId = patch.personal ? meId : null;
      if (patch.done !== undefined) {
        optimistic.done = patch.done;
        optimistic.completedAt = patch.done ? new Date().toISOString() : null;
      }
      restore(optimistic);
      try {
        const saved = await api.patch<Todo>(`/projects/${pid}/todos/${id}`, patch);
        set((list) => upsertTodo(list, saved));
        return saved;
      } catch (err) {
        onError(err, before, tr('没能保存待办'));
        return null;
      }
    },

    /** 拖动排序：插在 afterId 之后（null = 最前） */
    async moveTodo(id: string, afterId: string | null): Promise<void> {
      const before = find(id);
      if (!before) return;
      const move = moveTodoAfter(get(), id, afterId);
      if (!move?.changed) return;
      set(() => move.todos);
      try {
        const saved = await api.patch<Todo>(`/projects/${pid}/todos/${id}`, {
          afterTodoId: afterId,
        });
        set((list) => upsertTodo(list, saved));
      } catch (err) {
        onError(err, before, tr('没能调整顺序'));
      }
    },

    async deleteTodo(id: string): Promise<boolean> {
      const before = find(id);
      if (!before) return false;
      set((list) => removeTodo(list, id));
      try {
        await api.delete(`/projects/${pid}/todos/${id}`);
        return true;
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) return true;
        restore(before);
        toast.error(tr('没能删除待办'), errorText(err));
        return false;
      }
    },
  };
}

export type TodoActions = ReturnType<typeof createActions>;

export function useTodoActions(pid: string): TodoActions {
  const qc = useQueryClient();
  const me = useMeUser();
  const meId = me?.id ?? null;
  return useMemo(() => createActions(qc, pid, meId), [qc, pid, meId]);
}
