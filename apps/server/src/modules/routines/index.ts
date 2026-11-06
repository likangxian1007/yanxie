import { ApiError, RoutineCreateInput, RoutineUpdateInput } from '@srh/shared';
import { runtimeHooks } from '../../agents/runtime/hooks';
import { parse } from '../../lib/http';
import { requireProject, userActor, type ProjectAccess } from '../auth/guard';
import type { ModuleDef } from '../types';
import {
  createRoutine,
  deleteRoutine,
  getRoutineRow,
  listRoutines,
  toRoutine,
  updateRoutine,
  type RoutineRow,
} from './service';

/**
 * 定时任务（API.md §2.6）
 * 归属：后端与 agent 引擎线程。到点触发由 agent 运行时的调度器负责（listDueRoutines / markRoutineRan）。
 *
 *   GET    /projects/:projectId/routines
 *   POST   /projects/:projectId/routines
 *   PATCH  /projects/:projectId/routines/:routineId    创建者或 owner / advisor
 *   DELETE /projects/:projectId/routines/:routineId    创建者或 owner / advisor
 *   POST   /projects/:projectId/routines/:routineId/run  立即运行一次 → 202
 */
type P = { projectId: string };
type PR = P & { routineId: string };

function assertCanModify(access: ProjectAccess, row: RoutineRow) {
  if (row.createdBy !== access.user.id && access.role !== 'owner' && access.role !== 'advisor') {
    throw new ApiError('forbidden', '只有创建者或项目管理者可以修改这个定时任务');
  }
}

export const routinesModule: ModuleDef = {
  name: 'routines',
  owner: 'backend',
  register(app) {
    const ctx = app.ctx;

    app.get<{ Params: P }>('/projects/:projectId/routines', async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      return listRoutines(ctx, req.params.projectId);
    });

    app.post<{ Params: P }>('/projects/:projectId/routines', async (req, reply) => {
      const { user } = await requireProject(req, req.params.projectId, 'write');
      const input = parse(RoutineCreateInput, req.body);
      const routine = await createRoutine(
        ctx,
        { kind: 'user', id: user.id, name: user.name },
        req.params.projectId,
        input,
      );
      return reply.status(201).send(routine);
    });

    app.patch<{ Params: PR }>('/projects/:projectId/routines/:routineId', async (req) => {
      const { projectId, routineId } = req.params;
      const access = await requireProject(req, projectId, 'write');
      const input = parse(RoutineUpdateInput, req.body);
      const row = await getRoutineRow(ctx, projectId, routineId);
      if (!row) throw new ApiError('not_found', '定时任务不存在');
      assertCanModify(access, row);
      return updateRoutine(ctx, access.actor, projectId, routineId, input);
    });

    app.delete<{ Params: PR }>('/projects/:projectId/routines/:routineId', async (req, reply) => {
      const { projectId, routineId } = req.params;
      const access = await requireProject(req, projectId, 'write');
      const row = await getRoutineRow(ctx, projectId, routineId);
      if (!row) throw new ApiError('not_found', '定时任务不存在');
      assertCanModify(access, row);
      await deleteRoutine(ctx, access.actor, projectId, routineId);
      return reply.status(204).send();
    });

    app.post<{ Params: PR }>('/projects/:projectId/routines/:routineId/run', async (req, reply) => {
      const { projectId, routineId } = req.params;
      const { user } = await requireProject(req, projectId, 'write');
      const row = await getRoutineRow(ctx, projectId, routineId);
      if (!row) throw new ApiError('not_found', '定时任务不存在');
      const fire = runtimeHooks.fireRoutine;
      if (fire) {
        // 不等待运行结果；失败只记日志
        void Promise.resolve()
          .then(() => fire(ctx, toRoutine(row), user.id))
          .catch((err: unknown) =>
            req.log.error({ err, routineId, actor: userActor(user) }, '手动运行定时任务失败'),
          );
      }
      return reply.status(202).send({ accepted: true });
    });
  },
};
