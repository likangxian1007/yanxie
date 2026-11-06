import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ApiError,
  PageQuery,
  ResearchItemCreateInput,
  ResearchItemUpdateInput,
  ResearchItemPositionInput,
  ResearchRelationCreateInput,
  ResearchRelationUpdateInput,
  ResearchWorkspaceCreateInput,
} from '@srh/shared';
import { parse } from '../../lib/http';
import { requireProject } from '../collab-common';
import { getArtifact, listArtifacts, readArtifact } from './artifacts';
import { readResearchTable, researchTableCsv } from './tables';
import {
  archiveWorkspaceItem,
  createWorkspace,
  createWorkspaceItem,
  createWorkspaceRelation,
  findWorkspaceItem,
  getWorkspace,
  getWorkspaceItem,
  getWorkspaceItemContent,
  listWorkspaceItems,
  listWorkspaceRelations,
  updateWorkspaceItem,
  updateWorkspaceItemPosition,
  updateWorkspaceRelation,
} from './workspace';

type P = { projectId: string };
type R = P & { recordId: string };
type I = R & { itemId: string };
type L = R & { relationId: string };
const BaseVersionQuery = z.object({ baseVersion: z.coerce.number().int().positive() });
const ContentQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50000).default(20000),
});
const TableQuery = z.object({
  sheetId: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
function key(req: FastifyRequest, body: { idempotencyKey?: string }) {
  const header = req.headers['idempotency-key'];
  if (header && (typeof header !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/u.test(header)))
    throw new ApiError('validation_failed', '幂等键格式不正确');
  if (header && body.idempotencyKey && header !== body.idempotencyKey)
    throw new ApiError('validation_failed', '请求头和请求体的幂等键不一致');
  return (header as string | undefined) ?? body.idempotencyKey;
}
export function registerWorkspaceRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  app.get<{ Params: P & { artifactId: string } }>(
    '/projects/:projectId/research/artifacts/:artifactId',
    async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      return (await getArtifact(ctx, req.params.projectId, req.params.artifactId)).data;
    },
  );
  app.get<{ Params: P & { artifactId: string } }>(
    '/projects/:projectId/research/artifacts/:artifactId/download',
    async (req, reply) => {
      await requireProject(req, req.params.projectId, 'view');
      const { artifact, bytes } = await readArtifact(
        ctx,
        req.params.projectId,
        req.params.artifactId,
      );
      const inline =
        (req.query as { inline?: string }).inline === '1' &&
        artifact.kind === 'figure' &&
        ['image/svg+xml', 'image/png'].includes(artifact.mime);
      return reply
        .type(artifact.mime)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header(
          'Content-Disposition',
          `${inline ? 'inline' : 'attachment'}; filename="${artifact.id}"`,
        )
        .send(bytes);
    },
  );
  app.post<{ Params: P }>('/projects/:projectId/research/workspaces', async (req, reply) => {
    const { actor } = await requireProject(req, req.params.projectId, 'write');
    const input = parse(ResearchWorkspaceCreateInput, req.body ?? {});
    return reply.status(201).send(
      await createWorkspace(ctx, actor, req.params.projectId, {
        ...input,
        idempotencyKey: key(req, input),
      }),
    );
  });
  app.get<{ Params: P & { itemId: string } }>(
    '/projects/:projectId/research/items/:itemId',
    async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      return findWorkspaceItem(ctx, req.params.projectId, req.params.itemId);
    },
  );
  app.get<{ Params: R }>(
    '/projects/:projectId/research/records/:recordId/workspace',
    async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      return getWorkspace(
        ctx,
        req.params.projectId,
        req.params.recordId,
        parse(PageQuery, req.query),
      );
    },
  );
  app.get<{ Params: R }>('/projects/:projectId/research/records/:recordId/items', async (req) => {
    await requireProject(req, req.params.projectId, 'view');
    return listWorkspaceItems(
      ctx,
      req.params.projectId,
      req.params.recordId,
      parse(PageQuery, req.query),
    );
  });
  app.post<{ Params: R }>(
    '/projects/:projectId/research/records/:recordId/items',
    async (req, reply) => {
      const { actor } = await requireProject(req, req.params.projectId, 'write');
      const input = parse(ResearchItemCreateInput, req.body);
      return reply.status(201).send(
        await createWorkspaceItem(ctx, actor, req.params.projectId, req.params.recordId, {
          ...input,
          idempotencyKey: key(req, input),
        }),
      );
    },
  );
  app.get<{ Params: I }>(
    '/projects/:projectId/research/records/:recordId/items/:itemId',
    async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      return getWorkspaceItem(ctx, req.params.projectId, req.params.recordId, req.params.itemId);
    },
  );
  app.get<{ Params: I }>(
    '/projects/:projectId/research/records/:recordId/items/:itemId/content',
    async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      return getWorkspaceItemContent(
        ctx,
        req.params.projectId,
        req.params.recordId,
        req.params.itemId,
        parse(ContentQuery, req.query),
      );
    },
  );
  app.get<{ Params: I }>(
    '/projects/:projectId/research/records/:recordId/items/:itemId/table',
    async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      const item = await getWorkspaceItem(
        ctx,
        req.params.projectId,
        req.params.recordId,
        req.params.itemId,
      );
      return readResearchTable(ctx, req.params.projectId, item, parse(TableQuery, req.query));
    },
  );
  app.get<{ Params: I }>(
    '/projects/:projectId/research/records/:recordId/items/:itemId/table/export',
    async (req, reply) => {
      await requireProject(req, req.params.projectId, 'view');
      const item = await getWorkspaceItem(
        ctx,
        req.params.projectId,
        req.params.recordId,
        req.params.itemId,
      );
      const query = parse(z.object({ sheetId: z.string().min(1).optional() }), req.query);
      const table = await readResearchTable(ctx, req.params.projectId, item, query);
      return reply
        .type('text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="research-table.csv"')
        .send(researchTableCsv(table));
    },
  );
  app.get<{ Params: I }>(
    '/projects/:projectId/research/records/:recordId/items/:itemId/artifacts',
    async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      return listArtifacts(
        ctx,
        req.params.projectId,
        req.params.recordId,
        req.params.itemId,
        parse(PageQuery, req.query),
      );
    },
  );
  app.patch<{ Params: I }>(
    '/projects/:projectId/research/records/:recordId/items/:itemId',
    async (req) => {
      const { actor } = await requireProject(req, req.params.projectId, 'write');
      return updateWorkspaceItem(
        ctx,
        actor,
        req.params.projectId,
        req.params.recordId,
        req.params.itemId,
        parse(ResearchItemUpdateInput, req.body),
      );
    },
  );
  app.patch<{ Params: I }>(
    '/projects/:projectId/research/records/:recordId/items/:itemId/position',
    async (req) => {
      const { actor } = await requireProject(req, req.params.projectId, 'write');
      return updateWorkspaceItemPosition(
        ctx,
        actor,
        req.params.projectId,
        req.params.recordId,
        req.params.itemId,
        parse(ResearchItemPositionInput, req.body),
      );
    },
  );
  app.delete<{ Params: I }>(
    '/projects/:projectId/research/records/:recordId/items/:itemId',
    async (req, reply) => {
      const { actor } = await requireProject(req, req.params.projectId, 'write');
      const { baseVersion } = parse(BaseVersionQuery, req.query);
      await archiveWorkspaceItem(
        ctx,
        actor,
        req.params.projectId,
        req.params.recordId,
        req.params.itemId,
        baseVersion,
      );
      return reply.status(204).send();
    },
  );
  app.get<{ Params: R }>(
    '/projects/:projectId/research/records/:recordId/relations',
    async (req) => {
      await requireProject(req, req.params.projectId, 'view');
      return listWorkspaceRelations(
        ctx,
        req.params.projectId,
        req.params.recordId,
        parse(PageQuery, req.query),
      );
    },
  );
  app.post<{ Params: R }>(
    '/projects/:projectId/research/records/:recordId/relations',
    async (req, reply) => {
      const { actor } = await requireProject(req, req.params.projectId, 'write');
      const input = parse(ResearchRelationCreateInput, req.body);
      return reply.status(201).send(
        await createWorkspaceRelation(ctx, actor, req.params.projectId, req.params.recordId, {
          ...input,
          idempotencyKey: key(req, input),
        }),
      );
    },
  );
  app.patch<{ Params: L }>(
    '/projects/:projectId/research/records/:recordId/relations/:relationId',
    async (req) => {
      const { actor } = await requireProject(req, req.params.projectId, 'write');
      return updateWorkspaceRelation(
        ctx,
        actor,
        req.params.projectId,
        req.params.recordId,
        req.params.relationId,
        parse(ResearchRelationUpdateInput, req.body),
      );
    },
  );
  app.delete<{ Params: L }>(
    '/projects/:projectId/research/records/:recordId/relations/:relationId',
    async (req, reply) => {
      const { actor } = await requireProject(req, req.params.projectId, 'write');
      const { baseVersion } = parse(BaseVersionQuery, req.query);
      await updateWorkspaceRelation(
        ctx,
        actor,
        req.params.projectId,
        req.params.recordId,
        req.params.relationId,
        { baseVersion, label: '' },
        true,
      );
      return reply.status(204).send();
    },
  );
}
