import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, LatexCompileInput } from '@srh/shared';
import type { AppContext } from '../../../context';
import { parse } from '../../../lib/http';
import { requireProject, type Params } from '../../collab-common';
import { requireResource } from '../../sharing/service';
import { getRow, withDocumentSnapshot } from '../service';
import { compileLatex, getCompiledPdf, latexCapability } from './service';

/**
 * LaTeX 编译端点（API.md §2.7.5）：
 *
 *   GET  P/docs/latex/capability             → LatexCapability（编译是否可用、引擎、限制）
 *   POST P/docs/:docId/latex/compile         → LatexCompileResult（LatexCompileInput）
 *   GET  P/docs/:docId/latex/pdf/:pdfId      → application/pdf（?download=1 作为附件）
 *
 * 编译只读文档，不改内容，所以能看到文档（含访客、只读分享）即可。
 */
const P = '/projects/:projectId';

const PdfQuery = z.object({ download: z.enum(['1', '0', 'true', 'false']).optional() });

function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_') || 'paper.pdf';
  const encoded = encodeURIComponent(name).replace(
    /['()*]/gu,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function registerLatexRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: Params<'projectId'> }>(`${P}/docs/latex/capability`, async (req) => {
    await requireProject(req, req.params.projectId, 'view');
    return latexCapability(ctx);
  });

  app.post<{ Params: Params<'projectId' | 'docId'> }>(
    `${P}/docs/:docId/latex/compile`,
    async (req) => {
      const { projectId, docId } = req.params;
      await requireResource(req, projectId, 'document', docId, 'view');
      const input = parse(LatexCompileInput, req.body ?? {});
      const row = await getRow(ctx, projectId, docId);
      if (row.kind !== 'latex') throw new ApiError('bad_request', '只有 LaTeX 文档可以编译');
      return withDocumentSnapshot(ctx, row, (doc) =>
        compileLatex(ctx, projectId, docId, doc, input),
      );
    },
  );

  app.get<{ Params: Params<'projectId' | 'docId' | 'pdfId'> }>(
    `${P}/docs/:docId/latex/pdf/:pdfId`,
    async (req, reply) => {
      const { projectId, docId, pdfId } = req.params;
      await requireResource(req, projectId, 'document', docId, 'view');
      const q = parse(PdfQuery, req.query);
      const row = await getRow(ctx, projectId, docId);
      const pdf = getCompiledPdf(ctx, docId, pdfId);
      if (!pdf) throw new ApiError('not_found', 'PDF 已过期，请重新编译');
      const download = q.download === '1' || q.download === 'true';
      const name = `${(row.title || '未命名论文').replace(/[\\/:*?"<>|]+/gu, '_').slice(0, 80)}.pdf`;
      return (
        reply
          .header('Content-Type', 'application/pdf')
          .header(
            'Content-Disposition',
            contentDisposition(download ? 'attachment' : 'inline', name),
          )
          .header('X-Content-Type-Options', 'nosniff')
          // 个人文档的分享随时可能收回：不进浏览器缓存
          .header(
            'Cache-Control',
            row.space === 'personal' ? 'private, no-store' : 'private, max-age=3600, immutable',
          )
          .send(pdf)
      );
    },
  );
}
