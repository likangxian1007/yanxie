import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type {
  AgentSession,
  AnyProjectEvent,
  Invite,
  MemoryFile,
  Project,
  ProjectMember,
  ProjectWithRole,
  Thread,
} from '@srh/shared';
import { invites } from '../src/db/schema';
import { createInboxItem } from '../src/modules/inbox/service';
import { makeApp, setupProject, signup, type Session, type TestApp } from './helpers';

/**
 * 项目、成员、邀请、事件补拉（API.md §2.2、§2.6 P/events；权限见 ARCHITECTURE.md §9）。
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

const P = () => `/projects/${project.id}`;
const events = (projectId = project.id) => t.app.ctx.bus.listSince(projectId, 0, 1000);

describe('create & list', () => {
  it('create → 201 with defaults; coordinator session and MEMORY.md exist', async () => {
    const s = await signup(t.app, '建项目的人');
    const res = await s.req('POST', '/projects', { name: '  新课题 ', description: '描述' });
    expect(res.statusCode).toBe(201);
    const p = res.json<Project>();
    expect(p).toMatchObject({
      name: '新课题',
      description: '描述',
      icon: '🔬',
      color: 0,
      visibility: 'team',
      instructions: '',
      createdBy: s.user.id,
      archivedAt: null,
    });
    expect(p.id).toMatch(/^prj_/u);

    const agents = (await s.req('GET', `/projects/${p.id}/agents`)).json<AgentSession[]>();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ role: 'coordinator', threadId: null, projectId: p.id });

    const mem = (await s.req('GET', `/projects/${p.id}/memory`)).json<
      Omit<MemoryFile, 'content'>[]
    >();
    expect(mem.map((m) => m.path)).toContain('MEMORY.md');
    const index = await s.req('GET', `/projects/${p.id}/memory/MEMORY.md`);
    expect(index.statusCode).toBe(200);
    expect(index.json<MemoryFile>().content).toContain('# 项目记忆索引');

    const members = (await s.req('GET', `/projects/${p.id}/members`)).json<ProjectMember[]>();
    expect(members.map((m) => [m.user.id, m.role])).toEqual([[s.user.id, 'owner']]);

    expect((await s.req('POST', '/projects', { name: '' })).statusCode).toBe(422);
    const anon = await t.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'x' },
    });
    expect(anon.statusCode).toBe(401);
  });

  it('list returns own projects with role and unread count', async () => {
    await createInboxItem(t.app.ctx, {
      projectId: project.id,
      userId: member.user.id,
      kind: 'mention',
      title: '有人提到你',
      href: `/p/${project.id}`,
      sourceId: 'msg_unread_1',
    });
    const list = (await member.req('GET', '/projects')).json<ProjectWithRole[]>();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: project.id, role: 'member', unread: 1 });
    const ownerList = (await owner.req('GET', '/projects')).json<ProjectWithRole[]>();
    expect(ownerList[0]).toMatchObject({ id: project.id, role: 'owner', unread: 0 });
    const guestList = (await guest.req('GET', '/projects')).json<ProjectWithRole[]>();
    expect(guestList.map((p) => p.role)).toEqual(['guest']);
  });
});

describe('get / patch / delete', () => {
  it('GET for every member role', async () => {
    for (const s of [owner, member, advisor, guest]) {
      const res = await s.req('GET', P());
      expect(res.statusCode).toBe(200);
      expect(res.json<Project>().id).toBe(project.id);
    }
  });

  it('PATCH: member/guest 403, advisor ok, untouched fields preserved, project.updated', async () => {
    expect((await member.req('PATCH', P(), { name: 'x' })).statusCode).toBe(403);
    expect((await guest.req('PATCH', P(), { name: 'x' })).statusCode).toBe(403);
    const first = await owner.req('PATCH', P(), {
      description: '用对比学习做分子性质预测',
      color: 3,
    });
    expect(first.statusCode).toBe(200);
    const res = await advisor.req('PATCH', P(), {
      name: '图对比学习 v2',
      instructions: '用中文回答',
    });
    expect(res.statusCode).toBe(200);
    const p = res.json<Project>();
    expect(p).toMatchObject({
      name: '图对比学习 v2',
      instructions: '用中文回答',
      // 部分更新不能把没传的字段重置成默认值
      description: '用对比学习做分子性质预测',
      color: 3,
    });
    expect(new Date(p.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(project.updatedAt).getTime(),
    );
    expect((await advisor.req('PATCH', P(), { color: 99 })).statusCode).toBe(422);
    const ev = (await events()).filter((e) => e.type === 'project.updated').at(-1);
    expect(ev?.payload).toMatchObject({ name: '图对比学习 v2' });
    expect(ev?.actor).toMatchObject({ kind: 'user', id: advisor.user.id });
  });

  it('DELETE: advisor/member 403; owner 204 → gone for everyone (404, not listed)', async () => {
    const { project: p, owner: o, others } = await setupProject(t.app, ['advisor', 'member']);
    const [adv, mem] = others as [Session, Session];
    const inv = (
      await o.req('POST', `/projects/${p.id}/invites`, { role: 'member' })
    ).json<Invite>();
    expect((await adv.req('DELETE', `/projects/${p.id}`)).statusCode).toBe(403);
    expect((await mem.req('DELETE', `/projects/${p.id}`)).statusCode).toBe(403);
    expect((await o.req('DELETE', `/projects/${p.id}`)).statusCode).toBe(204);
    for (const s of [o, adv, mem]) {
      expect((await s.req('GET', `/projects/${p.id}`)).statusCode).toBe(404);
      expect((await s.req('GET', `/projects/${p.id}/timeline`)).statusCode).toBe(404);
      expect(
        (await s.req('GET', '/projects')).json<ProjectWithRole[]>().map((x) => x.id),
      ).not.toContain(p.id);
    }
    const ev = (await events(p.id)).find((e) => e.type === 'project.updated');
    expect(ev?.type === 'project.updated' && ev.payload.archivedAt).toBeTruthy();
    expect((await o.req('DELETE', `/projects/${p.id}`)).statusCode).toBe(404);
    // 归档项目的邀请也失效
    const late = await signup(t.app, '晚来的');
    expect((await late.req('POST', `/invites/${inv.token}/accept`)).statusCode).toBe(404);
  });
});

describe('members', () => {
  it('list visible to all members (including guest)', async () => {
    const res = await guest.req('GET', `${P()}/members`);
    expect(res.statusCode).toBe(200);
    const members = res.json<ProjectMember[]>();
    expect(members.map((m) => [m.user.id, m.role])).toEqual([
      [owner.user.id, 'owner'],
      [member.user.id, 'member'],
      [advisor.user.id, 'advisor'],
      [guest.user.id, 'guest'],
    ]);
    expect(members[0]!.user).toMatchObject({ name: '张三', email: owner.user.email });
  });

  it('role changes: member 403; advisor cannot touch owner or promote to owner; last owner 409', async () => {
    const url = (u: Session) => `${P()}/members/${u.user.id}`;
    expect((await member.req('PATCH', url(guest), { role: 'member' })).statusCode).toBe(403);
    expect((await advisor.req('PATCH', url(owner), { role: 'member' })).statusCode).toBe(403);
    expect((await advisor.req('PATCH', url(guest), { role: 'owner' })).statusCode).toBe(403);
    expect((await advisor.req('PATCH', url(guest), { role: 'nope' })).statusCode).toBe(422);
    expect(
      (await advisor.req('PATCH', `${P()}/members/usr_nope`, { role: 'member' })).statusCode,
    ).toBe(404);

    const demote = await owner.req('PATCH', url(owner), { role: 'member' });
    expect(demote.statusCode).toBe(409);
    expect(demote.json()).toMatchObject({ error: { code: 'conflict' } });

    const up = await advisor.req('PATCH', url(guest), { role: 'member' });
    expect(up.statusCode).toBe(200);
    expect(up.json<ProjectMember>()).toMatchObject({ role: 'member', user: { id: guest.user.id } });
    const ev = (await events()).filter((e) => e.type === 'member.updated').at(-1);
    expect(ev?.payload).toMatchObject({ role: 'member', user: { id: guest.user.id } });
    // guest 升为 member 后可以发言；恢复原角色
    expect(
      (await guest.req('POST', `${P()}/timeline`, { body: '我现在能说话了' })).statusCode,
    ).toBe(201);
    expect((await owner.req('PATCH', url(guest), { role: 'guest' })).statusCode).toBe(200);
    expect((await guest.req('POST', `${P()}/timeline`, { body: '又不行了' })).statusCode).toBe(403);
  });

  it('second owner allows demoting the first; removal rules', async () => {
    const {
      project: p,
      owner: o,
      others,
    } = await setupProject(t.app, ['member', 'advisor', 'guest']);
    const [mem, adv, gst] = others as [Session, Session, Session];
    const url = (u: Session) => `/projects/${p.id}/members/${u.user.id}`;
    // 成员不能移除别人，advisor 不能移除 owner
    expect((await mem.req('DELETE', url(gst))).statusCode).toBe(403);
    expect((await adv.req('DELETE', url(o))).statusCode).toBe(403);
    // 唯一的 owner 不能退出
    expect((await o.req('DELETE', url(o))).statusCode).toBe(409);
    // advisor 可以移除 guest
    expect((await adv.req('DELETE', url(gst))).statusCode).toBe(204);
    expect((await gst.req('GET', `/projects/${p.id}`)).statusCode).toBe(404);
    expect((await adv.req('DELETE', url(gst))).statusCode).toBe(404);
    // owner 把 advisor 升为 owner 后，自己可以降级
    expect((await o.req('PATCH', url(adv), { role: 'owner' })).statusCode).toBe(200);
    expect((await o.req('PATCH', url(o), { role: 'advisor' })).statusCode).toBe(200);
    expect((await o.req('DELETE', `/projects/${p.id}`)).statusCode).toBe(403);
    expect((await adv.req('PATCH', url(adv), { role: 'member' })).statusCode).toBe(409);
  });

  it('member can leave (DELETE self) → member.removed, project gone for them', async () => {
    const { project: p, others } = await setupProject(t.app, ['member']);
    const mem = others[0]!;
    const res = await mem.req('DELETE', `/projects/${p.id}/members/${mem.user.id}`);
    expect(res.statusCode).toBe(204);
    expect((await mem.req('GET', '/projects')).json<ProjectWithRole[]>()).toEqual([]);
    expect((await mem.req('GET', `/projects/${p.id}`)).statusCode).toBe(404);
    const ev = (await events(p.id)).find((e) => e.type === 'member.removed');
    expect(ev?.payload).toEqual({ userId: mem.user.id });
  });
});

describe('invites', () => {
  it('member/guest 403; owner & advisor create and list', async () => {
    expect((await member.req('POST', `${P()}/invites`, { role: 'member' })).statusCode).toBe(403);
    expect((await guest.req('GET', `${P()}/invites`)).statusCode).toBe(403);
    expect((await owner.req('POST', `${P()}/invites`, { role: 'owner' })).statusCode).toBe(422);
    const res = await advisor.req('POST', `${P()}/invites`, { email: 'New@Example.com' });
    expect(res.statusCode).toBe(201);
    const inv = res.json<Invite>();
    expect(inv).toMatchObject({
      projectId: project.id,
      email: 'new@example.com',
      role: 'member',
      acceptedAt: null,
      createdBy: advisor.user.id,
    });
    expect(inv.token.length).toBeGreaterThan(16);
    expect(new Date(inv.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);
    const list = (await owner.req('GET', `${P()}/invites`)).json<Invite[]>();
    expect(list.map((i) => i.id)).toContain(inv.id);
  });

  it('accept: joins with role, publishes member.joined, idempotent for an existing member', async () => {
    const inv = (await owner.req('POST', `${P()}/invites`, { role: 'advisor' })).json<Invite>();
    const s = await signup(t.app, '赵六');
    const res = await s.req('POST', `/invites/${inv.token}/accept`);
    expect(res.statusCode).toBe(200);
    expect(res.json<Project>().id).toBe(project.id);
    const ev = (await events()).filter((e) => e.type === 'member.joined').at(-1);
    expect(ev?.payload).toMatchObject({ user: { id: s.user.id, name: '赵六' }, role: 'advisor' });
    expect(ev?.actor).toMatchObject({ kind: 'user', id: s.user.id });
    // 通用链接可多人使用；已是成员再接受不改角色
    const again = await member.req('POST', `/invites/${inv.token}/accept`);
    expect(again.statusCode).toBe(200);
    const members = (await owner.req('GET', `${P()}/members`)).json<ProjectMember[]>();
    expect(members.find((m) => m.user.id === member.user.id)?.role).toBe('member');
    expect(members.find((m) => m.user.id === s.user.id)?.role).toBe('advisor');

    expect((await s.req('POST', '/invites/nope/accept')).statusCode).toBe(404);
    const anon = await t.app.inject({ method: 'POST', url: `/api/v1/invites/${inv.token}/accept` });
    expect(anon.statusCode).toBe(401);
  });

  it('expired invite → 409', async () => {
    const inv = (await owner.req('POST', `${P()}/invites`, { role: 'member' })).json<Invite>();
    await t.db.db
      .update(invites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invites.id, inv.id));
    const s = await signup(t.app, '迟到');
    const res = await s.req('POST', `/invites/${inv.token}/accept`);
    expect(res.statusCode).toBe(409);
    expect((await s.req('GET', '/projects')).json<ProjectWithRole[]>()).toEqual([]);
  });

  it('targeted invite: other email 403; single use (cannot rejoin after removal)', async () => {
    const s = await signup(t.app, '定向');
    const inv = (
      await owner.req('POST', `${P()}/invites`, {
        role: 'member',
        email: s.user.email.toUpperCase(),
      })
    ).json<Invite>();
    const intruder = await signup(t.app, '路人甲');
    expect((await intruder.req('POST', `/invites/${inv.token}/accept`)).statusCode).toBe(403);

    expect((await s.req('POST', `/invites/${inv.token}/accept`)).statusCode).toBe(200);
    const listed = (await owner.req('GET', `${P()}/invites`)).json<Invite[]>();
    expect(listed.find((i) => i.id === inv.id)?.acceptedAt).not.toBeNull();
    // 已是成员时重复接受是空操作
    expect((await s.req('POST', `/invites/${inv.token}/accept`)).statusCode).toBe(200);

    // 被移出后不能拿同一个定向链接重新加入
    expect((await owner.req('DELETE', `${P()}/members/${s.user.id}`)).statusCode).toBe(204);
    const reuse = await s.req('POST', `/invites/${inv.token}/accept`);
    expect(reuse.statusCode).toBe(409);
    expect((await s.req('GET', P())).statusCode).toBe(404);
  });

  it('generic link: removed member cannot rejoin with an old link; a new link works', async () => {
    const old = (await owner.req('POST', `${P()}/invites`, { role: 'advisor' })).json<Invite>();
    const s = await signup(t.app, '被移出');
    expect((await s.req('POST', `/invites/${old.token}/accept`)).statusCode).toBe(200);
    expect((await owner.req('DELETE', `${P()}/members/${s.user.id}`)).statusCode).toBe(204);

    const reuse = await s.req('POST', `/invites/${old.token}/accept`);
    expect(reuse.statusCode).toBe(403);
    expect(reuse.json()).toMatchObject({
      error: { code: 'forbidden', message: '你已被移出这个项目，请向管理员要新的邀请链接' },
    });
    expect((await s.req('GET', P())).statusCode).toBe(404);
    // 别人仍可用同一个通用链接
    const other = await signup(t.app, '新来的');
    expect((await other.req('POST', `/invites/${old.token}/accept`)).statusCode).toBe(200);

    // 移出之后新建的链接可以用
    const fresh = (await owner.req('POST', `${P()}/invites`, { role: 'member' })).json<Invite>();
    expect((await s.req('POST', `/invites/${fresh.token}/accept`)).statusCode).toBe(200);
    expect((await s.req('GET', P())).statusCode).toBe(200);
  });

  it('DELETE invite: manage only; revoked link no longer works; other project → 404', async () => {
    const inv = (await owner.req('POST', `${P()}/invites`, { role: 'member' })).json<Invite>();
    expect((await member.req('DELETE', `${P()}/invites/${inv.id}`)).statusCode).toBe(403);
    expect((await guest.req('DELETE', `${P()}/invites/${inv.id}`)).statusCode).toBe(403);

    // 别的项目的管理员不能撤销本项目的邀请
    const otherProject = await setupProject(t.app, []);
    const cross = await otherProject.owner.req(
      'DELETE',
      `/projects/${otherProject.project.id}/invites/${inv.id}`,
    );
    expect(cross.statusCode).toBe(404);

    expect((await advisor.req('DELETE', `${P()}/invites/${inv.id}`)).statusCode).toBe(204);
    expect((await owner.req('DELETE', `${P()}/invites/${inv.id}`)).statusCode).toBe(404);
    const listed = (await owner.req('GET', `${P()}/invites`)).json<Invite[]>();
    expect(listed.some((i) => i.id === inv.id)).toBe(false);

    const s = await signup(t.app, '晚了一步');
    expect((await s.req('POST', `/invites/${inv.token}/accept`)).statusCode).toBe(404);
    expect((await s.req('GET', P())).statusCode).toBe(404);
  });
});

describe('non-member', () => {
  it('gets 404 on everything under P', async () => {
    const stranger = await signup(t.app, '陌生人');
    const calls: [Parameters<Session['req']>[0], string, unknown?][] = [
      ['GET', P()],
      ['PATCH', P(), { name: 'x' }],
      ['DELETE', P()],
      ['GET', `${P()}/members`],
      ['PATCH', `${P()}/members/${member.user.id}`, { role: 'guest' }],
      ['DELETE', `${P()}/members/${member.user.id}`],
      ['GET', `${P()}/invites`],
      ['POST', `${P()}/invites`, { role: 'member' }],
      ['GET', `${P()}/events`],
      ['GET', `${P()}/timeline`],
      ['POST', `${P()}/timeline`, { body: 'hi' }],
      ['GET', `${P()}/threads`],
      ['GET', `${P()}/agents`],
      ['GET', `${P()}/memory`],
    ];
    for (const [method, url, body] of calls) {
      const res = await stranger.req(method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
    }
    // 不存在的项目同样 404
    expect((await owner.req('GET', '/projects/prj_nope')).statusCode).toBe(404);
  });
});

describe('P/events', () => {
  it('returns events after afterSeq in seq order; personal-thread events only for the owner', async () => {
    const { project: p, owner: o, others } = await setupProject(t.app, ['member', 'guest']);
    const [mem, gst] = others as [Session, Session];
    const before = (await o.req('GET', `/projects/${p.id}/events`)).json<AnyProjectEvent[]>();
    expect(before.length).toBeGreaterThan(0);
    const seqs = before.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const afterSeq = seqs.at(-1)!;

    const personal = (
      await mem.req('POST', `/projects/${p.id}/threads`, { body: '私下想想怎么做消融' })
    ).json<Thread>();
    await o.req('POST', `/projects/${p.id}/timeline`, { body: '公开消息' });

    const mine = (await mem.req('GET', `/projects/${p.id}/events?afterSeq=${afterSeq}`)).json<
      AnyProjectEvent[]
    >();
    expect(mine.every((e) => e.seq > afterSeq)).toBe(true);
    expect(mine.map((e) => e.seq)).toEqual([...mine.map((e) => e.seq)].sort((a, b) => a - b));
    expect(mine.some((e) => e.type === 'thread.created' && e.payload.id === personal.id)).toBe(
      true,
    );
    expect(mine.some((e) => e.type === 'message.created' && e.threadId === personal.id)).toBe(true);

    for (const s of [o, gst]) {
      const theirs = (await s.req('GET', `/projects/${p.id}/events?afterSeq=${afterSeq}`)).json<
        AnyProjectEvent[]
      >();
      expect(theirs.some((e) => e.threadId === personal.id)).toBe(false);
      expect(
        theirs.some(
          (e) =>
            (e.type === 'thread.created' || e.type === 'thread.updated') &&
            e.payload.id === personal.id,
        ),
      ).toBe(false);
      expect(
        theirs.some((e) => e.type === 'message.created' && e.payload.body === '公开消息'),
      ).toBe(true);
    }

    const limited = (await o.req('GET', `/projects/${p.id}/events?afterSeq=0&limit=2`)).json<
      AnyProjectEvent[]
    >();
    expect(limited.map((e) => e.seq)).toEqual([1, 2]);
    expect((await o.req('GET', `/projects/${p.id}/events?afterSeq=-1`)).statusCode).toBe(422);
  });
});
