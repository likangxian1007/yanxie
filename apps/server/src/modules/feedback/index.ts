import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import multipart from '@fastify/multipart';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ApiError,
  ClientErrorInput,
  CreateChangelogInput,
  CreateTicketInput,
  CreateTicketMessageInput,
  FEEDBACK_MAX_ATTACHMENT_BYTES,
  FEEDBACK_MAX_ATTACHMENTS,
  FEEDBACK_MAX_LOGS,
  FeedbackContext,
  MarkNotificationsReadInput,
  TicketListQuery,
  UpdateChangelogInput,
  UpdateTicketInput,
  UserNotificationQuery,
  type User,
} from '@srh/shared';
import { WindowCounter } from '../auth/rate-limit';
import { membership, requireUser } from '../auth/guard';
import { parse } from '../../lib/http';
import { recordOpsEvent } from '../../lib/ops-events';
import type { ModuleDef } from '../types';
import {
  addMessage,
  assertUploadCounts,
  attachmentPath,
  createChangelog,
  createTicket,
  deleteChangelog,
  findAttachment,
  isParty,
  listChangelog,
  listNotifications,
  listTickets,
  markNotificationsRead,
  markTicketRead,
  prepareUpload,
  setVote,
  ticketDetail,
  updateChangelog,
  updateTicket,
  viewableTicket,
  type PendingUpload,
  type Viewer,
} from './service';

/**
 * 反馈中心（feat/feedback-center）：工单、建议投票、更新日志、个人站内通知、前端报错上报。
 *
 *   POST   /feedback/tickets                       建工单（JSON 或 multipart：files 截图 ≤5×8MB，logs 诊断日志 ≤3×1MB）
 *   GET    /feedback/tickets                       列表（scope=mine|waiting|all …）
 *   GET    /feedback/tickets/:no                   详情（同时记已读）
 *   PATCH  /feedback/tickets/:no                   管理员改状态/优先级/负责人/roadmap/标题/类型；提交人只能关闭
 *   POST   /feedback/tickets/:no/messages          回复（JSON 或 multipart）
 *   POST   /feedback/tickets/:no/read              记已读
 *   POST|DELETE /feedback/tickets/:no/vote         建议投票 / 撤票
 *   GET    /feedback/tickets/:no/attachments/:id   下载附件（日志只给提交人与管理员）
 *   GET    /changelog  POST /changelog  PATCH|DELETE /changelog/:id
 *   GET    /me/notifications  POST /me/notifications/read
 *   POST   /feedback/client-errors                 前端报错 → 运维事件（source=web）
 */
type NoParams = { no: string };

export function viewerOf(user: User): Viewer {
  return { id: user.id, name: user.name, isAdmin: user.isAdmin === true };
}

export async function requireAdminUser(req: FastifyRequest): Promise<Viewer> {
  const v = viewerOf(await requireUser(req));
  if (!v.isAdmin) throw new ApiError('forbidden', '只有管理员能访问');
  return v;
}

function limiter(limit: number, windowMs: number) {
  const c = new WindowCounter(limit, windowMs, 10_000);
  return (key: string) => {
    const wait = c.blockedFor(key);
    if (wait !== null) {
      throw new ApiError('rate_limited', `操作太频繁了，请 ${wait} 秒后再试`, {
        retryAfterSec: wait,
      });
    }
    c.hit(key);
  };
}

interface ParsedBody {
  fields: Record<string, string>;
  uploads: PendingUpload[];
}

/** JSON 直接返回；multipart 收集字段与文件（files / logs），逐个校验 */
async function readBody(req: FastifyRequest): Promise<ParsedBody | null> {
  if (!req.isMultipart()) return null;
  const fields: Record<string, string> = {};
  const uploads: PendingUpload[] = [];
  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const data = await part.toBuffer();
        if (part.fieldname !== 'files' && part.fieldname !== 'logs') continue;
        uploads.push(prepareUpload(part.fieldname, part.filename, data));
        assertUploadCounts(uploads);
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE')
      throw new ApiError('payload_too_large', '每张截图不能超过 8 MB，每份日志不能超过 1 MB');
    if (code === 'FST_FILES_LIMIT') throw new ApiError('payload_too_large', '附件数量超过上限');
    if (code?.startsWith('FST_')) throw new ApiError('bad_request', '上传内容无法解析');
    throw err;
  }
  return { fields, uploads };
}

