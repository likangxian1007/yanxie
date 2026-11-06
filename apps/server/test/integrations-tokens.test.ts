import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type ApiTokenCreated, type ApiTokenList, type Project } from '@srh/shared';
import { createDb } from '../src/db/client';
import { migrationsFolder } from '../src/db/migrate';
import { apiTokens, users } from '../src/db/schema';
import { makeApp, setupProject, signup, type Session, type TestApp } from './helpers';

/**
 * 接入：API 令牌（API.md §2.21）。
 * 四类用例：成功、未登录 401、无权限 403/404、参数错 422；另加撤销 / 过期 / 限项目 / 限流 / 开关。
 */
let t: TestApp;
let project: Project;
let otherProject: Project;
let owner: Session;
let member: Session;

const READ = ['read'];
const WRITE = ['read', 'write'];

beforeAll(async () => {
  t = await makeApp({ API_TOKENS_ENABLED: 'true' });
  const setup = await setupProject(t.app, ['member', 'guest']);
  project = setup.project;
  owner = setup.owner;
  member = setup.others[0]!;
  const other = await owner.req('POST', '/projects', { name: '另一个课题' });
  otherProject = other.json<Project>();
}, 60_000);

afterAll(async () => {
  await t?.close();
});

async function createToken(
  session: Session,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; data: ApiTokenCreated }> {
  const res = await session.req('POST', '/auth/me/tokens', body);
  return { statusCode: res.statusCode, data: res.json<ApiTokenCreated>() };
}

