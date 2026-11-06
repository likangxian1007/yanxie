import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { and, eq, gt } from 'drizzle-orm';
import { ApiError, newId, type User } from '@srh/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/client';
import { authSessions, users } from '../../db/schema';

/**
 * 账号、密码与登录会话。
 * - 密码：scrypt（N=16384, r=8, p=1），存 `scrypt$<salt>$<hash>`。
 * - 会话：Cookie `srh_session` 里放 32 字节随机 token，库里只存 SHA-256。
 */
const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = 'srh_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export type UserRow = typeof users.$inferSelect;

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarColor: row.avatarColor,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt.toISOString(),
    isAdmin: row.isAdmin,
  };
}

/** ADMIN_EMAILS（逗号分隔）规范化后的集合 */
export function configuredAdminEmails(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map((s) => normalizeEmail(s))
      .filter(Boolean),
  );
}

/**
 * ADMIN_EMAILS 里的邮箱在登录 / 注册 / 读会话时自动设为管理员（只升不降）。
 * 失败不影响登录本身。返回（可能已更新的）行。
 */
export async function promoteConfiguredAdmin(
  db: Db,
  adminEmails: string,
  row: UserRow,
): Promise<UserRow> {
  if (row.isAdmin || !adminEmails) return row;
  if (!configuredAdminEmails(adminEmails).has(normalizeEmail(row.email))) return row;
  try {
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, row.id));
    return { ...row, isAdmin: true };
  } catch {
    return row;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** 新用户的头像色：按邮箱散列到 0–7，同一个人在各处颜色稳定 */
export function avatarColorFor(seed: string): number {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 8;
}

export async function createUser(
  ctx: AppContext,
  input: { email: string; name: string; password: string },
): Promise<UserRow> {
  const email = normalizeEmail(input.email);
  const [existing] = await ctx.db.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));
  if (existing) throw new ApiError('conflict', '这个邮箱已经注册过了');
  const [row] = await ctx.db.db
    .insert(users)
    .values({
      id: newId('user'),
      email,
      name: input.name.trim(),
      passwordHash: await hashPassword(input.password),
      avatarColor: avatarColorFor(email),
    })
    .returning();
  if (!row) throw new ApiError('internal', '创建用户失败');
  return row;
}

export async function authenticate(ctx: AppContext, email: string, password: string) {
  const [row] = await ctx.db.db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)));
  // 用户不存在时也跑一次哈希，避免按耗时探测邮箱是否注册
  const ok = row
    ? await verifyPassword(password, row.passwordHash)
    : await verifyPassword(
        password,
        'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      );
  if (!row || !ok) throw new ApiError('unauthorized', '邮箱或密码不正确');
  return row;
}

/** 新建登录会话，返回原 token（只出现在 Cookie 里） */
export async function createSession(ctx: AppContext, userId: string, userAgent?: string) {
  const token = randomBytes(32).toString('base64url');
  await ctx.db.db.insert(authSessions).values({
    id: newId('authSession'),
    userId,
    tokenHash: hashToken(token),
    userAgent: userAgent?.slice(0, 300) ?? null,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

export async function deleteSession(ctx: AppContext, token: string) {
  await ctx.db.db.delete(authSessions).where(eq(authSessions.tokenHash, hashToken(token)));
}

/** 由 token 找到用户；过期或不存在返回 null。REST 与 /ws、/collab 共用。 */
export async function userFromToken(db: Db, token: string | undefined): Promise<UserRow | null> {
  if (!token) return null;
  const [row] = await db
    .select({ user: users })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(
      and(eq(authSessions.tokenHash, hashToken(token)), gt(authSessions.expiresAt, new Date())),
    );
  return row?.user ?? null;
}

/** 从 Cookie 头里取会话 token（/ws 握手时 @fastify/cookie 已解析到 req.cookies） */
export function tokenFromCookies(cookies: Record<string, string | undefined> | undefined) {
  return cookies?.[SESSION_COOKIE];
}
