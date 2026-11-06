import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Project, ServerFrame, User } from '@srh/shared';
import { buildApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { createDb, type DbHandle } from '../src/db/client';
import { migrationsFolder } from '../src/db/migrate';

/**
 * 测试工具：内存 PGlite + 完整应用（不 listen），用 inject / injectWS 访问。
 * LLM 默认不配置（agent 运行时不跑）；需要时传 env 覆盖。
 */
export interface TestApp {
  app: FastifyInstance;
  db: DbHandle;
  config: AppConfig;
  close: () => Promise<void>;
}

export async function makeApp(env: Record<string, string> = {}): Promise<TestApp> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'pglite:memory',
    LOG_LEVEL: 'silent',
    STORAGE_DIR: mkdtempSync(join(tmpdir(), 'srh-test-')),
    ...env,
  });
  const db = await createDb(config.DATABASE_URL);
  await db.migrate(migrationsFolder());
  const app = await buildApp({ config, db, logger: false });
  await app.ready();
  return {
    app,
    db,
    config,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

export interface Session {
  user: User;
  cookie: string;
  /** 带 Cookie 的 inject 简写 */
  req: (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    body?: unknown,
  ) => Promise<{
    statusCode: number;
    json: <T = any>() => T; // eslint-disable-line @typescript-eslint/no-explicit-any
    body: string;
    headers: Record<string, string | string[] | number | undefined>;
  }>;
}

let seq = 0;

/** 注册一个新用户并返回带 Cookie 的会话 */
export async function signup(app: FastifyInstance, name = `用户${++seq}`): Promise<Session> {
  const email = `u${Date.now()}${++seq}@example.com`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, name, password: 'password123' },
  });
  if (res.statusCode !== 201) throw new Error(`注册失败 ${res.statusCode} ${res.body}`);
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  const cookie = (first ?? '').split(';')[0] ?? '';
  return sessionFor(app, res.json<User>(), cookie);
}

export function sessionFor(app: FastifyInstance, user: User, cookie: string): Session {
  return {
    user,
    cookie,
    req: async (method, url, body) => {
      const res = await app.inject({
        method,
        url: url.startsWith('/api') ? url : `/api/v1${url}`,
        headers: { cookie },
        ...(body !== undefined ? { payload: body as object } : {}),
      });
      return {
        statusCode: res.statusCode,
        json: () => res.json(),
        body: res.body,
        headers: res.headers,
      };
    },
  };
}

/** owner 建项目，其余人按角色经邀请加入 */
export async function setupProject(
  app: FastifyInstance,
  roles: ('advisor' | 'member' | 'guest')[] = ['member', 'advisor', 'guest'],
): Promise<{ project: Project; owner: Session; others: Session[] }> {
  const owner = await signup(app, '张三');
  const res = await owner.req('POST', '/projects', { name: '图对比学习' });
  if (res.statusCode !== 201) throw new Error(`建项目失败 ${res.body}`);
  const project = res.json<Project>();
  const others: Session[] = [];
  for (const role of roles) {
    const s = await signup(app, role === 'advisor' ? '王老师' : role === 'guest' ? '访客' : '李四');
    const inv = await owner.req('POST', `/projects/${project.id}/invites`, { role });
    const acc = await s.req('POST', `/invites/${inv.json<{ token: string }>().token}/accept`);
    if (acc.statusCode !== 200) throw new Error(`接受邀请失败 ${acc.body}`);
    others.push(s);
  }
  return { project, owner, others };
}

/** 打开 /ws 并收集帧 */
export async function openWs(app: FastifyInstance, cookie: string) {
  const frames: ServerFrame[] = [];
  const ws = await app.injectWS(
    '/ws',
    { headers: { cookie } },
    {
      onInit: (socket) =>
        socket.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as ServerFrame)),
    },
  );
  const waitFor = (pred: (f: ServerFrame) => boolean, timeoutMs = 5000) =>
    new Promise<ServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 WS 帧超时')), timeoutMs);
      const check = () => {
        const hit = frames.find(pred);
        if (hit) {
          clearTimeout(timer);
          resolve(hit);
        } else setTimeout(check, 10);
      };
      check();
    });
  return { ws, frames, waitFor };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
