import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import type { DocComment, DocumentMeta } from '@srh/shared';
import { inboxItems } from '../../src/db/schema';
import { setupCollabApp, type CollabTestApp } from './helpers';

const PID = 'prj_cmt';
const base = `/api/v1/projects/${PID}`;

let t: CollabTestApp;
let doc: DocumentMeta;
const events: { type: string; payload: unknown }[] = [];

const ANCHOR = {
  start: { type: null, tname: 'default', item: { client: 1, clock: 3 }, assoc: 0 },
  end: { type: null, tname: 'default', item: { client: 1, clock: 9 }, assoc: 0 },
};

beforeAll(async () => {
  t = await setupCollabApp();
  await t.seedUser('usr_own', '张三', 1);
  await t.seedUser('usr_adv', '王老师', 2);
  await t.seedUser('usr_mem', '李四', 3);
  await t.seedUser('usr_gst', '访客', 4);
  await t.seedUser('usr_out', '外人', 5);
  await t.seedProject(PID, 'usr_own');
  await t.addMember(PID, 'usr_adv', 'advisor');
  await t.addMember(PID, 'usr_mem', 'member');
  await t.addMember(PID, 'usr_gst', 'guest');
  t.app.ctx.bus.onEvent((ev) => events.push(ev));
  const res = await t.app.inject({
    method: 'POST',
    url: `${base}/docs`,
    headers: t.as('usr_own'),
    payload: { title: '研究计划', markdown: '# 背景\n\n对比学习的增广策略。' },
  });
  doc = res.json();
}, 60_000);
afterAll(async () => {
  await t?.close();
});

const url = (suffix = '') => `${base}/docs/${doc.id}/comments${suffix}`;

async function post(user: string, payload: Record<string, unknown>) {
  return t.app.inject({ method: 'POST', url: url(), headers: t.as(user), payload });
}

async function inboxOf(userId: string, sourceId: string) {
  return t.db.db
    .select()
    .from(inboxItems)
    .where(and(eq(inboxItems.userId, userId), eq(inboxItems.sourceId, sourceId)));
}

