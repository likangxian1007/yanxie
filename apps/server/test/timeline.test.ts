import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileObject, InboxItem, Message, OutputItem, Page, Project } from '@srh/shared';
import { createProjectThread } from '../src/modules/threads/service';
import { listMessages } from '../src/modules/timeline/service';
import { makeApp, setupProject, signup, type Session, type TestApp } from './helpers';

/**
 * 时间线与消息（API.md §2.3）：发言权限、分页、编辑删除、反应、@提及、旁聊、附件产出。
 */
let t: TestApp;
let project: Project;
let owner: Session;
let member: Session;
let advisor: Session;
let guest: Session;

beforeAll(async () => {
  t = await makeApp();
  const s = await setupProject(t.app);
  project = s.project;
  owner = s.owner;
  [member, advisor, guest] = s.others as [Session, Session, Session];
}, 60_000);

afterAll(async () => {
  await t?.close();
});

const TL = () => `/projects/${project.id}/timeline`;
const M = (id: string) => `/projects/${project.id}/messages/${id}`;
const events = () => t.app.ctx.bus.listSince(project.id, 0, 1000);

async function post(s: Session, body: unknown) {
  const res = await s.req('POST', TL(), body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Message>();
}

/** 上传一个文件（multipart，与 files.test.ts 同样手工拼） */
async function upload(s: Session, name: string, data: string) {
  const boundary = `----srhtest${Math.random().toString(16).slice(2)}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n`,
    ),
    Buffer.from(data),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project.id}/files`,
    headers: { cookie: s.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<FileObject>();
}

describe('post', () => {
  it('members post (201 + message.created); guest 403; invalid 422', async () => {
    const msg = await post(member, { body: '  今天把基线复现了  ' });
    expect(msg).toMatchObject({
      projectId: project.id,
      threadId: null,
      kind: 'text',
      body: '今天把基线复现了',
      author: { kind: 'user', id: member.user.id, name: '李四' },
      agentVisible: true,
      meta: {},
      reactions: [],
      outputs: [],
      rootOfThreadId: null,
      editedAt: null,
    });
    expect(msg.id).toMatch(/^msg_/u);
    const ev = (await events()).find(
      (e) => e.type === 'message.created' && e.payload.id === msg.id,
    );
    expect(ev).toMatchObject({ threadId: null, actor: { kind: 'user', id: member.user.id } });

    expect((await advisor.req('POST', TL(), { body: '导师也能说话' })).statusCode).toBe(201);
    const g = await guest.req('POST', TL(), { body: '访客想说话' });
    expect(g.statusCode).toBe(403);
    expect(g.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect((await member.req('POST', TL(), { body: '   ' })).statusCode).toBe(422);
    expect((await member.req('POST', TL(), {})).statusCode).toBe(422);
  });

  it('agentVisible=false (side chat) is stored and listed', async () => {
    const msg = await post(member, { body: '晚上吃啥', agentVisible: false });
    expect(msg.agentVisible).toBe(false);
    const page = (await guest.req('GET', TL())).json<Page<Message>>();
    expect(page.items.find((m) => m.id === msg.id)?.agentVisible).toBe(false);
  });
});

describe('list & pagination', () => {
  it('filters mixed channels before cursor pagination in both directions on timeline and threads', async () => {
    const { project: p, owner: o, others } = await setupProject(t.app, ['guest']);
    const g = others[0]!;
    const root = (
      await o.req('POST', `/projects/${p.id}/timeline`, { body: '根消息' })
    ).json<Message>();
    const { thread } = await createProjectThread(t.app.ctx, {
      projectId: p.id,
      rootMessageId: root.id,
      title: '频道分页',
      workingForUserId: o.user.id,
      actor: { kind: 'user', id: o.user.id, name: o.user.name },
    });
    const urls = [`/projects/${p.id}/timeline`, `/projects/${p.id}/threads/${thread.id}/messages`];
    for (const url of urls) {
      const created: Message[] = url.endsWith('/timeline') ? [root] : [];
      for (const [i, visible] of [false, true, true, true, false, true, true, false].entries()) {
        const response = await o.req('POST', url, { body: `频道消息 ${i}`, agentVisible: visible });
        expect(response.statusCode).toBe(201);
        created.push(response.json<Message>());
      }
      created.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const all = await g.req('GET', url);
      expect(all.statusCode).toBe(200);
      expect(all.json<Page<Message>>().items.map((m) => m.id)).toEqual(
        created.map((m) => m.id).reverse(),
      );
      const explicitAll = await g.req('GET', `${url}?channel=all`);
      expect(explicitAll.json<Page<Message>>()).toEqual(all.json<Page<Message>>());
      for (const channel of ['agent', 'team'] as const) {
        for (const order of ['asc', 'desc'] as const) {
          const expected = created.filter((m) => m.agentVisible === (channel === 'agent'));
          if (order === 'desc') expected.reverse();
          const actual: Message[] = [];
          let cursor: string | null = null;
          let pages = 0;
          do {
            const response = await g.req(
              'GET',
              `${url}?channel=${channel}&order=${order}&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
            );
            expect(response.statusCode).toBe(200);
            const page = response.json<Page<Message>>();
            expect(page.items).toHaveLength(Math.min(2, expected.length - actual.length));
            actual.push(...page.items);
            cursor = page.nextCursor;
            if (cursor) expect(cursor).toBe(page.items.at(-1)?.id);
            expect(++pages).toBeLessThanOrEqual(created.length);
          } while (cursor);
          expect(actual.map((m) => m.id)).toEqual(expected.map((m) => m.id));
        }
      }
      expect((await o.req('GET', `${url}?channel=other`)).statusCode).toBe(422);
    }
    // 内部调用保留 agent 可见性约束，即使调用者请求 team。
    const restricted = await listMessages(
      t.app.ctx,
      p.id,
      thread.id,
      { channel: 'team', order: 'asc', limit: 50 },
      { agentVisibleOnly: true },
    );
    expect(restricted.items.length).toBeGreaterThan(0);
    expect(restricted.items.every((m) => m.agentVisible)).toBe(true);
    const outsider = await signup(t.app);
    for (const url of urls) {
      expect((await outsider.req('GET', `${url}?channel=team`)).statusCode).toBe(404);
      expect(
        (await t.app.inject({ method: 'GET', url: `/api/v1${url}?channel=agent` })).statusCode,
      ).toBe(401);
    }
  });

  it('desc by default, ?order=asc reverses, cursor pages without overlap', async () => {
    const { project: p, owner: o } = await setupProject(t.app, []);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await o.req('POST', `/projects/${p.id}/timeline`, { body: `第 ${i} 条` });
      ids.push(res.json<Message>().id);
    }
    const url = `/projects/${p.id}/timeline`;
    const all = (await o.req('GET', url)).json<Page<Message>>();
    expect(all.items.map((m) => m.id)).toEqual([...ids].reverse());
    expect(all.nextCursor).toBeNull();

    const p1 = (await o.req('GET', `${url}?limit=2`)).json<Page<Message>>();
    expect(p1.items.map((m) => m.body)).toEqual(['第 4 条', '第 3 条']);
    expect(p1.nextCursor).toBe(ids[3]);
    const p2 = (await o.req('GET', `${url}?limit=2&cursor=${p1.nextCursor}`)).json<Page<Message>>();
    expect(p2.items.map((m) => m.body)).toEqual(['第 2 条', '第 1 条']);
    const p3 = (await o.req('GET', `${url}?limit=2&cursor=${p2.nextCursor}`)).json<Page<Message>>();
    expect(p3.items.map((m) => m.body)).toEqual(['第 0 条']);
    expect(p3.nextCursor).toBeNull();

    const asc = (await o.req('GET', `${url}?order=asc&limit=3`)).json<Page<Message>>();
    expect(asc.items.map((m) => m.id)).toEqual(ids.slice(0, 3));
    const asc2 = (await o.req('GET', `${url}?order=asc&limit=3&cursor=${asc.nextCursor}`)).json<
      Page<Message>
    >();
    expect(asc2.items.map((m) => m.id)).toEqual(ids.slice(3));
    expect(asc2.nextCursor).toBeNull();

    expect((await o.req('GET', `${url}?limit=0`)).statusCode).toBe(422);
    expect((await o.req('GET', `${url}?limit=101`)).statusCode).toBe(422);
    expect((await o.req('GET', `${url}?order=sideways`)).statusCode).toBe(422);
  });

  it('timeline holds only top-level messages; root message carries rootOfThreadId', async () => {
    const root = await post(owner, { body: '帮我调研一下 GraphCL' });
    const { thread } = await createProjectThread(t.app.ctx, {
      projectId: project.id,
      rootMessageId: root.id,
      title: 'GraphCL 调研',
      workingForUserId: owner.user.id,
      actor: { kind: 'agent', id: 'agt_x', name: '研协' },
    });
    const reply = await owner.req('POST', `/projects/${project.id}/threads/${thread.id}/messages`, {
      body: '线程里的回复',
    });
    expect(reply.statusCode).toBe(201);
    const page = (await member.req('GET', TL())).json<Page<Message>>();
    expect(page.items.find((m) => m.id === root.id)?.rootOfThreadId).toBe(thread.id);
    expect(page.items.some((m) => m.body === '线程里的回复')).toBe(false);
    // 线程根消息不能删除
    const del = await owner.req('DELETE', M(root.id));
    expect(del.statusCode).toBe(409);
  });
});

