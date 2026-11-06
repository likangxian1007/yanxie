import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import {
  ApiError,
  PaperNoteCreateInput,
  PaperNoteRenameInput,
  PaperNoteCopyInput,
} from '@srh/shared';
import { requirePersonalLibraryUser, requirePaperRecord } from './access';
import { parse } from '../../lib/http';
import { paperNotes } from '../../db/schema';
import { requireUser, userActor } from '../auth/guard';
import { getPaperRow } from './service';
import type { LibraryScopeInput } from './scope';
import {
  createNote,
  flushNote,
  getNote,
  listNotes,
  notifyNote,
  registerNoteStorage,
  removeNote,
  toNote,
} from './notes';

type Params = { projectId: string; paperId: string; noteId: string };
export function registerNoteRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  registerNoteStorage(ctx);
  for (const personal of [true, false]) {
    const base = `${personal ? '/library' : '/projects/:projectId/library'}/papers/:paperId/notes`;
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
    app.get<{ Params: Params }>(base, async (req, reply) => {
      const { scope } = await authorize(req);
      reply.header('Cache-Control', 'private, no-store');
      return listNotes(ctx, scope, req.params.paperId);
    });
    app.post<{ Params: Params }>(base, async (req, reply) => {
      const { scope, actor } = await authorize(req);
      const result = await createNote(
        ctx,
        scope,
        req.params.paperId,
        actor,
        parse(PaperNoteCreateInput, req.body),
      );
      return reply.code(201).send(result);
    });
    app.post<{ Params: Params }>(`${base}/:noteId/flush`, async (req, reply) => {
      const { scope, actor } = await authorize(req);
      reply.header('Cache-Control', 'private, no-store');
      return flushNote(ctx, scope, req.params.paperId, req.params.noteId, actor);
    });
    app.patch<{ Params: Params }>(`${base}/:noteId`, async (req) => {
      const { scope, actor } = await authorize(req);
      const input = parse(PaperNoteRenameInput, req.body);
      const { paperId, noteId } = req.params;
      const paper = await getPaperRow(ctx, scope, paperId);
      if (paper.archivedAt) throw new ApiError('conflict', '请先恢复已归档论文');
      await getNote(ctx, scope, paperId, noteId);
      const [row] = await ctx.db.db
        .update(paperNotes)
        .set({
          title: input.title,
          version: input.baseVersion + 1,
          updatedAt: new Date(),
          updatedBy: actor,
        })
        .where(
          and(
            eq(paperNotes.id, noteId),
            eq(paperNotes.version, input.baseVersion),
            isNull(paperNotes.deletedAt),
          ),
        )
        .returning();
      if (!row) throw new ApiError('version_conflict', '笔记已更新，请刷新后重新命名');
      await notifyNote(ctx, paperId, noteId, actor);
      return toNote(row);
    });
    app.delete<{ Params: Params }>(`${base}/:noteId`, async (req, reply) => {
      const { scope, actor } = await authorize(req);
      await removeNote(ctx, scope, req.params.paperId, req.params.noteId, actor);
      return reply.code(204).send();
    });
    if (personal)
      app.post<{ Params: Params }>(`${base}/:noteId/brief`, async (req, reply) => {
        const { scope, actor } = await authorize(req);
        const input = parse(PaperNoteCopyInput, req.body);
        const source = await flushNote(ctx, scope, req.params.paperId, req.params.noteId, actor);
        if (source.version !== input.sourceVersion)
          throw new ApiError('version_conflict', '笔记已更新，请重新读取后复制');
        const result = await createNote(ctx, scope, req.params.paperId, actor, {
          title: input.title,
          kind: 'brief',
          body: source.body,
        });
        return reply.code(201).send(result);
      });
  }
}
