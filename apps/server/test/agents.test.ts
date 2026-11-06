import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentSession, AgentStep, Message, Page, Project, Thread } from '@srh/shared';
import { createProjectThread } from '../src/modules/threads/service';
import { makeApp, setupProject, type Session, type TestApp } from './helpers';

/**
 * Agent 透明度（API.md §2.5）：会话列表、单个会话、思路步骤、中止。
 * 测试里不启动运行时：线程 agent 会话停在 queued，协调者是 idle。
 */
let t: TestApp;
let project: Project;
let owner: Session;
let member: Session;
let advisor: Session;
let guest: Session;
let coordinator: AgentSession;
let threadSessionId: string;
let personal: Thread;

beforeAll(async () => {
  t = await makeApp();
  const s = await setupProject(t.app);
  project = s.project;
  owner = s.owner;
  [member, advisor, guest] = s.others as [Session, Session, Session];

  const root = (
    await owner.req('POST', `/projects/${project.id}/timeline`, { body: '帮我调研图对比学习' })
  ).json<Message>();
  const r = await createProjectThread(t.app.ctx, {
    projectId: project.id,
    rootMessageId: root.id,
    title: '调研',
    workingForUserId: owner.user.id,
    actor: { kind: 'agent', id: 'agt_coord', name: '研协' },
  });
  threadSessionId = r.sessionId;
  personal = (
    await member.req('POST', `/projects/${project.id}/threads`, { body: '我的私人问题' })
  ).json<Thread>();
}, 60_000);

afterAll(async () => {
  await t?.close();
});

const A = (id = '') => `/projects/${project.id}/agents${id ? `/${id}` : ''}`;

describe('GET P/agents', () => {
  it('lists coordinator + thread agents; personal agents only for their owner', async () => {
    const forOwner = (await owner.req('GET', A())).json<AgentSession[]>();
    expect(forOwner.map((a) => a.role)).toEqual(['coordinator', 'thread']);
    coordinator = forOwner[0]!;
    expect(coordinator).toMatchObject({
      projectId: project.id,
      threadId: null,
      status: 'idle',
      activity: null,
      workingForUserId: null,
      tokenUsage: { input: 0, output: 0, cached: 0 },
    });
    expect(forOwner[1]).toMatchObject({
      id: threadSessionId,
      status: 'queued',
      workingForUserId: owner.user.id,
    });

    const forMember = (await member.req('GET', A())).json<AgentSession[]>();
    expect(forMember.map((a) => a.role)).toEqual(['coordinator', 'thread', 'personal']);
    expect(forMember[2]).toMatchObject({
      id: personal.agentSessionId,
      threadId: personal.id,
      workingForUserId: member.user.id,
    });
    for (const s of [advisor, guest]) {
      const list = (await s.req('GET', A())).json<AgentSession[]>();
      expect(list.map((a) => a.id)).not.toContain(personal.agentSessionId);
    }
  });
});

describe('GET P/agents/:id', () => {
  it('returns a session; personal session 404 for others; unknown 404', async () => {
    const one = await guest.req('GET', A(coordinator.id));
    expect(one.statusCode).toBe(200);
    expect(one.json<AgentSession>()).toEqual(coordinator);
    expect((await member.req('GET', A(personal.agentSessionId!))).statusCode).toBe(200);
    expect((await owner.req('GET', A(personal.agentSessionId!))).statusCode).toBe(404);
    expect((await owner.req('GET', A('ags_nope'))).statusCode).toBe(404);
  });

  it('steps: empty page for a fresh session; personal steps hidden from others', async () => {
    const res = await advisor.req('GET', `${A(coordinator.id)}/steps`);
    expect(res.statusCode).toBe(200);
    expect(res.json<Page<AgentStep>>()).toEqual({ items: [], nextCursor: null });
    const byTurn = await guest.req(
      'GET',
      `${A(threadSessionId)}/steps?turnId=turn_x&order=desc&limit=5`,
    );
    expect(byTurn.json<Page<AgentStep>>()).toEqual({ items: [], nextCursor: null });
    expect((await guest.req('GET', `${A(coordinator.id)}/steps?limit=0`)).statusCode).toBe(422);
    expect((await owner.req('GET', `${A(personal.agentSessionId!)}/steps`)).statusCode).toBe(404);
  });
});

describe('POST P/agents/:id/stop', () => {
  it('guest 403; member stops a queued session → stopped + agent.updated', async () => {
    expect((await guest.req('POST', `${A(threadSessionId)}/stop`)).statusCode).toBe(403);
    const res = await member.req('POST', `${A(threadSessionId)}/stop`);
    expect(res.statusCode).toBe(200);
    expect(res.json<AgentSession>()).toMatchObject({
      id: threadSessionId,
      status: 'stopped',
      activity: null,
    });
    const evs = await t.app.ctx.bus.listSince(project.id, 0, 1000);
    const ev = evs
      .filter((e) => e.type === 'agent.updated' && e.payload.id === threadSessionId)
      .at(-1);
    expect(ev?.payload).toMatchObject({ status: 'stopped' });
    expect(ev?.actor).toMatchObject({ kind: 'user', id: member.user.id });
    // 排队中还没开始的一轮也被取消（终验 R2：空闲时 /stop 无效，随后照常开跑）
    const { pendingWakeups } = await import('../src/agents/runtime/wake');
    expect(await pendingWakeups(t.app.ctx, threadSessionId)).toHaveLength(0);
  });

  it('stopping an idle session returns it unchanged; others cannot stop a personal agent', async () => {
    const res = await advisor.req('POST', `${A(coordinator.id)}/stop`);
    expect(res.statusCode).toBe(200);
    expect(res.json<AgentSession>()).toMatchObject({ id: coordinator.id, status: 'idle' });
    expect((await owner.req('POST', `${A(personal.agentSessionId!)}/stop`)).statusCode).toBe(404);
    const own = await member.req('POST', `${A(personal.agentSessionId!)}/stop`);
    expect(own.json<AgentSession>().status).toBe('stopped');
    expect((await member.req('POST', `${A('ags_nope')}/stop`)).statusCode).toBe(404);
  });
});
