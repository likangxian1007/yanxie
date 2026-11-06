import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ActorRef, Todo } from '@srh/shared';
import { collab } from '../../src/agents/tools/collab-port';
import { inboxItems, threads } from '../../src/db/schema';
import { createTodo } from '../../src/modules/todos/service';
import { setupCollabApp, type CollabTestApp } from './helpers';

const P = 'prj_todo';
const base = `/api/v1/projects/${P}`;

let t: CollabTestApp;

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
async function req(user: string, method: Method, url: string, payload?: unknown) {
  return t.app.inject({
    method,
    url: `${base}${url}`,
    headers: t.as(user),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function create(user: string, body: Record<string, unknown>): Promise<Todo> {
  const res = await req(user, 'POST', '/todos', body);
  expect(res.statusCode).toBe(201);
  return res.json<Todo>();
}

async function list(user: string, query = ''): Promise<Todo[]> {
  const res = await req(user, 'GET', `/todos${query}`);
  expect(res.statusCode).toBe(200);
  return res.json<Todo[]>();
}

async function lastEvent(type: string) {
  const events = await t.app.ctx.bus.listSince(P, 0, 10_000);
  return events.filter((e) => e.type === type).at(-1);
}

beforeAll(async () => {
  t = await setupCollabApp();
  await t.seedUser('usr_owner', '王老师');
  await t.seedUser('usr_mem', '张三');
  await t.seedUser('usr_mem2', '李四');
  await t.seedUser('usr_guest', '访客甲');
  await t.seedUser('usr_out', '路人');
  await t.seedProject(P, 'usr_owner');
  await t.addMember(P, 'usr_mem', 'member');
  await t.addMember(P, 'usr_mem2', 'member');
  await t.addMember(P, 'usr_guest', 'guest');
  await t.db.db
    .insert(threads)
    .values({ id: 'thr_todo', projectId: P, rootMessageId: 'msg_todo', title: '写方法章节' });
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('todos', () => {
  let shared: Todo;
  let personal: Todo;

  it('建共享待办与个人待办；个人待办只有主人可见', async () => {
    shared = await create('usr_mem', { title: '订组会会议室', priority: 'high' });
    expect(shared).toMatchObject({ ownerUserId: null, done: false, priority: 'high' });
    expect(await lastEvent('todo.created')).toMatchObject({ payload: { id: shared.id } });

    personal = await create('usr_mem', { title: '读两篇相关工作', personal: true });
    expect(personal.ownerUserId).toBe('usr_mem');
    expect(personal.position < shared.position).toBe(true);

    expect((await list('usr_mem')).map((x) => x.id)).toEqual([personal.id, shared.id]);
    expect((await list('usr_owner')).map((x) => x.id)).toEqual([shared.id]);
    expect((await list('usr_mem2', '?scope=mine')).map((x) => x.id)).toEqual([]);

    // 别人改/删个人待办 → 404
    expect(
      (await req('usr_owner', 'PATCH', `/todos/${personal.id}`, { done: true })).statusCode,
    ).toBe(404);
    expect((await req('usr_owner', 'DELETE', `/todos/${personal.id}`)).statusCode).toBe(404);
    // 拖到别人的个人待办之后 → 422
    const sneak = await req('usr_owner', 'PATCH', `/todos/${shared.id}`, {
      afterTodoId: personal.id,
    });
    expect(sneak.statusCode).toBe(422);
  });

  it('scope=project / scope=mine', async () => {
    const assigned = await create('usr_owner', { title: '跑一下对比实验', assigneeId: 'usr_mem' });
    const project = await list('usr_mem', '?scope=project');
    expect(project.every((x) => x.ownerUserId === null)).toBe(true);
    expect(project.map((x) => x.id)).toContain(assigned.id);

    const mine = await list('usr_mem', '?scope=mine');
    expect(mine.map((x) => x.id).sort()).toEqual([assigned.id, personal.id].sort());
    expect((await list('usr_owner', '?scope=mine')).map((x) => x.id)).toEqual([]);

    expect((await req('usr_mem', 'GET', '/todos?scope=all')).statusCode).toBe(422);
  });

  it('非成员 404，访客只读', async () => {
    expect((await req('usr_out', 'GET', '/todos')).statusCode).toBe(404);
    expect((await req('usr_guest', 'GET', '/todos')).statusCode).toBe(200);
    expect((await req('usr_guest', 'POST', '/todos', { title: '访客' })).statusCode).toBe(403);
    expect(
      (await req('usr_guest', 'PATCH', `/todos/${shared.id}`, { done: true })).statusCode,
    ).toBe(403);
  });

  it('完成 / 取消完成：写入与清空 completedAt，已完成排在后面', async () => {
    const done = await req('usr_mem2', 'PATCH', `/todos/${shared.id}`, { done: true });
    expect(done.statusCode).toBe(200);
    const doneTodo = done.json<Todo>();
    expect(doneTodo.done).toBe(true);
    expect(doneTodo.completedAt).not.toBeNull();
    expect(await lastEvent('todo.updated')).toMatchObject({
      payload: { id: shared.id, done: true },
    });

    const all = await list('usr_mem');
    expect(all.at(-1)!.id).toBe(shared.id);
    expect((await list('usr_mem', '?done=true')).map((x) => x.id)).toEqual([shared.id]);
    expect((await list('usr_mem', '?done=false')).some((x) => x.id === shared.id)).toBe(false);

    const undone = await req('usr_mem2', 'PATCH', `/todos/${shared.id}`, { done: false });
    expect(undone.json<Todo>()).toMatchObject({ done: false, completedAt: null });
  });

  it('已完成的按 completedAt 倒序', async () => {
    const a = await create('usr_owner', { title: '完成甲' });
    const b = await create('usr_owner', { title: '完成乙' });
    await req('usr_owner', 'PATCH', `/todos/${a.id}`, { done: true });
    await new Promise((r) => setTimeout(r, 5));
    await req('usr_owner', 'PATCH', `/todos/${b.id}`, { done: true });
    const doneIds = (await list('usr_owner', '?done=true')).map((x) => x.id);
    expect(doneIds.indexOf(b.id)).toBeLessThan(doneIds.indexOf(a.id));
  });

  it('拖动排序：afterTodoId 插在某条之后，null 放到最前', async () => {
    const a = await create('usr_owner', { title: '排序 A' });
    const b = await create('usr_owner', { title: '排序 B' });
    const c = await create('usr_owner', { title: '排序 C' });
    const order = async () =>
      (await list('usr_owner', '?scope=project&done=false'))
        .map((x) => x.title)
        .filter((x) => x.startsWith('排序'));
    expect(await order()).toEqual(['排序 C', '排序 B', '排序 A']);

    await req('usr_owner', 'PATCH', `/todos/${a.id}`, { afterTodoId: c.id });
    expect(await order()).toEqual(['排序 C', '排序 A', '排序 B']);

    await req('usr_owner', 'PATCH', `/todos/${b.id}`, { afterTodoId: null });
    expect(await order()).toEqual(['排序 B', '排序 C', '排序 A']);

    await req('usr_owner', 'PATCH', `/todos/${b.id}`, { afterTodoId: a.id });
    expect(await order()).toEqual(['排序 C', '排序 A', '排序 B']);
  });

  it('指派给成员 → 收件箱；指派给 agent → 事件 threadId', async () => {
    const todo = await create('usr_owner', { title: '补充数据集说明', assigneeId: 'usr_mem2' });
    const items = await t.db.db.select().from(inboxItems).where(eq(inboxItems.sourceId, todo.id));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      userId: 'usr_mem2',
      kind: 'assignment',
      title: '「补充数据集说明」指派给了你',
      href: `/p/${P}/todos?todo=${todo.id}`,
    });
    expect(await lastEvent('todo.created')).toMatchObject({ threadId: null });

    const res = await req('usr_owner', 'PATCH', `/todos/${todo.id}`, {
      assigneeId: 'agent:thr_todo',
    });
    expect(res.json<Todo>().assigneeId).toBe('agent:thr_todo');
    expect(await lastEvent('todo.updated')).toMatchObject({ threadId: 'thr_todo' });

    await req('usr_owner', 'PATCH', `/todos/${todo.id}`, { notes: '只改备注' });
    expect(await lastEvent('todo.updated')).toMatchObject({ threadId: null });

    // 完成后收件箱项标为完成
    await req('usr_owner', 'PATCH', `/todos/${todo.id}`, { done: true });
    const [item] = await t.db.db.select().from(inboxItems).where(eq(inboxItems.sourceId, todo.id));
    expect(item?.doneAt).toBeInstanceOf(Date);

    // 自己指派给自己不提醒
    const self = await create('usr_owner', { title: '自己做', assigneeId: 'usr_owner' });
    const none = await t.db.db.select().from(inboxItems).where(eq(inboxItems.sourceId, self.id));
    expect(none).toHaveLength(0);

    // 非成员、个人待办指派给别人 → 422
    expect(
      (await req('usr_owner', 'POST', '/todos', { title: 'x', assigneeId: 'usr_out' })).statusCode,
    ).toBe(422);
    const bad = await req('usr_owner', 'POST', '/todos', {
      title: '私事',
      personal: true,
      assigneeId: 'usr_mem',
    });
    expect(bad.statusCode).toBe(422);
  });

  it('删除：发 todo.deleted', async () => {
    const todo = await create('usr_mem', { title: '要删的', personal: true });
    expect((await req('usr_mem', 'DELETE', `/todos/${todo.id}`)).statusCode).toBe(204);
    expect(await lastEvent('todo.deleted')).toMatchObject({ payload: { id: todo.id } });
    expect((await req('usr_mem', 'DELETE', `/todos/${todo.id}`)).statusCode).toBe(404);
  });

  it('端口已注册；agent 调用忽略 personal，source 原样保存', async () => {
    const port = collab('todos');
    expect(port).toBeDefined();
    expect(port!.create).toBe(createTodo);
    const agent: ActorRef = { kind: 'agent', id: 'agt_y', name: '协调者' };
    const todo = await port!.create(t.app.ctx, agent, P, {
      title: '下期：补消融实验',
      personal: true,
      assigneeId: 'agent:thr_todo',
      source: { kind: 'report', id: 'rpt_1' },
    });
    expect(todo).toMatchObject({
      ownerUserId: null,
      assigneeId: 'agent:thr_todo',
      source: { kind: 'report', id: 'rpt_1' },
      createdBy: agent,
    });
    expect(await lastEvent('todo.created')).toMatchObject({
      threadId: 'thr_todo',
      payload: { id: todo.id },
    });
  });
});