describe('edit & delete', () => {
  it('only the author can edit/delete; others 403; guest 403; unknown 404', async () => {
    const msg = await post(member, { body: '初稿' });
    expect((await owner.req('PATCH', M(msg.id), { body: '改别人的' })).statusCode).toBe(403);
    expect((await advisor.req('DELETE', M(msg.id))).statusCode).toBe(403);
    expect((await guest.req('PATCH', M(msg.id), { body: 'x' })).statusCode).toBe(403);
    expect((await member.req('PATCH', M('msg_nope'), { body: 'x' })).statusCode).toBe(404);
    expect((await member.req('PATCH', M(msg.id), { body: '' })).statusCode).toBe(422);

    const edited = await member.req('PATCH', M(msg.id), { body: '定稿' });
    expect(edited.statusCode).toBe(200);
    expect(edited.json<Message>()).toMatchObject({ id: msg.id, body: '定稿' });
    expect(edited.json<Message>().editedAt).not.toBeNull();
    const upd = (await events()).filter(
      (e) => e.type === 'message.updated' && e.payload.id === msg.id,
    );
    expect(upd.at(-1)?.payload).toMatchObject({ body: '定稿' });

    expect((await member.req('DELETE', M(msg.id))).statusCode).toBe(204);
    expect((await member.req('DELETE', M(msg.id))).statusCode).toBe(404);
    expect((await member.req('PATCH', M(msg.id), { body: 'x' })).statusCode).toBe(404);
    const page = (await member.req('GET', TL())).json<Page<Message>>();
    expect(page.items.map((m) => m.id)).not.toContain(msg.id);
    const del = (await events()).find(
      (e) => e.type === 'message.deleted' && e.payload.id === msg.id,
    );
    expect(del?.payload).toEqual({ id: msg.id });
  });
});

