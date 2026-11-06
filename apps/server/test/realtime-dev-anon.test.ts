import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { Project, ServerFrame, Thread } from '@srh/shared';
import { makeApp, setupProject, sleep, type Session, type TestApp } from './helpers';

/**
 * 验收报告附录 B（严重）：REALTIME_DEV_ANON=true 时匿名放行的范围超出文档。
 * 现在：只有 /ws 握手能匿名；匿名访客看不到个人线程和收件箱；其他地方 userFromRequest 一律 null。
 */
let t: TestApp;
let project: Project;
let owner: Session;
let member: Session;

beforeAll(async () => {
  t = await makeApp({ REALTIME_DEV_ANON: 'true' });
  const s = await setupProject(t.app, ['member']);
  project = s.project;
  owner = s.owner;
  member = s.others[0]!;
}, 60_000);

afterAll(async () => {
  await t.close();
});

describe('REALTIME_DEV_ANON 只作用于 /ws', () => {
  it('非 WS 请求没有 Cookie → userFromRequest 为 null（协作 REST / collab 不再按匿名放行）', async () => {
    const fake = {
      url: '/api/v1/projects/x/docs',
      headers: {},
      cookies: {},
    } as unknown as FastifyRequest;
    expect(await t.app.ctx.access.userFromRequest(fake)).toBeNull();
    const collab = {
      url: '/collab/doc_x',
      headers: { upgrade: 'websocket' },
      cookies: {},
    } as unknown as FastifyRequest;
    expect(await t.app.ctx.access.userFromRequest(collab)).toBeNull();
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/timeline`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('匿名 /ws 能订阅，但收不到个人会话的事件', async () => {
    const P = `/projects/${project.id}`;
    const frames: ServerFrame[] = [];
    const ws = await t.app.injectWS(
      '/ws',
      {},
      {
        onInit: (socket) =>
          socket.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as ServerFrame)),
      },
    );
    const waitFor = async (pred: (f: ServerFrame) => boolean) => {
      for (let i = 0; i < 300; i++) {
        const hit = frames.find(pred);
        if (hit) return hit;
        await sleep(10);
      }
      throw new Error(`等待 WS 帧超时：${JSON.stringify(frames).slice(0, 600)}`);
    };
    await waitFor((f) => f.op === 'ready');
    ws.send(JSON.stringify({ op: 'subscribe', projectId: project.id, afterSeq: 0 }));
    await waitFor((f) => f.op === 'subscribed');
    const personal = (
      await member.req('POST', `${P}/threads`, { body: '私人想法 ANON-PRIV-1' })
    ).json<Thread>();
    await owner.req('POST', `${P}/timeline`, { body: '公开消息 ANON-PUB-1' });
    await waitFor(
      (f) =>
        f.op === 'event' &&
        f.event.type === 'message.created' &&
        f.event.payload.body === '公开消息 ANON-PUB-1',
    );
    await sleep(100);
    const text = JSON.stringify(frames);
    expect(text).not.toContain('ANON-PRIV-1');
    expect(text).not.toContain(personal.id);
    ws.terminate();
  });
});
