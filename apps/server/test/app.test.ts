import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { HealthResponse, ServerFrame } from '@srh/shared';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createDb, type DbHandle } from '../src/db/client';
import { migrationsFolder } from '../src/db/migrate';
import { projects, users } from '../src/db/schema';

let db: DbHandle;
let app: FastifyInstance;

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'pglite:memory',
    LOG_LEVEL: 'silent',
    REALTIME_DEV_ANON: 'true',
  });
  db = await createDb(config.DATABASE_URL);
  await db.migrate(migrationsFolder());
  app = await buildApp({ config, db, logger: false });
  await app.ready();
  // 测试数据：一个用户、一个项目
  await db.db
    .insert(users)
    .values({ id: 'usr_t', email: 't@example.com', name: '测试', passwordHash: 'x' });
  await db.db.insert(projects).values({ id: 'prj_t', name: '测试课题', createdBy: 'usr_t' });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe('health', () => {
  it('GET /api/health reports db ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json<HealthResponse>();
    expect(body.status).toBe('ok');
    expect(body.db).toMatchObject({ ok: true, driver: 'pglite' });
    expect(body.llm.configured).toBe(false);
  });

  it('unknown api route returns structured 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('event bus + /ws', () => {
  it('records monotonic seq and replays to late subscribers', async () => {
    const actor = { kind: 'system' as const, id: null, name: '系统' };
    const a = await app.ctx.bus.publish({
      projectId: 'prj_t',
      type: 'message.deleted',
      payload: { id: 'msg_a' },
      actor,
    });
    const b = await app.ctx.bus.publish({
      projectId: 'prj_t',
      type: 'message.deleted',
      payload: { id: 'msg_b' },
      actor,
    });
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(await app.ctx.bus.latestSeq('prj_t')).toBe(b.seq);

    const frames: ServerFrame[] = [];
    const ws = await app.injectWS(
      '/ws',
      {},
      {
        onInit: (socket) =>
          socket.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as ServerFrame)),
      },
    );
    const waitFor = (pred: (f: ServerFrame) => boolean) =>
      new Promise<ServerFrame>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 5000);
        const check = () => {
          const hit = frames.find(pred);
          if (hit) {
            clearTimeout(timer);
            resolve(hit);
          } else setTimeout(check, 10);
        };
        check();
      });
    await waitFor((f) => f.op === 'ready');
    ws.send(JSON.stringify({ op: 'subscribe', projectId: 'prj_t', afterSeq: a.seq }));
    await waitFor((f) => f.op === 'subscribed');
    // 补发了 a 之后的事件
    const replayed = frames.filter((f) => f.op === 'event');
    expect(replayed.map((f) => (f.op === 'event' ? f.event.seq : -1))).toEqual([b.seq]);

    // 实时推送
    const c = await app.ctx.bus.publish({
      projectId: 'prj_t',
      type: 'message.deleted',
      payload: { id: 'msg_c' },
      actor,
    });
    await waitFor((f) => f.op === 'event' && f.event.seq === c.seq);

    ws.send(JSON.stringify({ op: 'ping' }));
    await waitFor((f) => f.op === 'pong');
    ws.terminate();
  });

  it('replay=true replays from afterSeq even when it is 0; without it afterSeq=0 is live-only', async () => {
    await db.db.insert(projects).values({ id: 'prj_r', name: '补发课题', createdBy: 'usr_t' });
    const actor = { kind: 'system' as const, id: null, name: '系统' };
    const first = await app.ctx.bus.publish({
      projectId: 'prj_r',
      type: 'message.deleted',
      payload: { id: 'msg_r1' },
      actor,
    });
    expect(first.seq).toBe(1);

    const open = async () => {
      const frames: ServerFrame[] = [];
      const ws = await app.injectWS(
        '/ws',
        {},
        {
          onInit: (socket) =>
            socket.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as ServerFrame)),
        },
      );
      const waitFor = (pred: (f: ServerFrame) => boolean) =>
        new Promise<ServerFrame>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout')), 5000);
          const check = () => {
            const hit = frames.find(pred);
            if (hit) {
              clearTimeout(timer);
              resolve(hit);
            } else setTimeout(check, 10);
          };
          check();
        });
      await waitFor((f) => f.op === 'ready');
      return { ws, frames, waitFor };
    };
    const seqs = (frames: ServerFrame[]) =>
      frames.flatMap((f) => (f.op === 'event' ? [f.event.seq] : []));

    const withReplay = await open();
    withReplay.ws.send(
      JSON.stringify({ op: 'subscribe', projectId: 'prj_r', afterSeq: 0, replay: true }),
    );
    await withReplay.waitFor((f) => f.op === 'subscribed');
    expect(seqs(withReplay.frames)).toEqual([1]);
    withReplay.ws.terminate();

    const legacy = await open();
    legacy.ws.send(JSON.stringify({ op: 'subscribe', projectId: 'prj_r', afterSeq: 0 }));
    await legacy.waitFor((f) => f.op === 'subscribed');
    expect(seqs(legacy.frames)).toEqual([]);
    legacy.ws.terminate();
  });

  it('seq is contiguous per project, even under concurrent publishes', async () => {
    await db.db.insert(projects).values({ id: 'prj_u', name: '另一个课题', createdBy: 'usr_t' });
    const actor = { kind: 'system' as const, id: null, name: '系统' };
    const publish = (projectId: string, i: number) =>
      app.ctx.bus.publish({
        projectId,
        type: 'message.deleted',
        payload: { id: `msg_${projectId}_${i}` },
        actor,
      });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => publish(i % 2 ? 'prj_u' : 'prj_t', i)),
    );
    const seqU = results.filter((e) => e.projectId === 'prj_u').map((e) => e.seq);
    expect(seqU.sort((x, y) => x - y)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    const all = await app.ctx.bus.listSince('prj_t', 0);
    expect(all.map((e) => e.seq)).toEqual(Array.from({ length: all.length }, (_, i) => i + 1));
  });
});

describe('access policy', () => {
  it('denies /ws by default (fail closed)', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'pglite:memory' });
    const closed = await buildApp({ config, db, logger: false });
    await closed.ready();
    const ws = await closed.injectWS('/ws');
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4401);
    await closed.close();
  });

  it('rejects weak SESSION_SECRET in production', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'change-me-to-a-long-random-string' }),
    ).toThrow();
    expect(() =>
      loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40) }),
    ).not.toThrow();
  });
});
