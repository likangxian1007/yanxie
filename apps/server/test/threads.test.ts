import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type {
  ActorRef,
  Decision,
  ForwardMessageMeta,
  InboxItem,
  Message,
  Page,
  Project,
  Thread,
  WorkClaim,
} from '@srh/shared';
import { buildSystemPrompt } from '../src/agents/runtime/context';
import { agentSessions, projects, threads } from '../src/db/schema';
import { createClaim, listClaims } from '../src/modules/claims/service';
import { createDecision, createProjectThread } from '../src/modules/threads/service';
import { makeApp, setupProject, type Session, type TestApp } from './helpers';

/**
 * 线程、个人工作区、转发、决策卡（API.md §2.4）。
 * 项目线程由 agent 的 start_thread 创建，这里直接调 service 的 createProjectThread。
 */
let t: TestApp;
let project: Project;
let owner: Session;
let member: Session;
let advisor: Session;
let guest: Session;

const agentActor = (sessionId: string): ActorRef => ({
  kind: 'agent',
  id: sessionId,
  name: '研协',
});

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
const T = (id: string) => `${P()}/threads/${id}`;
const events = () => t.app.ctx.bus.listSince(project.id, 0, 1000);

/** 成员在时间线发需求 → 以该消息为锚点开项目线程（为 workingFor 工作） */
async function startThread(by: Session, body: string, title: string) {
  const root = (await by.req('POST', `${P()}/timeline`, { body })).json<Message>();
  const res = await createProjectThread(t.app.ctx, {
    projectId: project.id,
    rootMessageId: root.id,
    title,
    workingForUserId: by.user.id,
    actor: agentActor('agt_coord'),
  });
  return { root, ...res };
}

/** 线程 agent 已空闲（测试里没有运行时，会话一直是 queued） */
async function idleSession(sessionId: string) {
  await t.db.db
    .update(agentSessions)
    .set({ status: 'idle' })
    .where(eq(agentSessions.id, sessionId));
}