function parseContextField(raw: string | undefined) {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ApiError('validation_failed', 'context 不是合法的 JSON', {
      issues: [{ path: 'context', message: 'JSON 解析失败' }],
    });
  }
  return parse(FeedbackContext, value);
}

export const feedbackModule: ModuleDef = {
  name: 'feedback',
  owner: 'backend',
  async register(app) {
    const ctx = app.ctx;
    const createLimit = limiter(15, 60 * 60 * 1000);
    const messageLimit = limiter(30, 10 * 60 * 1000);
    const uploadLimit = limiter(40, 10 * 60 * 1000);
    const clientErrorLimit = limiter(30, 60 * 1000);
    const pollLimit = limiter(60, 60 * 1000);
    /** 每个附件记一次上传额度 */
    const chargeUploads = (userId: string, n: number) => {
      for (let i = 0; i < n; i += 1) uploadLimit(userId);
    };

    await app.register(async (api) => {
      await api.register(multipart, {
        limits: {
          fileSize: FEEDBACK_MAX_ATTACHMENT_BYTES,
          files: FEEDBACK_MAX_ATTACHMENTS + FEEDBACK_MAX_LOGS,
          fields: 20,
          fieldSize: 64 * 1024,
        },
      });

      api.post('/feedback/tickets', async (req, reply) => {
        const v = viewerOf(await requireUser(req));
        createLimit(v.id);
        const mp = await readBody(req);
        const input = mp
          ? parse(CreateTicketInput, {
              kind: mp.fields.kind,
              title: mp.fields.title,
              body: mp.fields.body ?? '',
              projectId: mp.fields.projectId || null,
              context: parseContextField(mp.fields.context),
              priority: mp.fields.priority || undefined,
            })
          : parse(CreateTicketInput, req.body);
        chargeUploads(v.id, mp?.uploads.length ?? 0);
        // 只挂自己是成员的项目；不是成员 / 不存在就不挂（不报错，也不泄露项目是否存在）
        const wantedProject = input.projectId ?? input.context?.projectId ?? null;
        const projectId =
          wantedProject && (await membership(req, wantedProject, v.id)) ? wantedProject : null;
        const row = await createTicket(
          ctx,
          v,
          {
            kind: input.kind,
            title: input.title,
            body: input.body,
            projectId,
            context: input.context ?? null,
            priority: input.priority,
          },
          mp?.uploads ?? [],
        );
        reply.code(201);
        return ticketDetail(ctx, row, v);
      });

      api.get('/feedback/tickets', async (req) => {
        const v = viewerOf(await requireUser(req));
        return listTickets(ctx, v, parse(TicketListQuery, req.query));
      });

      api.get<{ Params: NoParams }>('/feedback/tickets/:no', async (req) => {
        const v = viewerOf(await requireUser(req));
        const t = await viewableTicket(ctx, req.params.no, v);
        await markTicketRead(ctx, t, v.id);
        return ticketDetail(ctx, t, v);
      });

      api.patch<{ Params: NoParams }>('/feedback/tickets/:no', async (req) => {
        const v = viewerOf(await requireUser(req));
        const t = await viewableTicket(ctx, req.params.no, v);
        const row = await updateTicket(ctx, t, v, parse(UpdateTicketInput, req.body));
        return ticketDetail(ctx, row, v);
      });

      api.post<{ Params: NoParams }>('/feedback/tickets/:no/messages', async (req, reply) => {
        const v = viewerOf(await requireUser(req));
        messageLimit(v.id);
        const t = await viewableTicket(ctx, req.params.no, v);
        const mp = await readBody(req);
        const { body } = parse(CreateTicketMessageInput, mp ? { body: mp.fields.body } : req.body);
        chargeUploads(v.id, mp?.uploads.length ?? 0);
        const row = await addMessage(ctx, t, v, body, mp?.uploads ?? []);
        reply.code(201);
        return ticketDetail(ctx, row, v);
      });

      api.post<{ Params: NoParams }>('/feedback/tickets/:no/read', async (req) => {
        const v = viewerOf(await requireUser(req));
        const t = await viewableTicket(ctx, req.params.no, v);
        await markTicketRead(ctx, t, v.id);
        return { ok: true };
      });

      api.post<{ Params: NoParams }>('/feedback/tickets/:no/vote', async (req) => {
        const v = viewerOf(await requireUser(req));
        return setVote(ctx, await viewableTicket(ctx, req.params.no, v), v, true);
      });
      api.delete<{ Params: NoParams }>('/feedback/tickets/:no/vote', async (req) => {
        const v = viewerOf(await requireUser(req));
        return setVote(ctx, await viewableTicket(ctx, req.params.no, v), v, false);
      });

      api.get<{ Params: NoParams & { id: string } }>(
        '/feedback/tickets/:no/attachments/:id',
        async (req, reply: FastifyReply) => {
          const v = viewerOf(await requireUser(req));
          const t = await viewableTicket(ctx, req.params.no, v);
          const meta = await findAttachment(ctx, t, req.params.id);
          if (!meta) throw new ApiError('not_found', '附件不存在');
          if (meta.kind === 'log' && !isParty(t, v)) {
            throw new ApiError('forbidden', '诊断日志只有提交人和管理员能下载');
          }
          const abs = attachmentPath(ctx, meta);
          if (!abs) throw new ApiError('not_found', '附件不存在');
          const st = await stat(abs).catch(() => null);
          if (!st?.isFile()) throw new ApiError('not_found', '附件文件已丢失');
          const encoded = encodeURIComponent(meta.name);
          reply
            .header('X-Content-Type-Options', 'nosniff')
            .header('Cache-Control', 'private, no-cache')
            .header('Content-Security-Policy', 'sandbox')
            .header('Content-Length', String(st.size));
          if (meta.kind === 'log') {
            reply
              .type('text/plain; charset=utf-8')
              .header(
                'Content-Disposition',
                `attachment; filename="log.txt"; filename*=UTF-8''${encoded}`,
              );
          } else {
            reply
              .type(meta.mime)
              .header(
                'Content-Disposition',
                `inline; filename="image"; filename*=UTF-8''${encoded}`,
              );
          }
          return reply.send(createReadStream(abs));
        },
      );
    });

    // ------------------------------------------------------------ 更新日志
    app.get('/changelog', async (req) => {
      const v = viewerOf(await requireUser(req));
      return listChangelog(ctx, v.isAdmin);
    });
    app.post('/changelog', async (req, reply) => {
      const v = await requireAdminUser(req);
      reply.code(201);
      return createChangelog(ctx, v, parse(CreateChangelogInput, req.body));
    });
    app.patch<{ Params: { id: string } }>('/changelog/:id', async (req) => {
      await requireAdminUser(req);
      return updateChangelog(ctx, req.params.id, parse(UpdateChangelogInput, req.body));
    });
    app.delete<{ Params: { id: string } }>('/changelog/:id', async (req, reply) => {
      await requireAdminUser(req);
      await deleteChangelog(ctx, req.params.id);
      return reply.code(204).send();
    });

    // ------------------------------------------------------------ 站内通知
    app.get('/me/notifications', async (req) => {
      const v = viewerOf(await requireUser(req));
      pollLimit(v.id);
      const q = parse(UserNotificationQuery, req.query);
      return listNotifications(ctx, v.id, {
        unreadOnly: q.unread === '1' || q.unread === 'true',
        limit: q.limit,
      });
    });
    app.post('/me/notifications/read', async (req) => {
      const v = viewerOf(await requireUser(req));
      const input = parse(MarkNotificationsReadInput, req.body ?? {});
      await markNotificationsRead(ctx, v.id, input.all || !input.ids ? null : input.ids);
      return listNotifications(ctx, v.id, { unreadOnly: false, limit: 50 });
    });

    // ------------------------------------------------------------ 前端报错
    app.post('/feedback/client-errors', async (req, reply) => {
      const v = viewerOf(await requireUser(req));
      clientErrorLimit(v.id);
      const input = parse(ClientErrorInput, req.body);
      await recordOpsEvent(ctx.db.db, {
        source: 'web',
        level: input.level,
        message: input.message,
        stack: input.stack,
        detail: {
          url: input.url,
          route: input.route,
          userAgent: input.userAgent,
          appVersion: input.appVersion,
          userId: v.id,
        },
      });
      return reply.code(204).send();
    });
  },
};