describe('reactions', () => {
  it('PUT/DELETE are idempotent and grouped by emoji', async () => {
    const msg = await post(owner, { body: '实验跑完了' });
    const put = (s: Session, emoji: string) => s.req('PUT', `${M(msg.id)}/reactions`, { emoji });
    const r1 = await put(member, '👍');
    expect(r1.statusCode).toBe(200);
    expect(r1.json<Message>().reactions).toEqual([
      { emoji: '👍', actors: [{ kind: 'user', id: member.user.id, name: '李四' }] },
    ]);
    // 重复 PUT 不重复计数
    const r2 = await put(member, '👍');
    expect(r2.json<Message>().reactions[0]!.actors).toHaveLength(1);
    await put(advisor, '👍');
    const r3 = await put(member, '🎉');
    expect(r3.json<Message>().reactions.map((r) => [r.emoji, r.actors.length])).toEqual([
      ['👍', 2],
      ['🎉', 1],
    ]);
    expect((await put(guest, '👍')).statusCode).toBe(403);
    expect((await member.req('PUT', `${M(msg.id)}/reactions`, { emoji: '' })).statusCode).toBe(422);

    const delUrl = `${M(msg.id)}/reactions/${encodeURIComponent('👍')}`;
    const d1 = await member.req('DELETE', delUrl);
    expect(d1.statusCode).toBe(200);
    expect(d1.json<Message>().reactions.map((r) => [r.emoji, r.actors.map((a) => a.id)])).toEqual([
      ['👍', [advisor.user.id]],
      ['🎉', [member.user.id]],
    ]);
    // 再删一次是空操作
    const d2 = await member.req('DELETE', delUrl);
    expect(d2.statusCode).toBe(200);
    expect(d2.json<Message>().reactions).toEqual(d1.json<Message>().reactions);
    expect(
      (await member.req('PUT', `${M('msg_nope')}/reactions`, { emoji: '👍' })).statusCode,
    ).toBe(404);
  });
});