describe('project threads', () => {
  let thread: Thread;
  let sessionId: string;
  let rootId: string;

  it('createProjectThread: thread.created, agent session, root message linked; idempotent', async () => {
    const r = await startThread(member, '帮我复现 GraphCL 的结果', 'GraphCL 复现');
    thread = r.thread;
    sessionId = r.sessionId;
    rootId = r.root.id;
    expect(r.alreadyRunning).toBe(false);
    expect(thread).toMatchObject({
      kind: 'project',
      projectId: project.id,
      rootMessageId: rootId,
      title: 'GraphCL 复现',
      ownerUserId: member.user.id,
      statusBucket: 'working',
      resolved: false,
      replyCount: 0,
      agentSessionId: sessionId,
      label: null,
      forwardedAt: null,
    });
    const evs = await events();
    expect(evs.some((e) => e.type === 'thread.created' && e.payload.id === thread.id)).toBe(true);
    expect(
      evs.some(
        (e) =>
          e.type === 'message.updated' &&
          e.payload.id === rootId &&
          e.payload.rootOfThreadId === thread.id,
      ),
    ).toBe(true);

    const again = await createProjectThread(t.app.ctx, {
      projectId: project.id,
      rootMessageId: rootId,
      title: '重复',
      workingForUserId: member.user.id,
      actor: agentActor('agt_coord'),
    });
    expect(again).toMatchObject({ alreadyRunning: true, sessionId, thread: { id: thread.id } });
  });

  it('GET list (filters) and one; everyone incl. guest can view', async () => {
    const other = await startThread(owner, '整理一下相关工作', '相关工作');
    const list = (await guest.req('GET', `${P()}/threads`)).json<Page<Thread>>();
    expect(list.items.map((x) => x.id)).toEqual([other.thread.id, thread.id]);
    const p1 = (await guest.req('GET', `${P()}/threads?limit=1`)).json<Page<Thread>>();
    expect(p1.items.map((x) => x.id)).toEqual([other.thread.id]);
    const p2 = (await guest.req('GET', `${P()}/threads?limit=1&cursor=${p1.nextCursor}`)).json<
      Page<Thread>
    >();
    expect(p2.items.map((x) => x.id)).toEqual([thread.id]);
    expect(p2.nextCursor).toBeNull();
    const working = (await guest.req('GET', `${P()}/threads?bucket=working&resolved=false`)).json<
      Page<Thread>
    >();
    expect(working.items).toHaveLength(2);
    expect(
      (await guest.req('GET', `${P()}/threads?resolved=true`)).json<Page<Thread>>().items,
    ).toEqual([]);
    expect((await guest.req('GET', `${P()}/threads?bucket=nope`)).statusCode).toBe(422);

    const one = await guest.req('GET', T(thread.id));
    expect(one.statusCode).toBe(200);
    expect(one.json<Thread>().id).toBe(thread.id);
    expect((await guest.req('GET', T('thr_nope'))).statusCode).toBe(404);
  });

  it('thread messages: post (guest 403), list, replyCount', async () => {
    expect((await guest.req('POST', `${T(thread.id)}/messages`, { body: 'x' })).statusCode).toBe(
      403,
    );
    const res = await advisor.req('POST', `${T(thread.id)}/messages`, { body: '注意随机种子' });
    expect(res.statusCode).toBe(201);
    expect(res.json<Message>()).toMatchObject({ threadId: thread.id, body: '注意随机种子' });
    const msgs = (await guest.req('GET', `${T(thread.id)}/messages`)).json<Page<Message>>();
    expect(msgs.items.map((m) => m.body)).toEqual(['注意随机种子']);
    expect((await guest.req('GET', T(thread.id))).json<Thread>().replyCount).toBe(1);
  });

  it('PATCH title/label; guest 403; invalid 422', async () => {
    expect((await guest.req('PATCH', T(thread.id), { title: 'x' })).statusCode).toBe(403);
    expect((await member.req('PATCH', T(thread.id), { title: '' })).statusCode).toBe(422);
    const res = await member.req('PATCH', T(thread.id), {
      title: 'GraphCL 复现（v2）',
      label: '复现',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Thread>()).toMatchObject({
      title: 'GraphCL 复现（v2）',
      label: '复现',
      resolved: false,
    });
    const cleared = await member.req('PATCH', T(thread.id), { label: null });
    expect(cleared.json<Thread>()).toMatchObject({ title: 'GraphCL 复现（v2）', label: null });
    const ev = (await events())
      .filter((e) => e.type === 'thread.updated' && e.payload.id === thread.id)
      .at(-1);
    expect(ev?.payload).toMatchObject({ label: null });
  });

  it('PATCH statusText: members edit the plan; guest 403; too long 422', async () => {
    const plan = '复现 GraphCL\n✓ 读论文\n✱ 跑基线\n○ 写结果表';
    expect((await guest.req('PATCH', T(thread.id), { statusText: plan })).statusCode).toBe(403);
    expect(
      (await member.req('PATCH', T(thread.id), { statusText: 'x'.repeat(4001) })).statusCode,
    ).toBe(422);
    const res = await member.req('PATCH', T(thread.id), { statusText: plan });
    expect(res.statusCode).toBe(200);
    expect(res.json<Thread>().statusText).toBe(plan);
    expect((await guest.req('GET', T(thread.id))).json<Thread>().statusText).toBe(plan);
    const ev = (await events())
      .filter((e) => e.type === 'thread.updated' && e.payload.id === thread.id)
      .at(-1);
    expect(ev?.payload).toMatchObject({ statusText: plan });

    // 线程 agent 下一轮的 system prompt 里带着成员改过的计划
    const [session] = await t.db.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId));
    const [projectRow] = await t.db.db.select().from(projects).where(eq(projects.id, project.id));
    const [threadRow] = await t.db.db.select().from(threads).where(eq(threads.id, thread.id));
    const prompt = await buildSystemPrompt(t.app.ctx, {
      session: session!,
      project: projectRow!,
      thread: threadRow!,
      toolNames: [],
      requesterUserId: null,
    });
    expect(prompt).toContain('当前计划');
    expect(prompt).toContain('✱ 跑基线');
  });

  it('resolve by someone else → completed, finished inbox for owner, claims released', async () => {
    const claim = await createClaim(t.app.ctx, agentActor(sessionId), project.id, {
      resourceKind: 'document',
      resourceRef: 'doc_method',
      mode: 'exclusive',
      intent: '改写方法部分',
      ttlSec: 1800,
      threadId: thread.id,
      onBehalfOfUserId: member.user.id,
    });
    expect(claim.status).toBe('active');

    const res = await advisor.req('PATCH', T(thread.id), { resolved: true });
    expect(res.statusCode).toBe(200);
    expect(res.json<Thread>()).toMatchObject({ resolved: true, statusBucket: 'completed' });

    const inbox = (await member.req('GET', `/inbox?projectId=${project.id}`)).json<InboxItem[]>();
    expect(inbox.find((i) => i.kind === 'finished' && i.sourceId === thread.id)).toMatchObject({
      userId: member.user.id,
      href: `/p/${project.id}/threads/${thread.id}`,
    });
    const active = await listClaims(t.app.ctx, project.id, {
      threadId: thread.id,
      status: 'active',
    });
    expect(active).toEqual([]);
    const evs = await events();
    expect(
      evs.some(
        (e) =>
          e.type === 'claim.updated' &&
          (e.payload as WorkClaim).id === claim.id &&
          e.payload.status === 'released',
      ),
    ).toBe(true);
    const resolvedList = (await guest.req('GET', `${P()}/threads?resolved=true`)).json<
      Page<Thread>
    >();
    expect(resolvedList.items.map((x) => x.id)).toEqual([thread.id]);
    const completed = (await guest.req('GET', `${P()}/threads?bucket=completed`)).json<
      Page<Thread>
    >();
    expect(completed.items.map((x) => x.id)).toEqual([thread.id]);
  });

  it('owner resolving their own thread gets no finished inbox', async () => {
    const r = await startThread(owner, '画一张结果图', '结果图');
    expect((await owner.req('PATCH', T(r.thread.id), { resolved: true })).statusCode).toBe(200);
    const inbox = (await owner.req('GET', '/inbox')).json<InboxItem[]>();
    expect(inbox.some((i) => i.sourceId === r.thread.id)).toBe(false);
  });

  it('a member posting in a resolved thread reopens it; side chat does not', async () => {
    await member.req('POST', `${T(thread.id)}/messages`, { body: '旁注', agentVisible: false });
    expect((await guest.req('GET', T(thread.id))).json<Thread>().resolved).toBe(true);

    const res = await member.req('POST', `${T(thread.id)}/messages`, { body: '还需要补一组消融' });
    expect(res.statusCode).toBe(201);
    const th = (await guest.req('GET', T(thread.id))).json<Thread>();
    expect(th.resolved).toBe(false);
    expect(th.statusBucket).not.toBe('completed');
  });
});

