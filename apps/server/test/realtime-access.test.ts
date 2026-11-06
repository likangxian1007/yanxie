import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Message, Project, ServerFrame, Thread } from '@srh/shared';
import { createInboxItem } from '../src/modules/inbox/service';
import {
  makeApp,
  openWs,
  setupProject,
  signup,
  sleep,
  type Session,
  type TestApp,
} from './helpers';

/**
 * /ws 的鉴权与逐条可见性过滤（API.md §3.1、§4；realtime/access.ts）。
 * “收不到”的断言方法：之后再发一条双方都能看到的标记事件，等对方收到标记后再检查——
 * 同一项目按 seq 顺序推送，标记到了说明之前的事件该到的都已经到了。
 */
let t: TestApp;
let project: Project;
let owner: Session;
let member: Session;
let guest: Session;

type Live = Awaited<ReturnType<typeof openWs>>;
const opened: Live[] = [];

beforeAll(async () => {
  t = await makeApp();
  const s = await setupProject(t.app, ['member', 'guest']);
  project = s.project;
  owner = s.owner;
  [member, guest] = s.others as [Session, Session];
}, 60_000);

afterAll(async () => {
  for (const l of opened) l.ws.terminate();
  await t?.close();
});

async function connect(s: Session, projectId = project.id): Promise<Live> {
  const live = await openWs(t.app, s.cookie);
  opened.push(live);
  await live.waitFor((f) => f.op === 'ready');
  live.ws.send(JSON.stringify({ op: 'subscribe', projectId, afterSeq: 0 }));
  await live.waitFor(
    (f) => (f.op === 'subscribed' && f.projectId === projectId) || f.op === 'error',
  );
  return live;
}

const eventsOf = (live: Live) => live.frames.flatMap((f) => (f.op === 'event' ? [f.event] : []));

let markerN = 0;
/** 发一条所有成员可见的时间线消息，等每个连接都收到 */
async function marker(...lives: Live[]) {
  const body = `标记 ${++markerN}`;
  await owner.req('POST', `/projects/${project.id}/timeline`, { body, agentVisible: false });
  await Promise.all(
    lives.map((l) =>
      l.waitFor(
        (f) =>
          f.op === 'event' && f.event.type === 'message.created' && f.event.payload.body === body,
      ),
    ),
  );
}

describe('handshake & subscribe', () => {
  it('no cookie / bad cookie → closed with 4401, no ready frame', async () => {
    for (const headers of [{}, { cookie: 'srh_session=bogus' }]) {
      const frames: ServerFrame[] = [];
      const ws = await t.app.injectWS(
        '/ws',
        { headers },
        {
          onInit: (socket) =>
            socket.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as ServerFrame)),
        },
      );
      const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
      expect(code).toBe(4401);
      expect(frames.some((f) => f.op === 'ready')).toBe(false);
    }
  });

  it('foreign Origin → closed with 4403', async () => {
    const ws = await t.app.injectWS('/ws', {
      headers: { cookie: owner.cookie, origin: 'https://evil.example.com' },
    });
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4403);
  });

  it('ready carries userId; subscribing to a non-member / unknown project → forbidden error frame', async () => {
    const stranger = await signup(t.app, '陌生人');
    const live = await openWs(t.app, stranger.cookie);
    opened.push(live);
    const ready = await live.waitFor((f) => f.op === 'ready');
    expect(ready).toMatchObject({ op: 'ready', userId: stranger.user.id });
    for (const projectId of [project.id, 'prj_nope']) {
      live.frames.length = 0;
      live.ws.send(JSON.stringify({ op: 'subscribe', projectId, afterSeq: 0 }));
      const err = await live.waitFor((f) => f.op === 'error');
      expect(err).toMatchObject({ op: 'error', code: 'forbidden' });
    }
    expect(live.frames.some((f) => f.op === 'subscribed')).toBe(false);
    // 不认识的帧
    live.ws.send('not json');
    expect(await live.waitFor((f) => f.op === 'error' && f.code === 'bad_frame')).toBeTruthy();
    // 订阅失败后也收不到该项目的事件
    await owner.req('POST', `/projects/${project.id}/timeline`, { body: '陌生人看不到' });
    await sleep(100);
    expect(eventsOf(live)).toEqual([]);
  });
});

