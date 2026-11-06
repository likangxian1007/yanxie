import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';
import type { z } from 'zod';
import {
  ApiError,
  DOC_IMPORT_MAX_BYTES,
  DocumentImportQuery,
  LATEX_LIMITS,
  LatexAsset,
  latexFileKind,
  newId,
  type ActorRef,
  type DocumentKind,
  type DocumentMeta,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { documents, files } from '../../db/schema';
import { parse } from '../../lib/http';
import { requireProject, type Params } from '../collab-common';
import { latexAssetsMap, latexFilesMap } from './latex/project';
import { getRow, placementFor, toMeta } from './service';
import { toMarkdown } from './ydoc';

/**
 * 从文件导入（API.md §2.7.6）：
 *
 *   POST P/docs/import?kind=&title=&parentId=   body: application/octet-stream（Yjs 更新）→ 201 DocumentMeta
 *
 * 前端导入器（apps/web/src/features/docs/import）把 .docx / .xlsx / .pptx / .tex / .zip / .md 等
 * 解析进一个空的本地 Y.Doc，再把整份状态发到这里。服务端校验后与文档行在同一个事务里写入：
 * 要么得到一份完整的文档，要么什么都不留下（不会出现“建好了空文档、内容没推上去”的半成品）。
 */
const P = '/projects/:projectId';

/** 解码并校验导入的 Yjs 状态；不合法抛 422 */
export function decodeImportState(update: Uint8Array, kind: DocumentKind): Y.Doc {
  if (update.byteLength === 0) throw new ApiError('validation_failed', '导入的内容是空的');
  if (update.byteLength > DOC_IMPORT_MAX_BYTES) {
    throw new ApiError(
      'validation_failed',
      `导入的内容太大了（上限 ${Math.round(DOC_IMPORT_MAX_BYTES / 1024 / 1024)} MB）`,
    );
  }
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
  } catch {
    doc.destroy();
    throw new ApiError('validation_failed', '导入的内容无法解析，请重新导入');
  }
  // 依赖缺失的更新（截断、拼错）会挂在 pending 里而不是报错
  if (doc.store.pendingStructs || doc.store.pendingDs) {
    doc.destroy();
    throw new ApiError('validation_failed', '导入的内容不完整，请重新导入');
  }
  try {
    toMarkdown(doc, kind);
  } catch {
    doc.destroy();
    throw new ApiError('validation_failed', '导入的内容和文档类型不匹配');
  }
  return doc;
}

/** LaTeX 工程的路径 / 数量 / 长度上限，与前端编辑器一致（LATEX_LIMITS、latexFileKind） */
async function checkLatexProject(ctx: AppContext, projectId: string, doc: Y.Doc): Promise<void> {
  const bad = (msg: string): never => {
    throw new ApiError('validation_failed', msg);
  };
  const main = doc.getText('source').toString();
  if (main.length > LATEX_LIMITS.textChars) bad('main.tex 太长了');
  const textMap = latexFilesMap(doc);
  const assetMap = latexAssetsMap(doc);
  if (textMap.size + assetMap.size + 1 > LATEX_LIMITS.files) {
    bad(`一个 LaTeX 工程最多 ${LATEX_LIMITS.files} 个文件`);
  }
  textMap.forEach((value, name) => {
    if (latexFileKind(name) !== 'text') bad(`工程文件名不合法：${name.slice(0, 80)}`);
    if (!(value instanceof Y.Text)) bad(`${name} 不是文本文件`);
    if (value.length > LATEX_LIMITS.textChars) bad(`${name} 太长了`);
  });
  const fileIds: string[] = [];
  assetMap.forEach((value, name) => {
    if (latexFileKind(name) !== 'image') bad(`图片文件名不合法：${name.slice(0, 80)}`);
    const parsed = LatexAsset.safeParse(value);
    if (!parsed.success) bad(`${name} 的图片引用不完整`);
    else fileIds.push(parsed.data.fileId);
  });
  if (fileIds.length === 0) return;
  // 图片必须是本项目的文件（编译时按 fileId 从项目文件夹取）
  const unique = [...new Set(fileIds)];
  const rows = await ctx.db.db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.projectId, projectId), inArray(files.id, unique)));
  if (rows.length !== unique.length) bad('有图片不在这个项目的文件里，请重新导入');
}