/** 用 Bearer 调用（不经过 Cookie 简写） */
interface BearerResponse {
  statusCode: number;
  body: string;
  json: <T = unknown>() => T;
}

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  raw: string,
  payload?: unknown,
): Promise<BearerResponse> {
  const res = await t.app.inject({
    method,
    url: url.startsWith('/api') ? url : `/api/v1${url}`,
    headers: { authorization: `Bearer ${raw}` },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return {
    statusCode: res.statusCode,
    body: res.body,
    json: <T = unknown>() => res.json() as T,
  };
}

describe('令牌管理（只认网页登录）', () => {
  it('未登录 → 401', async () => {
    for (const [method, url] of [
      ['GET', '/auth/me/tokens'],
      ['POST', '/auth/me/tokens'],
      ['DELETE', '/auth/me/tokens/tok_x'],
    ] as const) {
      const res = await t.app.inject({
        method,
        url: `/api/v1${url}`,
        ...(method === 'POST' ? { payload: { name: 'x' } } : {}),
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('创建返回一次原文，列表只回 hint', async () => {
    const { statusCode, data } = await createToken(owner, {
      name: '我的 dots',
      scopes: READ,
      projectIds: [project.id],
      expiresInDays: 30,
    });
    expect(statusCode).toBe(201);
    expect(data.token.startsWith('srh_pat_')).toBe(true);
    expect(data.token.length).toBeGreaterThan(40);
    expect(data.apiToken.hint).toHaveLength(8);
    expect(data.token).toContain(data.apiToken.hint);
    expect(data.apiToken.scopes).toEqual(READ);
    expect(data.apiToken.projectIds).toEqual([project.id]);
    expect(data.apiToken.expiresAt).not.toBeNull();
    expect(data.apiToken.revokedAt).toBeNull();

    const list = await owner.req('GET', '/auth/me/tokens');
    const body = list.json<ApiTokenList>();
    expect(body.enabled).toBe(true);
    const mine = body.tokens.find((x) => x.id === data.apiToken.id);
    expect(mine?.hint).toBe(data.apiToken.hint);
    // 原文绝不出现在列表里
    expect(list.body.includes(data.token)).toBe(false);
  });

  it('参数错 → 422（名字空 / 权限空 / 天数越界 / 项目不是成员）', async () => {
    const cases: unknown[] = [
      { name: '   ', scopes: READ },
      { name: 'x', scopes: [] },
      { name: 'x', scopes: READ, expiresInDays: 0 },
      { name: 'x', scopes: READ, expiresInDays: 400 },
    ];
    for (const body of cases) {
      const res = await owner.req('POST', '/auth/me/tokens', body);
      expect(res.statusCode).toBe(422);
    }
    // 别人的项目：不是成员 → 422
    const outsider = await signup(t.app, '外人');
    const foreign = await outsider.req('POST', '/projects', { name: '别人的课题' });
    const bad = await createToken(owner, {
      name: '越权试试',
      scopes: READ,
      projectIds: [foreign.json<Project>().id],
    });
    expect(bad.statusCode).toBe(422);
  });

  it('令牌不能创建或撤销令牌 → 403', async () => {
    const { data } = await createToken(owner, { name: 'write', scopes: WRITE });
    const created = await call('POST', '/auth/me/tokens', data.token, { name: '偷偷再造' });
    expect(created.statusCode).toBe(403);
    const revoked = await call('DELETE', `/auth/me/tokens/${data.apiToken.id}`, data.token);
    expect(revoked.statusCode).toBe(403);
  });

  it('撤销幂等；不能撤别人的令牌（404）', async () => {
    const { data } = await createToken(owner, { name: '待撤', scopes: READ });
    expect((await member.req('DELETE', `/auth/me/tokens/${data.apiToken.id}`)).statusCode).toBe(
      404,
    );
    expect((await owner.req('DELETE', `/auth/me/tokens/${data.apiToken.id}`)).statusCode).toBe(204);
    expect((await owner.req('DELETE', `/auth/me/tokens/${data.apiToken.id}`)).statusCode).toBe(204);
    const list = (await owner.req('GET', '/auth/me/tokens')).json<ApiTokenList>();
    expect(list.tokens.find((x) => x.id === data.apiToken.id)?.revokedAt).not.toBeNull();
  });
});

describe('用令牌调用接口', () => {
  it('读时间线等同于本人登录', async () => {
    const { data } = await createToken(owner, { name: '读', scopes: READ });
    const me = await call('GET', '/auth/me', data.token);
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: { id: string } }>().user.id).toBe(owner.user.id);

    const timeline = await call('GET', `/projects/${project.id}/timeline`, data.token);
    expect(timeline.statusCode).toBe(200);

    const used = (await owner.req('GET', '/auth/me/tokens')).json<ApiTokenList>();
    expect(used.tokens.find((x) => x.id === data.apiToken.id)?.lastUsedAt).not.toBeNull();
  });

  it('撤销后立刻 401；非法令牌 401', async () => {
    const { data } = await createToken(owner, { name: '撤了', scopes: READ });
    expect((await call('GET', `/projects/${project.id}/timeline`, data.token)).statusCode).toBe(
      200,
    );
    await owner.req('DELETE', `/auth/me/tokens/${data.apiToken.id}`);
    expect((await call('GET', `/projects/${project.id}/timeline`, data.token)).statusCode).toBe(
      401,
    );
    expect((await call('GET', '/projects', 'srh_pat_not-a-real-token')).statusCode).toBe(401);
  });

  it('只读令牌写操作 403；可写令牌能发消息', async () => {
    const ro = await createToken(owner, { name: '只读', scopes: READ });
    const blocked = await call('POST', `/projects/${project.id}/timeline`, ro.data.token, {
      body: '只读令牌不该发出这条',
    });
    expect(blocked.statusCode).toBe(403);

    const rw = await createToken(owner, { name: '可写', scopes: WRITE });
    const ok = await call('POST', `/projects/${project.id}/timeline`, rw.data.token, {
      body: '来自令牌的一条消息',
    });
    expect(ok.statusCode).toBe(201);
  });

  it('只读令牌在协作模块的写接口同样 403（collab-common 身份链）', async () => {
    const ro = await createToken(owner, { name: '只读-协作', scopes: READ });
    // 看板 / 待办 / 文档 / 审阅 / 版本走的是 collab-common 的 requireProject，与上面的消息链不同
    const read = await call('GET', `/projects/${project.id}/todos`, ro.data.token);
    expect(read.statusCode).toBe(200);
    const todo = await call('POST', `/projects/${project.id}/todos`, ro.data.token, {
      title: '只读令牌不该建出这条待办',
    });
    expect(todo.statusCode).toBe(403);

    const rw = await createToken(owner, { name: '可写-协作', scopes: WRITE });
    const ok = await call('POST', `/projects/${project.id}/todos`, rw.data.token, {
      title: '来自令牌的一条待办',
    });
    expect(ok.statusCode).toBe(201);
  });

  it('限定项目：别的项目 404，列表里也只出现限定项目', async () => {
    const { data } = await createToken(owner, {
      name: '只看一个课题',
      scopes: READ,
      projectIds: [project.id],
    });
    expect(
      (await call('GET', `/projects/${otherProject.id}/timeline`, data.token)).statusCode,
    ).toBe(404);
    const projects = await call('GET', '/projects', data.token);
    expect(projects.statusCode).toBe(200);
    const list = projects.json<Project[]>();
    expect(list.map((p) => p.id)).toEqual([project.id]);

    const me = await call('GET', '/auth/me', data.token);
    const meBody = me.json<{ projects: Project[] }>();
    expect(meBody.projects.map((p) => p.id)).toEqual([project.id]);
  });

  it('过期后 401', async () => {
    const { data } = await createToken(owner, { name: '过期', scopes: READ });
    await t.db.db
      .update(apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiTokens.id, data.apiToken.id));
    expect((await call('GET', '/projects', data.token)).statusCode).toBe(401);
  });

  it('/ws 握手也认令牌', async () => {
    const { data } = await createToken(owner, { name: 'ws', scopes: READ });
    const frames: { op: string; userId?: string }[] = [];
    const ws = await t.app.injectWS(
      '/ws',
      { headers: { authorization: `Bearer ${data.token}` } },
      {
        onInit: (socket) =>
          socket.on('message', (raw: Buffer) => frames.push(JSON.parse(raw.toString()))),
      },
    );
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !frames.some((f) => f.op === 'ready')) {
      await new Promise((r) => setTimeout(r, 20));
    }
    ws.close();
    expect(frames.find((f) => f.op === 'ready')?.userId).toBe(owner.user.id);
  });
});

describe('开关与限流', () => {
  it('API_TOKENS_ENABLED=false：令牌 401，创建 403，列表仍可读', async () => {
    const off = await makeApp({ API_TOKENS_ENABLED: 'false' });
    try {
      const u = await signup(off.app, '离线用户');
      const list = await u.req('GET', '/auth/me/tokens');
      expect(list.statusCode).toBe(200);
      expect(list.json<ApiTokenList>().enabled).toBe(false);
      expect((await u.req('POST', '/auth/me/tokens', { name: 'x' })).statusCode).toBe(403);

      const res = await off.app.inject({
        method: 'GET',
        url: '/api/v1/projects',
        headers: { authorization: 'Bearer srh_pat_whatever' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await off.close();
    }
  }, 60_000);

  it('超过每分钟上限 → 429', async () => {
    const slow = await makeApp({ API_TOKENS_ENABLED: 'true', API_TOKENS_RATE_PER_MINUTE: '2' });
    try {
      const s = await setupProject(slow.app, []);
      const res = await s.owner.req('POST', '/auth/me/tokens', { name: '限流', scopes: READ });
      const token = res.json<ApiTokenCreated>().token;
      const call1 = await slow.app.inject({
        method: 'GET',
        url: '/api/v1/projects',
        headers: { authorization: `Bearer ${token}` },
      });
      const call2 = await slow.app.inject({
        method: 'GET',
        url: '/api/v1/projects',
        headers: { authorization: `Bearer ${token}` },
      });
      const call3 = await slow.app.inject({
        method: 'GET',
        url: '/api/v1/projects',
        headers: { authorization: `Bearer ${token}` },
      });
      expect([call1.statusCode, call2.statusCode, call3.statusCode]).toEqual([200, 200, 429]);
      expect(call3.headers['retry-after']).toBeDefined();
    } finally {
      await slow.close();
    }
  }, 60_000);
});

describe('迁移', () => {
  it('空库启动：一次迁移就建好 api_tokens，并能直接读写', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srh-migrate-empty-'));
    const db = await createDb(`pglite:${dir}`);
    try {
      await db.migrate(migrationsFolder());
      const [user] = await db.db
        .insert(users)
        .values({
          id: newId('user'),
          email: `mig-empty-${Date.now()}@example.com`,
          name: '空库测试',
          passwordHash: 'scrypt$x$y',
        })
        .returning();
      await db.db.insert(apiTokens).values({
        id: newId('apiToken'),
        userId: user!.id,
        name: '空库里的第一个令牌',
        tokenHash: 'e3b0c44298fc1c149afbf4c8996fb924',
        tokenHint: 'AbCdEfGh',
        scopes: ['read'],
        projectIds: [],
      });
      const rows = await db.db.select().from(apiTokens);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.projectIds).toEqual([]);
      expect(rows[0]?.scopes).toEqual(['read']);
      expect(rows[0]?.expiresAt).toBeNull();
      expect(rows[0]?.revokedAt).toBeNull();
    } finally {
      await db.close();
    }
  }, 120_000);

  it('旧库上再跑一次迁移不丢数据', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'srh-migrate-'));
    const db1 = await createDb(`pglite:${dir}`);
    await db1.migrate(migrationsFolder());
    await db1.db.insert(users).values({
      id: newId('user'),
      email: `mig-${Date.now()}@example.com`,
      name: '迁移测试',
      passwordHash: 'scrypt$x$y',
    });
    await db1.close();

    const db2 = await createDb(`pglite:${dir}`);
    await db2.migrate(migrationsFolder());
    const rows = await db2.db.select({ id: users.id }).from(users);
    expect(rows).toHaveLength(1);
    const table = await db2.db.select({ id: apiTokens.id }).from(apiTokens);
    expect(table).toEqual([]);
    await db2.close();
  }, 120_000);
});