describe('visibility filtering', () => {
  it("member A does not receive member B's personal thread events; B does", async () => {
    const a = await connect(owner);
    const b = await connect(member);
    const g = await connect(guest);
    const res = await member.req('POST', `/projects/${project.id}/threads`, {
      body: '我自己的小想法',
    });
    const personal = res.json<Thread>();
    await b.waitFor(
      (f) =>
        f.op === 'event' && f.event.type === 'thread.created' && f.event.payload.id === personal.id,
    );
    await b.waitFor(
      (f) =>
        f.op === 'event' &&
        f.event.type === 'message.created' &&
        f.event.payload.threadId === personal.id,
    );
    // 个人线程里再说一句（只在缓存里能判断出所属线程的事件）
    const more = await member.req(
      'POST',
      `/projects/${project.id}/threads/${personal.id}/messages`,
      { body: '补充' },
    );
    expect(more.statusCode).toBe(201);
    await b.waitFor(
      (f) =>
        f.op === 'event' && f.event.type === 'message.created' && f.event.payload.body === '补充',
    );

    await marker(a, b, g);
    for (const other of [a, g]) {
      const leaked = eventsOf(other).filter(
        (e) =>
          e.threadId === personal.id ||
          ((e.type === 'thread.created' || e.type === 'thread.updated') &&
            e.payload.id === personal.id),
      );
      expect(leaked).toEqual([]);
    }
    // 个人 agent 会话的 agent.updated 同样只给主人
    const stop = await member.req(
      'POST',
      `/projects/${project.id}/agents/${personal.agentSessionId}/stop`,
    );
    expect(stop.statusCode).toBe(200);
    await b.waitFor(
      (f) =>
        f.op === 'event' &&
        f.event.type === 'agent.updated' &&
        f.event.payload.id === personal.agentSessionId,
    );
    await marker(a, b, g);
    expect(eventsOf(a).some((e) => e.type === 'agent.updated')).toBe(false);

    // 时间线上的转发卡片所有人都能看到
    const fwd = await member.req('POST', `/projects/${project.id}/threads/${personal.id}/forward`, {
      note: '看看',
    });
    const card = fwd.json<Message>();
    await a.waitFor(
      (f) =>
        f.op === 'event' && f.event.type === 'message.created' && f.event.payload.id === card.id,
    );
    for (const l of [a, b, g]) l.ws.terminate();
  });

  it('inbox.created goes only to the target user', async () => {
    const a = await connect(owner);
    const b = await connect(member);
    const item = await createInboxItem(t.app.ctx, {
      projectId: project.id,
      userId: member.user.id,
      kind: 'mention',
      title: '有人提到你',
      href: `/p/${project.id}`,
      sourceId: 'msg_ws_inbox',
    });
    await b.waitFor(
      (f) => f.op === 'event' && f.event.type === 'inbox.created' && f.event.payload.id === item.id,
    );
    // @提及走同一条路径
    await owner.req('POST', `/projects/${project.id}/timeline`, {
      body: '@李四 看一下',
      mentions: [{ userId: member.user.id, label: '李四', start: 0, end: 3 }],
    });
    await b.waitFor(
      (f) =>
        f.op === 'event' &&
        f.event.type === 'inbox.created' &&
        f.event.payload.title.includes('看一下'),
    );
    await marker(a, b);
    expect(eventsOf(a).some((e) => e.type === 'inbox.created' || e.type === 'inbox.updated')).toBe(
      false,
    );
    a.ws.terminate();
    b.ws.terminate();
  });

  it('todo.created with ownerUserId only reaches that user; shared todos reach everyone', async () => {
    const a = await connect(owner);
    const b = await connect(member);
    const actor = { kind: 'user' as const, id: member.user.id, name: '李四' };
    await t.app.ctx.bus.publish({
      projectId: project.id,
      type: 'todo.created',
      payload: { id: 'tdo_private', title: '私人待办', ownerUserId: member.user.id } as never,
      actor,
    });
    await t.app.ctx.bus.publish({
      projectId: project.id,
      type: 'todo.created',
      payload: { id: 'tdo_shared', title: '共享待办', ownerUserId: null } as never,
      actor,
    });
    const todoId = (f: ServerFrame) =>
      f.op === 'event' && f.event.type === 'todo.created'
        ? (f.event.payload as { id: string }).id
        : null;
    await b.waitFor((f) => todoId(f) === 'tdo_private');
    await b.waitFor((f) => todoId(f) === 'tdo_shared');
    await a.waitFor((f) => todoId(f) === 'tdo_shared');
    await marker(a, b);
    expect(a.frames.some((f) => todoId(f) === 'tdo_private')).toBe(false);
    a.ws.terminate();
    b.ws.terminate();
  });

  it('a removed member stops receiving project events', async () => {
    const { project: p, owner: o, others } = await setupProject(t.app, ['member']);
    const mem = others[0]!;
    const a = await connect(o, p.id);
    const b = await connect(mem, p.id);
    await o.req('POST', `/projects/${p.id}/timeline`, { body: '移除前' });
    await b.waitFor(
      (f) =>
        f.op === 'event' && f.event.type === 'message.created' && f.event.payload.body === '移除前',
    );

    const closed = new Promise<number>((resolve) => b.ws.once('close', resolve));
    expect((await o.req('DELETE', `/projects/${p.id}/members/${mem.user.id}`)).statusCode).toBe(
      204,
    );
    expect(await closed).toBe(4403);
    await o.req('POST', `/projects/${p.id}/timeline`, { body: '移除后' });
    await t.app.ctx.bus.publish({
      projectId: p.id,
      type: 'todo.created',
      payload: { id: 'tdo_after', title: '移除后的待办', ownerUserId: null } as never,
      actor: { kind: 'system', id: null, name: '系统' },
    });
    await a.waitFor(
      (f) =>
        f.op === 'event' && f.event.type === 'message.created' && f.event.payload.body === '移除后',
    );
    await a.waitFor((f) => f.op === 'event' && f.event.type === 'todo.created');
    await sleep(100);
    const after = eventsOf(b).filter(
      (e) =>
        e.type === 'todo.created' || (e.type === 'message.created' && e.payload.body === '移除后'),
    );
    expect(after).toEqual([]);

    // 原连接已撤销；新建连接仍不能重新订阅。
    const again = await connect(mem, p.id);
    expect(await again.waitFor((f) => f.op === 'error')).toMatchObject({ code: 'forbidden' });
    a.ws.terminate();
    b.ws.terminate();
    again.ws.terminate();
  });
});
