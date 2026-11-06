import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import {
  ApiError,
  LibraryBibtexInput,
  LibraryCiteToDocInput,
  LibraryQaInput,
  LibrarySearchQuery,
  LibraryTranslationInput,
  PaperImportInput,
  PaperListQuery,
  PaperUpdateWithVersionsInput,
  PaperPublishInput,
  MoveSpaceInput,
  ResourceSpace,
  PAPER_PDF_MAX_BYTES,
  type LibraryQaFrame,
  type LibraryStatus,
  type PaperImportResult,
  type Paper,
} from '@srh/shared';
import { requirePersonalLibraryUser, requirePaperRecord } from './access';
import { requireResource } from '../sharing/service';
import type { Viewer } from '../sharing/access';
import { parse } from '../../lib/http';
import { requireProject, userActor, type Capability } from '../auth/guard';
import type { LibraryScopeInput } from './scope';
import { libraryLlmAvailable } from './llm';
import { libraryDiskPath, getLibraryFile } from './storage';
import type { ModuleDef } from '../types';
import { citeToDocument } from './cite-doc';
import { libraryDeps } from './pipeline';
import { enqueuePaper, queueStats, resumePending, stopQueue } from './queue';
import { retrieveForQuestion, streamAnswer } from './qa';
import { searchLibrary } from './search';
import { translateSelection, translationModels } from './translation';
import { publishPaper } from './publication';
import { listPublicationTargets } from './publication-targets';
import { registerNoteRoutes } from './notes-routes';
import { registerAnnotationRoutes } from './annotations-routes';
import { registerQaRoutes } from './qa-routes';
import {
  annotatePapers,
  visiblePaperIds,
  privateAbs,
  movePaperSpace,
  attachPdf,
  bibOf,
  deletePaper,
  getPaperDetail,
  getPaperRow,
  importByRef,
  importUpload,
  listByIds,
  listPapers,
  resetForReparse,
  toPaper,
  updatePaper,
} from './service';

/**
 * 文献库（API.md §2.15）。归属：文献库线程。
 *
 *   GET    P/library/status                    解析服务状态、队列
 *   GET    P/library/papers                    ?q=&tag=&status=&archived=
 *   POST   P/library/papers                    multipart file=PDF（可带 tags=a,b）| JSON {doi}|{arxiv}|{url}
 *   GET    P/library/papers/:paperId           元数据 + 结构（章节、段落、公式、图表、参考文献）
 *   PATCH  P/library/papers/:paperId           {title?, tags?, note?, archived?}
 *   DELETE P/library/papers/:paperId
 *   GET    P/library/papers/:paperId/pdf       PDF 流（鉴权）
 *   POST   P/library/papers/:paperId/pdf       multipart 补传 PDF（needs_pdf）
 *   POST   P/library/papers/:paperId/reparse
 *   GET    P/library/papers/:paperId/bibtex    text/x-bibtex
 *   POST   P/library/bibtex                    {paperIds?} → 选中的 / 全部
 *   GET    P/library/search                    ?q=&paperId=&limit=
 *   POST   P/library/qa                        {question, paperId?, history?} → NDJSON 流
 *   POST   P/library/cite                      {docId, paperIds, bibFile?} → 写 .bib，返回 \cite{…}
 */
type P = { projectId: string };
type PP = P & { paperId: string };

const MAX_UPLOAD = PAPER_PDF_MAX_BYTES;

const parseTags = (v: unknown): string[] | undefined =>
  typeof v === 'string' && v.trim()
    ? v
        .split(/[,，]/u)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 20)
    : undefined;

