import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ApiError,
  PaperQaAskInput,
  PaperQaSessionCreateInput,
  PaperQaSessionUpdateInput,
  PaperQaPublishPreviewInput,
  PaperQaBriefInput,
} from '@srh/shared';
import { requirePersonalLibraryUser, requirePaperRecord } from './access';
import { parse } from '../../lib/http';
import { requireUser, requireProject, userActor } from '../auth/guard';
import {
  registerQaStorage,
  listQaSessions,
  createQaSession,
  renameQaSession,
  removeQaSession,
  listQaTurns,
  flushQaTurn,
  qaRevisions,
} from './qa-records';
import { askQa, stopQa, abortQaTurns, recoverQaJobs, stopQaJobs, revokeQaUser } from './qa-jobs';
import { previewQa } from './qa-publication';
import { createNote } from './notes';
import type { LibraryScopeInput } from './scope';
type Params = { projectId: string; paperId: string; sessionId: string; turnId: string };
export function registerQaRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  registerQaStorage(ctx);
  const off = ctx.bus.onEvent((e) => {
    if (e.type === 'member.removed') revokeQaUser(ctx, e.projectId, e.payload.userId);
    else if (e.type === 'member.updated') revokeQaUser(ctx, e.projectId, e.payload.user.id);
  });
  app.addHook('onClose', async () => {
    off();
  });
  app.addHook('onReady', () => recoverQaJobs(ctx));
  app.addHook('onClose', () => stopQaJobs(ctx));
  app.post<{ Params: Params }>(
    '/library/papers/:paperId/qa/publication-preview',
    async (req, reply) => {
      const user = await requirePersonalLibraryUser(req),
        input = parse(PaperQaPublishPreviewInput, req.body);
      await requireProject(req, input.projectId, 'write');
      reply.header('Cache-Control', 'private, no-store');
      return previewQa(
        ctx,
        { ...userActor(user), id: user.id },
        req.params.paperId,
        input.selections,
        input.projectId,
        input.targetPaperId,
      );
    },
  );
  for (const personal of [true, false]) {
    const base = `${personal ? '/library' : '/projects/:projectId/library'}/papers/:paperId/qa`;
    const auth = async (req: FastifyRequest<{ Params: Params }>) => {
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
    app.get<{ Params: Params }>(`${base}/sessions`, async (req, reply) => {
      const { scope } = await auth(req);
      reply.header('Cache-Control', 'private, no-store');
      return listQaSessions(ctx, scope, req.params.paperId);
    });
    app.post<{ Params: Params }>(`${base}/sessions`, async (req, reply) => {
      const { scope, actor } = await auth(req);
      const input = parse(PaperQaSessionCreateInput, req.body);
      return reply
        .code(201)
        .send(await createQaSession(ctx, scope, req.params.paperId, actor, input.title));
    });
    app.patch<{ Params: Params }>(`${base}/sessions/:sessionId`, async (req) => {
      const { scope, actor } = await auth(req);
      const input = parse(PaperQaSessionUpdateInput, req.body);
      return renameQaSession(
        ctx,
        scope,
        req.params.paperId,
        req.params.sessionId,
        actor,
        input.title,
        input.baseVersion,
      );
    });
    app.post<{ Params: Params }>(`${base}/sessions/:sessionId/trash`, async (req, reply) => {
      const { scope, actor } = await auth(req);
      const input = parse(
        z.object({ baseVersion: z.number().int().positive() }).strict(),
        req.body,
      );
      abortQaTurns(
        ctx,
        await removeQaSession(
          ctx,
          scope,
          req.params.paperId,
          req.params.sessionId,
          actor,
          input.baseVersion,
        ),
      );
      return reply.code(204).send();
    });
    app.get<{ Params: Params }>(`${base}/sessions/:sessionId/turns`, async (req, reply) => {
      const { scope } = await auth(req);
      reply.header('Cache-Control', 'private, no-store');
      return listQaTurns(ctx, scope, req.params.paperId, req.params.sessionId);
    });
    app.post<{ Params: Params }>(`${base}/sessions/:sessionId/turns`, async (req, reply) => {
      const { scope, actor } = await auth(req);
      return reply
        .code(202)
        .send(
          await askQa(
            ctx,
            scope,
            req.params.paperId,
            req.params.sessionId,
            actor,
            parse(PaperQaAskInput, req.body),
          ),
        );
    });
    app.post<{ Params: Params }>(`${base}/turns/:turnId/stop`, async (req) => {
      const { scope, actor } = await auth(req);
      return stopQa(ctx, scope, req.params.paperId, req.params.turnId, actor);
    });
    app.post<{ Params: Params }>(`${base}/turns/:turnId/flush`, async (req) => {
      const { scope, actor } = await auth(req);
      return flushQaTurn(ctx, scope, req.params.paperId, req.params.turnId, actor);
    });
    app.get<{ Params: Params }>(`${base}/turns/:turnId/revisions`, async (req, reply) => {
      const { scope } = await auth(req);
      const input = parse(
        z.object({ before: z.coerce.number().int().positive().optional() }).strict(),
        req.query,
      );
      reply.header('Cache-Control', 'private, no-store');
      return qaRevisions(ctx, scope, req.params.paperId, req.params.turnId, input.before);
    });
    if (personal)
      app.post<{ Params: Params }>(`${base}/turns/:turnId/brief`, async (req, reply) => {
        const { scope, actor } = await auth(req),
          input = parse(PaperQaBriefInput, req.body);
        const turn = await flushQaTurn(ctx, scope, req.params.paperId, req.params.turnId, actor);
        if (turn.status !== 'done' || turn.version !== input.sourceVersion)
          throw new ApiError('version_conflict', '问答已变化，请刷新后重新制作说明稿');
        const body = `# ${input.title}\n\n## 问题\n${turn.question}\n\n${turn.selection ? `## 提问时引用的原文\n第 ${turn.selection.page} 页（${turn.selection.status === 'available' ? '当前 PDF' : '来源待复核'}）：${turn.selection.text}\n\n` : ''}## 结论（请整理成独立说明）\n${turn.answer}\n\n## 来源记录\n问答版本：v${turn.version}；提出者：${turn.createdBy.name}；时间：${turn.createdAt}\n\n${turn.sources.map((s) => `- ${s.paperTitle}，p.${s.page} ¶${s.para}`).join('\n')}`;
        if (body.length > 100000)
          throw new ApiError('validation_failed', '问答与来源合计过长，请精简正文后再制作说明稿');
        return reply.code(201).send(
          await createNote(ctx, scope, req.params.paperId, actor, {
            title: input.title,
            kind: 'brief',
            body,
          }),
        );
      });
  }
}
