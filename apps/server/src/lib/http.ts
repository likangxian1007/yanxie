import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError, type ZodType } from 'zod';
import { ApiError } from '@srh/shared';
import { recordOpsEvent } from './ops-events';

type Issue = { path: string; message: string };
const toIssues = (err: ZodError): Issue[] =>
  err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

/**
 * 校验失败时的总提示：第一条是中文原因就直接用它（多条时注明还有几处），
 * 否则（zod 默认英文）退回笼统提示；逐字段原因总在 details.issues 里。
 */
export function validationMessage(issues: Issue[]): string {
  const first = issues[0];
  if (!first || !/\p{Script=Han}/u.test(first.message)) return '提交的内容不符合要求';
  return issues.length > 1
    ? `${first.message}（另有 ${issues.length - 1} 处要修改）`
    : first.message;
}

/** 用共享 zod schema 校验请求；失败抛 422 validation_failed。 */
export function parse<T extends ZodType>(schema: T, data: unknown): ReturnType<T['parse']> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = toIssues(result.error);
    throw new ApiError('validation_failed', validationMessage(issues), { issues });
  }
  return result.data as ReturnType<T['parse']>;
}

export function notImplemented(what: string): never {
  throw new ApiError('not_implemented', `${what} 尚未实现`);
}

/** 统一错误响应：{ error: { code, message, details? } }，见 @srh/shared errors.ts */
export function registerErrorHandling(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | ApiError | ZodError, req, reply) => {
    if (err instanceof ApiError) {
      // 限流类错误统一带上 Retry-After 头（登录限流与 API 令牌限流共用，见 API.md §2.21）
      const retryAfter = err.details?.retryAfterSec;
      if (typeof retryAfter === 'number') reply.header('Retry-After', String(retryAfter));
      return reply.status(err.status).send(err.toBody());
    }
    if (err instanceof ZodError) {
      const issues = toIssues(err);
      return reply.status(422).send({
        error: {
          code: 'validation_failed',
          message: validationMessage(issues),
          details: { issues },
        },
      });
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, 'unhandled error');
      // 运维后台：按指纹合并计数（自己吞错误，不影响这次响应）
      const db = req.server.ctx?.db?.db;
      if (db) {
        void recordOpsEvent(db, {
          source: 'server',
          level: 'error',
          message: err.message || 'unhandled error',
          stack: err.stack,
          detail: {
            method: req.method,
            route: req.routeOptions?.url ?? req.url.split('?')[0],
            status,
          },
        });
      }
    }
    return reply.status(status).send({
      error: {
        code: status >= 500 ? 'internal' : 'bad_request',
        message: status >= 500 ? '服务器出错了，请稍后再试' : err.message,
      },
    });
  });
}