describe('personal threads', () => {
  let personal: Thread;

  it('create: personal thread + root message inside it, not on the timeline', async () => {
    const res = await member.req('POST', `${P()}/threads`, { body: '帮我想想消融实验怎么设计' });
    expect(res.statusCode).toBe(201);
    personal = res.json<Thread>();
    expect(personal).toMatchObject({
      kind: 'personal',
      ownerUserId: member.user.id,
      title: '帮我想想消融实验怎么设计',
      replyCount: 0,
    });
    expect(personal.agentSessionId).toBeTruthy();
    const msgs = (await member.req('GET', `${T(personal.id)}/messages`)).json<Page<Message>>();
    expect(msgs.items.map((m) => m.id)).toEqual([personal.rootMessageId]);
    const tl = (await owner.req('GET', `${P()}/timeline`)).json<Page<Message>>();
    expect(tl.items.some((m) => m.id === personal.rootMessageId)).toBe(false);
    expect((await guest.req('POST', `${P()}/threads`, { body: 'x' })).statusCode).toBe(403);
  });

  it('only the owner can see it: others 404 on GET / messages / post / patch / forward', async () => {
    expect((await member.req('GET', T(personal.id))).statusCode).toBe(200);
    for (const s of [owner, advisor, guest]) {
      expect((await s.req('GET', T(personal.id))).statusCode).toBe(404);
      expect((await s.req('GET', `${T(personal.id)}/messages`)).statusCode).toBe(404);
      expect((await s.req('GET', `${T(personal.id)}/messages?channel=team`)).statusCode).toBe(404);
      const list = (await s.req('GET', `${P()}/threads?kind=personal`)).json<Page<Thread>>();
      expect(list.items.map((x) => x.id)).not.toContain(personal.id);
    }
    expect((await member.req('GET', `${T(personal.id)}/messages?channel=bad`)).statusCode).toBe(
      422,
    );
    for (const s of [owner, advisor]) {
      expect((await s.req('POST', `${T(personal.id)}/messages`, { body: 'x' })).statusCode).toBe(
        404,
      );
      expect((await s.req('PATCH', T(personal.id), { title: 'x' })).statusCode).toBe(404);
      expect((await s.req('POST', `${T(personal.id)}/forward`, { note: 'x' })).statusCode).toBe(
        404,
      );
    }
    // 别人的个人会话里的消息也不能被改、加反应
    const rootUrl = `${P()}/messages/${personal.rootMessageId}`;
    expect((await owner.req('PUT', `${rootUrl}/reactions`, { emoji: '👍' })).statusCode).toBe(404);
    const mine = (await member.req('GET', `${P()}/threads?kind=personal`)).json<Page<Thread>>();
    expect(mine.items.map((x) => x.id)).toEqual([personal.id]);
    // 默认列表只有项目线程
    const projectList = (await member.req('GET', `${P()}/threads`)).json<Page<Thread>>();
    expect(projectList.items.every((x) => x.kind === 'project')).toBe(true);
  });

  it('forward → timeline message kind=forward with meta; thread.forwardedAt set', async () => {
    await member.req('POST', `${T(personal.id)}/messages`, { body: '先去掉数据增强试试' });
    const side = await member.req('POST', `${T(personal.id)}/messages`, {
      body: '私下吐槽',
      agentVisible: false,
    });
    const team = await member.req('GET', `${T(personal.id)}/messages?channel=team`);
    expect(team.statusCode).toBe(200);
    expect(team.json<Page<Message>>().items.map((m) => m.id)).toEqual([side.json<Message>().id]);
    const agent = await member.req('GET', `${T(personal.id)}/messages?channel=agent`);
    expect(agent.json<Page<Message>>().items.every((m) => m.agentVisible)).toBe(true);
    const res = await member.req('POST', `${T(personal.id)}/forward`, {
      note: '这个思路团队可以一起做',
    });
    expect(res.statusCode).toBe(201);
    const msg = res.json<Message>();
    expect(msg).toMatchObject({
      kind: 'forward',
      threadId: null,
      body: '这个思路团队可以一起做',
      author: { kind: 'user', id: member.user.id },
    });
    const meta = msg.meta as ForwardMessageMeta;
    expect(meta).toMatchObject({
      threadId: personal.id,
      threadTitle: personal.title,
      forwardedBy: { kind: 'user', id: member.user.id, name: '李四' },
    });
    expect(meta.summary.split('\n')).toEqual([
      '李四：帮我想想消融实验怎么设计',
      '李四：先去掉数据增强试试',
    ]);

    const tl = (await advisor.req('GET', `${P()}/timeline`)).json<Page<Message>>();
    expect(tl.items[0]).toMatchObject({ id: msg.id, kind: 'forward' });
    const th = (await member.req('GET', T(personal.id))).json<Thread>();
    expect(th.forwardedAt).not.toBeNull();
    // 线程不存在 / 项目线程不能转发
    expect((await member.req('POST', `${T('thr_nope')}/forward`, {})).statusCode).toBe(404);
    const pt = (await member.req('GET', `${P()}/threads`)).json<Page<Thread>>().items[0]!;
    expect((await member.req('POST', `${T(pt.id)}/forward`, {})).statusCode).toBe(404);
  });

  it('delete: only the owner, only personal; busy agent → 409; thread.deleted event', async () => {
    const res = await member.req('POST', `${P()}/threads`, { body: '临时问一下' });
    const tmp = res.json<Thread>();
    // agent 仍在排队（测试里没有运行时）→ 拒绝
    expect((await member.req('DELETE', T(tmp.id))).statusCode).toBe(409);
    await idleSession(tmp.agentSessionId!);
    // 别人看不到 → 404；项目线程不能删 → 403
    expect((await owner.req('DELETE', T(tmp.id))).statusCode).toBe(404);
    const pt = (await member.req('GET', `${P()}/threads`)).json<Page<Thread>>().items[0]!;
    expect((await owner.req('DELETE', T(pt.id))).statusCode).toBe(403);

    expect((await member.req('DELETE', T(tmp.id))).statusCode).toBe(204);
    expect((await member.req('GET', T(tmp.id))).statusCode).toBe(404);
    const mine = (await member.req('GET', `${P()}/threads?kind=personal`)).json<Page<Thread>>();
    expect(mine.items.map((x) => x.id)).not.toContain(tmp.id);
    const ev = (await events()).find((e) => e.type === 'thread.deleted');
    expect(ev?.payload).toEqual({ id: tmp.id });
  });
});

