import { z } from 'zod';
import { ApiError, MemoryWriteInput } from '@srh/shared';
import { parse } from '../../lib/http';
import { requireProject } from '../auth/guard';
import type { ModuleDef } from '../types';
import { deleteMemory, listMemory, readMemory, writeMemory } from './service';

/**
 * 项目记忆（乐观并发，API.md §2.6）
 * 归属：后端与 agent 引擎线程。
 *
 *   GET    /projects/:projectId/memory      清单（不含正文）
 *   GET    /projects/:projectId/memory/*    单个文件
 *   PUT    /projects/:projectId/memory      写入（MemoryWriteInput，带 baseVersion）
 *   DELETE /projects/:projectId/memory/*    删除（?baseVersion=）
 *
 * 人编辑记忆需要 manage（owner / advisor，ARCHITECTURE.md §9）；agent 经 service 直接写。
 */
type P = { projectId: string };
type PW = P & { '*': string };

const DeleteQuery = z.object({ baseVersion: z.coerce.number().int().min(0) });

export const memoryModule: ModuleDef = {
  name: 'memory',
  owner: 'backend',
  register(app) {
    const ctx = app.ctx;

    app.get<{ Params: P }>('/projects/:projectId/memory', async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      return listMemory(ctx, req.params.projectId);
    });

    app.get<{ Params: PW }>('/projects/:projectId/memory/*', async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      const file = await readMemory(ctx, req.params.projectId, req.params['*']);
      if (!file) throw new ApiError('not_found', '记忆文件不存在');
      return file;
    });

    app.put<{ Params: P }>('/projects/:projectId/memory', async (req) => {
      const { actor } = await requireProject(req, req.params.projectId, 'manage');
      const input = parse(MemoryWriteInput, req.body);
      return writeMemory(ctx, actor, req.params.projectId, input);
    });

    app.delete<{ Params: PW }>('/projects/:projectId/memory/*', async (req, reply) => {
      const { actor } = await requireProject(req, req.params.projectId, 'manage');
      const q = parse(DeleteQuery, req.query);
      await deleteMemory(ctx, actor, req.params.projectId, req.params['*'], q.baseVersion);
      return reply.status(204).send();
    });
  },
};