export const libraryModule: ModuleDef = {
  name: 'library',
  owner: 'library',
  async register(app) {
    const ctx = app.ctx;
    registerNoteRoutes(app);
    registerAnnotationRoutes(app);
    registerQaRoutes(app);

    app.addHook('onReady', async () => {
      if (ctx.config.NODE_ENV !== 'test') void resumePending(ctx);
    });
    app.addHook('onClose', async () => stopQueue(ctx));

    await app.register(async (api) => {
      await api.register(multipart, {
        limits: { fileSize: MAX_UPLOAD, files: 1, fields: 5, fieldSize: 2000 },
      });

      /** 读 multipart：file 字段 + 可选 tags */
      const readUpload = async (req: FastifyRequest) => {
        if (!req.isMultipart()) return null;
        let upload: { data: Buffer; filename: string } | null = null;
        let tags: string[] | undefined;
        let space: ResourceSpace | undefined;
        try {
          for await (const part of req.parts()) {
            if (part.type === 'file') {
              const data = await part.toBuffer();
              if (part.fieldname === 'file' && !upload) {
                upload = { data, filename: part.filename || 'paper.pdf' };
              }
            } else if (part.fieldname === 'tags') {
              tags = parseTags(part.value);
            } else if (part.fieldname === 'space') {
              const parsed = ResourceSpace.safeParse(part.value);
              if (parsed.success) space = parsed.data;
            }
          }
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === 'FST_REQ_FILE_TOO_LARGE') {
            throw new ApiError('bad_request', 'PDF 不能超过 100 MB');
          }
          if (code?.startsWith('FST_')) throw new ApiError('bad_request', '上传内容无法解析');
          throw err;
        }
        if (!upload) throw new ApiError('bad_request', '缺少 file 字段');
        return { ...upload, tags, space };
      };

      api.get<{ Params: { paperId: string } }>(
        '/library/papers/:paperId/publish-targets',
        async (req, reply) => {
          const user = await requirePersonalLibraryUser(req);
          const input = parse(
            z.object({ projectId: z.string().min(1).max(100) }).strict(),
            req.query,
          );
          await requireProject(req, input.projectId, 'write');
          reply.header('Cache-Control', 'private, no-store');
          return listPublicationTargets(ctx, user.id, req.params.paperId, input.projectId);
        },
      );
      api.post<{ Params: { paperId: string } }>(
        '/library/papers/:paperId/publish',
        async (req, reply) => {
          const user = await requirePersonalLibraryUser(req);
          const input = parse(PaperPublishInput, req.body ?? {});
          await requireProject(req, input.projectId, 'write');
          const outcome = await publishPaper(
            ctx,
            { ...userActor(user), id: user.id },
            req.params.paperId,
            input,
          );
          return reply
            .header('Cache-Control', 'private, no-store')
            .status(outcome.replayed ? 200 : 201)
            .send(outcome);
        },
      );

      api.post<{ Params: PP }>('/projects/:projectId/library/papers/:paperId/move', async (req) => {
        const a = await requireResource(
          req,
          req.params.projectId,
          'paper',
          req.params.paperId,
          'view',
        );
        if (!a.role) throw new ApiError('forbidden', '只有课题成员能移动文献');
        const { space } = parse(MoveSpaceInput, req.body ?? {});
        const p = await movePaperSpace(
          ctx,
          { kind: 'user', id: a.user.id, name: a.user.name },
          a.role,
          req.params.projectId,
          req.params.paperId,
          space,
        );
        return (await annotatePapers(ctx, [p], a.viewer))[0];
      });
      for (const personal of [false, true]) {
        const base = personal ? '/library' : '/projects/:projectId/library';
        const authorize = async (
          req: FastifyRequest<{ Params: P & { paperId?: string } }>,
          cap: Capability,
        ) => {
          if (personal) {
            const user = await requirePersonalLibraryUser(req);
            return {
              user,
              actor: userActor(user),
              scope: { kind: 'personal', ownerUserId: user.id } as LibraryScopeInput,
              viewer: { userId: user.id, role: null } as Viewer,
            };
          }
          if (req.params.paperId) {
            const a =
              cap === 'view'
                ? await requirePaperRecord(
                    req,
                    req.params.projectId,
                    req.params.paperId,
                    req.method !== 'GET',
                  )
                : await requireResource(
                    req,
                    req.params.projectId,
                    'paper',
                    req.params.paperId,
                    'edit',
                  );
            if (
              (req.method === 'DELETE' ||
                (req.body as { archived?: boolean } | null)?.archived !== undefined) &&
              a.res.space === 'personal' &&
              a.access !== 'manage'
            )
              throw new ApiError('forbidden', '只有所有者能归档或删除个人文献');
            return {
              user: a.user,
              actor: a.actor,
              scope: req.params.projectId as LibraryScopeInput,
              viewer: a.viewer,
            };
          }
          const a = await requireProject(req, req.params.projectId, cap);
          return {
            user: a.user,
            actor: a.actor,
            scope: req.params.projectId as LibraryScopeInput,
            viewer: { userId: a.user.id, role: a.role } as Viewer,
          };
        };
        const annotated = async <T extends Paper>(list: T[], viewer: Viewer) =>
          personal ? list : await annotatePapers(ctx, list, viewer);
        const visible = async (viewer: Viewer, projectId: LibraryScopeInput) =>
          personal ? undefined : [...(await visiblePaperIds(ctx, reqProject(projectId), viewer))];
        api.get<{ Params: P }>(`${base}/status`, async (req) => {
          const { scope: projectId } = await authorize(req, 'view');
          const parser = libraryDeps(ctx).parser(ctx);
          const probe = await parser.probe();
          const status: LibraryStatus = {
            parser: parser.name,
            reachable: probe.reachable,
            version: probe.version,
            url: parser.url,
            queue: queueStats(ctx, projectId),
            llm: await libraryLlmAvailable(ctx, projectId),
          };
          return status;
        });

        api.get<{ Params: P }>(`${base}/papers`, async (req) => {
          const { scope: projectId, viewer } = await authorize(req, 'view');
          return annotated(
            await listPapers(ctx, projectId, parse(PaperListQuery, req.query), viewer),
            viewer,
          );
        });

        api.post<{ Params: P }>(`${base}/papers`, async (req, reply) => {
          const { actor, scope: projectId, viewer, user } = await authorize(req, 'write');
          const upload = await readUpload(req);
          const input = upload ? null : parse(PaperImportInput, req.body ?? {});
          const owner =
            !personal && (upload?.space ?? input?.space) === 'personal' ? user.id : null;
          const outcome = upload
            ? await importUpload(ctx, actor, projectId, upload, owner)
            : await importByRef(ctx, actor, projectId, input!, owner);
          if (outcome.enqueue) enqueuePaper(ctx, projectId, outcome.row.id);
          const body: PaperImportResult<Paper> = {
            paper: (await annotated([toPaper(outcome.row)], viewer))[0]!,
            duplicate: outcome.duplicate,
          };
          return reply.status(outcome.duplicate ? 200 : 201).send(body);
        });

        api.get<{ Params: PP }>(`${base}/papers/:paperId`, async (req) => {
          const { paperId } = req.params;
          const { scope: projectId, viewer } = await authorize(req, 'view');
          const detail = await getPaperDetail(ctx, projectId, paperId);
          return { ...detail, ...(await annotated([detail], viewer))[0] };
        });

        api.patch<{ Params: PP }>(`${base}/papers/:paperId`, async (req) => {
          const { paperId } = req.params;
          const input = parse(PaperUpdateWithVersionsInput, req.body ?? {});
          const { actor, scope: projectId } = await authorize(
            req,
            input.archived === undefined ? 'view' : 'write',
          );
          return updatePaper(ctx, actor, projectId, paperId, input);
        });

        api.delete<{ Params: PP }>(`${base}/papers/:paperId`, async (req, reply) => {
          const { paperId } = req.params;
          const { actor, scope: projectId } = await authorize(req, 'write');
          await deletePaper(ctx, actor, projectId, paperId);
          return reply.status(204).send();
        });

        api.get<{ Params: PP }>(`${base}/papers/:paperId/pdf`, async (req, reply) => {
          const { paperId } = req.params;
          const { scope: projectId } = await authorize(req, 'view');
          const row = await getPaperRow(ctx, projectId, paperId);
          const file = row.fileId ? await getLibraryFile(ctx, projectId, row.fileId) : null;
          if (!file && !row.privatePdfPath) throw new ApiError('not_found', '这篇论文还没有 PDF');
          const abs = row.privatePdfPath
            ? privateAbs(ctx, row.privatePdfPath)
            : libraryDiskPath(ctx, projectId, file!.path);
          try {
            await access(abs);
          } catch {
            throw new ApiError('not_found', 'PDF 文件已丢失');
          }
          const ascii = `${row.citekey}.pdf`.replace(/[^\x20-\x7e]/gu, '_');
          return reply
            .header('Content-Type', 'application/pdf')
            .header('Content-Disposition', `inline; filename="${ascii}"`)
            .header('X-Content-Type-Options', 'nosniff')
            .header('Cache-Control', 'private, no-store')
            .send(createReadStream(abs));
        });

        api.post<{ Params: PP }>(`${base}/papers/:paperId/pdf`, async (req) => {
          const { paperId } = req.params;
          const { actor, scope: projectId } = await authorize(req, 'write');
          const upload = await readUpload(req);
          if (!upload) throw new ApiError('bad_request', '请用 multipart/form-data 上传 PDF');
          const row = await attachPdf(ctx, actor, projectId, paperId, upload);
          enqueuePaper(ctx, projectId, row.id);
          return toPaper(row);
        });

        api.post<{ Params: PP }>(`${base}/papers/:paperId/reparse`, async (req) => {
          const { paperId } = req.params;
          const { actor, scope: projectId } = await authorize(req, 'write');
          const row = await resetForReparse(ctx, actor, projectId, paperId);
          enqueuePaper(ctx, projectId, row.id);
          return toPaper(row);
        });

        api.get<{ Params: PP }>(`${base}/papers/:paperId/bibtex`, async (req, reply) => {
          const { paperId } = req.params;
          const { scope: projectId } = await authorize(req, 'view');
          const row = await getPaperRow(ctx, projectId, paperId);
          return reply.header('Content-Type', 'text/x-bibtex; charset=utf-8').send(bibOf(row));
        });

        api.post<{ Params: P }>(`${base}/bibtex`, async (req, reply) => {
          const { scope: projectId, viewer } = await authorize(req, 'view');
          const input = parse(LibraryBibtexInput, req.body ?? {});
          const rows = await listByIds(ctx, projectId, input.paperIds, viewer);
          return reply
            .header('Content-Type', 'text/x-bibtex; charset=utf-8')
            .send(rows.map(bibOf).join('\n'));
        });

        api.get<{ Params: P }>(`${base}/search`, async (req) => {
          const { scope: projectId, viewer } = await authorize(req, 'view');
          const q = parse(LibrarySearchQuery, req.query);
          return searchLibrary(ctx, projectId, q.q, {
            paperId: q.paperId,
            paperIds: await visible(viewer, projectId),
            limit: q.limit,
          });
        });

        api.get<{ Params: P }>(`${base}/translation-models`, async (req, reply) => {
          const { scope } = await authorize(req, 'view');
          reply.header('Cache-Control', 'private, no-store');
          return translationModels(ctx, scope);
        });

        api.post<{ Params: PP }>(`${base}/papers/:paperId/translate`, async (req, reply) => {
          // 与现有问答一致，项目访客不能发起消耗模型额度的请求。
          const { actor, scope } = await authorize(req, 'write');
          if (!personal) await requireProject(req, req.params.projectId, 'write');
          if (!actor.id) throw new ApiError('unauthorized', '请先登录');
          const input = parse(LibraryTranslationInput, req.body ?? {});
          const ac = new AbortController();
          const close = () => ac.abort();
          reply.raw.on('close', close);
          reply.header('Cache-Control', 'private, no-store');
          try {
            return await translateSelection(
              ctx,
              scope,
              actor.id,
              req.params.paperId,
              input,
              ac.signal,
            );
          } finally {
            reply.raw.off('close', close);
          }
        });

        if (!personal)
          api.post<{ Params: P }>(`${base}/cite`, async (req) => {
            const { actor, scope: projectId } = await authorize(req, 'write');
            if (typeof projectId !== 'string')
              throw new ApiError('forbidden', '个人文献需先发布到项目才能引用');
            return citeToDocument(
              ctx,
              actor,
              projectId,
              parse(LibraryCiteToDocInput, req.body ?? {}),
            );
          });

        api.post<{ Params: P }>(`${base}/qa`, async (req, reply) => {
          // 问答会消耗模型额度：与其他驱动 agent / 花钱的接口一致，访客（只读）不能用
          const { scope: projectId, viewer } = await authorize(req, 'write');
          const allowed = await visible(viewer, projectId);
          const input = parse(LibraryQaInput, req.body ?? {});
          if (input.paperId) {
            if (allowed && !allowed.includes(input.paperId))
              throw new ApiError('not_found', '论文不存在');
            const row = await getPaperRow(ctx, projectId, input.paperId);
            if (row.status !== 'ready') {
              throw new ApiError('conflict', '这篇论文还没有解析完成，暂时不能问答');
            }
          }
          if (!(await libraryLlmAvailable(ctx, projectId))) {
            throw new ApiError(
              'llm_unavailable',
              '尚无可用模型，请在有写入权限的项目中打开“设置 → 模型”配置后重试',
            );
          }
          const ac = new AbortController();
          reply.raw.on('close', () => ac.abort());
          const { keywords, sources } = await retrieveForQuestion(
            ctx,
            projectId,
            input,
            ac.signal,
            undefined,
            allowed,
          );
          const write = (f: LibraryQaFrame) => reply.raw.write(`${JSON.stringify(f)}\n`);
          if (sources.length === 0) {
            reply.hijack();
            reply.raw.writeHead(200, ndjsonHead);
            write({ type: 'sources', keywords, sources });
            write({
              type: 'delta',
              text: input.paperId
                ? '当前论文没有可用于问答的正文，请确认 PDF 已解析，或选中一段原文后提问。'
                : '文献库里没有找到相关段落。若要概括当前论文，请切回单篇范围；跨论文提问请补充主题。',
            });
            write({ type: 'done' });
            reply.raw.end();
            return;
          }
          const iter = streamAnswer(ctx, projectId, input, sources, ac.signal, viewer.userId)[
            Symbol.asyncIterator
          ]();
          // 先取第一块：key 无效 / 限流等错误仍按统一 JSON 格式返回
          const first = await iter.next();
          reply.hijack();
          reply.raw.writeHead(200, ndjsonHead);
          write({ type: 'sources', keywords, sources });
          try {
            if (!first.done) {
              write({ type: 'delta', text: first.value });
              for (let r = await iter.next(); !r.done; r = await iter.next()) {
                write({ type: 'delta', text: r.value });
              }
            }
            write({ type: 'done' });
          } catch (err) {
            if (!ac.signal.aborted) {
              req.log.warn({ err }, 'library qa stream failed');
              write({ type: 'error', message: '回答中断了，请重试' });
            }
          } finally {
            reply.raw.end();
          }
        });
      }
    });
  },
};

const reqProject = (scope: LibraryScopeInput) =>
  typeof scope === 'string' ? scope : scope.kind === 'project' ? scope.projectId : '';

const ndjsonHead = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
};
