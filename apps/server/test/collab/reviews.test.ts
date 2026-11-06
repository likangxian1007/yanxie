import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnyProjectEvent, Review, ReviewComment } from '@srh/shared';
import { collab } from '../../src/agents/tools/collab-port';
import { documents, inboxItems, messages, outputs, reports, threads } from '../../src/db/schema';
import { setupCollabApp, type CollabTestApp } from './helpers';

const PID = 'prj_rev';
const base = `/api/v1/projects/${PID}/reviews`;

let t: CollabTestApp;
let events: AnyProjectEvent[] = [];

type Detail = Review & { comments: ReviewComment[] };
type ErrorBody = { error: { code: string; message: string } };

async function api(method: string, url: string, user: string, payload?: unknown) {
  return t.app.inject({
    method: method as 'GET',
    url,
    headers: t.as(user),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function createReview(body: Record<string, unknown>, user = 'usr_o'): Promise<Review> {
  const res = await api('POST', base, user, {
    targetKind: 'document',
    targetId: 'doc_r',
    title: '方法章节',
    reviewerIds: ['usr_a', 'usr_b'],
    threadId: 'thr_r',
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Review>();
}

async function verdict(id: string, user: string, body: Record<string, unknown>) {
  return api('POST', `${base}/${id}/verdict`, user, body);
}

async function inboxOf(userId: string, sourceId: string) {
  return t.db.db
    .select()
    .from(inboxItems)
    .where(and(eq(inboxItems.userId, userId), eq(inboxItems.sourceId, sourceId)));
}

beforeAll(async () => {
  t = await setupCollabApp();
  await t.seedUser('usr_o', '王老师');
  await t.seedUser('usr_a', '张三');
  await t.seedUser('usr_b', '李四');
  await t.seedUser('usr_c', '赵六');
  await t.seedUser('usr_g', '访客');
  await t.seedUser('usr_x', '路人');
  await t.seedProject(PID, 'usr_o');
  await t.addMember(PID, 'usr_a', 'member');
  await t.addMember(PID, 'usr_b', 'member');
  await t.addMember(PID, 'usr_c', 'member');
  await t.addMember(PID, 'usr_g', 'guest');

  const actor = { kind: 'user' as const, id: 'usr_a', name: '张三' };
  await t.db.db.insert(messages).values([
    {
      id: 'msg_root',
      projectId: PID,
      threadId: 'thr_r',
      authorKind: 'user',
      authorId: 'usr_a',
      authorName: '张三',
      body: '帮我写方法章节',
    },
    {
      id: 'msg_plan',
      projectId: PID,
      threadId: 'thr_r',
      authorKind: 'agent',
      authorId: 'agt_1',
      authorName: '线程 agent',
      body: '计划：1. 读论文 2. 写初稿',
    },
    {
      id: 'msg_side',
      projectId: PID,
      threadId: 'thr_r',
      authorKind: 'user',
      authorId: 'usr_b',
      authorName: '李四',
      body: '旁聊：别让 agent 看到',
      agentVisible: false,
    },
  ]);
  await t.db.db.insert(threads).values({
    id: 'thr_r',
    projectId: PID,
    rootMessageId: 'msg_root',
    title: '方法章节初稿',
    statusText: '写作中\n✓ 读论文\n✱ 写初稿',
  });
  await t.db.db.insert(documents).values({
    id: 'doc_r',
    projectId: PID,
    title: '方法',
    contentText: '## 方法\n我们提出……',
    createdBy: actor,
  });
  await t.db.db.insert(reports).values({
    id: 'rpt_r',
    projectId: PID,
    title: '第 1 周组会',
    periodStart: new Date('2026-10-19T00:00:00Z'),
    periodEnd: new Date('2026-10-26T00:00:00Z'),
    content: '# 本周进展\n- 完成基线',
    createdBy: actor,
  });
  await t.db.db.insert(outputs).values({
    id: 'out_r',
    projectId: PID,
    threadId: 'thr_r',
    kind: 'link',
    ref: 'https://example.com/fig1.png',
    title: '图 1',
  });
  t.app.ctx.bus.onEvent((ev) => events.push(ev));
}, 60_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  events = [];
});

describe('create review', () => {
  it('snapshots the target, writes participants, inbox items and review.created', async () => {
    const review = await createReview({ summary: '请重点看公式' });
    expect(review).toMatchObject({
      projectId: PID,
      targetKind: 'document',
      targetId: 'doc_r',
      title: '方法章节',
      summary: '请重点看公式',
      requestedBy: { kind: 'user', id: 'usr_o', name: '王老师' },
      threadId: 'thr_r',
      status: 'open',
      snapshot: '## 方法\n我们提出……',
      commentCount: 0,
      closedAt: null,
    });
    expect(review.reviewers.map((r) => [r.userId, r.verdict])).toEqual([
      ['usr_a', 'pending'],
      ['usr_b', 'pending'],
    ]);
    const ev = events.find((e) => e.type === 'review.created');
    expect(ev?.threadId).toBe('thr_r');
    expect(ev?.payload).toEqual(review);

    for (const uid of ['usr_a', 'usr_b']) {
      const items = await inboxOf(uid, review.id);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: 'review',
        title: '「方法章节」请你审阅',
        href: `/p/${PID}/reviews/${review.id}`,
        doneAt: null,
      });
    }
    expect(events.filter((e) => e.type === 'inbox.created')).toHaveLength(2);
  });

  it('does not notify the requester when they review their own request', async () => {
    const review = await createReview({ reviewerIds: ['usr_o', 'usr_a'] });
    expect(await inboxOf('usr_o', review.id)).toHaveLength(0);
    expect(await inboxOf('usr_a', review.id)).toHaveLength(1);
  });

  it('rejects non-member or guest reviewers with 422', async () => {
    for (const reviewerIds of [['usr_a', 'usr_x'], ['usr_g'], ['usr_nobody']]) {
      const res = await api('POST', base, 'usr_o', {
        targetKind: 'document',
        targetId: 'doc_r',
        title: '坏审阅人',
        reviewerIds,
      });
      expect(res.statusCode, JSON.stringify(reviewerIds)).toBe(422);
      expect(res.json<ErrorBody>().error.code).toBe('validation_failed');
    }
  });

  it('returns 404 for a missing target, 404 for non-members, 403 for guests', async () => {
    const missing = await api('POST', base, 'usr_o', {
      targetKind: 'document',
      targetId: 'doc_missing',
      title: 'x',
      reviewerIds: ['usr_a'],
    });
    expect(missing.statusCode).toBe(404);
    const badPrefix = await api('POST', base, 'usr_o', {
      targetKind: 'plan',
      targetId: 'thr_r',
      title: 'x',
      reviewerIds: ['usr_a'],
    });
    expect(badPrefix.statusCode).toBe(404);
    const body = { targetKind: 'document', targetId: 'doc_r', title: 'x', reviewerIds: ['usr_a'] };
    expect((await api('POST', base, 'usr_x', body)).statusCode).toBe(404);
    expect((await api('GET', base, 'usr_x')).statusCode).toBe(404);
    expect((await api('POST', base, 'usr_g', body)).statusCode).toBe(403);
    expect((await api('GET', base, 'usr_g')).statusCode).toBe(200);
  });

  it('builds snapshots for experiment, report, message, plan, thread and output targets', async () => {
    const snap = async (targetKind: string, targetId: string) =>
      (
        await createReview({
          targetKind,
          targetId,
          title: `${targetKind} 审阅`,
          reviewerIds: ['usr_a'],
        })
      ).snapshot ?? '';

    expect(
      (
        await api('POST', base, 'usr_a', {
          targetKind: 'experiment',
          targetId: 'exp_old',
          title: '旧实验',
          reviewerIds: ['usr_b'],
        })
      ).statusCode,
    ).toBe(404);
    expect(await snap('report', 'rpt_r')).toBe('# 本周进展\n- 完成基线');
    expect(await snap('message', 'msg_plan')).toBe('计划：1. 读论文 2. 写初稿');
    expect(await snap('plan', 'msg_plan')).toBe('计划：1. 读论文 2. 写初稿');
    expect(await snap('plan', 'doc_r')).toBe('## 方法\n我们提出……');
    const threadSnap = await snap('thread', 'thr_r');
    expect(threadSnap).toContain('# 线程：方法章节初稿');
    expect(threadSnap).toContain('✱ 写初稿');
    expect(threadSnap).toContain('**张三**：帮我写方法章节');
    expect(threadSnap).not.toContain('旁聊');
    const outSnap = await snap('output', 'out_r');
    expect(outSnap).toContain('# 图 1');
    expect(outSnap).toContain('https://example.com/fig1.png');
  });
});

describe('verdicts', () => {
  it('only invited reviewers can give a verdict', async () => {
    const review = await createReview({});
    const res = await verdict(review.id, 'usr_o', { verdict: 'lgtm' });
    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorBody>().error.message).toBe('只有被邀请的审阅人可以给出结论');
    expect((await verdict(review.id, 'usr_c', { verdict: 'lgtm' })).statusCode).toBe(403);
    expect((await verdict(review.id, 'usr_x', { verdict: 'lgtm' })).statusCode).toBe(404);
    expect((await verdict(review.id, 'usr_a', { verdict: 'pending' })).statusCode).toBe(422);
  });

  it('recomputes status: one LGTM + one pending → open, all LGTM → approved', async () => {
    const review = await createReview({});
    events = [];
    const first = await verdict(review.id, 'usr_a', { verdict: 'lgtm' });
    expect(first.statusCode, first.body).toBe(200);
    const afterA = first.json<Review>();
    expect(afterA.status).toBe('open');
    expect(afterA.commentCount).toBe(1);
    expect(afterA.reviewers.find((r) => r.userId === 'usr_a')?.verdict).toBe('lgtm');

    const created = events.find((e) => e.type === 'review.comment_created');
    expect(created?.payload).toMatchObject({ body: 'LGTM', verdict: 'lgtm' });
    expect(created?.threadId).toBe('thr_r');
    const updated = events.find((e) => e.type === 'review.updated');
    expect(updated?.threadId).toBe('thr_r');
    expect(updated?.payload).toEqual(afterA);

    // a 处理完了，b 的还挂着
    expect((await inboxOf('usr_a', review.id))[0]?.doneAt).not.toBeNull();
    expect((await inboxOf('usr_b', review.id))[0]?.doneAt).toBeNull();

    const second = await verdict(review.id, 'usr_b', { verdict: 'lgtm', comment: '写得很清楚' });
    const approved = second.json<Review>();
    expect(approved.status).toBe('approved');
    expect((await inboxOf('usr_b', review.id))[0]?.doneAt).not.toBeNull();

    const detail = (await api('GET', `${base}/${review.id}`, 'usr_g')).json<Detail>();
    expect(detail.comments.map((c) => [c.body, c.verdict])).toEqual([
      ['LGTM', 'lgtm'],
      ['写得很清楚', 'lgtm'],
    ]);
  });

  it('any changes_requested wins; commented without text writes no comment', async () => {
    const review = await createReview({});
    const a = (await verdict(review.id, 'usr_a', { verdict: 'lgtm' })).json<Review>();
    expect(a.status).toBe('open');
    const b = (await verdict(review.id, 'usr_b', { verdict: 'changes_requested' })).json<Review>();
    expect(b.status).toBe('changes_requested');
    const detail = (await api('GET', `${base}/${review.id}`, 'usr_a')).json<Detail>();
    expect(detail.comments.at(-1)).toMatchObject({
      body: '需要修改',
      verdict: 'changes_requested',
    });

    // b 只评论（不带文字）：不写评论，也不撤销自己之前的“要求修改”（与 GitHub 一致）
    events = [];
    const c = (await verdict(review.id, 'usr_b', { verdict: 'commented' })).json<Review>();
    expect(c.status).toBe('changes_requested');
    expect(c.commentCount).toBe(2);
    expect(events.some((e) => e.type === 'review.comment_created')).toBe(false);

    const d = (
      await verdict(review.id, 'usr_b', { verdict: 'commented', comment: '再想想' })
    ).json<Review>();
    expect(d.commentCount).toBe(3);
  });
});

describe('comments', () => {
  it('adds anchored comments, bumps commentCount and resolves them', async () => {
    const review = await createReview({});
    events = [];
    const res = await api('POST', `${base}/${review.id}/comments`, 'usr_c', {
      body: '这句话需要引用',
      anchor: { quote: '我们提出' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const comment = res.json<ReviewComment>();
    expect(comment).toMatchObject({
      reviewId: review.id,
      author: { kind: 'user', id: 'usr_c' },
      body: '这句话需要引用',
      verdict: null,
      anchor: { quote: '我们提出' },
      resolved: false,
    });
    expect(events.map((e) => e.type)).toEqual(['review.comment_created', 'review.updated']);
    expect((events[1]?.payload as Review).commentCount).toBe(1);
    expect(events.every((e) => e.threadId === 'thr_r')).toBe(true);

    const second = await api('POST', `${base}/${review.id}/comments`, 'usr_a', { body: '同意' });
    expect(second.statusCode).toBe(201);
    expect(
      (await api('POST', `${base}/${review.id}/comments`, 'usr_g', { body: 'x' })).statusCode,
    ).toBe(403);
    expect(
      (await api('POST', `${base}/${review.id}/comments`, 'usr_a', { body: '  ' })).statusCode,
    ).toBe(422);

    const detail = (await api('GET', `${base}/${review.id}`, 'usr_a')).json<Detail>();
    expect(detail.commentCount).toBe(2);
    expect(detail.comments.map((c) => c.body)).toEqual(['这句话需要引用', '同意']);

    events = [];
    const patch = await api('PATCH', `${base}/${review.id}/comments/${comment.id}`, 'usr_o', {
      resolved: true,
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json<ReviewComment>().resolved).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['review.comment_updated']);
    expect(events[0]?.threadId).toBe('thr_r');
    const missing = await api('PATCH', `${base}/${review.id}/comments/rvc_missing`, 'usr_o', {
      resolved: true,
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('close & list', () => {
  it('lets the requester or a manager close; closes inbox items; blocks later verdicts', async () => {
    const review = await createReview({}, 'usr_c');
    const denied = await api('POST', `${base}/${review.id}/close`, 'usr_a');
    expect(denied.statusCode).toBe(403);

    events = [];
    const res = await api('POST', `${base}/${review.id}/close`, 'usr_c');
    expect(res.statusCode).toBe(200);
    const closed = res.json<Review>();
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();
    expect(events.find((e) => e.type === 'review.updated')?.threadId).toBe('thr_r');
    for (const uid of ['usr_a', 'usr_b']) {
      expect((await inboxOf(uid, review.id))[0]?.doneAt).not.toBeNull();
    }

    const late = await verdict(review.id, 'usr_a', { verdict: 'lgtm' });
    expect(late.statusCode).toBe(409);
    expect((await api('POST', `${base}/${review.id}/close`, 'usr_c')).statusCode).toBe(409);

    // 负责人也能关别人发起的审阅
    const other = await createReview({}, 'usr_c');
    const byOwner = await api('POST', `${base}/${other.id}/close`, 'usr_o');
    expect(byOwner.statusCode).toBe(200);
  });

  it('filters by status, mine and target, newest updated first', async () => {
    const mineAsReviewer = await createReview({ title: '给 C 的', reviewerIds: ['usr_c'] });
    const mineAsRequester = await createReview(
      { title: 'C 发起的', reviewerIds: ['usr_a'] },
      'usr_c',
    );
    // 换个目标：同一发起人对同一目标再发起会取代上一轮（见下面的 supersede 用例）
    await createReview({
      title: '与 C 无关',
      reviewerIds: ['usr_a'],
      targetKind: 'report',
      targetId: 'rpt_r',
    });

    const mine = (await api('GET', `${base}?mine=1`, 'usr_c')).json<Review[]>();
    const ids = mine.map((r) => r.id);
    expect(ids).toContain(mineAsReviewer.id);
    expect(ids).toContain(mineAsRequester.id);
    expect(
      mine.every(
        (r) => r.requestedBy.id === 'usr_c' || r.reviewers.some((p) => p.userId === 'usr_c'),
      ),
    ).toBe(true);
    expect(mine.some((r) => r.title === '与 C 无关')).toBe(false);

    // 有新动作的审阅排到最前
    await verdict(mineAsReviewer.id, 'usr_c', { verdict: 'changes_requested' });
    const all = (await api('GET', base, 'usr_a')).json<Review[]>();
    expect(all[0]?.id).toBe(mineAsReviewer.id);
    expect(all[0]?.commentCount).toBe(1);

    const changes = (await api('GET', `${base}?status=changes_requested`, 'usr_a')).json<
      Review[]
    >();
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((r) => r.status === 'changes_requested')).toBe(true);

    const byTarget = (await api('GET', `${base}?targetKind=report&targetId=rpt_r`, 'usr_a')).json<
      Review[]
    >();
    expect(byTarget.length).toBeGreaterThan(0);
    expect(byTarget.every((r) => r.targetKind === 'report' && r.targetId === 'rpt_r')).toBe(true);

    expect((await api('GET', `${base}?status=nope`, 'usr_a')).statusCode).toBe(422);
    expect((await api('GET', `${base}/rev_missing`, 'usr_a')).statusCode).toBe(404);
  });
});

describe('supersede', () => {
  it('同一发起方对同一目标发起新一轮：旧审阅关闭并指向新审阅，旧的待审阅消息完成，不能再给结论', async () => {
    const round1 = await createReview({ title: '第一轮', reviewerIds: ['usr_a'] });
    expect(round1.supersededById).toBeNull();
    const v = await verdict(round1.id, 'usr_a', {
      verdict: 'changes_requested',
      comment: '改公式',
    });
    expect(v.statusCode).toBe(200);

    events = [];
    const round2 = await createReview({ title: '第二轮', reviewerIds: ['usr_a'] });
    const old = (await api('GET', `${base}/${round1.id}`, 'usr_a')).json<Detail>();
    expect(old).toMatchObject({ status: 'closed', supersededById: round2.id });
    expect(old.closedAt).not.toBeNull();
    // 旧审阅的 review.updated 先于新审阅的 review.created 推送，载荷是完整对象
    const updated = events.find((e) => e.type === 'review.updated');
    expect(updated?.payload).toMatchObject({ id: round1.id, supersededById: round2.id });
    expect((await inboxOf('usr_a', round1.id))[0]?.doneAt).not.toBeNull();
    expect((await inboxOf('usr_a', round2.id))[0]?.doneAt).toBeNull();
    expect((await verdict(round1.id, 'usr_a', { verdict: 'lgtm' })).statusCode).toBe(409);
    // 两轮都有快照，前端据此显示两轮之间的差异
    expect(old.snapshot).not.toBeNull();
    expect(round2.snapshot).not.toBeNull();
  });

  it('别人对同一目标发起的审阅不受影响', async () => {
    const mine = await createReview({
      title: '王老师发起',
      threadId: null,
      reviewerIds: ['usr_a'],
    });
    const theirs = await createReview(
      { title: '赵六发起', threadId: null, reviewerIds: ['usr_a'] },
      'usr_c',
    );
    const still = (await api('GET', `${base}/${mine.id}`, 'usr_a')).json<Detail>();
    expect(still.status).not.toBe('closed');
    expect(still.supersededById).toBeNull();
    expect(theirs.status).toBe('open');
  });
});

describe('reviews agent port', () => {
  it('registers reviews.create and wakes the requesting thread via threadId', async () => {
    const port = collab('reviews');
    expect(port).toBeDefined();
    if (!port) return;
    const agent = { kind: 'agent' as const, id: 'agt_1', name: '线程 agent' };
    const review = await port.create(t.app.ctx, agent, PID, {
      targetKind: 'plan',
      targetId: 'msg_plan',
      title: '请审阅计划',
      reviewerIds: ['usr_o'],
      threadId: 'thr_r',
    });
    expect(review.requestedBy).toEqual(agent);
    expect(review.snapshot).toBe('计划：1. 读论文 2. 写初稿');
    expect(await inboxOf('usr_o', review.id)).toHaveLength(1);

    events = [];
    await verdict(review.id, 'usr_o', { verdict: 'lgtm' });
    const updated = events.find((e) => e.type === 'review.updated');
    expect(updated?.threadId).toBe('thr_r');
    expect((updated?.payload as Review).status).toBe('approved');
  });
});
