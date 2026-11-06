import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { passwordResets } from '../src/db/schema';
import { setMailSenderForTests, type MailMessage } from '../src/mail';
import { resetRateLimits } from '../src/modules/auth/rate-limit';
import { RESET_TOKEN_TTL_MS } from '../src/modules/auth/password-reset';
import { makeApp, signup, sleep, type TestApp } from './helpers';

/**
 * 找回密码（API.md §2.1）：令牌生命周期、过期、一次性、新申请作废旧令牌、
 * 重置后所有会话失效、限流、不泄露邮箱是否注册。
 */
let t: TestApp;
let outbox: MailMessage[] = [];

beforeAll(async () => {
  t = await makeApp({ PUBLIC_URL: 'https://co.example.io/app' });
}, 60_000);

afterAll(async () => {
  setMailSenderForTests(null);
  await t?.close();
});

beforeEach(() => {
  outbox = [];
  resetRateLimits();
  setMailSenderForTests((m) => {
    outbox.push(m);
  });
});

afterEach(() => setMailSenderForTests(null));

const post = (url: string, payload: object, extra: { cookie?: string; ip?: string } = {}) =>
  t.app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    payload,
    ...(extra.ip ? { remoteAddress: extra.ip } : {}),
    ...(extra.cookie ? { headers: { cookie: extra.cookie } } : {}),
  });

/** 等后台发信完成 */
async function waitMail(count = 1) {
  for (let i = 0; i < 200 && outbox.length < count; i++) await sleep(10);
  return outbox;
}

function tokenFrom(mail: MailMessage): string {
  const m = /reset-password\?token=([A-Za-z0-9_-]+)/u.exec(mail.text);
  if (!m) throw new Error('邮件里没有重置链接');
  return m[1]!;
}

async function requestToken(email: string): Promise<string> {
  const before = outbox.length;
  const res = await post('/auth/password/request-reset', { email });
  expect(res.statusCode).toBe(202);
  const box = await waitMail(before + 1);
  return tokenFrom(box[box.length - 1]!);
}

describe('request-reset', () => {
  it('sends a bilingual html+text mail with a PUBLIC_URL link; stores only the hash', async () => {
    const s = await signup(t.app);
    const res = await post('/auth/password/request-reset', {
      email: ` ${s.user.email.toUpperCase()} `,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });
    const [mail] = await waitMail();
    expect(mail!.to).toBe(s.user.email);
    expect(mail!.text).toContain('https://co.example.io/app/reset-password?token=');
    expect(mail!.html).toContain('https://co.example.io/app/reset-password?token=');
    expect(mail!.text).toContain('重置');
    expect(mail!.text).toContain('reset');
    const token = tokenFrom(mail!);
    expect(Buffer.from(token, 'base64url').length).toBeGreaterThanOrEqual(32);
    const rows = await t.db.db
      .select()
      .from(passwordResets)
      .where(eq(passwordResets.userId, s.user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toContain(token);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/u);
    const ttl = rows[0]!.expiresAt.getTime() - rows[0]!.createdAt.getTime();
    expect(Math.abs(ttl - RESET_TOKEN_TTL_MS)).toBeLessThan(5_000);
  });

  it('unknown email gets the exact same response and no mail (no enumeration)', async () => {
    const s = await signup(t.app);
    const known = await post('/auth/password/request-reset', { email: s.user.email });
    const unknown = await post('/auth/password/request-reset', {
      email: 'nobody-here@example.com',
    });
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.body).toBe(known.body);
    await waitMail(1);
    await sleep(50);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe(s.user.email);
  });

  it('rejects an invalid email with 422', async () => {
    const res = await post('/auth/password/request-reset', { email: 'not-an-email' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_failed');
  });

  it('rate-limits 3 per email per window, same for unknown emails, with Retry-After', async () => {
    for (const email of ['ghost@example.com', (await signup(t.app)).user.email]) {
      for (let i = 0; i < 3; i++) {
        const ok = await post('/auth/password/request-reset', { email }, { ip: `10.0.0.${i + 1}` });
        expect(ok.statusCode).toBe(202);
      }
      const blocked = await post('/auth/password/request-reset', { email }, { ip: '10.0.0.9' });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('rate_limited');
      expect(blocked.json().error.message).toMatch(/^重置请求太频繁，请 \d+ (秒|分钟)后再试$/u);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    }
  });

  it('rate-limits per IP across many emails', async () => {
    for (let i = 0; i < 20; i++) {
      const ok = await post(
        '/auth/password/request-reset',
        { email: `spray${i}@example.com` },
        { ip: '10.9.9.9' },
      );
      expect(ok.statusCode).toBe(202);
    }
    const blocked = await post(
      '/auth/password/request-reset',
      { email: 'spray-last@example.com' },
      { ip: '10.9.9.9' },
    );
    expect(blocked.statusCode).toBe(429);
  });
});

describe('reset', () => {
  it('sets the new password, kills all sessions, token is single-use', async () => {
    const s = await signup(t.app);
    // 另一台设备上的会话
    const login2 = await post('/auth/login', { email: s.user.email, password: 'password123' });
    const cookie2 = String(login2.headers['set-cookie']).split(';')[0]!;
    const token = await requestToken(s.user.email);

    const ok = await post('/auth/password/reset', { token, password: 'n3w-passw0rd' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });

    for (const cookie of [s.cookie, cookie2]) {
      const me = await t.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie },
      });
      expect(me.statusCode).toBe(401);
    }
    const oldPw = await post('/auth/login', { email: s.user.email, password: 'password123' });
    expect(oldPw.statusCode).toBe(401);
    const newPw = await post('/auth/login', { email: s.user.email, password: 'n3w-passw0rd' });
    expect(newPw.statusCode).toBe(200);

    const again = await post('/auth/password/reset', { token, password: 'another-pass1' });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.message).toBe('重置链接无效或已过期');
  });

  it('a newer request invalidates the older token', async () => {
    const s = await signup(t.app);
    const first = await requestToken(s.user.email);
    const second = await requestToken(s.user.email);
    expect(second).not.toBe(first);
    const old = await post('/auth/password/reset', { token: first, password: 'n3w-passw0rd' });
    expect(old.statusCode).toBe(400);
    const fresh = await post('/auth/password/reset', { token: second, password: 'n3w-passw0rd' });
    expect(fresh.statusCode).toBe(200);
  });

  it('expired token is rejected', async () => {
    const s = await signup(t.app);
    const token = await requestToken(s.user.email);
    await t.db.db
      .update(passwordResets)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(passwordResets.userId, s.user.id));
    const res = await post('/auth/password/reset', { token, password: 'n3w-passw0rd' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
    const login = await post('/auth/login', { email: s.user.email, password: 'password123' });
    expect(login.statusCode).toBe(200);
  });

  it('garbage token → 400; weak password → 422 and token stays usable', async () => {
    const bad = await post('/auth/password/reset', { token: 'nope', password: 'n3w-passw0rd' });
    expect(bad.statusCode).toBe(400);
    const s = await signup(t.app);
    const token = await requestToken(s.user.email);
    const weak = await post('/auth/password/reset', { token, password: '12345678' });
    expect(weak.statusCode).toBe(422);
    expect(weak.json().error.details.issues[0].path).toBe('password');
    const ok = await post('/auth/password/reset', { token, password: 'n3w-passw0rd' });
    expect(ok.statusCode).toBe(200);
  });
});
