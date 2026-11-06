import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Multipart } from '@fastify/multipart';
import { and, eq, lt, sql } from 'drizzle-orm';
import { ApiError, newId, type AccessLevel, type ShareResourceKind } from '@srh/shared';
import {
  apiOperationAudit,
  apiOperationRequests,
  apiTokenWriteUsage,
  projects,
  versions,
  changeProposals,
} from '../../db/schema';
import type { Operation, OperationCatalog } from './catalog';
import type { OperationArguments } from '../mcp/operation-tools';
import { assertTokenProject, bearerAuthFor, bearerFromHeader, type BearerAuth } from './service';
import { operationInvocation } from './invocation-context';
import { resultPermissionVersion, stageOperationResult } from './results';
import { diskPath, getFile, MAX_FILE_BYTES } from '../files/service';

const states = new WeakMap<
  FastifyRequest,
  {
    auth: BearerAuth;
    operation: Operation;
    started: number;
    target: Record<string, string>;
    requestId: string;
    retryId?: string;
    replay?: boolean;
    errorCode?: string;
  }
>();
const semanticReads = new WeakSet<FastifyRequest>();
export const tokenRequestMethod = (req: FastifyRequest) =>
  semanticReads.has(req) ? 'GET' : req.method;

export function trackOperationProject(req: FastifyRequest, projectId: string): void {
  const state = states.get(req);
  if (state) state.target.projectId = projectId;
}

/** 收据记录业务守卫实际检查过的资源，不让调用参数替换授权对象。 */
export function trackOperationResource(
  req: FastifyRequest,
  projectId: string,
  kind: ShareResourceKind,
  id: string,
  need: AccessLevel,
): void {
  const state = states.get(req);
  if (!state) return;
  const index = Number(state.target.resourceCount ?? 0);
  state.target[`resource${index}ProjectId`] = projectId;
  state.target[`resource${index}Kind`] = kind;
  state.target[`resource${index}Id`] = id;
  state.target[`resource${index}Need`] = need;
  state.target.resourceCount = String(index + 1);
}

/** 重放与分段结果仍按当前成员、角色及分享权限检查，不能把历史成功当永久授权。 */
export async function authorizeOperationResultTarget(
  req: FastifyRequest,
  auth: BearerAuth,
  op: Operation,
  target: Record<string, string>,
): Promise<void> {
  const projectId = target.projectId;
  if (!projectId) return;
  assertTokenProject(auth.token, projectId);
  const [project] = await req.server.ctx.db.db
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project || project.archivedAt) throw new ApiError('not_found', '项目不存在');
  if (target.threadId) {
    const { requireVisibleThread } = await import('../threads/service');
    await requireVisibleThread(req.server.ctx, projectId, target.threadId, auth.user.id);
  }
  if (target.resourceCount) {
    const { requireResource } = await import('../sharing/service');
    for (let i = 0; i < Number(target.resourceCount); i++) {
      await requireResource(
        req,
        target[`resource${i}ProjectId`]!,
        target[`resource${i}Kind`] as ShareResourceKind,
        target[`resource${i}Id`]!,
        target[`resource${i}Need`] as AccessLevel,
      );
    }
    return;
  }
  let docId = target.docId ?? (target.targetKind === 'document' ? target.targetId : undefined);
  const paperId = target.paperId ?? (target.targetKind === 'paper' ? target.targetId : undefined);
  if (!docId && target.versionId) {
    const [version] = await req.server.ctx.db.db
      .select()
      .from(versions)
      .where(and(eq(versions.projectId, projectId), eq(versions.id, target.versionId)));
    if (!version) throw new ApiError('not_found', '版本不存在');
    if (version.targetKind === 'document') docId = version.targetId;
  }
  if (!docId && target.proposalId && !op.path.includes('/plans/')) {
    const [proposal] = await req.server.ctx.db.db
      .select()
      .from(changeProposals)
      .where(
        and(eq(changeProposals.projectId, projectId), eq(changeProposals.id, target.proposalId)),
      );
    if (!proposal) throw new ApiError('not_found', '提案不存在');
    if (proposal.targetKind === 'document') docId = proposal.targetId;
  }
  const shareId =
    target.id && (target.kind === 'document' || target.kind === 'paper') ? target.id : undefined;
  if (docId || paperId || shareId) {
    const { loadResource } = await import('../sharing/service');
    const { accessOf } = await import('../sharing/access');
    const { memberRole } = await import('../collab-common/guard');
    const kind = docId ? 'document' : paperId ? 'paper' : (target.kind as 'document' | 'paper');
    const resource = await loadResource(req.server.ctx, kind, (docId ?? paperId ?? shareId)!);
    const role = await memberRole(req.server.ctx, projectId, auth.user.id);
    const level =
      resource && resource.projectId === projectId
        ? await accessOf(req.server.ctx, resource, { userId: auth.user.id, role })
        : 'none';
    if (level === 'none') throw new ApiError('not_found', '资源不存在，或你没有访问权限');
    if (
      op.effect !== 'read' &&
      op.id !== 'POST /share/:token' &&
      (level === 'view' || level === 'comment')
    )
      throw new ApiError('forbidden', '资源不再允许编辑');
    if (op.path.includes('/shares/') && op.effect !== 'read' && level !== 'manage')
      throw new ApiError('forbidden', '只有所有者能管理分享');
  } else {
    const { requireProject } = await import('../auth/guard');
    await requireProject(req, projectId, op.effect === 'read' ? 'view' : 'write');
  }
}

