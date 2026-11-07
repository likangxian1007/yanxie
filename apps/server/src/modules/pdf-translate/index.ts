import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import type { FastifyRequest } from 'fastify';
import { ApiError, PdfTranslateInput, type PdfTranslateJob } from '@srh/shared';
import { parse } from '../../lib/http';
import { requireProject, requireUser, userActor } from '../auth/guard';
import { requirePersonalLibraryUser, requirePaperRecord } from '../library/access';
import type { LibraryScopeInput } from '../library/scope';
import { getPaperRow, privateAbs } from '../library/service';
import { getLibraryFile, libraryDiskPath } from '../library/storage';
import type { ModuleDef } from '../types';
import {
  getPdfTranslate,
  pdfTranslateEnabled,
  pdfTranslateFile,
  startPdfTranslate,
} from './service';

/**
 * 整篇 PDF 保版式翻译（ARCHITECTURE.md §7.8，API.md）。个人文献库与项目文献库各一套：
 *
 *   POST P/library/papers/:paperId/pdf-translate             {pages?, mode?, localOnly?}
 *   GET  P/library/papers/:paperId/pdf-translate             任务状态（进度、本地 / 云端、是否回退）
 *   GET  P/library/papers/:paperId/pdf-translate/file?kind=mono|dual
 *
 * PDF_TRANSLATE_URL 为空时所有路由都是 404。
 */
type Params = { projectId: string; paperId: string };

export const pdfTranslateModule: ModuleDef = {
  name: 'pdf-translate',
  owner: 'backend',
  register(app) {
    const ctx = app.ctx;
    for (const personal of [true, false]) {
      const base = `${personal ? '/library' : '/projects/:projectId/library'}/papers/:paperId/pdf-translate`;
      const authorize = async (req: FastifyRequest<{ Params: Params }>, write: boolean) => {
        if (!pdfTranslateEnabled(ctx.config))
          throw new ApiError('not_found', 'PDF 翻译服务没有配置');
        const user = personal ? await requirePersonalLibraryUser(req) : await requireUser(req);
        if (!personal) {
          await requirePaperRecord(req, req.params.projectId, req.params.paperId, false);
          // 与问答、划词翻译一致：项目访客不能发起消耗模型额度的请求
          if (write) await requireProject(req, req.params.projectId, 'write');
        }
        const scope = (
          personal ? { kind: 'personal', ownerUserId: user.id } : req.params.projectId
        ) as LibraryScopeInput;
        return { actor: userActor(user), scope };
      };
      const paperKey = (req: FastifyRequest<{ Params: Params }>) => req.params.paperId;

      app.post<{ Params: Params }>(base, async (req): Promise<PdfTranslateJob> => {
        const { scope } = await authorize(req, true);
        const input = parse(PdfTranslateInput, req.body ?? {});
        const row = await getPaperRow(ctx, scope, req.params.paperId);
        const file = row.fileId ? await getLibraryFile(ctx, scope, row.fileId) : null;
        if (!file && !row.privatePdfPath) throw new ApiError('not_found', '这篇论文还没有 PDF');
        const abs = row.privatePdfPath
          ? privateAbs(ctx, row.privatePdfPath)
          : libraryDiskPath(ctx, scope, file!.path);
        try {
          await access(abs);
        } catch {
          throw new ApiError('not_found', 'PDF 文件已丢失');
        }
        return startPdfTranslate(ctx.config, paperKey(req), abs, input);
      });

      app.get<{ Params: Params }>(base, async (req, reply): Promise<PdfTranslateJob> => {
        const { scope } = await authorize(req, false);
        await getPaperRow(ctx, scope, req.params.paperId);
        reply.header('Cache-Control', 'private, no-store');
        return getPdfTranslate(ctx.config, paperKey(req));
      });

      app.get<{ Params: Params; Querystring: { kind?: string; download?: string } }>(
        `${base}/file`,
        async (req, reply) => {
          const { scope } = await authorize(req, false);
          const kind =
            req.query.kind === 'dual' ? 'dual' : req.query.kind === 'mono' ? 'mono' : null;
          if (!kind) throw new ApiError('bad_request', 'kind 只能是 mono 或 dual');
          const row = await getPaperRow(ctx, scope, req.params.paperId);
          const path = await pdfTranslateFile(ctx.config, paperKey(req), kind);
          const ascii = `${row.citekey}.zh.${kind}.pdf`
            .replace(/[^\x20-\x7e]/gu, '_')
            .replace(/"/gu, '_');
          return reply
            .header('Content-Type', 'application/pdf')
            .header(
              'Content-Disposition',
              `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${ascii}"`,
            )
            .header('X-Content-Type-Options', 'nosniff')
            .header('Cache-Control', 'private, no-store')
            .send(createReadStream(path));
        },
      );
    }
  },
};
