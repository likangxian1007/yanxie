import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Message, Project, Thread } from '@srh/shared';
import { agentSessions, projects } from '../src/db/schema';
import { projectTools } from '../src/agents/tools/project';
import { messagingTools } from '../src/agents/tools/messaging';
import { ToolError, type ToolContext } from '../src/agents/tools/types';
import { enqueueWake, pendingWakeups, renderWake } from '../src/agents/runtime/wake';
import { makeApp, setupProject, type Session, type TestApp } from './helpers';

/**
 * 验收报告附录 B 第 1、2 条（阻断 / 严重）：
 * 旁聊（agentVisible=false）和别人的个人会话，任何 agent 的读工具和唤醒信封里都不能出现，
 * 因为 agent 的思路（steps）对全项目（含访客）可见。
 */
const SIDE = 'SIDE-LUNCH-4242';
const PRIV = 'ZETA-PRIV-7781';

let t: TestApp;
let project: Project;
let owner: Session;
let member: Session;
let coord: ToolContext;
let sideId: string;
let personal: Thread;
let personalMsgId: string;

const tool = (name: string) => {
  const def = [...projectTools, ...messagingTools].find((d) => d.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return (args: unknown) =>
    def.run(coord, def.schema.parse(args)) as Promise<Record<string, unknown>>;
};

beforeAll(async () => {
  t = await makeApp();
  const p = await setupProject(t.app);
  project = p.project;
  owner = p.owner;
  member = p.others[0]!;
  const P = `/projects/${project.id}`;

  sideId = (
    await owner.req('POST', `${P}/timeline`, {
      body: `旁聊：午饭吃什么？暗号 ${SIDE}`,
      agentVisible: false,
    })
  ).json<Message>().id;
  await owner.req('POST', `${P}/timeline`, { body: '正常的项目消息' });

  personal = (
    await member.req('POST', `${P}/threads`, { body: `我的私人想法 ${PRIV}` })
  ).json<Thread>();
  personalMsgId = (await member.req('GET', `${P}/threads/${personal.id}/messages`)).json<{
    items: Message[];
  }>().items[0]!.id;
  await member.req('POST', `${P}/threads/${personal.id}/messages`, {
    body: `私人旁聊 ${PRIV}-SIDE`,
    agentVisible: false,
  });
  const fwd = await member.req('POST', `${P}/threads/${personal.id}/forward`, { note: '转发附言' });
  expect(fwd.statusCode).toBe(201);

  const db = t.app.ctx.db.db;
  const [session] = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.projectId, project.id), eq(agentSessions.role, 'coordinator')));
  const [projectRow] = await db.select().from(projects).where(eq(projects.id, project.id));
  coord = {
    ctx: t.app.ctx,
    session: session!,
    project: projectRow!,
    thread: null,
    turnId: 'turn_test',
    actor: { kind: 'agent', id: session!.id, name: '研协' },
    requesterUserId: owner.user.id,
    visible: new Set(),
    setActivity: async () => {},
  };
}, 60_000);

afterAll(async () => {
  await t.close();
});

describe('agent 读不到旁聊与别人的个人会话', () => {
  it('fetch_timeline 不含旁聊', async () => {
    const res = await tool('fetch_timeline')({});
    const text = JSON.stringify(res);
    expect(text).toContain('正常的项目消息');
    expect(text).not.toContain(SIDE);
  });

  it('fetch_messages 按 id 读旁聊 → 读不到', async () => {
    const res = await tool('fetch_messages')({ message_ids: [sideId, personalMsgId] });
    expect(res.messages).toEqual([]);
  });

  it('search_project 搜不到旁聊和个人会话', async () => {
    expect(JSON.stringify(await tool('search_project')({ query: SIDE }))).not.toContain(SIDE);
    expect(JSON.stringify(await tool('search_project')({ query: PRIV }))).not.toContain(
      `我的私人想法`,
    );
  });

  it('协调者 fetch_thread 已转发的个人会话 → 拒绝，并提示去问转发人', async () => {
    await expect(tool('fetch_thread')({ thread_id: personal.id })).rejects.toBeInstanceOf(
      ToolError,
    );
    await expect(tool('fetch_thread')({ thread_id: personal.id })).rejects.toThrow(/转发卡片/u);
  });

  it('对旁聊 react → 找不到消息', async () => {
    await expect(tool('react')({ message_id: sideId, emoji: '👍' })).rejects.toBeInstanceOf(
      ToolError,
    );
  });

  it('唤醒信封里引用旁聊或个人会话消息时，服务器不展开原文', async () => {
    await enqueueWake(t.app.ctx, coord.session, 'mention', {
      type: 'relay',
      reason: 'followup',
      note: '测试引用',
      citedIds: [sideId, personalMsgId],
    } as never);
    const rows = await pendingWakeups(t.app.ctx, coord.session.id);
    const { text } = await renderWake(t.app.ctx, coord.session, rows);
    expect(text).not.toContain(SIDE);
    expect(text).not.toContain(PRIV);
  });

  it('转发卡片的摘要只含 agent 可见的消息', async () => {
    const tl = (await owner.req('GET', `/projects/${project.id}/timeline`)).json<{
      items: Message[];
    }>();
    const card = tl.items.find((m) => m.kind === 'forward')!;
    const summary = (card.meta as { summary: string }).summary;
    expect(summary).toContain(PRIV);
    expect(summary).not.toContain(`${PRIV}-SIDE`);
  });
});
