import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActorRef, Message, Project, ThreadSummary } from '@srh/shared';
import { createInboxItem } from '../src/modules/inbox/service';
import { createDecision, createProjectThread } from '../src/modules/threads/service';
import { threadIdFromHref } from '../src/modules/threads/summary';
import { makeApp, setupProject, type Session, type TestApp } from './helpers';

/** GET P/thread-summaries：协作台线程面板的每线程汇总（产出数、未答决策、在等谁）。 */
let t: TestApp;
let project: Project;
let owner: Session;
let member: Session;
let guest: Session;

const agent: ActorRef = { kind: 'agent', id: 'agt_test', name: '研协' };

beforeAll(async () => {
  t = await makeApp();
  const s = await setupProject(t.app, ['member', 'guest']);
  project = s.project;
  owner = s.owner;
  [member, guest] = s.others as [Session, Session];
}, 60_000);

afterAll(async () => {
  await t?.close();
});

const P = () => `/projects/${project.id}`;

async function startThread(by: Session, title: string) {
  const root = (await by.req('POST', `${P()}/timeline`, { body: title })).json<Message>();
  const r = await createProjectThread(t.app.ctx, {
    projectId: project.id,
    rootMessageId: root.id,
    title,
    workingForUserId: by.user.id,
    actor: agent,
  });
  return r.thread;
}

describe('thread-summaries', () => {
  it('从收件箱 href 取线程 id', () => {
    expect(threadIdFromHref('/p/prj_1/threads/thr_ABC?decision=dec_1')).toBe('thr_ABC');
    expect(threadIdFromHref('/p/prj_1/reviews/rev_1')).toBeNull();
  });

  it('汇总未答决策与在等的成员；个人会话不出现；访客可读', async () => {
    const a = await startThread(member, '数据集选择');
    const b = await startThread(owner, '相关工作');
    // 个人会话：不该出现在汇总里
    const personal = await member.req('POST', `${P()}/threads`, { body: '我自己的草稿' });
    expect(personal.statusCode).toBe(201);

    await createDecision(t.app.ctx, {
      projectId: project.id,
      threadId: a.id,
      actor: agent,
      question: '主实验用哪个数据集？',
      options: [
        { label: 'ZINC', consequence: '规模大' },
        { label: 'QM9', consequence: '规模小' },
      ],
      recommended: 1,
      notifyUserId: member.user.id,
    });
    // 同一线程再 @ 一次 owner；finished 类不算“在等”
    await createInboxItem(t.app.ctx, {
      projectId: project.id,
      userId: owner.user.id,
      kind: 'mention',
      title: '@张三 看一下',
      href: `/p/${project.id}/threads/${a.id}`,
      sourceId: 'msg_x',
    });
    await createInboxItem(t.app.ctx, {
      projectId: project.id,
      userId: owner.user.id,
      kind: 'finished',
      title: '「相关工作」已完成',
      href: `/p/${project.id}/threads/${b.id}`,
      sourceId: b.id,
    });

    const res = await guest.req('GET', `${P()}/thread-summaries`);
    expect(res.statusCode).toBe(200);
    const list = res.json<ThreadSummary[]>();
    expect(list.map((s) => s.threadId).sort()).toEqual([a.id, b.id].sort());

    const sa = list.find((s) => s.threadId === a.id)!;
    expect(sa.openDecisions).toBe(1);
    expect(sa.outputs).toBe(0);
    expect(sa.waitingOn.map((w) => [w.userId, w.kind])).toEqual([
      [member.user.id, 'decision'],
      [owner.user.id, 'mention'],
    ]);
    const sb = list.find((s) => s.threadId === b.id)!;
    expect(sb).toMatchObject({ openDecisions: 0, waitingOn: [] });
  });

  it('未登录 401', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/v1${P()}/thread-summaries` });
    expect(res.statusCode).toBe(401);
  });
});
