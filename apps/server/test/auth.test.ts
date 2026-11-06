import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Invite, MeResponse, User } from '@srh/shared';
import { makeApp, sessionFor, setupProject, signup, type TestApp } from './helpers';

/**
 * 认证与用户（API.md §2.1）：注册、登录、会话 Cookie、/auth/me、登出、带邀请注册。
 */
let t: TestApp;

beforeAll(async () => {
  t = await makeApp();
}, 60_000);

afterAll(async () => {
  await t?.close();
});

const post = (url: string, payload: object, cookie?: string) =>
  t.app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    payload,
    ...(cookie ? { headers: { cookie } } : {}),
  });

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? (raw[0] as string) : (raw as string | undefined);
  return first ?? '';
}

describe('register', () => {
  it('201 + HttpOnly session cookie; email normalized; no password hash leaked', async () => {
    // 邮箱先 trim 再校验，服务端再转小写
    const ok = await post('/auth/register', {
      email: '  Alice@Example.com ',
      name: ' 爱丽丝 ',
      password: 'password123',
    });
    expect(ok.statusCode).toBe(201);
    const user = ok.json<User & { passwordHash?: string }>();
    expect(user).toMatchObject({ email: 'alice@example.com', name: '爱丽丝', avatarUrl: null });
    expect(user.avatarColor).toBeGreaterThanOrEqual(0);
    expect(user.avatarColor).toBeLessThanOrEqual(7);
    expect(user.passwordHash).toBeUndefined();
    const cookie = cookieOf(ok);
    expect(cookie).toMatch(/^srh_session=[^;]+/u);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
  });

  it('duplicate email (case-insensitive) → 409 conflict', async () => {
    const res = await post('/auth/register', {
      email: 'ALICE@example.com',
      name: '另一个',
      password: 'password123',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'conflict' } });
  });

  it('invalid input → 422 with issues', async () => {
    const res = await post('/auth/register', {
      email: 'x@example.com',
      name: '短',
      password: '123',
    });
    expect(res.statusCode).toBe(422);
    const body = res.json<{ error: { code: string; details: { issues: { path: string }[] } } }>();
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details.issues.map((i) => i.path)).toContain('password');
    const notEmail = await post('/auth/register', {
      email: '  not-an-email ',
      name: '张三',
      password: 'password123',
    });
    expect(notEmail.statusCode).toBe(422);
  });

  it('Korean / Chinese / English names with a valid 8-char password register fine', async () => {
    for (const [i, name] of ['이강현', '张三', 'Kang Li', 'José Ñ'].entries()) {
      const res = await post('/auth/register', {
        email: ` Name${i}-${Date.now()}@Example.com\u200b `,
        name,
        password: 'abcd1234',
      });
      expect(res.statusCode, name).toBe(201);
      expect(res.json<{ name: string }>().name).toBe(name);
    }
  });

  it('every invalid field gets its own Chinese reason', async () => {
    const res = await post('/auth/register', { email: 'nope', name: '  ', password: 'abc' });
    expect(res.statusCode).toBe(422);
    const body = res.json<{
      error: { message: string; details: { issues: { path: string; message: string }[] } };
    }>();
    expect(body.error.details.issues).toEqual(
      expect.arrayContaining([
        { path: 'email', message: '邮箱格式不对，应类似 you@lab.edu.cn' },
        { path: 'name', message: '请填写姓名' },
        { path: 'password', message: '密码至少 8 位（现在 3 位）' },
      ]),
    );
    expect(body.error.message).toMatch(/（另有 2 处要修改）$/u);
    const login = await post('/auth/login', { email: '', password: '' });
    expect(login.statusCode).toBe(422);
    expect(
      login.json<{ error: { details: { issues: { path: string; message: string }[] } } }>().error
        .details.issues,
    ).toEqual(
      expect.arrayContaining([
        { path: 'email', message: '请填写邮箱' },
        { path: 'password', message: '请填写密码' },
      ]),
    );
  });

  it('weak passwords (all digits / one repeated char) → 422 with a Chinese message', async () => {
    for (const password of ['12345678', '0000000000', 'aaaaaaaa', '........']) {
      const res = await post('/auth/register', {
        email: `weak${Date.now()}@example.com`,
        name: '弱密码',
        password,
      });
      expect(res.statusCode, password).toBe(422);
      const body = res.json<{
        error: { message: string; details: { issues: { path: string; message: string }[] } };
      }>();
      const expected = /^\d+$/u.test(password)
        ? '密码太简单：不能全是数字，请加上字母或符号'
        : '密码太简单：不能全是同一个字符';
      expect(body.error.details.issues).toEqual([{ path: 'password', message: expected }]);
      // 总提示直接说出原因，而不是笼统的「提交的内容不符合要求」
      expect(body.error.message).toBe(expected);
    }
    const ok = await post('/auth/register', {
      email: `strong${Date.now()}@example.com`,
      name: '强密码',
      password: '1234567a',
    });
    expect(ok.statusCode).toBe(201);
  });
});

