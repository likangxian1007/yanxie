import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  ApiError,
  DocCommentCreateInput,
  DocCommentUpdateInput,
  DocMentionInput,
  DocumentAiInput,
  DocumentCreateInput,
  DocumentEdit,
  DocumentKind,
  DocumentUpdateInput,
  DocumentVersionCreateInput,
  MoveSpaceInput,
  SpaceFilter,
  type AccessLevel,
  type ProjectRole,
} from '@srh/shared';
import type { FastifyRequest } from 'fastify';
import { registerCollabPort } from '../../agents/tools/collab-port';
import { documents } from '../../db/schema';
import { parse } from '../../lib/http';
import { setCollabStorage } from '../../realtime/collab';
import { ensureWorkbook } from './sheet-model';
import { memberRole, requireProject, type Params } from '../collab-common';
import { streamText } from '../collab-common/llm';
import { accessOf, TEAM_VIEWER, type Viewer } from '../sharing/access';
import { loadResource, requireResource, type ResourceAccess } from '../sharing/service';
import type { ModuleDef } from '../types';
import {
  aiSystemPrompt,
  aiUserPrompt,
  latexFixUserPrompt,
  needsSelection,
  stripLeadingFence,
} from './ai';
import { registerImportRoutes } from './import';
import { registerLatexRoutes } from './latex/routes';
import {
  createComment,
  deleteComment,
  listComments,
  notifyDocMentions,
  updateComment,
} from './comments';
import {
  annotateDocs,
  applyDocumentEdit,
  createDocument,
  createVersion,
  deleteDocument,
  getDocument,
  getRow,
  listDocuments,
  listVersions,
  moveDocumentSpace,
  persistDocument,
  readDocument,
  readVersion,
  restoreVersion,
  searchDocuments,
  updateDocument,
} from './service';

/**
 * 协同文档（富文本 / 表格 / 幻灯片 / LaTeX）：元数据、版本、结构化编辑、内嵌 AI；正文走 /collab Yjs。
 * 归属：协作功能线程。端点契约见 API.md §2.7；个人 / 团队空间与分享见 §2.19。
 *
 * 每篇文档属于团队空间（项目成员按角色访问）或某人的个人空间（所有者 + 分享到的人）。
 * 带 :docId 的端点按文档权限检查（sharing/service.ts requireResource）：
 * 看不到 → 404，级别不够 → 403。
 *
 *   GET    P/docs?archived=&kind=&parentId=&space= → DocumentMeta[]（带 access；space=team|personal|shared|all）
 *   GET    P/docs/search?q=                     → DocumentSearchHit[]（只搜自己能看到的）
 *   POST   P/docs                               → 201 DocumentMeta（space=personal 建在自己的个人空间）
 *   POST   P/docs/import?kind=&title=&parentId=&space= → 201 DocumentMeta（octet-stream Yjs 状态，见 import.ts）
 *   GET    P/docs/:docId                        → DocumentMeta（可阅读）
 *   PATCH  P/docs/:docId                        → DocumentMeta（标题、图标、父文档、归档；可编辑）
 *   DELETE P/docs/:docId                        → 204（团队：可编辑的成员；个人：所有者）
 *   POST   P/docs/:docId/move                   → DocumentMeta { space }（换空间，连同子文档）
 *   GET    P/docs/:docId/markdown               → DocumentContent { meta, markdown, outline }
 *   POST   P/docs/:docId/edit                   → { meta, markdown }（DocumentEdit，作为 Yjs 事务应用）
 *   POST   P/docs/:docId/ai                     → text/plain 流（DocumentAiInput）
 *   GET    P/docs/:docId/versions               → DocumentVersion[]
 *   POST   P/docs/:docId/versions               → 201 DocumentVersion
 *   GET    P/docs/:docId/versions/:versionId    → { version, markdown }
 *   POST   P/docs/:docId/versions/:versionId/restore → DocumentMeta
 *   GET    P/docs/:docId/comments               → DocComment[]（行内评论，旧到新）
 *   POST   P/docs/:docId/comments               → 201 DocComment（可评论）
 *   PATCH  P/docs/:docId/comments/:commentId    → DocComment（改正文 / 解决 / 重新打开）
 *   DELETE P/docs/:docId/comments/:commentId    → 204
 *   POST   P/docs/:docId/mentions               → { notified }（正文里 @ 了成员）
 *   GET    P/docs/latex/capability              → LatexCapability
 *   POST   P/docs/:docId/latex/compile          → LatexCompileResult
 *   GET    P/docs/:docId/latex/pdf/:pdfId       → application/pdf
 */
