import { randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { ApiError, newId } from '@srh/shared';
import type { AppContext } from '../../context';
import { authSessions, passwordResets, users } from '../../db/schema';
import type { MailMessage } from '../../mail';
import { hashPassword, hashToken, normalizeEmail } from './service';

/**
 * 找回密码（API.md §2.1）：
 * - 申请：邮箱存在才生成令牌并发信；不存在什么也不做。接口对两种情况的响应完全一样。
 * - 令牌：32 字节随机数（base64url），库里只存 SHA-256 与 user id；30 分钟过期；
 *   同一用户再申请时旧令牌全部删除；用过即删。
 * - 重置成功：改密码（与注册同样的规则和 scrypt 哈希）、删掉该用户全部令牌和全部登录会话。
 */
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
export const INVALID_RESET_TOKEN = '重置链接无效或已过期';

export interface ResetRequestResult {
  /** 账号存在时要发的邮件；不存在为 null */
  mail: MailMessage | null;
}

/** 生成令牌并作废旧令牌；返回待发邮件（账号不存在时为 null） */
export async function createPasswordReset(
  ctx: AppContext,
  rawEmail: string,
): Promise<ResetRequestResult> {
  const email = normalizeEmail(rawEmail);
  const [user] = await ctx.db.db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.email, email));
  if (!user) return { mail: null };
  const token = randomBytes(32).toString('base64url');
  await ctx.db.db.transaction(async (tx) => {
    await tx.delete(passwordResets).where(eq(passwordResets.userId, user.id));
    await tx.insert(passwordResets).values({
      id: newId('passwordReset'),
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    });
  });
  const link = `${ctx.config.PUBLIC_URL.replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
  return { mail: resetMail(user.email, user.name, link) };
}

/** 用令牌设新密码；令牌无效 / 过期 / 用过统一报 400 */
export async function resetPassword(ctx: AppContext, token: string, password: string) {
  const tokenHash = hashToken(token);
  const passwordHash = await hashPassword(password);
  const userId = await ctx.db.db.transaction(async (tx) => {
    // 先删再改：删除成功的那一个请求才算用掉令牌，并发重复提交只有一个生效
    const [row] = await tx
      .delete(passwordResets)
      .where(and(eq(passwordResets.tokenHash, tokenHash), gt(passwordResets.expiresAt, new Date())))
      .returning({ userId: passwordResets.userId });
    if (!row) return null;
    await tx.update(users).set({ passwordHash }).where(eq(users.id, row.userId));
    await tx.delete(passwordResets).where(eq(passwordResets.userId, row.userId));
    await tx.delete(authSessions).where(eq(authSessions.userId, row.userId));
    return row.userId;
  });
  if (!userId) {
    // 顺手清掉过期的同名令牌（若有）
    await ctx.db.db.delete(passwordResets).where(eq(passwordResets.tokenHash, tokenHash));
    throw new ApiError('bad_request', INVALID_RESET_TOKEN);
  }
  return userId;
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/**
 * 重置邮件：用户没有存语言偏好，所以中文在上、英文在下；同时给 HTML 与纯文本。
 */
export function resetMail(to: string, name: string, link: string): MailMessage {
  const subject = '重置你的研协密码 / Reset your Thinkloft password';
  const text = [
    `${name}，你好：`,
    '',
    '我们收到了重置你研协账号密码的请求。打开下面的链接设置新密码（30 分钟内有效，只能用一次）：',
    link,
    '',
    '如果不是你本人操作，忽略这封邮件即可，你的密码不会改变。',
    '',
    '——',
    '',
    `Hi ${name},`,
    '',
    'We received a request to reset the password for your Thinkloft account. Open the link below to set a new password (valid for 30 minutes, single use):',
    link,
    '',
    "If you didn't request this, you can ignore this email and your password will stay the same.",
  ].join('\n');
  const n = escapeHtml(name);
  const href = escapeHtml(link);
  const button = (label: string) =>
    `<p style="margin:20px 0"><a href="${href}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600">${label}</a></p>`;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;color:#1f2328;font-size:15px;line-height:1.6">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px">
<p>${n}，你好：</p>
<p>我们收到了重置你研协账号密码的请求。点下面的按钮设置新密码，链接 30 分钟内有效，只能用一次。</p>
${button('设置新密码')}
<p style="color:#6b7280;font-size:13px">如果按钮打不开，把这个链接复制到浏览器：<br><a href="${href}" style="color:#2563eb;word-break:break-all">${href}</a></p>
<p style="color:#6b7280;font-size:13px">如果不是你本人操作，忽略这封邮件即可，你的密码不会改变。</p>
<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
<p>Hi ${n},</p>
<p>We received a request to reset the password for your Thinkloft account. Use the button below to set a new password. The link is valid for 30 minutes and can be used once.</p>
${button('Set a new password')}
<p style="color:#6b7280;font-size:13px">If the button doesn't work, copy this link into your browser:<br><a href="${href}" style="color:#2563eb;word-break:break-all">${href}</a></p>
<p style="color:#6b7280;font-size:13px">If you didn't request this, you can ignore this email and your password will stay the same.</p>
</div></body></html>`;
  return { to, subject, html, text };
}
