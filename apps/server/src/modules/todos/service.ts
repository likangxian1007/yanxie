import { and, asc, eq, isNull, ne, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  ApiError,
  TodoCreateInput,
  TodoUpdateInput,
  isAgentAssignee,
  newId,
  type ActorRef,
  type Todo,
} from '@srh/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/client';
import { todos } from '../../db/schema';
import { parse } from '../../lib/http';
import { notFound, parseDate, positionBetween } from '../collab-common';
import { markInboxDoneBySource } from '../collab-common/inbox';
import {
  addedAssignees,
  eventThreadId,
  notifyAssigned,
  validateAssignees,
} from '../boards/assignees';
import { comparePos, posAfter, posKey } from '../boards/position';
import { todoDto, type TodoRow } from './serialize';

/**
 * 待办的业务逻辑（路由、agent 工具、组会汇报共用）。
 * - 共享待办：ownerUserId = null，项目成员都能看、能改。
 * - 个人待办：ownerUserId = 主人，只有主人能看/改（别人访问 404）。
 * - 排序：未完成在前按 position；已完成按 completedAt 倒序。position 为项目内统一的分数索引。
 */

export const TodoListQuery = z.object({
  scope: z.enum(['project', 'mine']).optional(),
  done: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type TodoListFilter = z.output<typeof TodoListQuery>;

export const todoHref = (projectId: string, todoId: string) =>
  `/p/${projectId}/todos?todo=${todoId}`;

/** 操作者对应的用户 id；agent / 系统没有个人待办 */
function viewerId(actor: ActorRef): string | null {
  return actor.kind === 'user' ? actor.id : null;
}

function invalid(field: string, message: string): never {
  throw new ApiError('validation_failed', message, { issues: [{ path: field, message }] });
}

/** 当前操作者能看到的待办：共享的 + 自己的个人待办 */
function visibleTo(me: string | null): SQL {
  return me
    ? (or(isNull(todos.ownerUserId), eq(todos.ownerUserId, me)) as SQL)
    : isNull(todos.ownerUserId);
}

async function visibleTodo(
  exec: Db,
  actor: ActorRef,
  projectId: string,
  todoId: string,
): Promise<TodoRow | undefined> {
  const [row] = await exec
    .select()
    .from(todos)
    .where(and(eq(todos.id, todoId), eq(todos.projectId, projectId), visibleTo(viewerId(actor))));
  return row;
}

async function loadTodo(
  exec: Db,
  actor: ActorRef,
  projectId: string,
  todoId: string,
): Promise<TodoRow> {
  const row = await visibleTodo(exec, actor, projectId, todoId);
  if (!row) notFound('待办');
  return row;
}

function isCreator(row: TodoRow, userId: string): boolean {
  return row.createdBy.kind === 'user' && row.createdBy.id === userId;
}

/** 个人待办只能指派给主人自己或 agent */
function checkPersonalAssignee(owner: string | null, assignee: string | null) {
  if (owner && assignee && !isAgentAssignee(assignee) && assignee !== owner) {
    invalid('assigneeId', '个人待办只能指派给自己或 agent，想交给别人请改成共享待办');
  }
}

/** 项目里最靠前的位置之前 */
async function headPosition(exec: Db, projectId: string, excludeId?: string): Promise<string> {
  const [first] = await exec
    .select({ position: todos.position })
    .from(todos)
    .where(and(eq(todos.projectId, projectId), ...(excludeId ? [ne(todos.id, excludeId)] : [])))
    .orderBy(asc(posKey(todos.position)))
    .limit(1);
  return positionBetween(null, first?.position ?? null);
}

function sortTodos(rows: TodoRow[]): TodoRow[] {
  return rows.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (!a.done) return comparePos(a.position, b.position) || comparePos(a.id, b.id);
    const ta = a.completedAt?.getTime() ?? 0;
    const tb = b.completedAt?.getTime() ?? 0;
    return tb - ta || comparePos(b.id, a.id);
  });
}

/**
 * 列表。scope=project：项目共享待办；scope=mine：我的个人待办 + 指派给我的共享待办；
 * 不传：共享 + 我的个人。done 不传 = 全部。
 */
export async function listTodos(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  filter: TodoListFilter = {},
): Promise<Todo[]> {
  const me = viewerId(actor);
  let scope: SQL;
  if (filter.scope === 'project') scope = isNull(todos.ownerUserId);
  else if (filter.scope === 'mine') {
    if (!me) return [];
    scope = or(
      eq(todos.ownerUserId, me),
      and(isNull(todos.ownerUserId), eq(todos.assigneeId, me)),
    ) as SQL;
  } else scope = visibleTo(me);
  const where = [eq(todos.projectId, projectId), scope];
  if (filter.done !== undefined) where.push(eq(todos.done, filter.done));
  const rows = await ctx.db.db
    .select()
    .from(todos)
    .where(and(...where));
  return sortTodos(rows).map(todoDto);
}

/**
 * 新建待办，放在最前。personal=true → 操作者的个人待办；agent 调用时忽略 personal（建共享待办）。
 * 组会汇报拆待办时传 source = { kind: 'report', id }。
 */