describe('@mention', () => {
  it('creates a mention inbox item for the mentioned member only', async () => {
    const msg = await post(owner, {
      body: '@李四 帮忙看下这个结果，@张三 自己不算',
      mentions: [{ userId: member.user.id, label: '李四', start: 0, end: 3 }],
    });
    const inbox = (await member.req('GET', `/inbox?projectId=${project.id}`)).json<InboxItem[]>();
    const hit = inbox.find((i) => i.sourceId === msg.id);
    expect(hit).toMatchObject({
      kind: 'mention',
      userId: member.user.id,
      projectId: project.id,
      href: `/p/${project.id}#${msg.id}`,
    });
    expect(hit!.title).toContain('张三');
    // 作者 @ 自己不发；没被 @ 的人不发
    for (const s of [owner, advisor, guest]) {
      const items = (await s.req('GET', '/inbox')).json<InboxItem[]>();
      expect(items.some((i) => i.sourceId === msg.id)).toBe(false);
    }
  });

  it('mentions inside a personal thread are not delivered', async () => {
    const res = await member.req('POST', `/projects/${project.id}/threads`, {
      body: '@王老师 会怎么看？',
    });
    expect(res.statusCode).toBe(201);
    const items = (await advisor.req('GET', '/inbox')).json<InboxItem[]>();
    expect(items.some((i) => i.kind === 'mention' && i.title.includes('王老师 会怎么看'))).toBe(
      false,
    );
  });
});

describe('attachments', () => {
  it('fileIds attach file outputs, recorded in meta and listed in P/outputs', async () => {
    const file = await upload(member, '结果.txt', 'acc=0.91');
    const msg = await post(member, { body: '结果见附件', fileIds: [file.id] });
    expect(msg.meta).toEqual({ fileIds: [file.id] });
    expect(msg.outputs).toHaveLength(1);
    expect(msg.outputs[0]).toMatchObject({ kind: 'file', ref: file.id, title: '结果.txt' });

    const outs = (await guest.req('GET', `/projects/${project.id}/outputs`)).json<
      Page<OutputItem>
    >();
    const out = outs.items.find((o) => o.ref === file.id);
    expect(out).toMatchObject({
      kind: 'file',
      messageId: msg.id,
      threadId: null,
      title: '结果.txt',
    });

    const bad = await member.req('POST', TL(), { body: '附件不存在', fileIds: ['fil_nope'] });
    expect(bad.statusCode).toBe(422);
    // 失败的请求没有留下消息
    const page = (await member.req('GET', TL())).json<Page<Message>>();
    expect(page.items.some((m) => m.body === '附件不存在')).toBe(false);
  });
});
