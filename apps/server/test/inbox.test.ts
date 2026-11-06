import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InboxItem, Project } from '@srh/shared';
import { makeApp, setupProject, signup, sleep, type Session, type TestApp } from './helpers';
import { createInboxItem, markInboxDoneBySource } from '../src/modules/inbox/service';

let t: TestApp;
let project: Project;
let owner: Session;
let member: Session;

beforeAll(async () => {
  t = await makeApp();
  const s = await setupProject(t.app, ['member']);
  project = s.project;
  owner = s.owner;
  member = s.others[0]!;
}, 60_000);

afterAll(async () => {
  await t?.close();
});

const item = (userId: string, kind: InboxItem['kind'], sourceId: string, title = sourceId) =>
  createInboxItem(t.app.ctx, {
    projectId: project.id,
    userId,
    kind,
    title,
    href: `/p/${project.id}`,
    sourceId,
  });

describe('inbox', () => {
  let review: InboxItem;

  it('creates with dedupe and inbox.created event', async () => {
    await item(member.user.id, 'finished', 'thr_1');
    await sleep(5);
    await item(member.user.id, 'mention', 'msg_1');
    await sleep(5);
    review = await item(member.user.id, 'review', 'rev_1');
    await sleep(5);
    await item(member.user.id, 'mention', 'msg_2');
    const dup = await item(member.user.id, 'review', 'rev_1', '另一个标题');
    expect(dup.id).toBe(review.id);
    expect(dup.title).toBe('rev_1');
    await item(owner.user.id, 'decision', 'dec_1');

    const evs = await t.app.ctx.bus.listSince(project.id, 0, 1000);
    expect(evs.filter((e) => e.type === 'inbox.created')).toHaveLength(5);
  });

  it('lists only own open items sorted by priority then time', async () => {
    const res = await member.req('GET', '/inbox');
    expect(res.statusCode).toBe(200);
    const items = res.json<InboxItem[]>();
    expect(items.map((i) => i.sourceId)).toEqual(['rev_1', 'msg_2', 'msg_1', 'thr_1']);
    expect(items.every((i) => i.userId === member.user.id)).toBe(true);
    const scoped = await member.req('GET', `/inbox?projectId=${project.id}&done=false`);
    expect(scoped.json<InboxItem[]>()).toHaveLength(4);
  });

  it('patch read/done; other user gets 404', async () => {
    expect((await owner.req('PATCH', `/inbox/${review.id}`, { read: true })).statusCode).toBe(404);
    const r = await member.req('PATCH', `/inbox/${review.id}`, { read: true });
    expect(r.statusCode).toBe(200);
    expect(r.json<InboxItem>().readAt).not.toBeNull();
    const unread = await member.req('PATCH', `/inbox/${review.id}`, { read: false });
    expect(unread.json<InboxItem>().readAt).toBeNull();
    const done = await member.req('PATCH', `/inbox/${review.id}`, { done: true });
    expect(done.json<InboxItem>().doneAt).not.toBeNull();
    const open = (await member.req('GET', '/inbox')).json<InboxItem[]>();
    expect(open.map((i) => i.id)).not.toContain(review.id);
    const closed = (await member.req('GET', '/inbox?done=true')).json<InboxItem[]>();
    expect(closed.map((i) => i.id)).toEqual([review.id]);
    const evs = await t.app.ctx.bus.listSince(project.id, 0, 1000);
    expect(
      evs.filter((e) => e.type === 'inbox.updated' && e.payload.id === review.id),
    ).toHaveLength(3);
    // 完成后同来源可以再次生成新条目
    const again = await item(member.user.id, 'review', 'rev_1');
    expect(again.id).not.toBe(review.id);
  });

  it('markInboxDoneBySource', async () => {
    await item(owner.user.id, 'mention', 'msg_2');
    await markInboxDoneBySource(t.app.ctx, 'msg_2', { userId: member.user.id });
    expect(
      (await member.req('GET', '/inbox')).json<InboxItem[]>().map((i) => i.sourceId),
    ).not.toContain('msg_2');
    expect((await owner.req('GET', '/inbox')).json<InboxItem[]>().map((i) => i.sourceId)).toContain(
      'msg_2',
    );
    await markInboxDoneBySource(t.app.ctx, 'msg_2');
    expect(
      (await owner.req('GET', '/inbox')).json<InboxItem[]>().map((i) => i.sourceId),
    ).not.toContain('msg_2');
  });

  it('auth and membership', async () => {
    const anon = await t.app.inject({ method: 'GET', url: '/api/v1/inbox' });
    expect(anon.statusCode).toBe(401);
    const stranger = await signup(t.app, '路人');
    expect((await stranger.req('GET', `/inbox?projectId=${project.id}`)).statusCode).toBe(404);
    expect((await stranger.req('GET', '/inbox')).json<InboxItem[]>()).toEqual([]);
    // 被移出项目后看不到该项目的条目
    expect(
      (await owner.req('DELETE', `/projects/${project.id}/members/${member.user.id}`)).statusCode,
    ).toBe(204);
    expect((await member.req('GET', '/inbox')).json<InboxItem[]>()).toEqual([]);
  });
});