describe('文档行内评论', () => {
  let root: DocComment;

  it('成员新开评论串：带锚点和引用原文，发 document.comment_created，@ 的人收到提醒', async () => {
    events.length = 0;
    const res = await post('usr_mem', {
      body: '这里的增广是不是要说明一下 @王老师',
      anchor: ANCHOR,
      quote: '增广策略',
      mentions: ['usr_adv', 'usr_out', 'usr_mem'],
    });
    expect(res.statusCode).toBe(201);
    root = res.json();
    expect(root).toMatchObject({
      documentId: doc.id,
      parentId: null,
      quote: '增广策略',
      anchor: ANCHOR,
      resolved: false,
      author: { kind: 'user', id: 'usr_mem', name: '李四' },
    });
    // 不是成员的、自己，都不算
    expect(root.mentions).toEqual(['usr_adv']);
    expect(root.id).toMatch(/^dcm_/u);
    const ev = events.find((e) => e.type === 'document.comment_created');
    expect(ev?.payload).toMatchObject({ id: root.id });

    const [item] = await inboxOf('usr_adv', root.id);
    expect(item).toMatchObject({ kind: 'mention', projectId: PID });
    expect(item!.title).toContain('李四');
    expect(item!.title).toContain('研究计划');
    expect(item!.href).toBe(`/p/${PID}/docs/${doc.id}?comment=${root.id}`);
  });

  it('导师可以回复；回复挂到首条上，首条作者收到提醒', async () => {
    const res = await post('usr_adv', { body: '同意，补一句', parentId: root.id });
    expect(res.statusCode).toBe(201);
    const reply: DocComment = res.json();
    expect(reply.parentId).toBe(root.id);
    expect(reply.anchor).toBeNull();
    const [item] = await inboxOf('usr_mem', reply.id);
    expect(item?.title).toContain('回复了你');

    // 回复的回复也挂在首条上
    const nested = await post('usr_own', { body: '好', parentId: reply.id });
    expect(nested.json().parentId).toBe(root.id);

    const list = await t.app.inject({ method: 'GET', url: url(), headers: t.as('usr_gst') });
    expect(list.statusCode).toBe(200);
    expect((list.json() as DocComment[]).map((c) => c.body)).toEqual([
      '这里的增广是不是要说明一下 @王老师',
      '同意，补一句',
      '好',
    ]);
  });

  it('访客只能看：评论、解决、删除都 403；非成员 404', async () => {
    expect((await post('usr_gst', { body: '我也说一句' })).statusCode).toBe(403);
    const patch = await t.app.inject({
      method: 'PATCH',
      url: url(`/${root.id}`),
      headers: t.as('usr_gst'),
      payload: { resolved: true },
    });
    expect(patch.statusCode).toBe(403);
    const out = await t.app.inject({ method: 'GET', url: url(), headers: t.as('usr_out') });
    expect(out.statusCode).toBe(404);
  });

  it('解决 / 重新打开：只对首条；解决后相关提醒标记完成；新回复自动重新打开', async () => {
    events.length = 0;
    const resolved = await t.app.inject({
      method: 'PATCH',
      url: url(`/${root.id}`),
      headers: t.as('usr_adv'),
      payload: { resolved: true },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      resolved: true,
      resolvedBy: { id: 'usr_adv' },
    });
    expect(events.map((e) => e.type)).toContain('document.comment_updated');
    const open = await t.db.db
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.sourceId, root.id), isNull(inboxItems.doneAt)));
    expect(open).toHaveLength(0);

    const list: DocComment[] = (
      await t.app.inject({ method: 'GET', url: url(), headers: t.as('usr_own') })
    ).json();
    const replyId = list.find((c) => c.parentId)!.id;
    const bad = await t.app.inject({
      method: 'PATCH',
      url: url(`/${replyId}`),
      headers: t.as('usr_own'),
      payload: { resolved: true },
    });
    expect(bad.statusCode).toBe(422);

    events.length = 0;
    await post('usr_own', { body: '还有一处', parentId: root.id });
    const reopened = events.find((e) => e.type === 'document.comment_updated');
    expect(reopened?.payload).toMatchObject({ id: root.id, resolved: false });

    const again = await t.app.inject({
      method: 'PATCH',
      url: url(`/${root.id}`),
      headers: t.as('usr_mem'),
      payload: { resolved: false },
    });
    expect(again.json().resolved).toBe(false);
  });

  it('只能改自己的正文；改正文时新 @ 的人收到提醒', async () => {
    const other = await t.app.inject({
      method: 'PATCH',
      url: url(`/${root.id}`),
      headers: t.as('usr_adv'),
      payload: { body: '改别人的' },
    });
    expect(other.statusCode).toBe(403);
    const mine = await t.app.inject({
      method: 'PATCH',
      url: url(`/${root.id}`),
      headers: t.as('usr_mem'),
      payload: { body: '请 @张三 也看看', mentions: ['usr_adv', 'usr_own'] },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().body).toBe('请 @张三 也看看');
    expect(await inboxOf('usr_own', root.id)).toHaveLength(1);
  });

  it('删除：作者或负责人 / 导师；删首条连同回复一起删，发 document.comment_deleted', async () => {
    const c: DocComment = (await post('usr_mem', { body: '临时评论', quote: 'x' })).json();
    const r: DocComment = (await post('usr_own', { body: '回复', parentId: c.id })).json();
    const denied = await t.app.inject({
      method: 'DELETE',
      url: url(`/${r.id}`),
      headers: t.as('usr_mem'),
    });
    expect(denied.statusCode).toBe(403);
    events.length = 0;
    const ok = await t.app.inject({
      method: 'DELETE',
      url: url(`/${c.id}`),
      headers: t.as('usr_adv'),
    });
    expect(ok.statusCode).toBe(204);
    expect(events.find((e) => e.type === 'document.comment_deleted')?.payload).toEqual({
      id: c.id,
      documentId: doc.id,
    });
    const list: DocComment[] = (
      await t.app.inject({ method: 'GET', url: url(), headers: t.as('usr_own') })
    ).json();
    expect(list.some((x) => x.id === c.id || x.id === r.id)).toBe(false);
  });

  it('非富文本文档不能评论；空正文 422；文档删除后评论一起删', async () => {
    const sheet: DocumentMeta = (
      await t.app.inject({
        method: 'POST',
        url: `${base}/docs`,
        headers: t.as('usr_own'),
        payload: { kind: 'sheet', title: '表' },
      })
    ).json();
    const res = await t.app.inject({
      method: 'POST',
      url: `${base}/docs/${sheet.id}/comments`,
      headers: t.as('usr_own'),
      payload: { body: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect((await post('usr_own', { body: '   ' })).statusCode).toBe(422);

    const tmp: DocumentMeta = (
      await t.app.inject({
        method: 'POST',
        url: `${base}/docs`,
        headers: t.as('usr_own'),
        payload: { title: '临时' },
      })
    ).json();
    await t.app.inject({
      method: 'POST',
      url: `${base}/docs/${tmp.id}/comments`,
      headers: t.as('usr_own'),
      payload: { body: '会被删' },
    });
    await t.app.inject({
      method: 'DELETE',
      url: `${base}/docs/${tmp.id}`,
      headers: t.as('usr_own'),
    });
    const gone = await t.app.inject({
      method: 'GET',
      url: `${base}/docs/${tmp.id}/comments`,
      headers: t.as('usr_own'),
    });
    expect(gone.statusCode).toBe(404);
  });
});

describe('正文 @提及', () => {
  it('前端插入提及：成员收到提醒（去重、不提醒自己和非成员）；访客 403', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: `${base}/docs/${doc.id}/mentions`,
      headers: t.as('usr_own'),
      payload: { userIds: ['usr_mem', 'usr_mem', 'usr_own', 'usr_out'], context: '请补实验' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ notified: ['usr_mem'] });
    const [item] = await inboxOf('usr_mem', `${doc.id}:mention`);
    expect(item).toMatchObject({ kind: 'mention', href: `/p/${PID}/docs/${doc.id}` });
    expect(item!.title).toContain('请补实验');
    const guest = await t.app.inject({
      method: 'POST',
      url: `${base}/docs/${doc.id}/mentions`,
      headers: t.as('usr_gst'),
      payload: { userIds: ['usr_mem'] },
    });
    expect(guest.statusCode).toBe(403);
  });

  it('结构化编辑写进 [@名字](mention:id)：生成提及节点，新提到的成员收到提醒', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: `${base}/docs/${doc.id}/edit`,
      headers: t.as('usr_own'),
      payload: { op: 'append', markdown: '请 [@王老师](mention:usr_adv) 过目。' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().markdown).toContain('[@王老师](mention:usr_adv)');
    const [item] = await inboxOf('usr_adv', `${doc.id}:mention`);
    expect(item?.kind).toBe('mention');
  });
});
