import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Invite, Project } from '@srh/shared';
import {
  DEFAULT_RATE_LIMITS,
  WindowCounter,
  resetRateLimits,
  setRateLimitOverridesForTests,
  waitText,
} from '../src/modules/auth/rate-limit';
import { makeApp, setupProject, signup, type Session, type TestApp } from './helpers';

/**
 * 安全相关：登录 / 注册限流、写请求的 Origin（CSRF）校验。
 */
let t: TestApp;

beforeAll(async () => {
  t = await makeApp();
}, 60_000);

afterAll(async () => {
  await t?.close();
});

const login = (email: string, password: string, remoteAddress = '127.0.0.1') =>
  t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
    remoteAddress,
  });

describe('login rate limit', () => {
  it('5 failures per email+IP → 429 rate_limited, even with the right password', async () => {
    const s = await signup(t.app, '被爆破');
    for (let i = 0; i < 5; i++) {
      expect((await login(s.user.email, `wrong-${i}`)).statusCode).toBe(401);
    }
    // 大小写、首尾空格不同也算同一个邮箱
    const blocked = await login(` ${s.user.email.toUpperCase()} `, 'wrong-again');
    expect(blocked.statusCode).toBe(429);
    const body = blocked.json<{
      error: {
        code: string;
        message: string;
        details: { retryAfterSec: number; retryAfter: number };
      };
    }>();
    expect(body.error.code).toBe('rate_limited');
    // 中文提示写明要等多久（窗口 15 分钟 → “请 15 分钟后再试”）
    expect(body.error.message).toMatch(/^登录尝试过多，请 \d+ (分钟|秒)后再试$/u);
    expect(body.error.message).toContain('请 15 分钟后再试');
    expect(body.error.details.retryAfterSec).toBeGreaterThan(0);
    expect(body.error.details.retryAfterSec).toBeLessThanOrEqual(15 * 60);
    expect(body.error.details.retryAfter).toBe(body.error.details.retryAfterSec);
    expect(Number(blocked.headers['retry-after'])).toBe(body.error.details.retryAfterSec);

    const right = await login(s.user.email, 'password123');
    expect(right.statusCode).toBe(429);
    // 别的 IP 上的同一个邮箱不受影响（防止从外面把受害者锁死）
    expect((await login(s.user.email, 'password123', '10.9.9.9')).statusCode).toBe(200);

    // 测试钩子：清空计数后可以正常登录
    resetRateLimits();
    expect((await login(s.user.email, 'password123')).statusCode).toBe(200);
  });

  it('same IP (lab behind one NAT): different emails are limited independently', async () => {
    const ip = '172.16.0.1';
    const a = await signup(t.app, '同学甲');
    const b = await signup(t.app, '同学乙');
    for (let i = 0; i < 5; i++) {
      expect((await login(a.user.email, `wrong-${i}`, ip)).statusCode).toBe(401);
    }
    expect((await login(a.user.email, 'password123', ip)).statusCode).toBe(429);
    // 同一 NAT 后面的乙照常能登录、输错也只算自己的
    expect((await login(b.user.email, 'wrong', ip)).statusCode).toBe(401);
    expect((await login(b.user.email, 'password123', ip)).statusCode).toBe(200);
  });

  it('a successful login resets the email counter', async () => {
    const s = await signup(t.app, '手滑');
    for (let i = 0; i < 4; i++) {
      expect((await login(s.user.email, `wrong-${i}`)).statusCode).toBe(401);
    }
    expect((await login(s.user.email, 'password123')).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect((await login(s.user.email, `wrong-${i}`)).statusCode).toBe(401);
    }
    expect((await login(s.user.email, 'password123')).statusCode).toBe(429);
  });

  it('concurrent attempts are counted too', async () => {
    const s = await signup(t.app, '并发');
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => login(s.user.email, `wrong-${i}`)),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(7);
  });

  it('per-IP spraying ceiling (any emails) → 429 for that IP only', async () => {
    // 默认 100 次；单独建一个上限为 12 的应用，免得用例太慢
    setRateLimitOverridesForTests({ loginFailuresPerIp: 12 });
    let spray: TestApp;
    try {
      spray = await makeApp();
    } finally {
      setRateLimitOverridesForTests(null);
    }
    const sprayLogin = (email: string, remoteAddress: string) =>
      spray.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: 'guess' },
        remoteAddress,
      });
    try {
      const ip = '10.20.30.40';
      for (let i = 0; i < 12; i++) {
        // 每个邮箱只错 1 次，不会触发按邮箱 + IP 的限制
        expect((await sprayLogin(`spray${i}@example.com`, ip)).statusCode).toBe(401);
      }
      const blocked = await sprayLogin('spray-new@example.com', ip);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ error: { code: 'rate_limited' } });
      expect(blocked.json<{ error: { message: string } }>().error.message).toMatch(
        /登录尝试过多，请 \d+ (分钟|秒)后再试/u,
      );
      expect((await sprayLogin('spray-new@example.com', '10.20.30.41')).statusCode).toBe(401);
    } finally {
      await spray.close();
    }
  }, 60_000);

  it('default ceilings: per-IP spraying ceiling is far above the per-account limit', () => {
    expect(DEFAULT_RATE_LIMITS.loginFailuresPerEmailIp).toBe(5);
    expect(DEFAULT_RATE_LIMITS.loginFailuresPerIp).toBeGreaterThanOrEqual(100);
    expect(DEFAULT_RATE_LIMITS.registerPerIp).toBeGreaterThanOrEqual(50);
  });

  it('wait text: seconds under a minute, otherwise whole minutes (rounded up)', () => {
    expect(waitText(42)).toBe('42 秒');
    expect(waitText(60)).toBe('1 分钟');
    expect(waitText(150)).toBe('3 分钟');
    expect(waitText(0.2)).toBe('1 秒');
  });
});

