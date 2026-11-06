import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { TicketDetail, TicketSummary, UserNotificationList } from '@srh/shared';
import { users } from '../src/db/schema';
import { makeApp, sessionFor, signup, type Session, type TestApp } from './helpers';

/** 反馈中心与运维后台：工单编号、通知、等我回复、投票、更新日志、日志附件权限、管理员权限 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function multipart(
  fields: Record<string, string>,
  files: { field: string; name: string; type: string; data: Buffer }[],
) {
  const boundary = `----srhtest${Date.now()}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  }
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`,
      ),
      f.data,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function makeAdmin(t: TestApp, s: Session): Promise<Session> {
  await t.db.db.update(users).set({ isAdmin: true }).where(eq(users.id, s.user.id));
  return sessionFor(t.app, { ...s.user, isAdmin: true }, s.cookie);
}

describe('反馈中心', () => {
  let t: TestApp;
  let admin: Session;
  let alice: Session;
  let bob: Session;

  beforeAll(async () => {
    t = await makeApp();
    admin = await makeAdmin(t, await signup(t.app, '管理员'));
    alice = await signup(t.app, 'Alice');
    bob = await signup(t.app, 'Bob');
  }, 60_000);
  afterAll(async () => t.close());

  it('工单编号 YX-N 递增，新工单通知管理员', async () => {
    const a = await alice.req('POST', '/feedback/tickets', {
      kind: 'bug',
      title: '按钮点不动',
      body: '复现步骤…',
    });
    expect(a.statusCode).toBe(201);
    const b = await alice.req('POST', '/feedback/tickets', { kind: 'question', title: '怎么导出' });
    const da = a.json<TicketDetail>();
    const db = b.json<TicketDetail>();
    expect(db.no).toBe(da.no + 1);
    expect(da.code).toBe(`YX-${da.no}`);
    expect(da.status).toBe('open');
    const n = (await admin.req('GET', '/me/notifications')).json<UserNotificationList>();
    expect(n.items.some((x) => x.kind === 'ticket_new' && x.href === `/feedback/YX-${da.no}`)).toBe(
      true,
    );
    // 别人看不到 bug 工单
    expect((await bob.req('GET', `/feedback/tickets/${da.no}`)).statusCode).toBe(404);
    expect((await alice.req('GET', `/feedback/tickets/YX-${da.no}`)).statusCode).toBe(200);
  });

  it('管理员回复通知提交人；等我回复筛选；打开工单标已读', async () => {
    const tk = (
      await alice.req('POST', '/feedback/tickets', { kind: 'bug', title: '保存失败' })
    ).json<TicketDetail>();
    // 管理员一方：新工单最后回复方是用户 → 等管理员回复
    let waiting = (await admin.req('GET', '/feedback/tickets?scope=waiting')).json<
      TicketSummary[]
    >();
    expect(waiting.some((x) => x.id === tk.id)).toBe(true);

    const r = await admin.req('POST', `/feedback/tickets/${tk.no}/messages`, {
      body: '我们看一下',
    });
    expect(r.statusCode).toBe(201);
    const d = r.json<TicketDetail>();
    expect(d.lastReplyBy).toBe('admin');
    expect(d.messages.at(-1)?.isStaff).toBe(true);

    waiting = (await admin.req('GET', '/feedback/tickets?scope=waiting')).json<TicketSummary[]>();
    expect(waiting.some((x) => x.id === tk.id)).toBe(false);
    const aliceWaiting = (await alice.req('GET', '/feedback/tickets?scope=waiting')).json<
      TicketSummary[]
    >();
    const mineRow = aliceWaiting.find((x) => x.id === tk.id);
    expect(mineRow?.waiting).toBe(true);
    expect(mineRow?.unread).toBe(true);

    let n = (await alice.req('GET', '/me/notifications')).json<UserNotificationList>();
    expect(
      n.items.some((x) => x.kind === 'ticket_reply' && x.href === `/feedback/YX-${tk.no}`),
    ).toBe(true);
    const unreadBefore = n.unread;
    const detail = (await alice.req('GET', `/feedback/tickets/${tk.no}`)).json<TicketDetail>();
    expect(detail.unread).toBe(false);
    expect(detail.peerReadAt).not.toBeNull();
    n = (await alice.req('GET', '/me/notifications')).json<UserNotificationList>();
    expect(n.unread).toBeLessThan(unreadBefore);

    // 用户回复 → 未指派时通知所有管理员
    await alice.req('POST', `/feedback/tickets/${tk.no}/messages`, { body: '还是不行' });
    n = (await admin.req('GET', '/me/notifications?unread=1')).json<UserNotificationList>();
    expect(n.items.some((x) => x.kind === 'ticket_user_reply')).toBe(true);

    // 旁人不能回复、提交人只能关闭
    expect(
      (await bob.req('POST', `/feedback/tickets/${tk.no}/messages`, { body: 'x' })).statusCode,
    ).toBe(404);
    expect(
      (await alice.req('PATCH', `/feedback/tickets/${tk.no}`, { status: 'doing' })).statusCode,
    ).toBe(403);
    const st = await admin.req('PATCH', `/feedback/tickets/${tk.no}`, {
      status: 'doing',
      assigneeUserId: admin.user.id,
    });
    expect(st.statusCode).toBe(200);
    expect(st.json<TicketDetail>().messages.some((m) => m.isSystem)).toBe(true);
    n = (await alice.req('GET', '/me/notifications?unread=1')).json<UserNotificationList>();
    expect(n.items.some((x) => x.kind === 'ticket_status')).toBe(true);
    const closed = await alice.req('PATCH', `/feedback/tickets/${tk.no}`, { status: 'closed' });
    expect(closed.json<TicketDetail>().status).toBe('closed');
  });

  it('建议公开可投票，按票数排序', async () => {
    const idea = (
      await alice.req('POST', '/feedback/tickets', { kind: 'idea', title: '支持暗色主题' })
    ).json<TicketDetail>();
    expect((await bob.req('GET', `/feedback/tickets/${idea.no}`)).statusCode).toBe(200);
    let v = await bob.req('POST', `/feedback/tickets/${idea.no}/vote`);
    expect(v.json()).toEqual({ voteCount: 1, voted: true });
    v = await bob.req('POST', `/feedback/tickets/${idea.no}/vote`);
    expect(v.json()).toEqual({ voteCount: 1, voted: true });
    v = await alice.req('POST', `/feedback/tickets/${idea.no}/vote`);
    expect(v.json<{ voteCount: number }>().voteCount).toBe(2);
    v = await bob.req('DELETE', `/feedback/tickets/${idea.no}/vote`);
    expect(v.json()).toEqual({ voteCount: 1, voted: false });
    const wall = (await bob.req('GET', '/feedback/tickets?kind=idea&sort=votes')).json<
      TicketSummary[]
    >();
    expect(wall[0]?.id).toBe(idea.id);
    // Bob 的 all 只看到建议
    const all = (await bob.req('GET', '/feedback/tickets')).json<TicketSummary[]>();
    expect(all.every((x) => x.kind === 'idea' || x.mine)).toBe(true);
    // bug 不能投票
    const bug = (
      await bob.req('POST', '/feedback/tickets', { kind: 'bug', title: 'x' })
    ).json<TicketDetail>();
    expect((await bob.req('POST', `/feedback/tickets/${bug.no}/vote`)).statusCode).toBe(400);
  });

  it('发布更新日志关闭关联工单并通知提交人；草稿只有管理员可见', async () => {
    const tk = (
      await bob.req('POST', '/feedback/tickets', { kind: 'idea', title: '批量导入' })
    ).json<TicketDetail>();
    const draft = await admin.req('POST', '/changelog', {
      version: 'v1.2.0',
      title: '批量导入上线',
      body: '- 支持批量导入',
      tags: ['feature'],
      ticketNos: [tk.no],
      publish: false,
    });
    expect(draft.statusCode).toBe(201);
    const entry = draft.json<{ id: string; publishedAt: string | null }>();
    expect(entry.publishedAt).toBeNull();
    expect((await bob.req('GET', '/changelog')).json<unknown[]>().length).toBe(0);
    expect((await admin.req('GET', '/changelog')).json<unknown[]>().length).toBe(1);
    expect((await bob.req('POST', '/changelog', { version: 'x', title: 'x' })).statusCode).toBe(
      403,
    );

    const pub = await admin.req('PATCH', `/changelog/${entry.id}`, { publish: true });
    expect(pub.statusCode).toBe(200);
    const d = (await bob.req('GET', `/feedback/tickets/${tk.no}`)).json<TicketDetail>();
    expect(d.status).toBe('done');
    expect(d.roadmap).toBe('shipped');
    expect(d.messages.some((m) => m.isSystem && m.body.includes('v1.2.0'))).toBe(true);
    const n = (await bob.req('GET', '/me/notifications')).json<UserNotificationList>();
    expect(n.items.some((x) => x.kind === 'changelog')).toBe(true);
    const list = (await bob.req('GET', '/changelog')).json<{ tickets: { code: string }[] }[]>();
    expect(list[0]?.tickets[0]?.code).toBe(`YX-${tk.no}`);
    expect((await admin.req('DELETE', `/changelog/${entry.id}`)).statusCode).toBe(204);
  });

  it('截图与诊断日志附件：日志只有提交人与管理员能下载', async () => {
    const mp = multipart(
      {
        kind: 'idea',
        title: '带附件的建议',
        body: '见截图',
        context: JSON.stringify({ route: '/projects/x', viewport: '1440x900' }),
      },
      [
        { field: 'files', name: 'shot.png', type: 'image/png', data: PNG },
        {
          field: 'logs',
          name: 'diag.log',
          type: 'text/plain',
          data: Buffer.from('console: TypeError\n'),
        },
      ],
    );
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/feedback/tickets',
      headers: { cookie: alice.cookie, 'content-type': mp.contentType },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(201);
    const d = res.json<TicketDetail>();
    expect(d.attachments.map((a) => a.kind).sort()).toEqual(['image', 'log']);
    expect(d.context?.viewport).toBe('1440x900');
    const log = d.attachments.find((a) => a.kind === 'log')!;
    const img = d.attachments.find((a) => a.kind === 'image')!;

    const get = (s: Session, url: string) =>
      t.app.inject({ method: 'GET', url, headers: { cookie: s.cookie } });
    const own = await get(alice, log.url);
    expect(own.statusCode).toBe(200);
    expect(own.headers['content-type']).toContain('text/plain');
    expect(own.headers['content-disposition']).toContain('attachment');
    expect(own.body).toContain('TypeError');
    expect((await get(admin, log.url)).statusCode).toBe(200);
    expect((await get(bob, log.url)).statusCode).toBe(403);
    // 旁人看建议：看得到截图，看不到日志与上下文
    const bobView = (await bob.req('GET', `/feedback/tickets/${d.no}`)).json<TicketDetail>();
    expect(bobView.hiddenLogCount).toBe(1);
    expect(bobView.attachments.every((a) => a.kind === 'image')).toBe(true);
    expect(bobView.context).toBeNull();
    const imgRes = await get(bob, img.url);
    expect(imgRes.statusCode).toBe(200);
    expect(imgRes.headers['content-type']).toBe('image/png');
    expect(imgRes.headers['x-content-type-options']).toBe('nosniff');

    // 二进制日志 415、伪装的图片 415
    const bad = multipart({ kind: 'bug', title: 'x' }, [
      { field: 'logs', name: 'a.log', type: 'text/plain', data: Buffer.from([0x61, 0, 0x62]) },
    ]);
    const badRes = await t.app.inject({
      method: 'POST',
      url: '/api/v1/feedback/tickets',
      headers: { cookie: alice.cookie, 'content-type': bad.contentType },
      payload: bad.payload,
    });
    expect(badRes.statusCode).toBe(415);
    const fake = multipart({ kind: 'bug', title: 'x' }, [
      { field: 'files', name: 'a.png', type: 'image/png', data: Buffer.from('<svg/>') },
    ]);
    const fakeRes = await t.app.inject({
      method: 'POST',
      url: '/api/v1/feedback/tickets',
      headers: { cookie: alice.cookie, 'content-type': fake.contentType },
      payload: fake.payload,
    });
    expect(fakeRes.statusCode).toBe(415);
  });

  it('后台接口非管理员 403；管理员可用', async () => {
    for (const url of ['/admin/overview', '/admin/users', '/admin/projects', '/admin/ops-events']) {
      expect((await bob.req('GET', url)).statusCode).toBe(403);
    }
    expect(
      (await bob.req('PATCH', `/admin/users/${bob.user.id}`, { isAdmin: true })).statusCode,
    ).toBe(403);
    const ov = await admin.req('GET', '/admin/overview');
    expect(ov.statusCode).toBe(200);
    const o = ov.json<{
      db: { ok: boolean };
      counts: { users: number };
      server: { version: string };
    }>();
    expect(o.db.ok).toBe(true);
    expect(o.counts.users).toBeGreaterThanOrEqual(3);
    const ul = (await admin.req('GET', '/admin/users')).json<{ id: string; isAdmin: boolean }[]>();
    expect(ul.find((u) => u.id === admin.user.id)?.isAdmin).toBe(true);
    expect((await admin.req('GET', '/admin/projects')).statusCode).toBe(200);
    // 不能撤销自己
    expect(
      (await admin.req('PATCH', `/admin/users/${admin.user.id}`, { isAdmin: false })).statusCode,
    ).toBe(409);
  });

  it('前端报错写入运维事件，可转成工单', async () => {
    const r = await bob.req('POST', '/feedback/client-errors', {
      message: 'TypeError: x is undefined',
      stack: 'at foo (app.js:1:2)',
      route: '/projects/:id',
    });
    expect(r.statusCode).toBe(204);
    const ev = (await admin.req('GET', '/admin/ops-events?source=web')).json<
      { id: string; message: string }[]
    >();
    expect(ev[0]?.message).toContain('TypeError');
    const tk = await admin.req('POST', `/admin/ops-events/${ev[0]!.id}/ticket`);
    expect(tk.statusCode).toBe(201);
    const d = tk.json<TicketDetail>();
    expect(d.source).toBe('ops');
    expect(d.opsEventId).toBe(ev[0]!.id);
    expect((await admin.req('POST', `/admin/ops-events/${ev[0]!.id}/ticket`)).statusCode).toBe(409);
    const open = (await admin.req('GET', '/admin/ops-events?open=1')).json<{ id: string }[]>();
    expect(open.some((x) => x.id === ev[0]!.id)).toBe(false);
    expect((await admin.req('DELETE', `/admin/ops-events/${ev[0]!.id}`)).statusCode).toBe(204);
  });
});

describe('ADMIN_EMAILS', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp({ ADMIN_EMAILS: 'Boss@Example.com, other@example.com' });
  }, 60_000);
  afterAll(async () => t.close());

  it('配置里的邮箱注册即为管理员，/auth/me 返回 isAdmin，且不能被撤销', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'boss@example.com', name: '老板', password: 'password123' },
    });
    expect(res.statusCode).toBe(201);
    const raw = res.headers['set-cookie'];
    const cookie = ((Array.isArray(raw) ? raw[0] : raw) ?? '').split(';')[0]!;
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.json<{ isAdmin?: boolean }>().isAdmin).toBe(true);
    const boss = sessionFor(t.app, res.json(), cookie);
    expect((await boss.req('GET', '/admin/overview')).statusCode).toBe(200);

    const plain = await signup(t.app, '普通人');
    const pm = await t.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: plain.cookie },
    });
    expect(pm.json<{ isAdmin?: boolean }>().isAdmin).toBe(false);

    // 授予再由另一位管理员尝试撤销配置管理员
    expect(
      (await boss.req('PATCH', `/admin/users/${plain.user.id}`, { isAdmin: true })).statusCode,
    ).toBe(200);
    const promoted = sessionFor(t.app, plain.user, plain.cookie);
    const rows = (await boss.req('GET', '/admin/users')).json<
      { id: string; adminByConfig: boolean }[]
    >();
    expect(rows.find((r) => r.id === boss.user.id)?.adminByConfig).toBe(true);
    expect(
      (await promoted.req('PATCH', `/admin/users/${boss.user.id}`, { isAdmin: false })).statusCode,
    ).toBe(409);
    expect(
      (await boss.req('PATCH', `/admin/users/${plain.user.id}`, { isAdmin: false })).statusCode,
    ).toBe(200);
    expect((await promoted.req('GET', '/admin/overview')).statusCode).toBe(403);
  });
});