describe('login / me / logout', () => {
  it('login ok sets a working cookie; wrong password / unknown email → 401', async () => {
    const bad = await post('/auth/login', { email: 'alice@example.com', password: 'wrong-pass' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ error: { code: 'unauthorized' } });
    const unknown = await post('/auth/login', { email: 'nobody@example.com', password: 'x' });
    expect(unknown.statusCode).toBe(401);

    const ok = await post('/auth/login', { email: ' ALICE@example.com ', password: 'password123' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<User>().email).toBe('alice@example.com');
    const cookie = cookieOf(ok).split(';')[0]!;
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json<MeResponse>()).toMatchObject({
      user: { email: 'alice@example.com' },
      projects: [],
    });
  });

  it('/auth/me without or with a bogus cookie → 401', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/auth/me' })).statusCode).toBe(401);
    const bogus = await t.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: 'srh_session=nope' },
    });
    expect(bogus.statusCode).toBe(401);
  });

  it('/auth/me lists projects with role and unread', async () => {
    const { project, owner, others } = await setupProject(t.app, ['advisor']);
    const advisor = others[0]!;
    const me = (await advisor.req('GET', '/auth/me')).json<MeResponse>();
    expect(me.user.id).toBe(advisor.user.id);
    expect(me.projects).toHaveLength(1);
    expect(me.projects[0]).toMatchObject({
      id: project.id,
      name: '图对比学习',
      role: 'advisor',
      unread: 0,
    });
    const mine = (await owner.req('GET', '/auth/me')).json<MeResponse>();
    expect(mine.projects.map((p) => [p.id, p.role])).toEqual([[project.id, 'owner']]);
    // eventSeq = 该项目当前最新的事件 seq（前端 /ws 订阅的补发下界）
    expect(mine.projects[0]!.eventSeq).toBe(await t.app.ctx.bus.latestSeq(project.id));
  });

  it('PATCH /auth/me updates name / avatarColor; invalid → 422; empty → unchanged', async () => {
    const s = await signup(t.app, '改名前');
    const res = await s.req('PATCH', '/auth/me', { name: '  改名后 ', avatarColor: 5 });
    expect(res.statusCode).toBe(200);
    expect(res.json<User>()).toMatchObject({ id: s.user.id, name: '改名后', avatarColor: 5 });
    expect((await s.req('GET', '/auth/me')).json<MeResponse>().user.name).toBe('改名后');
    expect((await s.req('PATCH', '/auth/me', { avatarColor: 9 })).statusCode).toBe(422);
    expect((await s.req('PATCH', '/auth/me', { name: '' })).statusCode).toBe(422);
    const same = await s.req('PATCH', '/auth/me', {});
    expect(same.json<User>()).toMatchObject({ name: '改名后', avatarColor: 5 });
    const anon = await t.app.inject({ method: 'PATCH', url: '/api/v1/auth/me', payload: {} });
    expect(anon.statusCode).toBe(401);
  });

  it('logout → 204, clears cookie, old token no longer works; other sessions survive', async () => {
    const s = await signup(t.app, '登出者');
    const login = await post('/auth/login', { email: s.user.email, password: 'password123' });
    const other = sessionFor(t.app, s.user, cookieOf(login).split(';')[0]!);

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: s.cookie },
    });
    expect(res.statusCode).toBe(204);
    expect(cookieOf(res)).toMatch(/^srh_session=;/u);
    expect((await s.req('GET', '/auth/me')).statusCode).toBe(401);
    expect((await other.req('GET', '/auth/me')).statusCode).toBe(200);
    // 未登录时登出也是 204
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/auth/logout' })).statusCode).toBe(
      204,
    );
  });
});

describe('register with inviteToken', () => {
  it('joins the project with the invited role and is logged in', async () => {
    const { project, owner } = await setupProject(t.app, []);
    const inv = (
      await owner.req('POST', `/projects/${project.id}/invites`, { role: 'guest' })
    ).json<Invite>();
    const res = await post('/auth/register', {
      email: `invitee${Date.now()}@example.com`,
      name: '新人',
      password: 'password123',
      inviteToken: inv.token,
    });
    expect(res.statusCode).toBe(201);
    const s = sessionFor(t.app, res.json<User>(), cookieOf(res).split(';')[0]!);
    const me = (await s.req('GET', '/auth/me')).json<MeResponse>();
    expect(me.projects.map((p) => [p.id, p.role])).toEqual([[project.id, 'guest']]);
    const evs = await t.app.ctx.bus.listSince(project.id, 0, 1000);
    expect(
      evs.some(
        (e) =>
          e.type === 'member.joined' &&
          e.payload.user.id === s.user.id &&
          e.payload.role === 'guest',
      ),
    ).toBe(true);
  });

  it('targeted invite for another email → 403', async () => {
    const { project, owner } = await setupProject(t.app, []);
    const inv = (
      await owner.req('POST', `/projects/${project.id}/invites`, {
        role: 'member',
        email: 'someone-else@example.com',
      })
    ).json<Invite>();
    const email = `wrong${Date.now()}@example.com`;
    const res = await post('/auth/register', {
      email,
      name: '冒名',
      password: 'password123',
      inviteToken: inv.token,
    });
    expect(res.statusCode).toBe(403);
    // 邀请无效时不留下账号：去掉邀请重新注册仍然成功
    const retry = await post('/auth/register', { email, name: '冒名', password: 'password123' });
    expect(retry.statusCode).toBe(201);
  });
});
