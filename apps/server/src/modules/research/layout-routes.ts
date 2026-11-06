import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError, ResearchLayoutUpdateInput } from '@srh/shared';
import { parse } from '../../lib/http';
import { requireProject } from '../collab-common';
import { updateResearchLayout } from './layout';

function requestKey(req: FastifyRequest, body: { idempotencyKey: string }) {
  const header = req.headers['idempotency-key'];
  if (header && (typeof header !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/u.test(header)))
    throw new ApiError('validation_failed', '幂等键格式不正确');
  if (header && body.idempotencyKey && header !== body.idempotencyKey)
    throw new ApiError('validation_failed', '请求头和请求体的幂等键不一致');
  return (header as string | undefined) ?? body.idempotencyKey;
}

export function registerResearchLayoutRoutes(app: FastifyInstance) {
  app.patch<{ Params: { projectId: string; recordId: string } }>(
    '/projects/:projectId/research/records/:recordId/layout',
    async (req) => {
      const { projectId, recordId } = req.params;
      const { actor } = await requireProject(req, projectId, 'write');
      const body = req.body;
      const header = req.headers['idempotency-key'];
      const input = parse(
        ResearchLayoutUpdateInput,
        body && typeof body === 'object' && !Array.isArray(body)
          ? {
              ...body,
              idempotencyKey: (body as { idempotencyKey?: unknown }).idempotencyKey ?? header,
            }
          : body,
      );
      return updateResearchLayout(app.ctx, actor, projectId, recordId, {
        ...input,
        idempotencyKey: requestKey(req, input),
      });
    },
  );
}