export async function createTodo(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  input: TodoCreateInput,
): Promise<Todo> {
  const data = parse(TodoCreateInput, input);
  const dueAt = parseDate(data.dueAt, 'dueAt');
  const me = viewerId(actor);
  const owner = data.personal && me ? me : null;
  const { todo, added, ev } = await ctx.db.db.transaction(async (tx) => {
    const added = data.assigneeId
      ? await validateAssignees(tx, projectId, [data.assigneeId], 'assigneeId')
      : [];
    const assigneeId = added[0] ?? null;
    checkPersonalAssignee(owner, assigneeId);
    const [row] = await tx
      .insert(todos)
      .values({
        id: newId('todo'),
        projectId,
        ownerUserId: owner,
        assigneeId,
        title: data.title,
        notes: data.notes,
        priority: data.priority,
        dueAt,
        position: await headPosition(tx, projectId),
        source: data.source,
        createdBy: actor,
      })
      .returning();
    if (!row) throw new Error('待办写入失败');
    const todo = todoDto(row);
    const ev = await ctx.bus.record(tx, {
      projectId,
      threadId: eventThreadId(null, added),
      type: 'todo.created',
      payload: todo,
      actor,
    });
    return { todo, added, ev };
  });
  ctx.bus.emit(ev);
  await notifyAssigned(ctx, actor, projectId, added, {
    title: todo.title,
    href: todoHref(projectId, todo.id),
    sourceId: todo.id,
  });
  return todo;
}

/** 改待办：done 切换写/清 completedAt；afterTodoId 拖动排序（null = 最前）。 */
export async function updateTodo(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  todoId: string,
  input: TodoUpdateInput,
): Promise<Todo> {
  const data = parse(TodoUpdateInput, input);
  const dueAt = data.dueAt === undefined ? undefined : parseDate(data.dueAt, 'dueAt');
  const me = viewerId(actor);
  const { todo, added, completed, ev } = await ctx.db.db.transaction(async (tx) => {
    const current = await loadTodo(tx, actor, projectId, todoId);
    const patch: Partial<TodoRow> = {};
    if (data.title !== undefined) patch.title = data.title;
    if (data.notes !== undefined) patch.notes = data.notes;
    if (data.priority !== undefined) patch.priority = data.priority;
    if (dueAt !== undefined) patch.dueAt = dueAt;
    if (data.personal !== undefined && me) {
      // 共享待办改成个人待办会让其他成员看不到它：只有创建人可以这么做
      if (data.personal && !current.ownerUserId && !isCreator(current, me)) {
        throw new ApiError(
          'forbidden',
          '只有这条待办的创建人可以把它改成个人待办。想自己跟进，可以指派给自己',
        );
      }
      patch.ownerUserId = data.personal ? me : null;
    }

    let added: string[] = [];
    if (data.assigneeId !== undefined) {
      const next = data.assigneeId
        ? ((await validateAssignees(tx, projectId, [data.assigneeId], 'assigneeId'))[0] ?? null)
        : null;
      patch.assigneeId = next;
      added = addedAssignees(current.assigneeId ? [current.assigneeId] : [], next ? [next] : []);
    }
    checkPersonalAssignee(
      patch.ownerUserId !== undefined ? patch.ownerUserId : current.ownerUserId,
      patch.assigneeId !== undefined ? patch.assigneeId : current.assigneeId,
    );

    let completed = false;
    if (data.done !== undefined && data.done !== current.done) {
      patch.done = data.done;
      patch.completedAt = data.done ? new Date() : null;
      completed = data.done;
    }

    if (data.afterTodoId !== undefined && data.afterTodoId !== todoId) {
      if (data.afterTodoId === null) {
        patch.position = await headPosition(tx, projectId, todoId);
      } else {
        const after = await visibleTodo(tx, actor, projectId, data.afterTodoId);
        if (!after) invalid('afterTodoId', 'afterTodoId 指向的待办不存在');
        const [next] = await tx
          .select({ position: todos.position })
          .from(todos)
          .where(
            and(
              eq(todos.projectId, projectId),
              ne(todos.id, todoId),
              posAfter(todos.position, after.position),
            ),
          )
          .orderBy(asc(posKey(todos.position)))
          .limit(1);
        patch.position = positionBetween(after.position, next?.position ?? null);
      }
    }

    let row = current;
    if (Object.keys(patch).length) {
      const [updated] = await tx.update(todos).set(patch).where(eq(todos.id, todoId)).returning();
      if (!updated) notFound('待办');
      row = updated;
    }
    const todo = todoDto(row);
    const ev = await ctx.bus.record(tx, {
      projectId,
      threadId: eventThreadId(null, added),
      type: 'todo.updated',
      payload: todo,
      actor,
    });
    return { todo, added, completed, ev };
  });
  ctx.bus.emit(ev);
  if (completed) await markInboxDoneBySource(ctx, projectId, todoId, actor);
  await notifyAssigned(ctx, actor, projectId, added, {
    title: todo.title,
    href: todoHref(projectId, todo.id),
    sourceId: todo.id,
  });
  return todo;
}

export async function deleteTodo(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  todoId: string,
): Promise<void> {
  const ev = await ctx.db.db.transaction(async (tx) => {
    await loadTodo(tx, actor, projectId, todoId);
    await tx.delete(todos).where(eq(todos.id, todoId));
    return ctx.bus.record(tx, { projectId, type: 'todo.deleted', payload: { id: todoId }, actor });
  });
  ctx.bus.emit(ev);
  await markInboxDoneBySource(ctx, projectId, todoId, actor);
}