describe('decisions', () => {
  let thread: Thread;
  let sessionId: string;
  let decision: Decision;

  it('createDecision → decision message, decision.created, inbox, bucket blocked', async () => {
    const r = await startThread(member, '选哪个数据集做主实验？', '数据集选择');
    thread = r.thread;
    sessionId = r.sessionId;
    await idleSession(sessionId);

    decision = await createDecision(t.app.ctx, {
      projectId: project.id,
      threadId: thread.id,
      actor: agentActor(sessionId),
      question: '主实验用哪个数据集？',
      options: [
        { label: 'ZINC', consequence: '规模大，训练慢' },
        { label: 'QM9', consequence: '规模小，快速验证' },
      ],
      recommended: 1,
      reason: '先快速验证',
      notifyUserId: member.user.id,
    });
    expect(decision).toMatchObject({
      state: 'open',
      chosen: null,
      threadId: thread.id,
      recommended: 1,
    });

    const th = (await guest.req('GET', T(thread.id))).json<Thread>();
    expect(th.statusBucket).toBe('blocked');
    const msgs = (await guest.req('GET', `${T(thread.id)}/messages`)).json<Page<Message>>();
    const card = msgs.items.find((m) => m.id === decision.messageId);
    expect(card).toMatchObject({ kind: 'decision', body: '主实验用哪个数据集？' });
    expect((card!.meta as { decision: Decision }).decision).toMatchObject({
      id: decision.id,
      state: 'open',
    });

    const inbox = (await member.req('GET', `/inbox?projectId=${project.id}`)).json<InboxItem[]>();
    expect(inbox[0]).toMatchObject({ kind: 'decision', sourceId: decision.id });
    const evs = await events();
    expect(evs.some((e) => e.type === 'decision.created' && e.payload.id === decision.id)).toBe(
      true,
    );

    await expect(
      createDecision(t.app.ctx, {
        projectId: project.id,
        threadId: thread.id,
        actor: agentActor(sessionId),
        question: '坏的',
        options: [
          { label: 'A', consequence: '' },
          { label: 'B', consequence: '' },
        ],
        recommended: 2,
        notifyUserId: null,
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('answer: guest 403, invalid option 422, unknown 404', async () => {
    const url = `${P()}/decisions/${decision.id}/answer`;
    expect((await guest.req('POST', url, { chosen: 0 })).statusCode).toBe(403);
    const bad = await member.req('POST', url, { chosen: 3 });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: { code: 'validation_failed' } });
    expect((await member.req('POST', url, { chosen: 7 })).statusCode).toBe(422);
    expect((await member.req('POST', url, {})).statusCode).toBe(422);
    expect(
      (await member.req('POST', `${P()}/decisions/dec_nope/answer`, { chosen: 0 })).statusCode,
    ).toBe(404);
  });

  it('GET decision / message locate the card (站内引用 #dec_ / #msg_)；unknown 404', async () => {
    const d = (await guest.req('GET', `${P()}/decisions/${decision.id}`)).json<Decision>();
    expect(d).toMatchObject({
      id: decision.id,
      messageId: decision.messageId,
      threadId: thread.id,
    });
    const m = await guest.req('GET', `${P()}/messages/${decision.messageId}`);
    expect(m.statusCode).toBe(200);
    expect(m.json<Message>()).toMatchObject({ id: decision.messageId, threadId: thread.id });
    expect((await guest.req('GET', `${P()}/decisions/dec_nope`)).statusCode).toBe(404);
    expect((await guest.req('GET', `${P()}/messages/msg_nope`)).statusCode).toBe(404);
  });

  it("GET message in someone else's personal session → 404", async () => {
    const mine = (
      await member.req('POST', `${P()}/threads`, { body: '帮我想想实验设计' })
    ).json<Thread>();
    const page = (await member.req('GET', `${T(mine.id)}/messages`)).json<Page<Message>>();
    const first = page.items[0]!;
    expect((await member.req('GET', `${P()}/messages/${first.id}`)).statusCode).toBe(200);
    expect((await owner.req('GET', `${P()}/messages/${first.id}`)).statusCode).toBe(404);
  });

  it('answer → answered, card updated, bucket recomputed, inbox done; second answer 409', async () => {
    const url = `${P()}/decisions/${decision.id}/answer`;
    const res = await advisor.req('POST', url, { chosen: 1 });
    expect(res.statusCode).toBe(200);
    const answered = res.json<Decision>();
    expect(answered).toMatchObject({
      id: decision.id,
      state: 'answered',
      chosen: 1,
      chosenBy: { kind: 'user', id: advisor.user.id },
    });
    expect(answered.answeredAt).not.toBeNull();

    const th = (await guest.req('GET', T(thread.id))).json<Thread>();
    // 没有未答决策卡了；最后一条消息是 agent 发的决策卡 → 待查看
    expect(th.statusBucket).toBe('review_ready');

    const msgs = (await guest.req('GET', `${T(thread.id)}/messages`)).json<Page<Message>>();
    const card = msgs.items.find((m) => m.id === decision.messageId)!;
    expect((card.meta as { decision: Decision }).decision).toMatchObject({
      state: 'answered',
      chosen: 1,
    });

    const open = (await member.req('GET', `/inbox?projectId=${project.id}`)).json<InboxItem[]>();
    expect(open.some((i) => i.sourceId === decision.id)).toBe(false);
    const done = (await member.req('GET', `/inbox?projectId=${project.id}&done=true`)).json<
      InboxItem[]
    >();
    expect(done.find((i) => i.sourceId === decision.id)?.doneAt).not.toBeNull();

    const evs = await events();
    expect(
      evs.some(
        (e) =>
          e.type === 'decision.updated' &&
          e.payload.id === decision.id &&
          e.payload.state === 'answered',
      ),
    ).toBe(true);

    const second = await member.req('POST', url, { chosen: 0 });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      error: { code: 'conflict', details: { current: { state: 'answered' } } },
    });
  });

  it('并发回答同一张决策卡：只有一个成功，其余 409，只发一次 decision.updated', async () => {
    const d = await createDecision(t.app.ctx, {
      projectId: project.id,
      threadId: thread.id,
      actor: agentActor(sessionId),
      question: '并发测试',
      options: [
        { label: 'A', consequence: 'a' },
        { label: 'B', consequence: 'b' },
      ],
      recommended: 0,
      notifyUserId: null,
    });
    const url = `${P()}/decisions/${d.id}/answer`;
    const res = await Promise.all([
      member.req('POST', url, { chosen: 0 }),
      advisor.req('POST', url, { chosen: 1 }),
      owner.req('POST', url, { chosen: 1 }),
    ]);
    const codes = res.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409, 409]);
    const evs = await events();
    expect(
      evs.filter(
        (e) =>
          e.type === 'decision.updated' && e.payload.id === d.id && e.payload.state === 'answered',
      ),
    ).toHaveLength(1);
  });
});
