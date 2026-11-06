import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm, stat, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, type FileObject } from '@srh/shared';
import { parse } from '../../lib/http';
import { apiTokenFor, requireProject, requireUser } from '../auth/guard';
import { trackOperationProject } from './runtime';
import {
  diskPath,
  getFile,
  getFileByPath,
  guessMime,
  MAX_FILE_BYTES,
  normalizePath,
  writeProjectFile,
} from '../files/service';

export const TRANSFER_CHUNK_BYTES = 256 * 1024;
const TTL = 24 * 60 * 60 * 1000;
export const TransferBeginInput = z.object({
  projectId: z.string().min(1),
  path: z.string().min(1),
  size: z.number().int().min(0).max(MAX_FILE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const TransferChunkInput = z.object({
  offset: z.number().int().min(0),
  base64: z.string().max(Math.ceil(TRANSFER_CHUNK_BYTES / 3) * 4),
});
export const TransferDownloadQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(TRANSFER_CHUNK_BYTES).default(TRANSFER_CHUNK_BYTES),
});

type Transfer = {
  id: string;
  projectId: string;
  path: string;
  size: number;
  sha256: string;
  userId: string;
  tokenId: string | null;
  offset: number;
  touched: number;
  file?: FileObject;
  queue: Promise<void>;
};
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const absent = () => new ApiError('not_found', '传输不存在或已过期');

/** 注册在 /api/v1 下。暂存状态属于当前实例，重启后需重新开始传输。 */
export function registerTransferRoutes(app: FastifyInstance): void {
  const root = resolve(app.ctx.config.STORAGE_DIR, '.integration-transfers');
  const instance = join(root, randomUUID());
  const transfers = new Map<string, Transfer>();
  const publications = new Map<string, Promise<void>>();
  const ready = mkdir(instance, { recursive: true, mode: 0o700 });
  let closed = false;
  const cleanup = async () => {
    await ready;
    if (closed) return;
    const now = Date.now();
    await utimes(instance, new Date(), new Date());
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || join(root, entry.name) === instance) continue;
      const path = join(root, entry.name);
      const info = await stat(path).catch(() => null);
      if (info && now - info.mtimeMs > 2 * TTL) await rm(path, { recursive: true, force: true });
    }
    for (const [id, transfer] of transfers) {
      if (now - transfer.touched <= TTL) continue;
      await transfer.queue;
      if (Date.now() - transfer.touched <= TTL) continue;
      transfers.delete(id);
      await rm(join(instance, id), { force: true });
    }
  };
  const timer = setInterval(
    () => {
      void cleanup().catch((err: unknown) => app.log.error(err));
    },
    60 * 60 * 1000,
  );
  timer.unref();
  app.addHook('onClose', async () => {
    closed = true;
    clearInterval(timer);
    await ready;
    await Promise.all([...transfers.values()].map((t) => t.queue));
    transfers.clear();
    await rm(instance, { recursive: true, force: true });
  });

  const locked = async <T>(t: Transfer, fn: () => Promise<T>): Promise<T> => {
    const prev = t.queue;
    let release!: () => void;
    t.queue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await prev;
    try {
      if (transfers.get(t.id) !== t) throw absent();
      return await fn();
    } finally {
      release();
    }
  };
  // 不同上传也可能指向同一路径；发布检查与落盘必须在同一个临界区。
  const publishing = async <T>(t: Transfer, fn: () => Promise<T>): Promise<T> => {
    const key = `${t.projectId}:${t.path.toLowerCase()}`;
    const previous = publications.get(key) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>((done) => {
      release = done;
    });
    publications.set(key, pending);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (publications.get(key) === pending) publications.delete(key);
    }
  };
  const owned = async (req: FastifyRequest, id: string): Promise<Transfer> => {
    const user = await requireUser(req);
    const token = await apiTokenFor(req);
    const t = transfers.get(id);
    if (
      !t ||
      t.userId !== user.id ||
      t.tokenId !== (token?.id ?? null) ||
      Date.now() - t.touched > TTL
    )
      throw absent();
    await requireProject(req, t.projectId, 'write');
    trackOperationProject(req, t.projectId);
    t.touched = Date.now();
    return t;
  };

  app.post('/integrations/transfers', async (req, reply) => {
    const input = parse(TransferBeginInput, req.body);
    const { user } = await requireProject(req, input.projectId, 'write');
    const token = await apiTokenFor(req);
    const path = normalizePath(input.path);
    const active = [...transfers.values()].filter(
      (t) => t.userId === user.id && !t.file && Date.now() - t.touched <= TTL,
    );
    if (
      active.length >= 8 ||
      active.reduce((sum, t) => sum + t.size, 0) + input.size > 64 * 1024 * 1024
    )
      throw new ApiError('rate_limited', '未完成上传最多 8 个、总计 64 MiB，请完成或取消旧传输');
    if (await getFileByPath(app.ctx, input.projectId, path))
      throw new ApiError('conflict', '目标文件已存在');
    await ready;
    const id = randomUUID();
    const handle = await open(join(instance, id), 'wx', 0o600);
    await handle.close();
    transfers.set(id, {
      id,
      projectId: input.projectId,
      path,
      size: input.size,
      sha256: input.sha256,
      userId: user.id,
      tokenId: token?.id ?? null,
      offset: 0,
      touched: Date.now(),
      queue: Promise.resolve(),
    });
    return reply
      .status(201)
      .send({ transferId: id, chunkSize: TRANSFER_CHUNK_BYTES, expiresInSeconds: TTL / 1000 });
  });

  app.put<{ Params: { transferId: string } }>(
    '/integrations/transfers/:transferId/chunks',
    async (req) => {
      const t = await owned(req, req.params.transferId);
      const input = parse(TransferChunkInput, req.body);
      // Buffer.from 容忍无效编码，必须往返校验以免悄悄丢字节。
      const bytes = Buffer.from(input.base64, 'base64');
      if (
        !bytes.length ||
        bytes.toString('base64') !== input.base64 ||
        bytes.length > TRANSFER_CHUNK_BYTES
      )
        throw new ApiError('bad_request', '分块编码或长度无效');
      return locked(t, async () => {
        if (t.file) throw new ApiError('conflict', '传输已完成');
        if (input.offset + bytes.length > t.size || input.offset > t.offset)
          throw new ApiError('conflict', '分块偏移或长度无效');
        const handle = await open(join(instance, t.id), 'r+');
        try {
          if (input.offset < t.offset) {
            if (input.offset + bytes.length > t.offset)
              throw new ApiError('conflict', '分块与已有数据重叠');
            const existing = Buffer.alloc(bytes.length);
            const { bytesRead } = await handle.read(existing, 0, bytes.length, input.offset);
            if (bytesRead !== bytes.length || !existing.equals(bytes))
              throw new ApiError('conflict', '重复分块的内容不一致');
          } else {
            let written = 0;
            while (written < bytes.length)
              written += (
                await handle.write(bytes, written, bytes.length - written, t.offset + written)
              ).bytesWritten;
            t.offset += written;
          }
        } finally {
          await handle.close();
        }
        return { nextOffset: t.offset };
      });
    },
  );

  app.post<{ Params: { transferId: string } }>(
    '/integrations/transfers/:transferId/complete',
    async (req) => {
      const t = await owned(req, req.params.transferId);
      return locked(t, () =>
        publishing(t, async () => {
          if (t.file) return t.file;
          if (t.offset !== t.size) throw new ApiError('conflict', '文件尚未传完');
          const bytes = await readFile(join(instance, t.id));
          if (bytes.length !== t.size || hash(bytes) !== t.sha256)
            throw new ApiError('conflict', '文件摘要不匹配');
          const { actor } = await requireProject(req, t.projectId, 'write');
          if (await getFileByPath(app.ctx, t.projectId, t.path))
            throw new ApiError('conflict', '目标文件已存在');
          const { file } = await writeProjectFile(
            app.ctx,
            actor,
            t.projectId,
            t.path,
            bytes,
            guessMime(t.path),
          );
          t.file = file;
          await rm(join(instance, t.id), { force: true });
          return file;
        }),
      );
    },
  );

  app.delete<{ Params: { transferId: string } }>(
    '/integrations/transfers/:transferId',
    async (req, reply) => {
      const t = await owned(req, req.params.transferId);
      await locked(t, async () => {
        transfers.delete(t.id);
        await rm(join(instance, t.id), { force: true });
      });
      return reply.status(204).send();
    },
  );

  app.get<{ Params: { projectId: string; fileId: string } }>(
    '/projects/:projectId/files/:fileId/chunks',
    async (req) => {
      const { projectId, fileId } = req.params;
      await requireProject(req, projectId, 'view');
      const query = parse(TransferDownloadQuery, req.query);
      const row = await getFile(app.ctx, projectId, fileId);
      if (!row) throw new ApiError('not_found', '文件不存在');
      const bytes = await readFile(diskPath(app.ctx, projectId, row.path)).catch(
        (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') throw new ApiError('not_found', '文件内容已丢失');
          throw err;
        },
      );
      if (query.offset > bytes.length) throw new ApiError('bad_request', '读取偏移超出文件长度');
      const end = Math.min(query.offset + query.limit, bytes.length);
      return {
        fileId,
        size: bytes.length,
        sha256: hash(bytes),
        offset: query.offset,
        base64: bytes.subarray(query.offset, end).toString('base64'),
        nextOffset: end < bytes.length ? end : null,
      };
    },
  );
}
