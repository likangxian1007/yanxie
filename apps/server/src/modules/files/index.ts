import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import multipart from '@fastify/multipart';
import { and, desc, eq, isNull, lt, ne, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, FileListQuery, OutputListQuery, type OutputItem, type Page } from '@srh/shared';
import { outputs, threads } from '../../db/schema';
import { parse } from '../../lib/http';
import { requireProject } from '../auth/guard';
import type { ModuleDef } from '../types';
import {
  MAX_FILE_BYTES,
  deleteProjectFile,
  diskPath,
  getFile,
  guessMime,
  isReservedName,
  listFiles,
  normalizePath,
  toFile,
  uniquePath,
  writeProjectFile,
} from './service';

/**
 * 项目共享文件：上传、下载、资料库（产出汇总），API.md §2.6
 * 归属：后端与 agent 引擎线程。
 *
 *   GET    /projects/:projectId/files              ?dir=
 *   POST   /projects/:projectId/files              multipart：file（必填）、path（可选，默认 uploads/<文件名>）
 *   GET    /projects/:projectId/files/:fileId      ?download=1 → 附件下载，否则内联
 *   DELETE /projects/:projectId/files/:fileId
 *   GET    /projects/:projectId/outputs            ?kind= + 游标分页（资料库）
 */
type P = { projectId: string };
type PF = P & { fileId: string };

const DownloadQuery = z.object({
  download: z.enum(['1', '0', 'true', 'false']).optional(),
});

/**
 * 允许在浏览器里内联打开的类型（白名单）：值为实际返回的 Content-Type。
 * 文本类一律按 text/plain 返回，浏览器不会把它们当文档渲染；其他类型一律按附件下载。
 */
const INLINE_TYPES: Record<string, string> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
  'application/pdf': 'application/pdf',
  'text/plain': 'text/plain; charset=utf-8',
  'text/markdown': 'text/plain; charset=utf-8',
  'text/csv': 'text/plain; charset=utf-8',
};

/** 附件下载时的 Content-Type：文本类补上 utf-8 */
function attachmentType(mime: string): string {
  const base = mime.split(';')[0]!.trim().toLowerCase();
  const textLike = base.startsWith('text/') || base === 'application/json';
  return textLike ? `${base}; charset=utf-8` : base || 'application/octet-stream';
}

