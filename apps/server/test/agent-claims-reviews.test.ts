import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import type { AnyProjectEvent, Project } from '@srh/shared';
import { agentSessions, events, projects, threads, workClaims } from '../src/db/schema';
import { createClaim, releaseClaim } from '../src/modules/claims/service';
import { createProjectThread } from '../src/modules/threads/service';
import { createMessage } from '../src/modules/timeline/service';
import { createRouter } from '../src/agents/runtime/router';
import { pendingWakeups, renderWake } from '../src/agents/runtime/wake';
import { registerCollabPort, resetCollabPort } from '../src/agents/tools/collab-port';
import { collabTools } from '../src/agents/tools/collab';
import type { ToolContext } from '../src/agents/tools/types';
import { makeApp, setupProject, type Session, type TestApp } from './helpers';

/**
 * 验收报告：
 * - 附录 C「认领释放后草稿没人并入」：认领放开 → 唤醒之前撞上它的 agent（claim-released）。
 * - 附录 A/D「旧审阅不关闭」：同一对象重新送审 → 关闭本 agent 之前发起的旧审阅；已关闭审阅的动作不再唤醒 agent。
 */
let t: TestApp;
let project: Project;
let owner: Session;
let advisor: Session;
let a: { sessionId: string; threadId: string };
let b: { sessionId: string; threadId: string };

async function newThread(title: string) {
  const ctx = t.app.ctx;
  const ref = { kind: 'user' as const, id: owner.user.id, name: owner.user.name };
  const root = await createMessage(ctx, {
    projectId: project.id,
    threadId: null,
    author: ref,
    body: title,
  });
  const { thread, sessionId } = await createProjectThread(ctx, {
    projectId: project.id,
    rootMessageId: root.id,
    title,
    workingForUserId: owner.user.id,
    actor: ref,
  });
  return { sessionId, threadId: thread.id };
}

const agent = (id: string) => ({ kind: 'agent' as const, id, name: '研协' });

async function lastEvent(type: string): Promise<AnyProjectEvent> {
  const [row] = await t.db.db
    .select()
    .from(events)
    .where(and(eq(events.projectId, project.id), eq(events.type, type as never)))
    .orderBy(desc(events.seq))
    .limit(1);
  return {
    ...row!,
    payload: row!.payload,
    createdAt: row!.createdAt.toISOString(),
  } as unknown as AnyProjectEvent;
}

beforeAll(async () => {
  t = await makeApp();
  const s = await setupProject(t.app, ['advisor']);
  project = s.project;
  owner = s.owner;
  advisor = s.others[0]!;
  a = await newThread('写实验一节');
  b = await newThread('补实验一节的草稿');
}, 60_000);

afterAll(async () => {
  resetCollabPort();
  await t.close();
});

describe('认领放开 → 唤醒等待者', () => {
  it('B 撞上 A 的认领；A 放开后 B 收到 claim-released，A 自己不会被唤醒', async () => {
    const ctx = t.app.ctx;
    const router = createRouter(ctx);
    const held = await createClaim(ctx, agent(a.sessionId), project.id, {
      resourceKind: 'doc_section',
      resourceRef: 'doc_x#3 实验',
      mode: 'exclusive',
      intent: '写实验一节',
      ttlSec: 1800,
      threadId: a.threadId,
    });
    await expect(
      createClaim(ctx, agent(b.sessionId), project.id, {
        resourceKind: 'doc_section',
        resourceRef: 'doc_x#3 实验',
        mode: 'exclusive',
        intent: '把草稿并入实验一节',
        ttlSec: 1800,
        threadId: b.threadId,
      }),
    ).rejects.toMatchObject({ code: 'claim_conflict' });

    await releaseClaim(ctx, agent(a.sessionId), project.id, held.id);
    await router.route(await lastEvent('claim.updated'));

    const wb = await pendingWakeups(ctx, b.sessionId);
    const released = wb.filter((w) => w.reason === 'claim-released');
    expect(released).toHaveLength(1);
    const [session] = await t.db.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, b.sessionId));
    const { text } = await renderWake(ctx, session!, released);
    expect(text).toContain('<claim-released');
    expect(text).toContain('把草稿并入实验一节');
    expect(
      (await pendingWakeups(ctx, a.sessionId)).some((w) => w.reason === 'claim-released'),
    ).toBe(false);
  });
});

