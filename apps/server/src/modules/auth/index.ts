import type { FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  ApiError,
  LoginInput,
  PasswordResetInput,
  PasswordResetRequestInput,
  RegisterInput,
  UpdateMeInput,
  type MeResponse,
} from '@srh/shared';
import type { AppConfig } from '../../config';
import { users } from '../../db/schema';
import { parse } from '../../lib/http';
import { sendMail } from '../../mail';
import { createPasswordReset, resetPassword } from './password-reset';
import type { ModuleDef } from '../types';
import { acceptInvite, checkInvite, listProjectsForUser } from '../projects/service';
import { apiTokenFor, assertAllowedOrigin, requireUser } from './guard';
import { createAuthRateLimiter, rateLimitOptionsFor, releaseRateLimiter } from './rate-limit';
import {
  authenticate,
  createSession,
  createUser,
  deleteSession,
  normalizeEmail,
  promoteConfiguredAdmin,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  toUser,
  tokenFromCookies,
} from './service';

/**
 * 注册、登录、会话 Cookie、当前用户（API.md §2.1）。
 * 权限守卫见 guard.ts（requireUser / requireProject / can），其他模块直接 import。
 */
function setSessionCookie(reply: FastifyReply, config: AppConfig, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.PUBLIC_URL.startsWith('https://'),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export const authModule: ModuleDef = {
  name: 'auth',
  owner: 'backend',
  register(app) {
    const ctx = app.ctx;
    const limiter = createAuthRateLimiter(rateLimitOptionsFor(ctx.config.NODE_ENV));
    app.addHook('onClose', async () => releaseRateLimiter(limiter));

    /** 限流时同时给出 Retry-After 头 */
    const limited = (reply: FastifyReply, fn: () => void) => {
      try {
        fn();
      } catch (err) {
        const sec = err instanceof ApiError ? err.details?.retryAfterSec : undefined;
        if (typeof sec === 'number') reply.header('Retry-After', String(sec));
        throw err;
      }
    };

    app.post('/auth/register', async (req, reply) => {
      assertAllowedOrigin(req);
      const input = parse(RegisterInput, req.body);
      limited(reply, () => limiter.beginRegister(req.ip));
      if (input.inviteToken) {
        // 与 acceptInvite 的校验一致（过期、邮箱、已用过的定向邀请）；新账号不可能是“被移出的成员”
        const { inv } = await checkInvite(ctx, input.inviteToken, input.email);
        if (inv.email && inv.acceptedAt) throw new ApiError('conflict', '这个邀请链接已经用过了');
      }
      const row = await promoteConfiguredAdmin(
        ctx.db.db,
        ctx.config.ADMIN_EMAILS,
        await createUser(ctx, input),
      );
      if (input.inviteToken) {
        await acceptInvite(ctx, input.inviteToken, row);
      }
      const token = await createSession(ctx, row.id, req.headers['user-agent']);
      setSessionCookie(reply, ctx.config, token);
      return reply.status(201).send(toUser(row));
    });

    app.post('/auth/login', async (req, reply) => {
      assertAllowedOrigin(req);
      const input = parse(LoginInput, req.body);
      const email = normalizeEmail(input.email);
      limited(reply, () => limiter.beginLogin(email, req.ip));
      const row = await promoteConfiguredAdmin(
        ctx.db.db,
        ctx.config.ADMIN_EMAILS,
        await authenticate(ctx, email, input.password),
      );
      limiter.loginSucceeded(email, req.ip);
      const token = await createSession(ctx, row.id, req.headers['user-agent']);
      setSessionCookie(reply, ctx.config, token);
      return reply.send(toUser(row));
    });

    // 找回密码：不管邮箱是否注册，响应都一样（202 + 同一句话），邮件在后台发，
    // 不让响应耗时暴露账号是否存在
    app.post('/auth/password/request-reset', async (req, reply) => {
      assertAllowedOrigin(req);
      const input = parse(PasswordResetRequestInput, req.body);
      const email = normalizeEmail(input.email);
      limited(reply, () => limiter.beginPasswordReset(email, req.ip));
      void createPasswordReset(ctx, email)
        .then(({ mail }) => (mail ? sendMail(ctx.config, mail, req.log) : null))
        .catch((err: Error) => req.log.warn({ error: err.message }, '[auth] 生成密码重置令牌失败'));
      return reply.status(202).send({ ok: true });
    });

    app.post('/auth/password/reset', async (req, reply) => {
      assertAllowedOrigin(req);
      const input = parse(PasswordResetInput, req.body);
      await resetPassword(ctx, input.token, input.password);
      // 所有会话都已删除（包括当前浏览器的），清掉 Cookie，让用户用新密码重新登录
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.send({ ok: true });
    });

    app.post('/auth/logout', async (req, reply) => {
      assertAllowedOrigin(req);
      const token = tokenFromCookies(req.cookies);
      if (token) await deleteSession(ctx, token);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.status(204).send();
    });

    app.get('/auth/me', async (req): Promise<MeResponse> => {
      const user = await requireUser(req);
      const token = await apiTokenFor(req);
      return {
        user,
        projects: await listProjectsForUser(ctx, user.id, token?.projectIds ?? []),
        isAdmin: user.isAdmin ?? false,
      };
    });

    app.patch('/auth/me', async (req) => {
      const user = await requireUser(req);
      const input = parse(UpdateMeInput, req.body);
      if (input.name === undefined && input.avatarColor === undefined) return user;
      const [row] = await ctx.db.db
        .update(users)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.avatarColor !== undefined ? { avatarColor: input.avatarColor } : {}),
        })
        .where(eq(users.id, user.id))
        .returning();
      return toUser(row!);
    });
  },
};
