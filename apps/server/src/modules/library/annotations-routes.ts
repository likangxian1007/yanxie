import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PaperAnnotationCreateInput,
  PaperAnnotationUpdateInput,
  PaperAnnotationVersionInput,
  PaperAnnotationBriefInput,
} from '@srh/shared';
import { requirePersonalLibraryUser, requirePaperRecord } from './access';
import { parse } from '../../lib/http';
import { requireUser, userActor } from '../auth/guard';
import type { LibraryScopeInput } from './scope';
import {
  createAnnotation,
  annotationBrief,
  flushAnnotation,
  listAnnotations,
  registerAnnotationStorage,
  removeAnnotation,
  restoreAnnotation,
  updateAnnotation,
} from './annotations';

type Params = { projectId: string; paperId: string; annotationId: string };
export function registerAnnotationRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  registerAnnotationStorage(ctx);
  for (const personal of [true, false]) {
    const base = `${personal ? '/library' : '/projects/:projectId/library'}/papers/:paperId/annotations`;
    const authorize = async (req: FastifyRequest<{ Params: Params }>) => {
      const user = personal ? await requirePersonalLibraryUser(req) : await requireUser(req);
      if (!personal)
        await requirePaperRecord(
          req,
          req.params.projectId,
          req.params.paperId,
          req.method !== 'GET',
        );
      return {
        actor: userActor(user),
        scope: (personal
          ? { kind: 'personal', ownerUserId: user.id }
          : req.params.projectId) as LibraryScopeInput,
      };
    };
    if (personal)
      app.post<{ Params: Params }>(`${base}/:annotationId/brief`, async (req, reply) => {
        const { actor } = await authorize(req);
        const input = parse(PaperAnnotationBriefInput, req.body);
        return reply
          .code(201)
          .send(
            await annotationBrief(
              ctx,
              actor.id!,
              req.params.paperId,
              req.params.annotationId,
              actor,
              input,
            ),
          );
      });
    app.get<{ Params: Params }>(base, async (req, reply) => {
      const { scope } = await authorize(req);
      const query = parse(
        z.object({ includeDeleted: z.enum(['true', 'false']).optional() }).strict(),
        req.query,
      );
      reply.header('Cache-Control', 'private, no-store');
      return listAnnotations(ctx, scope, req.params.paperId, query.includeDeleted === 'true');
    });
    app.post<{ Params: Params }>(base, async (req, reply) => {
      const { scope, actor } = await authorize(req);
      return reply
        .code(201)
        .send(
          await createAnnotation(
            ctx,
            scope,
            req.params.paperId,
            actor,
            parse(PaperAnnotationCreateInput, req.body),
          ),
        );
    });
    app.patch<{ Params: Params }>(`${base}/:annotationId`, async (req) => {
      const { scope, actor } = await authorize(req);
      return updateAnnotation(
        ctx,
        scope,
        req.params.paperId,
        req.params.annotationId,
        actor,
        parse(PaperAnnotationUpdateInput, req.body),
      );
    });
    app.post<{ Params: Params }>(`${base}/:annotationId/flush`, async (req, reply) => {
      const { scope, actor } = await authorize(req);
      reply.header('Cache-Control', 'private, no-store');
      return flushAnnotation(ctx, scope, req.params.paperId, req.params.annotationId, actor);
    });
    app.post<{ Params: Params }>(`${base}/:annotationId/trash`, async (req, reply) => {
      const { scope, actor } = await authorize(req);
      const input = parse(PaperAnnotationVersionInput, req.body);
      await removeAnnotation(
        ctx,
        scope,
        req.params.paperId,
        req.params.annotationId,
        actor,
        input.baseVersion,
      );
      return reply.code(204).send();
    });
    app.post<{ Params: Params }>(`${base}/:annotationId/restore`, async (req) => {
      const { scope, actor } = await authorize(req);
      const input = parse(PaperAnnotationVersionInput, req.body);
      return restoreAnnotation(
        ctx,
        scope,
        req.params.paperId,
        req.params.annotationId,
        actor,
        input.baseVersion,
      );
    });
  }
}