function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Buffer.isBuffer(value))
    return JSON.stringify({ sha256: createHash('sha256').update(value).digest('hex') });
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(',')}}`;
}

/** 暂存分块不算发布；一次完成文件发布才消耗一次业务写额度。 */
function billable(op: Operation): boolean {
  return (
    op.effect !== 'read' &&
    !(
      /^\/api\/v1\/integrations\/transfers(?:\/|$)/u.test(op.path) && !op.path.endsWith('/complete')
    )
  );
}

export function installIntegrationRuntime(app: FastifyInstance, catalog: OperationCatalog): void {
  const cleanup = setInterval(() => {
    void app.ctx.db.db
      .delete(apiOperationAudit)
      .where(lt(apiOperationAudit.createdAt, new Date(Date.now() - 30 * 24 * 3600 * 1000)))
      .catch((err) => app.log.error({ err }, 'integration audit cleanup failed'));
  }, 3600_000);
  cleanup.unref();
  app.addHook('onClose', async () => {
    clearInterval(cleanup);
  });
  app.addHook('onRoute', (route) => catalog.registerRoute(route));
  app.addHook('preValidation', async (req, reply) => {
    if (!req.url.startsWith('/api/v1/')) return;
    // Transport authentication has its own HTTP challenge and cannot be recursively invoked.
    if (req.routeOptions.url === '/api/v1/mcp') return;
    if (!bearerFromHeader(req.headers.authorization)) return;
    const auth = await bearerAuthFor(req);
    if (!auth) return;
    const operation = catalog.getByRoute(
      req.method === 'HEAD' ? 'GET' : req.method,
      req.routeOptions.url ?? '',
    );
    if (!operation) throw new ApiError('forbidden', '这个操作需要在网页中完成');
    const target = Object.fromEntries(
      Object.entries(req.params as Record<string, unknown>).filter(
        ([key, value]) =>
          !/token|secret|key/iu.test(key) && typeof value === 'string' && value.length <= 200,
      ),
    ) as Record<string, string>;
    const targetInput =
      req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE'
        ? req.query
        : req.body;
    for (const key of ['targetKind', 'targetId']) {
      const value = (targetInput as Record<string, unknown> | null)?.[key];
      if (typeof value === 'string' && value.length <= 200) target[key] = value;
    }
    const bodyProjectId = (req.body as { projectId?: unknown } | null)?.projectId;
    if (!target.projectId && typeof bodyProjectId === 'string') target.projectId = bodyProjectId;
    const requestId = operationInvocation.getStore()?.requestId ?? req.id;
    states.set(req, { auth, operation, started: Date.now(), target, requestId });
    reply.header('X-Operation-Request-Id', requestId);
    if (operation.access !== 'open') throw new ApiError('forbidden', '这个操作需要在网页中完成');
    if (operation.effect === 'read') semanticReads.add(req);
    else if (!auth.token.scopes.includes('write'))
      throw new ApiError('forbidden', '这个令牌只有只读权限，不能修改或执行');
    const params = req.params as Record<string, string>;
    if (params.projectId) assertTokenProject(auth.token, params.projectId);
    if (operation.id === 'POST /projects' && auth.token.projectIds.length)
      throw new ApiError('forbidden', '限定项目的令牌不能创建范围外项目');
    const bodyKey = (req.body as { idempotencyKey?: unknown } | null)?.idempotencyKey;
    if (req.headers['idempotency-key'] && bodyKey && req.headers['idempotency-key'] !== bodyKey)
      throw new ApiError('validation_failed', '请求头与请求体幂等键不一致');
    const key = req.headers['idempotency-key'] ?? bodyKey;
    if (key !== undefined && (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/u.test(key))) {
      throw new ApiError('validation_failed', '幂等键必须为 8–128 位字母、数字、下划线或短横线');
    }
    if (typeof key === 'string' && billable(operation)) {
      let body = req.body;
      if (req.isMultipart?.()) {
        const parts: Multipart[] = [];
        const summary = [];
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            const bytes = await part.toBuffer();
            parts.push({
              ...part,
              file: Object.assign(Readable.from(bytes), {
                truncated: false,
                bytesRead: bytes.length,
              }),
              toBuffer: async () => bytes,
            });
            summary.push({
              name: part.fieldname,
              filename: part.filename,
              mime: part.mimetype,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            });
          } else {
            parts.push(part);
            summary.push({ name: part.fieldname, value: part.value });
          }
        }
        req.parts = async function* () {
          for (const part of parts) yield part;
        } as typeof req.parts;
        body = summary;
      }
      const requestHash = createHash('sha256')
        .update(stable({ params: req.params, query: req.query, body }))
        .digest('hex');
      const id = newId('apiOperationRequest');
      const inserted = await app.ctx.db.db
        .insert(apiOperationRequests)
        .values({ id, tokenId: auth.token.id, operationId: operation.id, key, requestHash })
        .onConflictDoNothing()
        .returning();
      if (!inserted.length) {
        const [prior] = await app.ctx.db.db
          .select()
          .from(apiOperationRequests)
          .where(
            and(
              eq(apiOperationRequests.tokenId, auth.token.id),
              eq(apiOperationRequests.operationId, operation.id),
              eq(apiOperationRequests.key, key),
            ),
          );
        if (!prior || prior.requestHash !== requestHash)
          throw new ApiError('conflict', '这个幂等键已用于不同请求');
        await authorizeOperationResultTarget(req, auth, operation, prior.target);
        if (prior.status === 'pending')
          throw new ApiError(
            'conflict',
            '同一操作正在执行，或上次结果尚未确认；请查询目标状态，不要换键重试',
            { requestId: prior.id, state: 'pending_or_unknown' },
          );
        const state = states.get(req)!;
        state.replay = true;
        reply.header('Idempotency-Replayed', 'true');
        reply.type(prior.responseType ?? 'application/json');
        return reply.status(prior.responseStatus ?? 500).send(prior.responseBody ?? '');
      }
      states.get(req)!.retryId = id;
    }
    if (billable(operation)) {
      const day = new Date().toISOString().slice(0, 10);
      const result = await app.ctx.db.db
        .insert(apiTokenWriteUsage)
        .values({ tokenId: auth.token.id, day, used: 1 })
        .onConflictDoUpdate({
          target: [apiTokenWriteUsage.tokenId, apiTokenWriteUsage.day],
          set: { used: sql`${apiTokenWriteUsage.used} + 1` },
          setWhere: lt(apiTokenWriteUsage.used, app.ctx.config.MCP_WRITE_PER_DAY),
        })
        .returning();
      if (!result.length) {
        const state = states.get(req)!;
        if (state.retryId) {
          await app.ctx.db.db
            .delete(apiOperationRequests)
            .where(eq(apiOperationRequests.id, state.retryId));
          state.retryId = undefined;
        }
        throw new ApiError('rate_limited', '这个令牌今天的写操作额度已用满，读操作不受影响', {
          retryAfterSec: 3600,
        });
      }
    }
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const state = states.get(req);
    if (state && reply.statusCode >= 400 && typeof payload === 'string') {
      try {
        state.errorCode = (JSON.parse(payload) as { error?: { code?: string } }).error?.code;
      } catch {
        /* non-JSON error */
      }
    }
    if (state?.retryId && !state.replay) {
      // Mutating operations return JSON; unknown/streaming outcomes remain blocked rather than replayed unsafely.
      const body =
        typeof payload === 'string'
          ? payload
          : Buffer.isBuffer(payload)
            ? payload.toString('utf8')
            : payload === null || payload === undefined
              ? ''
              : undefined;
      if (body !== undefined && Buffer.byteLength(body) <= 24 * 1024 * 1024) {
        // 无项目路径的创建／分享解析也需把实际目标写入收据，供重放重新授权。
        try {
          const result = JSON.parse(body) as {
            projectId?: string;
            id?: string;
            resourceKind?: string;
            resourceId?: string;
          };
          if (!state.target.projectId && result.projectId)
            state.target.projectId = result.projectId;
          if (state.operation.id === 'POST /projects' && result.id)
            state.target.projectId = result.id;
          if (
            state.operation.id === 'POST /share/:token' &&
            result.resourceId &&
            result.resourceKind
          ) {
            state.target.kind = result.resourceKind;
            state.target.id = result.resourceId;
          }
        } catch {
          /* Empty or binary responses have no target metadata. */
        }
        try {
          await app.ctx.db.db
            .update(apiOperationRequests)
            .set({
              status: 'completed',
              target: state.target,
              responseStatus: reply.statusCode,
              responseBody: body,
              responseType: String(reply.getHeader('content-type') ?? 'application/json'),
              completedAt: new Date(),
            })
            .where(eq(apiOperationRequests.id, state.retryId));
        } catch {
          // 保持 pending，避免重试重复执行；不要把带业务响应参数的 SQL 错误写入日志。
          app.log.error(
            { requestId: state.requestId, operationId: state.operation.id },
            'integration retry receipt persistence failed',
          );
        }
      }
    }
    return payload;
  });
  app.addHook('onResponse', async (req, reply) => {
    const state = states.get(req);
    if (!state) return;
    await app.ctx.db.db.insert(apiOperationAudit).values({
      id: newId('apiOperationAudit'),
      requestId: state.requestId,
      tokenId: state.auth.token.id,
      userId: state.auth.user.id,
      operationId: state.operation.id,
      target: state.target,
      status: reply.statusCode,
      errorCode: state.errorCode,
      elapsedMs: Date.now() - state.started,
    });
  });
}

/** Invoke only a registered route with the original user's identity; the request still traverses every business guard. */
export async function invokeOperation(
  app: FastifyInstance,
  auth: BearerAuth,
  raw: string,
  op: Operation,
  args: OperationArguments,
  requestId?: string,
): Promise<unknown> {
  const permissionVersion = resultPermissionVersion(app.ctx);
  if (op.access !== 'open') throw new ApiError('forbidden', '这个操作需要在网页中完成');
  const expected = op.input.params;
  for (const name of expected)
    if (!args.params?.[name]) throw new ApiError('validation_failed', `缺少路径参数 ${name}`);
  let url = op.path.replace(/:([A-Za-z0-9_]+)/gu, (_, name: string) =>
    encodeURIComponent(args.params![name]!),
  );
  if (url.includes('*')) {
    if (!args.params?.['*']) throw new ApiError('validation_failed', '缺少通配路径参数 *');
    url = url.replace('*', encodeURIComponent(args.params['*']));
  }
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(args.query ?? {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object')
      throw new ApiError('validation_failed', '查询参数必须是字符串、数字或布尔值');
    query.set(key, String(value));
  }
  if (query.size) url += `?${query}`;
  let payload = args.body;
  const headers: Record<string, string> = {
    authorization: `Bearer ${raw}`,
    ...(args.idempotencyKey ? { 'idempotency-key': args.idempotencyKey } : {}),
  };
  if (args.transfer) {
    if (args.body !== undefined)
      throw new ApiError(
        'validation_failed',
        '文件传输与 JSON 正文不能同时提供；multipart 元数据请放在 fields',
      );
    const binary = op.id === 'POST /projects/:projectId/docs/import';
    const multipart = [
      'POST /projects/:projectId/files',
      'POST /projects/:projectId/library/papers',
      'POST /projects/:projectId/library/papers/:paperId/pdf',
    ].includes(op.id);
    if (
      (!binary && !multipart) ||
      (binary && args.transfer.encoding !== 'base64') ||
      (multipart && args.transfer.encoding !== 'multipart')
    )
      throw new ApiError('validation_failed', '这个操作不接受指定的文件传输格式');
    const file = args.transfer.encoding === 'base64' ? args.transfer : args.transfer.file;
    let bytes: Buffer;
    if (file.fileId) {
      const projectId = args.params?.projectId;
      if (!projectId) throw new ApiError('validation_failed', '引用文件需要 projectId');
      assertTokenProject(auth.token, projectId);
      const { memberRole } = await import('../collab-common/guard');
      if (!(await memberRole(app.ctx, projectId, auth.user.id)))
        throw new ApiError('not_found', '项目不存在');
      const stored = await getFile(app.ctx, projectId, file.fileId);
      if (!stored) throw new ApiError('not_found', '文件不存在');
      bytes = await readFile(diskPath(app.ctx, projectId, stored.path));
    } else {
      bytes = Buffer.from(file.base64!, 'base64');
      if (bytes.toString('base64') !== file.base64)
        throw new ApiError('validation_failed', '文件编码无效');
    }
    if (bytes.length > MAX_FILE_BYTES) throw new ApiError('validation_failed', '文件超过 20 MiB');
    if (args.transfer.encoding === 'base64') {
      payload = bytes;
      headers['content-type'] = 'application/octet-stream';
    } else {
      const boundary = `srh-${randomUUID()}`;
      const escape = (value: string) => value.replace(/[\r\n"\\]/gu, '_');
      const parts: Buffer[] = [];
      for (const [key, value] of Object.entries(args.transfer.fields ?? {}))
        parts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${escape(key)}"\r\n\r\n${value}\r\n`,
          ),
        );
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${escape(args.transfer.file.filename)}"\r\nContent-Type: ${escape(args.transfer.file.mimeType ?? 'application/octet-stream')}\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      );
      payload = Buffer.concat(parts);
      headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
    }
  }
  const response = await operationInvocation.run({ auth, method: op.method, url, requestId }, () =>
    app.inject({
      method: op.method as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
      url,
      headers,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    }),
  );
  const type = String(response.headers['content-type'] ?? '');
  const continuation =
    response.headers['x-next-event-seq'] !== undefined
      ? { afterSeq: Number(response.headers['x-next-event-seq']) }
      : undefined;
  let data: unknown;
  if (type.includes('json')) data = response.body ? response.json() : null;
  else
    data = {
      mimeType: type,
      encoding: 'base64',
      base64: response.rawPayload.toString('base64'),
      size: response.rawPayload.length,
    };
  if (response.statusCode >= 400) {
    const error = (
      data as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }
    )?.error;
    throw new ApiError(
      (error?.code ?? 'internal') as ConstructorParameters<typeof ApiError>[0],
      error?.message ?? '操作失败',
      { ...error?.details, httpStatus: response.statusCode },
    );
  }
  if (
    response.rawPayload.length > 64 * 1024 &&
    op.id !== 'GET /integrations/results/:resultId/chunks'
  ) {
    const target = Object.fromEntries(expected.map((name) => [name, args.params![name]!]));
    const source =
      op.method === 'GET' || op.method === 'DELETE'
        ? args.query
        : (args.body as Record<string, unknown> | undefined);
    for (const key of ['targetKind', 'targetId'])
      if (typeof source?.[key] === 'string') target[key] = source[key];
    return {
      status: response.statusCode,
      data: stageOperationResult(
        app.ctx,
        auth,
        op,
        target,
        response.rawPayload,
        type,
        permissionVersion,
      ),
      segmented: true,
      ...(continuation ? { continuation } : {}),
    };
  }
  return {
    status: response.statusCode,
    data,
    ...(continuation ? { continuation } : {}),
    ...(response.headers['idempotency-replayed'] ? { replayed: true } : {}),
  };
}
