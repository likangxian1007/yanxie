import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '@srh/shared';
import type { AppContext } from '../../context';
import { parse } from '../../lib/http';
import type { Operation } from './catalog';
import { bearerAuthFor, type BearerAuth } from './service';
import { authorizeOperationResultTarget } from './runtime';

export const ResultChunkQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(256 * 1024)
    .default(16 * 1024),
});
type Entry = {
  bytes: Buffer;
  tokenId: string;
  operation: Operation;
  target: Record<string, string>;
  mimeType: string;
  expires: number;
};
const caches = new WeakMap<AppContext, Map<string, Entry>>();
const permissionVersions = new WeakMap<AppContext, number>();
export const resultPermissionVersion = (ctx: AppContext) => permissionVersions.get(ctx) ?? 0;
const TTL = 15 * 60 * 1000;
const MAX_BYTES = 64 * 1024 * 1024;
function cache(ctx: AppContext) {
  let entries = caches.get(ctx);
  if (!entries) caches.set(ctx, (entries = new Map()));
  for (const [id, entry] of entries) if (entry.expires <= Date.now()) entries.delete(id);
  return entries;
}
function chunk(id: string, entry: Entry, offset = 0, limit = 16 * 1024) {
  const end = Math.min(offset + limit, entry.bytes.length);
  return {
    resultId: id,
    mimeType: entry.mimeType,
    encoding: 'base64',
    size: entry.bytes.length,
    offset,
    base64: entry.bytes.subarray(offset, end).toString('base64'),
    nextOffset: end < entry.bytes.length ? end : null,
    expiresAt: new Date(entry.expires).toISOString(),
  };
}
export function stageOperationResult(
  ctx: AppContext,
  auth: BearerAuth,
  operation: Operation,
  target: Record<string, string>,
  bytes: Buffer,
  mimeType: string,
  expectedPermissionVersion: number,
) {
  if (resultPermissionVersion(ctx) !== expectedPermissionVersion)
    throw new ApiError('conflict', '读取期间权限发生变化，请重新读取');
  if (bytes.length > MAX_BYTES)
    throw new ApiError('validation_failed', '结果超过 64 MiB，请使用业务分页或导出接口缩小范围');
  const entries = cache(ctx);
  let used = [...entries.values()].reduce((sum, entry) => sum + entry.bytes.length, 0);
  for (const [id, entry] of entries) {
    if (used + bytes.length <= MAX_BYTES) break;
    entries.delete(id);
    used -= entry.bytes.length;
  }
  const id = randomUUID();
  const entry: Entry = {
    bytes,
    tokenId: auth.token.id,
    operation,
    target,
    mimeType,
    expires: Date.now() + TTL,
  };
  entries.set(id, entry);
  return {
    ...chunk(id, entry),
    continuationOperation: 'GET /integrations/results/:resultId/chunks',
  };
}
export function registerResultRoutes(app: FastifyInstance) {
  // 聚合结果与间接资源引用无法仅凭一个 projectId 重新授权。权限变化时整体失效，
  // 同时覆盖全局列表、线程历史和研究条目引用；正常内容更新不影响固定结果。
  permissionVersions.set(app.ctx, 0);
  const off = app.ctx.bus.onEvent((event) => {
    if (
      [
        'project.updated',
        'member.joined',
        'member.updated',
        'member.removed',
        'share.updated',
        'thread.deleted',
        'document.deleted',
        'paper.deleted',
        'notebook.deleted',
        'file.deleted',
      ].includes(event.type)
    ) {
      permissionVersions.set(app.ctx, resultPermissionVersion(app.ctx) + 1);
      caches.get(app.ctx)?.clear();
    }
  });
  app.get<{ Params: { resultId: string } }>(
    '/integrations/results/:resultId/chunks',
    async (req) => {
      const auth = await bearerAuthFor(req);
      const entry = cache(app.ctx).get(req.params.resultId);
      if (!auth || !entry || entry.tokenId !== auth.token.id)
        throw new ApiError('not_found', '结果不存在或已过期，请重新读取');
      await authorizeOperationResultTarget(req, auth, entry.operation, entry.target);
      const { offset, limit } = parse(ResultChunkQuery, req.query);
      if (offset > entry.bytes.length) throw new ApiError('validation_failed', '偏移超出结果长度');
      return chunk(req.params.resultId, entry, offset, limit);
    },
  );
  app.addHook('onClose', async () => {
    off();
    caches.delete(app.ctx);
    permissionVersions.delete(app.ctx);
  });
}