describe('register rate limit', () => {
  let limited: TestApp;

  beforeAll(async () => {
    // 测试环境默认不限注册；这里单独建一个限额为 3 的应用
    setRateLimitOverridesForTests({ registerPerIp: 3 });
    try {
      limited = await makeApp();
    } finally {
      setRateLimitOverridesForTests(null);
    }
  }, 60_000);

  afterAll(async () => {
    await limited?.close();
  });

  const register = (n: number, remoteAddress: string) =>
    limited.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: `reg${n}-${Date.now()}@example.com`,
        name: '注册',
        password: 'password123',
      },
      remoteAddress,
    });

  it('per IP: over the limit → 429 with Retry-After; other IPs unaffected', async () => {
    for (let i = 0; i < 3; i++) expect((await register(i, '10.1.1.1')).statusCode).toBe(201);
    const blocked = await register(3, '10.1.1.1');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({
      error: { code: 'rate_limited', details: { retryAfterSec: expect.any(Number) } },
    });
    expect(blocked.json<{ error: { message: string } }>().error.message).toMatch(/注册太频繁/u);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await register(4, '10.1.1.2')).statusCode).toBe(201);
  });

  it('the default test app does not limit registrations', async () => {
    for (let i = 0; i < 12; i++) await signup(t.app);
  });
});

describe('WindowCounter', () => {
  it('sliding window, retry-after, reset, bounded size', () => {
    const c = new WindowCounter(2, 1000, 3);
    c.hit('a', 0);
    expect(c.blockedFor('a', 10)).toBeNull();
    c.hit('a', 100);
    expect(c.blockedFor('a', 200)).toBe(1);
    expect(c.blockedFor('a', 1001)).toBeNull(); // 第一次已滑出窗口
    c.reset('a');
    expect(c.blockedFor('a', 200)).toBeNull();
    for (const k of ['k1', 'k2', 'k3', 'k4', 'k5']) c.hit(k, 5000);
    expect(c.size).toBeLessThanOrEqual(3);
    // 最早的 key 被淘汰，最新的保留
    expect(c.blockedFor('k5', 5000)).toBeNull();
    c.hit('k5', 5001);
    expect(c.blockedFor('k5', 5002)).toBe(1);
  });
});

