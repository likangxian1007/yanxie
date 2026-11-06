import { z } from 'zod';
import {
  BoardCreateInput,
  BoardUpdateInput,
  CardCreateInput,
  CardUpdateInput,
  ColumnUpsertInput,
} from '@srh/shared';
import { registerCollabPort } from '../../agents/tools/collab-port';
import { parse } from '../../lib/http';
import { requireProject, roleCan, type Params } from '../collab-common';
import type { ModuleDef } from '../types';
import {
  createBoard,
  createCard,
  createCardAuto,
  createColumn,
  deleteBoard,
  deleteCard,
  deleteColumn,
  ensureDefaultBoard,
  getBoard,
  listBoards,
  updateBoard,
  updateCard,
  updateColumn,
} from './service';

/**
 * 科研看板：看板、列、卡片
 * 归属：协作功能线程。端点契约见 API.md §2.8，请求体 schema 见 @srh/shared api-collab.ts。
 * 业务逻辑在 service.ts（路由与 agent 工具共用）。
 *
 * 端点（均挂在 /api/v1 下）：
 *   GET    /projects/:projectId/boards                 → Board[]（没有看板时自动建默认看板；访客不建，返回 []）
 *   POST   /projects/:projectId/boards                 → 201 Board
 *   GET    /projects/:projectId/boards/:boardId        → Board & { cards }
 *   PATCH  /projects/:projectId/boards/:boardId        → Board
 *   DELETE /projects/:projectId/boards/:boardId        → 204（最后一个看板 409）
 *   POST   /projects/:projectId/boards/:boardId/columns → 201 BoardColumn
 *   PATCH  /projects/:projectId/columns/:columnId      → BoardColumn
 *   DELETE /projects/:projectId/columns/:columnId?moveTo= → 204（非空列需 moveTo，否则 409）
 *   POST   /projects/:projectId/boards/:boardId/cards  → 201 Card
 *   PATCH  /projects/:projectId/cards/:cardId          → Card（baseVersion 乐观并发）
 *   DELETE /projects/:projectId/cards/:cardId          → 204
 */
const ColumnDeleteQuery = z.object({ moveTo: z.string().min(1).optional() });

export const boardsModule: ModuleDef = {
  name: 'boards',
  owner: 'collab',
  register(app) {
    registerCollabPort({
      boards: {
        createCard: createCardAuto,
        updateCard,
        ensureDefaultBoard,
      },
    });

    const P = '/projects/:projectId';

    app.get<{ Params: Params<'projectId'> }>(`${P}/boards`, async (req) => {
      const { projectId } = req.params;
      const { actor, role } = await requireProject(req, projectId, 'view');
      // 访客只读：不替他们建默认看板，没有就是空列表
      return listBoards(app.ctx, actor, projectId, { createDefault: roleCan(role, 'write') });
    });

    app.post<{ Params: Params<'projectId'> }>(`${P}/boards`, async (req, reply) => {
      const { projectId } = req.params;
      const { actor } = await requireProject(req, projectId, 'write');
      const board = await createBoard(app.ctx, actor, projectId, parse(BoardCreateInput, req.body));
      return reply.status(201).send(board);
    });

    app.get<{ Params: Params<'projectId' | 'boardId'> }>(`${P}/boards/:boardId`, async (req) => {
      const { projectId, boardId } = req.params;
      await requireProject(req, projectId, 'view');
      return getBoard(app.ctx, projectId, boardId);
    });

    app.patch<{ Params: Params<'projectId' | 'boardId'> }>(`${P}/boards/:boardId`, async (req) => {
      const { projectId, boardId } = req.params;
      const { actor } = await requireProject(req, projectId, 'write');
      return updateBoard(app.ctx, actor, projectId, boardId, parse(BoardUpdateInput, req.body));
    });

    app.delete<{ Params: Params<'projectId' | 'boardId'> }>(
      `${P}/boards/:boardId`,
      async (req, reply) => {
        const { projectId, boardId } = req.params;
        const { actor } = await requireProject(req, projectId, 'write');
        await deleteBoard(app.ctx, actor, projectId, boardId);
        return reply.status(204).send();
      },
    );

    app.post<{ Params: Params<'projectId' | 'boardId'> }>(
      `${P}/boards/:boardId/columns`,
      async (req, reply) => {
        const { projectId, boardId } = req.params;
        const { actor } = await requireProject(req, projectId, 'write');
        const column = await createColumn(
          app.ctx,
          actor,
          projectId,
          boardId,
          parse(ColumnUpsertInput, req.body),
        );
        return reply.status(201).send(column);
      },
    );

    app.patch<{ Params: Params<'projectId' | 'columnId'> }>(
      `${P}/columns/:columnId`,
      async (req) => {
        const { projectId, columnId } = req.params;
        const { actor } = await requireProject(req, projectId, 'write');
        return updateColumn(
          app.ctx,
          actor,
          projectId,
          columnId,
          parse(ColumnUpsertInput.partial(), req.body),
        );
      },
    );

    app.delete<{ Params: Params<'projectId' | 'columnId'> }>(
      `${P}/columns/:columnId`,
      async (req, reply) => {
        const { projectId, columnId } = req.params;
        const { actor } = await requireProject(req, projectId, 'write');
        const { moveTo } = parse(ColumnDeleteQuery, req.query);
        await deleteColumn(app.ctx, actor, projectId, columnId, moveTo);
        return reply.status(204).send();
      },
    );

    app.post<{ Params: Params<'projectId' | 'boardId'> }>(
      `${P}/boards/:boardId/cards`,
      async (req, reply) => {
        const { projectId, boardId } = req.params;
        const { actor } = await requireProject(req, projectId, 'write');
        const card = await createCard(
          app.ctx,
          actor,
          projectId,
          boardId,
          parse(CardCreateInput, req.body),
        );
        return reply.status(201).send(card);
      },
    );

    app.patch<{ Params: Params<'projectId' | 'cardId'> }>(`${P}/cards/:cardId`, async (req) => {
      const { projectId, cardId } = req.params;
      const { actor } = await requireProject(req, projectId, 'write');
      return updateCard(app.ctx, actor, projectId, cardId, parse(CardUpdateInput, req.body));
    });

    app.delete<{ Params: Params<'projectId' | 'cardId'> }>(
      `${P}/cards/:cardId`,
      async (req, reply) => {
        const { projectId, cardId } = req.params;
        const { actor } = await requireProject(req, projectId, 'write');
        await deleteCard(app.ctx, actor, projectId, cardId);
        return reply.status(204).send();
      },
    );
  },
};
