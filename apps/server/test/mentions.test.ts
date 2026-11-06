import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { inboxItems, messages, projectMembers, threads } from '../src/db/schema';
import { makeApp, signup, type TestApp, type Session } from './helpers';
let t: TestApp;
const sessions: Record<string, Session> = {};
let pid: string;
const body = '@同名 @同名 @同名甲';
const first = { userId: 'usr_one', label: '同名', start: 0, end: 3 };
const second = { userId: 'usr_two', label: '同名', start: 4, end: 7 };
const req = (method: 'POST' | 'PATCH', path: string, payload: unknown, user = 'usr_owner') =>
  sessions[user]!.req(method, `/projects/${pid}${path}`, payload);
const inbox = (id: string) =>
  t.db.db
    .select()
    .from(inboxItems)
    .where(and(eq(inboxItems.sourceId, id), eq(inboxItems.kind, 'mention')));
beforeAll(async () => {
  t = await makeApp();
  await Promise.all(
    [
      ['usr_owner', '作者'],
      ['usr_one', '同名'],
      ['usr_two', '同名'],
      ['usr_prefix', '同名甲'],
      ['usr_out', '项目外'],
      ['usr_guest', '访客'],
    ].map(async ([id, name]) => {
      sessions[id!] = await signup(t.app, name!);
    }),
  );
  const project = await sessions.usr_owner!.req('POST', '/projects', { name: '提及验证' });
  expect(project.statusCode).toBe(201);
  pid = project.json().id;
  for (const id of ['usr_one', 'usr_two', 'usr_prefix', 'usr_guest'])
    await t.db.db.insert(projectMembers).values({
      projectId: pid,
      userId: sessions[id]!.user.id,
      role: id === 'usr_guest' ? 'guest' : 'member',
    });
  first.userId = sessions.usr_one!.user.id;
  second.userId = sessions.usr_two!.user.id;
}, 60000);
afterAll(() => t.close());
describe('结构化聊天提及', () => {
  it('精确通知选中的 ID，同名、前缀与手写文本不触发误提醒', async () => {
    const manual = await req('POST', '/timeline', { body });
    expect(manual.statusCode).toBe(201);
    expect(await inbox(manual.json().id)).toHaveLength(0);
    const selected = await req('POST', '/timeline', { body, mentions: [first] });
    expect(selected.statusCode).toBe(201);
    const list = await inbox(selected.json().id);
    expect(list.map((i) => i.userId)).toEqual([sessions.usr_one!.user.id]);
    expect(list[0]!.href).toBe(`/p/${pid}#${selected.json().id}`);
  });
  it('编辑只提醒新增对象，已处理后重新添加也不重发', async () => {
    const created = await req('POST', '/timeline', { body, mentions: [first] });
    const id = created.json().id;
    expect(
      (await req('PATCH', `/messages/${id}`, { body, mentions: [first, second] })).statusCode,
    ).toBe(200);
    expect((await inbox(id)).map((i) => i.userId).sort()).toEqual(
      [sessions.usr_one!.user.id, sessions.usr_two!.user.id].sort(),
    );
    await t.db.db.update(inboxItems).set({ doneAt: new Date() }).where(eq(inboxItems.sourceId, id));
    await req('PATCH', `/messages/${id}`, { body: '修改后' });
    await req('PATCH', `/messages/${id}`, { body, mentions: [first, second] });
    expect(await inbox(id)).toHaveLength(2);
  });
  it('正文重复提及同一成员只提醒一次，项目线程提醒保留频道与定位', async () => {
    const duplicate = await req('POST', '/timeline', {
      body: '@同名 @同名',
      mentions: [first, { ...first, start: 4, end: 7 }],
    });
    expect(duplicate.statusCode).toBe(201);
    expect(await inbox(duplicate.json().id)).toHaveLength(1);
    await t.db.db.insert(threads).values({
      id: 'thr_mentions',
      projectId: pid,
      rootMessageId: duplicate.json().id,
      title: '项目线程',
      kind: 'project',
    });
    const team = await req('POST', '/threads/thr_mentions/messages', {
      body,
      mentions: [first],
      agentVisible: false,
    });
    expect(team.statusCode).toBe(201);
    expect((await inbox(team.json().id))[0]!.href).toBe(
      `/p/${pid}/threads/thr_mentions?discussion=thr_mentions#${team.json().id}`,
    );
    expect(team.json().agentVisible).toBe(false);
  });
  it('拒绝跨项目成员、越界、重叠与无效文本；访客不能发送', async () => {
    for (const mentions of [
      [{ ...first, userId: sessions.usr_out!.user.id }],
      [{ ...first, end: 300 }],
      [{ ...first, label: '伪造' }],
      [first, first],
    ])
      expect((await req('POST', '/timeline', { body, mentions })).statusCode).toBe(422);
    expect(
      (await req('POST', '/timeline', { body, mentions: [first] }, 'usr_guest')).statusCode,
    ).toBe(403);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/api/v1/projects/${pid}/timeline`,
          payload: { body, mentions: [first] },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('不提醒自己，团队讨论提醒打开对应频道与消息', async () => {
    const self = await req('POST', '/timeline', {
      body: '@作者',
      mentions: [{ userId: sessions.usr_owner!.user.id, label: '作者', start: 0, end: 3 }],
    });
    expect(await inbox(self.json().id)).toHaveLength(0);
    const team = await req('POST', '/timeline', { body, mentions: [first], agentVisible: false });
    expect(team.statusCode).toBe(201);
    expect((await inbox(team.json().id))[0]!.href).toBe(
      `/p/${pid}?discussion=project#${team.json().id}`,
    );
    expect(team.json().agentVisible).toBe(false);
  });
  it('个人会话不能通知他人，成员离开后不能新增提及', async () => {
    await t.db.db.insert(messages).values({
      id: 'msg_private',
      projectId: pid,
      body: '私人',
      authorKind: 'user',
      authorId: sessions.usr_owner!.user.id,
      authorName: '作者',
    });
    await t.db.db.insert(threads).values({
      id: 'thr_private',
      projectId: pid,
      rootMessageId: 'msg_private',
      title: '私人',
      kind: 'personal',
      ownerUserId: sessions.usr_owner!.user.id,
    });
    expect(
      (await req('POST', '/threads/thr_private/messages', { body, mentions: [first] })).statusCode,
    ).toBe(422);
    expect((await req('POST', '/threads/thr_private/messages', { body })).statusCode).toBe(201);
    await t.db.db
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, pid),
          eq(projectMembers.userId, sessions.usr_one!.user.id),
        ),
      );
    expect((await req('POST', '/timeline', { body, mentions: [first] })).statusCode).toBe(422);
  });
});