describe('Origin / CSRF check on writes', () => {
  let project: Project;
  let owner: Session;

  beforeAll(async () => {
    const s = await setupProject(t.app, []);
    project = s.project;
    owner = s.owner;
  });

  const send = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ) =>
    t.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { cookie: owner.cookie, ...headers },
      ...(payload ? { payload } : {}),
    });

  it('foreign Origin on a cookie-authenticated write → 403', async () => {
    const res = await send(
      'PATCH',
      `/projects/${project.id}`,
      { origin: 'http://evil.example' },
      { name: '被改了' },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: { code: 'forbidden', message: '请求来源不被允许' },
    });
    expect((await send('POST', '/projects', { origin: 'null' }, { name: 'x' })).statusCode).toBe(
      403,
    );
    // 无 body 的 POST（浏览器的“简单请求”）
    const inv = (
      await owner.req('POST', `/projects/${project.id}/invites`, { role: 'member' })
    ).json<Invite>();
    const s = await signup(t.app, '受害者');
    const accept = await t.app.inject({
      method: 'POST',
      url: `/api/v1/invites/${inv.token}/accept`,
      headers: { cookie: s.cookie, origin: 'http://sub.localhost:5173' },
    });
    expect(accept.statusCode).toBe(403);
    expect((await owner.req('GET', `/projects/${project.id}`)).json<Project>().name).toBe(
      '图对比学习',
    );
  });

  it('PUBLIC_URL origin and same-host origin are allowed; GET is never blocked', async () => {
    const ok = await send(
      'PATCH',
      `/projects/${project.id}`,
      { origin: t.config.PUBLIC_URL },
      { description: '来自前端' },
    );
    expect(ok.statusCode).toBe(200);
    const same = await send(
      'PATCH',
      `/projects/${project.id}`,
      { origin: 'https://srh.example.com', host: 'srh.example.com' },
      { description: '同源' },
    );
    expect(same.statusCode).toBe(200);
    const read = await send('GET', `/projects/${project.id}`, { origin: 'http://evil.example' });
    expect(read.statusCode).toBe(200);
  });

  it('no Origin: Sec-Fetch-Site cross-site → 403; same-origin / absent → allowed', async () => {
    const cross = await send(
      'PATCH',
      `/projects/${project.id}`,
      { 'sec-fetch-site': 'cross-site' },
      { description: 'x' },
    );
    expect(cross.statusCode).toBe(403);
    const sameSite = await send(
      'PATCH',
      `/projects/${project.id}`,
      { 'sec-fetch-site': 'same-origin' },
      { description: 'y' },
    );
    expect(sameSite.statusCode).toBe(200);
    const none = await send('PATCH', `/projects/${project.id}`, {}, { description: 'z' });
    expect(none.statusCode).toBe(200);
  });

  it('login / register / logout check the Origin too', async () => {
    const evil = { origin: 'http://evil.example' };
    const reg = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: evil,
      payload: { email: `csrf${Date.now()}@example.com`, name: '跨站', password: 'password123' },
    });
    expect(reg.statusCode).toBe(403);
    const lg = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: evil,
      payload: { email: owner.user.email, password: 'password123' },
    });
    expect(lg.statusCode).toBe(403);
    const out = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...evil, cookie: owner.cookie },
    });
    expect(out.statusCode).toBe(403);
    // 会话没被登出
    expect((await owner.req('GET', '/auth/me')).statusCode).toBe(200);

    const fromWeb = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: t.config.PUBLIC_URL },
      payload: { email: owner.user.email, password: 'password123' },
    });
    expect(fromWeb.statusCode).toBe(200);
  });
});