describe('重新送审关闭旧审阅', () => {
  it('同一对象第二次 request_review 关掉第一条；关闭事件不唤醒线程 agent', async () => {
    const ctx = t.app.ctx;
    const created: string[] = [];
    const closed: string[] = [];
    // 用最小的审阅端口：真实写 reviews 表由协作模块负责，这里只验证工具的取代逻辑
    const { reviews } = await import('../src/db/schema');
    registerCollabPort({
      reviews: {
        async create(_ctx, actor, projectId, input) {
          const id = `rev_${created.length + 1}`;
          created.push(id);
          const now = new Date();
          await t.db.db.insert(reviews).values({
            id,
            projectId,
            targetKind: input.targetKind,
            targetId: input.targetId,
            title: input.title,
            summary: input.summary ?? '',
            requestedBy: actor,
            threadId: input.threadId ?? null,
            status: 'open',
            snapshot: {},
            createdAt: now,
            updatedAt: now,
          } as never);
          return { id, title: input.title, status: 'open' } as never;
        },
        async close(_ctx, _actor, _projectId, reviewId) {
          closed.push(reviewId);
          await t.db.db.update(reviews).set({ status: 'closed' }).where(eq(reviews.id, reviewId));
          return { id: reviewId } as never;
        },
      },
    });
    const [session] = await t.db.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, a.sessionId));
    const [projectRow] = await t.db.db.select().from(projects).where(eq(projects.id, project.id));
    const [threadRow] = await t.db.db.select().from(threads).where(eq(threads.id, a.threadId));
    const tc: ToolContext = {
      ctx,
      session: session!,
      project: projectRow!,
      thread: threadRow!,
      turnId: 'turn_test',
      actor: agent(a.sessionId),
      requesterUserId: owner.user.id,
      visible: new Set(),
      setActivity: async () => {},
    };
    const def = collabTools.find((d) => d.name === 'request_review')!;
    const args = {
      target_kind: 'plan',
      target_id: 'doc_plan',
      title: '实验计划',
      reviewer_ids: [advisor.user.id],
    };
    await def.run(tc, def.schema.parse(args));
    const second = (await def.run(
      tc,
      def.schema.parse({ ...args, title: '实验计划（修订）' }),
    )) as {
      superseded_reviews?: string[];
    };
    expect(closed).toEqual(['rev_1']);
    expect(second.superseded_reviews).toEqual(['rev_1']);

    // 已关闭审阅上的 review.updated 不唤醒 agent
    const router = createRouter(ctx);
    const before = (await pendingWakeups(ctx, a.sessionId)).length;
    await router.route({
      projectId: project.id,
      threadId: a.threadId,
      type: 'review.updated',
      payload: { id: 'rev_1', threadId: a.threadId, status: 'closed', title: '实验计划' },
      actor: { kind: 'user', id: advisor.user.id, name: advisor.user.name },
    } as unknown as AnyProjectEvent);
    expect((await pendingWakeups(ctx, a.sessionId)).length).toBe(before);
  });
});

describe('一轮结束放开本线程认领', () => {
  it('release 后认领表里本线程没有 active 认领', async () => {
    // turn.ts finish() 调的是 releaseThreadClaims；这里验证它会触发 claim.updated（router 依赖它唤醒等待者）
    const ctx = t.app.ctx;
    await createClaim(ctx, agent(b.sessionId), project.id, {
      resourceKind: 'topic',
      resourceRef: '实验一节草稿',
      mode: 'exclusive',
      intent: '写草稿',
      ttlSec: 1800,
      threadId: b.threadId,
    });
    const { releaseThreadClaims } = await import('../src/modules/claims/service');
    expect(await releaseThreadClaims(ctx, project.id, b.threadId, agent(b.sessionId))).toBe(1);
    const active = await t.db.db
      .select()
      .from(workClaims)
      .where(and(eq(workClaims.threadId, b.threadId), eq(workClaims.status, 'active')));
    expect(active).toHaveLength(0);
  });
});