/** 幂等键 → 第一次导入的结果（进程内，15 分钟） */
const IDEMPOTENCY_TTL_MS = 15 * 60_000;
const recentImports = new WeakMap<
  AppContext,
  Map<string, { at: number; result: Promise<DocumentMeta> }>
>();

/**
 * 导入新文档。带 importId 时同一个键只建一次文档（重试拿回第一次的结果，replayed = true）；
 * 第一次失败的键不缓存，可以重试。
 */
export async function importDocument(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  query: DocumentImportQuery,
  update: Uint8Array,
): Promise<{ meta: DocumentMeta; replayed: boolean }> {
  const data = DocumentImportQuery.parse(query);
  if (!data.importId) {
    return { meta: await createFromState(ctx, actor, projectId, data, update), replayed: false };
  }
  let cache = recentImports.get(ctx);
  if (!cache) {
    cache = new Map();
    recentImports.set(ctx, cache);
  }
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > IDEMPOTENCY_TTL_MS) cache.delete(k);
  const key = `${projectId}:${actor.id ?? ''}:${data.importId}`;
  const hit = cache.get(key);
  if (hit) {
    const meta = await hit.result;
    // 第一次导入之后文档被删掉了：当作新的导入
    const [row] = await ctx.db.db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.id, meta.id));
    if (row) return { meta: await getDocumentMeta(ctx, projectId, meta.id), replayed: true };
    cache.delete(key);
  }
  const result = createFromState(ctx, actor, projectId, data, update);
  cache.set(key, { at: now, result });
  try {
    return { meta: await result, replayed: false };
  } catch (err) {
    cache.delete(key);
    throw err;
  }
}

async function getDocumentMeta(ctx: AppContext, projectId: string, docId: string) {
  return toMeta(await getRow(ctx, projectId, docId));
}

async function createFromState(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  data: z.output<typeof DocumentImportQuery>,
  update: Uint8Array,
): Promise<DocumentMeta> {
  const placement = await placementFor(
    ctx,
    projectId,
    data.space,
    actor.kind === 'user' ? actor.id : null,
    data.parentId,
  );
  const doc = decodeImportState(update, data.kind);
  try {
    if (data.kind === 'latex') await checkLatexProject(ctx, projectId, doc);
    const title = data.title || '未命名文档';
    const markdown = toMarkdown(doc, data.kind);
    const { meta, event } = await ctx.db.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(documents)
        .values({
          id: newId('document'),
          projectId,
          kind: data.kind,
          ...placement,
          title,
          ydocState: Y.encodeStateAsUpdate(doc),
          contentText: markdown,
          createdBy: actor,
          updatedBy: actor,
        })
        .returning();
      const meta = toMeta(row!);
      const event = await ctx.bus.record(tx, {
        projectId,
        type: 'document.created',
        payload: meta,
        actor,
      });
      return { meta, event };
    });
    ctx.bus.emit(event);
    return meta;
  } finally {
    doc.destroy();
  }
}

/** 注册导入端点：原始字节请求体只在这个封装上下文里解析 */
export async function registerImportRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await app.register(async (api) => {
    api.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: DOC_IMPORT_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );

    api.post<{ Params: Params<'projectId'> }>(
      `${P}/docs/import`,
      { bodyLimit: DOC_IMPORT_MAX_BYTES },
      async (req, reply) => {
        const { projectId } = req.params;
        const { actor } = await requireProject(req, projectId, 'write');
        const query = parse(DocumentImportQuery, req.query ?? {});
        if (!Buffer.isBuffer(req.body)) {
          throw new ApiError('bad_request', '请用 application/octet-stream 发送导入内容');
        }
        const body = req.body;
        const update = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        const { meta, replayed } = await importDocument(ctx, actor, projectId, query, update);
        return reply.status(replayed ? 200 : 201).send(meta);
      },
    );
  });
}
