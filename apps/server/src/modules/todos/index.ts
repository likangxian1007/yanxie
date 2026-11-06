import { TodoCreateInput, TodoUpdateInput } from '@srh/shared';
import { registerCollabPort } from '../../agents/tools/collab-port';
import { parse } from '../../lib/http';
import { requireProject, type Params } from '../collab-common';
import type { ModuleDef } from '../types';
import { TodoListQuery, createTodo, deleteTodo, listTodos, updateTodo } from './service';

/**
 * 待办（项目共享 + 个人）
 * 归属：协作功能线程。端点契约见 API.md §2.8，请求体 schema 见 @srh/shared api-collab.ts。
 * 业务逻辑在 service.ts（路由、agent 工具、组会汇报共用）。
 *
 * 端点（均挂在 /api/v1 下）：
 *   GET    /projects/:projectId/todos?scope=project|mine&done=true|false → Todo[]
 *   POST   /projects/:projectId/todos           → 201 Todo
 *   PATCH  /projects/:projectId/todos/:todoId   → Todo
 *   DELETE /projects/:projectId/todos/:todoId   → 204
 */
export const todosModule: ModuleDef = {
  name: 'todos',
  owner: 'collab',
  register(app) {
    registerCollabPort({ todos: { create: createTodo } });

    const P = '/projects/:projectId';

    app.get<{ Params: Params<'projectId'> }>(`${P}/todos`, async (req) => {
      const { projectId } = req.params;
      const { actor } = await requireProject(req, projectId, 'view');
      return listTodos(app.ctx, actor, projectId, parse(TodoListQuery, req.query));
    });

    app.post<{ Params: Params<'projectId'> }>(`${P}/todos`, async (req, reply) => {
      const { projectId } = req.params;
      const { actor } = await requireProject(req, projectId, 'write');
      const todo = await createTodo(app.ctx, actor, projectId, parse(TodoCreateInput, req.body));
      return reply.status(201).send(todo);
    });

    app.patch<{ Params: Params<'projectId' | 'todoId'> }>(`${P}/todos/:todoId`, async (req) => {
      const { projectId, todoId } = req.params;
      const { actor } = await requireProject(req, projectId, 'write');
      return updateTodo(app.ctx, actor, projectId, todoId, parse(TodoUpdateInput, req.body));
    });

    app.delete<{ Params: Params<'projectId' | 'todoId'> }>(
      `${P}/todos/:todoId`,
      async (req, reply) => {
        const { projectId, todoId } = req.params;
        const { actor } = await requireProject(req, projectId, 'write');
        await deleteTodo(app.ctx, actor, projectId, todoId);
        return reply.status(204).send();
      },
    );
  },
};