/** Content-Disposition：ASCII 兜底名 + RFC 5987 filename* */
function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_') || 'file';
  const encoded = encodeURIComponent(name).replace(
    /['()*]/gu,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * 上传文件名只取最后一段，去掉控制字符，Windows 不允许的字符换成 _，
 * 去掉末尾的点和空格，保留设备名（CON、NUL…）前加 _。显式 path 字段不做替换，不合法直接 400。
 */
function cleanFileName(name: string | undefined): string {
  const base = (name ?? '').replace(/\\/gu, '/').split('/').pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/[<>:"|?*]/gu, '_')
    .trim()
    .replace(/[. ]+$/u, '');
  if (!cleaned) return 'file';
  return isReservedName(cleaned) ? `_${cleaned}` : cleaned;
}

export const filesModule: ModuleDef = {
  name: 'files',
  owner: 'backend',
  async register(app) {
    const ctx = app.ctx;

    // multipart 只在本模块的封装上下文里生效
    await app.register(async (api) => {
      await api.register(multipart, {
        limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 10, fieldSize: 4096 },
      });

      api.get<{ Params: P }>('/projects/:projectId/files', async (req) => {
        await requireProject(req, req.params.projectId, 'view');
        const q = parse(FileListQuery, req.query);
        return listFiles(ctx, req.params.projectId, q.dir);
      });

      api.post<{ Params: P }>('/projects/:projectId/files', async (req, reply) => {
        const { projectId } = req.params;
        const { actor } = await requireProject(req, projectId, 'write');
        if (!req.isMultipart()) {
          throw new ApiError('bad_request', '请用 multipart/form-data 上传文件');
        }
        let upload: { data: Buffer; filename: string; mimetype: string } | null = null;
        let explicitPath: string | null = null;
        try {
          for await (const part of req.parts()) {
            if (part.type === 'file') {
              if (part.fieldname !== 'file' || upload) {
                await part.toBuffer(); // 丢弃多余的文件字段
                continue;
              }
              upload = {
                data: await part.toBuffer(),
                filename: cleanFileName(part.filename),
                mimetype: part.mimetype,
              };
            } else if (
              part.fieldname === 'path' &&
              typeof part.value === 'string' &&
              part.value.trim()
            ) {
              explicitPath = part.value;
            }
          }
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === 'FST_REQ_FILE_TOO_LARGE')
            throw new ApiError('bad_request', '文件不能超过 20 MB');
          if (code?.startsWith('FST_')) throw new ApiError('bad_request', '上传内容无法解析');
          throw err;
        }
        if (!upload) throw new ApiError('bad_request', '缺少 file 字段');
        // 明确给了路径：覆盖同路径文件（file.updated）；默认路径：重名时追加 (1)、(2)…
        const path = explicitPath
          ? normalizePath(explicitPath)
          : await uniquePath(ctx, projectId, `uploads/${upload.filename}`);
        const guessed = guessMime(path);
        const mime =
          guessed !== 'application/octet-stream'
            ? guessed
            : upload.mimetype && upload.mimetype !== 'application/octet-stream'
              ? upload.mimetype
              : guessed;
        const { file } = await writeProjectFile(ctx, actor, projectId, path, upload.data, mime);
        return reply.status(201).send(file);
      });

      api.get<{ Params: PF }>('/projects/:projectId/files/:fileId', async (req, reply) => {
        const { projectId, fileId } = req.params;
        await requireProject(req, projectId, 'view');
        const q = parse(DownloadQuery, req.query);
        const row = await getFile(ctx, projectId, fileId);
        if (!row) throw new ApiError('not_found', '文件不存在');
        const abs = diskPath(ctx, projectId, row.path);
        try {
          await access(abs);
        } catch {
          throw new ApiError('not_found', '文件内容已丢失');
        }
        const file = toFile(row);
        const inlineType = INLINE_TYPES[file.mime.split(';')[0]!.trim().toLowerCase()];
        const download = q.download === '1' || q.download === 'true' || !inlineType;
        reply
          .header('Content-Type', download || !inlineType ? attachmentType(file.mime) : inlineType)
          .header(
            'Content-Disposition',
            contentDisposition(download ? 'attachment' : 'inline', file.name),
          )
          .header('X-Content-Type-Options', 'nosniff')
          .header('Cache-Control', 'private, no-cache');
        // 即使被当文档打开也不执行脚本、不算同源。内联 PDF 例外：Chrome 的 PDF 查看器在
        // sandbox 文档里无法显示（PDF 本身由浏览器的独立查看器渲染，不在本站源里执行脚本）
        if (download || inlineType !== 'application/pdf') {
          reply.header('Content-Security-Policy', 'sandbox');
        }
        return reply.send(createReadStream(abs));
      });

      api.delete<{ Params: PF }>('/projects/:projectId/files/:fileId', async (req, reply) => {
        const { projectId, fileId } = req.params;
        const { actor } = await requireProject(req, projectId, 'write');
        await deleteProjectFile(ctx, actor, projectId, fileId);
        return reply.status(204).send();
      });

      // 资料库：消息上挂的产出，新到旧；个人线程的产出只有主人看得到
      api.get<{ Params: P }>(
        '/projects/:projectId/outputs',
        async (req): Promise<Page<OutputItem>> => {
          const { projectId } = req.params;
          const { user } = await requireProject(req, projectId, 'view');
          const q = parse(OutputListQuery, req.query);
          const conds: (SQL | undefined)[] = [
            eq(outputs.projectId, projectId),
            or(isNull(threads.id), ne(threads.kind, 'personal'), eq(threads.ownerUserId, user.id)),
          ];
          if (q.kind) conds.push(eq(outputs.kind, q.kind));
          if (q.cursor) conds.push(lt(outputs.id, q.cursor));
          const rows = await ctx.db.db
            .select({ o: outputs })
            .from(outputs)
            .leftJoin(threads, eq(threads.id, outputs.threadId))
            .where(and(...conds))
            .orderBy(desc(outputs.id))
            .limit(q.limit + 1);
          const more = rows.length > q.limit;
          const items = rows.slice(0, q.limit).map(({ o }) => ({
            id: o.id,
            kind: o.kind,
            ref: o.ref,
            title: o.title,
            threadId: o.threadId ?? null,
            messageId: o.messageId ?? null,
            createdAt: o.createdAt.toISOString(),
          }));
          return { items, nextCursor: more ? (items[items.length - 1]?.id ?? null) : null };
        },
      );
    });
  },
};