const P = '/projects/:projectId';

const ListQuery = z.object({
  archived: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  kind: DocumentKind.optional(),
  parentId: z.string().optional(),
  space: SpaceFilter.optional(),
});
const SearchQuery = z.object({ q: z.string().max(200).default('') });

type DocParams = Params<'projectId' | 'docId'>;
type VersionParams = Params<'projectId' | 'docId' | 'versionId'>;
type CommentParams = Params<'projectId' | 'docId' | 'commentId'>;

/** 带 :docId 的端点：按文档权限检查 */
export function requireDoc(
  req: FastifyRequest<{ Params: DocParams }>,
  need: AccessLevel,
): Promise<ResourceAccess> {
  return requireResource(req, req.params.projectId, 'document', req.params.docId, need);
}

/** 评论的删除 / 解决按角色判断：个人文档的所有者相当于负责人，其余人按普通成员 */
function commentRole(a: ResourceAccess): ProjectRole {
  if (a.res.space === 'personal') return a.access === 'manage' ? 'owner' : 'member';
  return a.role ?? 'member';
}

export const documentsModule: ModuleDef = {
  name: 'documents',
  owner: 'collab',
  async register(app) {
    const ctx = app.ctx;

    setCollabStorage(ctx, {
      async load(docId) {
        const [row] = await ctx.db.db
          .select({
            projectId: documents.projectId,
            state: documents.ydocState,
            archivedAt: documents.archivedAt,
            kind: documents.kind,
          })
          .from(documents)
          .where(eq(documents.id, docId));
        return row
          ? {
              projectId: row.projectId,
              state: row.state ?? null,
              archived: !!row.archivedAt,
              kind: row.kind,
            }
          : null;
      },
      // 表格旧单表结构：在服务端载入时迁移到多工作表结构（确定 id，客户端再迁移也不会重复）
      prepare(doc, kind) {
        if (kind === 'sheet') doc.transact(() => ensureWorkbook(doc));
      },
      role: (projectId, userId) => memberRole(ctx, projectId, userId),
      // 个人空间的文档按分享权限：可编辑才能写，可阅读 / 可评论只读
      async access(docId, userId) {
        const res = await loadResource(ctx, 'document', docId);
        if (!res) return 'none';
        const role = await memberRole(ctx, res.projectId, userId);
        return accessOf(ctx, res, { userId, role });
      },
      async persist(docId, doc, actor) {
        await persistDocument(ctx, docId, doc, actor);
      },
    });

    /** agent 端口：读写前按 agent 代表的人（个人会话）或团队（协调者、团队线程）检查权限 */
    const agentAccess = async (pid: string, docId: string, viewer: Viewer | undefined) => {
      const res = await loadResource(ctx, 'document', docId);
      const level =
        res && res.projectId === pid ? await accessOf(ctx, res, viewer ?? TEAM_VIEWER) : 'none';
      if (level === 'none') throw new ApiError('not_found', '文档不存在，或你没有访问权限');
      return level;
    };
    registerCollabPort({
      documents: {
        list: (c, pid, viewer) => listDocuments(c, pid, {}, viewer ?? TEAM_VIEWER),
        async read(c, pid, docId, viewer) {
          await agentAccess(pid, docId, viewer);
          return readDocument(c, pid, docId);
        },
        create: (c, actor, pid, input, viewer) =>
          createDocument(c, actor, pid, input, (viewer ?? TEAM_VIEWER).userId),
        async applyEdit(c, actor, pid, docId, edit, opts) {
          const level = await agentAccess(pid, docId, opts?.viewer);
          if (level !== 'edit' && level !== 'manage') {
            throw new ApiError('forbidden', '只有阅读或评论权限，不能修改这篇文档');
          }
          return applyDocumentEdit(c, actor, pid, docId, edit);
        },
      },
      search: {
        searchDocuments: (c, pid, q, viewer) =>
          searchDocuments(c, pid, q, 20, viewer ?? TEAM_VIEWER),
      },
    });

    app.get<{ Params: Params<'projectId'> }>(`${P}/docs`, async (req) => {
      const { projectId } = req.params;
      const { user, role } = await requireProject(req, projectId, 'view');
      const viewer: Viewer = { userId: user.id, role };
      const metas = await listDocuments(ctx, projectId, parse(ListQuery, req.query), viewer);
      return annotateDocs(ctx, metas, viewer);
    });

    app.get<{ Params: Params<'projectId'> }>(`${P}/docs/search`, async (req) => {
      const { projectId } = req.params;
      const { user, role } = await requireProject(req, projectId, 'view');
      const { q } = parse(SearchQuery, req.query);
      return searchDocuments(ctx, projectId, q, 20, { userId: user.id, role });
    });

    app.post<{ Params: Params<'projectId'> }>(`${P}/docs`, async (req, reply) => {
      const { projectId } = req.params;
      const { actor, user, role } = await requireProject(req, projectId, 'write');
      const input = parse(DocumentCreateInput, req.body ?? {});
      const meta = await createDocument(ctx, actor, projectId, input, user.id);
      const [out] = await annotateDocs(ctx, [meta], { userId: user.id, role });
      return reply.status(201).send(out);
    });

    app.get<{ Params: DocParams }>(`${P}/docs/:docId`, async (req) => {
      const a = await requireDoc(req, 'view');
      const [out] = await annotateDocs(
        ctx,
        [await getDocument(ctx, req.params.projectId, req.params.docId)],
        a.viewer,
      );
      return out;
    });

    app.patch<{ Params: DocParams }>(`${P}/docs/:docId`, async (req) => {
      const { projectId, docId } = req.params;
      const a = await requireDoc(req, 'edit');
      const meta = await updateDocument(
        ctx,
        a.actor,
        projectId,
        docId,
        parse(DocumentUpdateInput, req.body ?? {}),
      );
      const [out] = await annotateDocs(ctx, [meta], a.viewer);
      return out;
    });

    app.delete<{ Params: DocParams }>(`${P}/docs/:docId`, async (req, reply) => {
      const { projectId, docId } = req.params;
      const a = await requireDoc(req, 'edit');
      if (a.res.space === 'personal' && a.access !== 'manage') {
        throw new ApiError('forbidden', '只有所有者能删除个人空间里的文档');
      }
      await deleteDocument(ctx, a.actor, projectId, docId);
      return reply.status(204).send();
    });

    app.post<{ Params: DocParams }>(`${P}/docs/:docId/move`, async (req) => {
      const { projectId, docId } = req.params;
      const a = await requireDoc(req, 'view');
      if (!a.role) throw new ApiError('forbidden', '只有课题成员能移动文档');
      const { space } = parse(MoveSpaceInput, req.body ?? {});
      const meta = await moveDocumentSpace(
        ctx,
        { kind: 'user', id: a.user.id, name: a.user.name },
        a.role,
        projectId,
        docId,
        space,
      );
      const [out] = await annotateDocs(ctx, [meta], a.viewer);
      return out;
    });

    app.get<{ Params: DocParams }>(`${P}/docs/:docId/markdown`, async (req) => {
      const { projectId, docId } = req.params;
      await requireDoc(req, 'view');
      return readDocument(ctx, projectId, docId);
    });

    app.post<{ Params: DocParams }>(`${P}/docs/:docId/edit`, async (req) => {
      const { projectId, docId } = req.params;
      const { actor } = await requireDoc(req, 'edit');
      return applyDocumentEdit(ctx, actor, projectId, docId, parse(DocumentEdit, req.body));
    });

    app.post<{ Params: DocParams }>(`${P}/docs/:docId/ai`, async (req, reply) => {
      const { projectId, docId } = req.params;
      const access = await requireDoc(req, 'edit');
      const input = parse(DocumentAiInput, req.body ?? {});
      if (needsSelection(input.action) && !input.selection.trim()) {
        throw new ApiError('validation_failed', '先选中要处理的内容');
      }
      const row = await getRow(ctx, projectId, docId);
      const content = await readDocument(ctx, projectId, docId);
      const ac = new AbortController();
      reply.raw.on('close', () => ac.abort());
      const iter = streamText(ctx, {
        billing: { payerUserId: access.user.id, projectId, note: 'docs-ai' },
        system: aiSystemPrompt(row.kind, input.action),
        user:
          input.action === 'latex_fix' && row.kind === 'latex'
            ? latexFixUserPrompt({
                title: row.title,
                selection: input.selection,
                prompt: input.prompt,
                document: content.markdown,
              })
            : aiUserPrompt({
                title: row.title,
                kind: row.kind,
                action: input.action,
                selection: input.selection,
                prompt: input.prompt,
                context: content.markdown,
              }),
        temperature: input.action === 'table' || input.action === 'latex_fix' ? 0.2 : 0.6,
        signal: ac.signal,
      })[Symbol.asyncIterator]();
      // 先取第一块：LLM 未配置 / key 无效等错误在这里抛出，仍能按统一格式返回 JSON 错误
      const first = await iter.next();
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      });
      let head = first.done ? '' : first.value;
      let headDone = false;
      const flushHead = () => {
        if (headDone) return;
        headDone = true;
        const cleaned = stripLeadingFence(head);
        if (cleaned) reply.raw.write(cleaned);
      };
      try {
        if (head.length >= 12) flushHead();
        if (!first.done) {
          for (let r = await iter.next(); !r.done; r = await iter.next()) {
            if (headDone) reply.raw.write(r.value);
            else {
              head += r.value;
              if (head.length >= 12) flushHead();
            }
          }
        }
        flushHead();
      } catch (err) {
        if (!ac.signal.aborted) req.log.warn({ err }, 'doc ai stream failed');
      } finally {
        reply.raw.end();
      }
    });

    // ------------------------------------------------------------ 行内评论与 @提及
    app.get<{ Params: DocParams }>(`${P}/docs/:docId/comments`, async (req) => {
      const { projectId, docId } = req.params;
      await requireDoc(req, 'view');
      return listComments(ctx, projectId, docId);
    });

    app.post<{ Params: DocParams }>(`${P}/docs/:docId/comments`, async (req, reply) => {
      const { projectId, docId } = req.params;
      const { actor } = await requireDoc(req, 'comment');
      const input = parse(DocCommentCreateInput, req.body ?? {});
      return reply.status(201).send(await createComment(ctx, actor, projectId, docId, input));
    });

    app.patch<{ Params: CommentParams }>(`${P}/docs/:docId/comments/:commentId`, async (req) => {
      const { projectId, docId, commentId } = req.params;
      const a = await requireDoc(req, 'comment');
      const input = parse(DocCommentUpdateInput, req.body ?? {});
      return updateComment(
        ctx,
        { actor: a.actor, role: commentRole(a) },
        projectId,
        docId,
        commentId,
        input,
      );
    });

    app.delete<{ Params: CommentParams }>(
      `${P}/docs/:docId/comments/:commentId`,
      async (req, reply) => {
        const { projectId, docId, commentId } = req.params;
        const a = await requireDoc(req, 'comment');
        await deleteComment(
          ctx,
          { actor: a.actor, role: commentRole(a) },
          projectId,
          docId,
          commentId,
        );
        return reply.status(204).send();
      },
    );

    app.post<{ Params: DocParams }>(`${P}/docs/:docId/mentions`, async (req) => {
      const { projectId, docId } = req.params;
      const { actor } = await requireDoc(req, 'edit');
      return notifyDocMentions(
        ctx,
        actor,
        projectId,
        docId,
        parse(DocMentionInput, req.body ?? {}),
      );
    });
    // LaTeX 真编译（PDF + BibTeX），见 latex/routes.ts
    registerLatexRoutes(app, ctx);
    // 从文件导入（带初始 Yjs 状态原子新建），见 import.ts
    await registerImportRoutes(app, ctx);

    app.get<{ Params: DocParams }>(`${P}/docs/:docId/versions`, async (req) => {
      const { projectId, docId } = req.params;
      await requireDoc(req, 'view');
      return listVersions(ctx, projectId, docId);
    });

    app.post<{ Params: DocParams }>(`${P}/docs/:docId/versions`, async (req, reply) => {
      const { projectId, docId } = req.params;
      const { actor } = await requireDoc(req, 'edit');
      const input = parse(DocumentVersionCreateInput, req.body ?? {});
      return reply.status(201).send(await createVersion(ctx, actor, projectId, docId, input));
    });

    app.get<{ Params: VersionParams }>(`${P}/docs/:docId/versions/:versionId`, async (req) => {
      const { projectId, docId, versionId } = req.params;
      await requireDoc(req, 'view');
      return readVersion(ctx, projectId, docId, versionId);
    });

    app.post<{ Params: VersionParams }>(
      `${P}/docs/:docId/versions/:versionId/restore`,
      async (req) => {
        const { projectId, docId, versionId } = req.params;
        const { actor } = await requireDoc(req, 'edit');
        return restoreVersion(ctx, actor, projectId, docId, versionId);
      },
    );
  },
};
