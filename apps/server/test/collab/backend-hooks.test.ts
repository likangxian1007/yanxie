import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActorRef, Review } from '@srh/shared';
import { collab } from '../../src/agents/tools/collab-port';
import { createReview } from '../../src/modules/reviews/service';
import { setupCollabApp, type CollabTestApp } from './helpers';

/** 与后端 PR #10 的接口对接：ReviewsPort.close 与协作接口的 CSRF 来源校验 */
const P = 'prj_hooks';
let t: CollabTestApp;

beforeAll(async () => {
  t = await setupCollabApp();
  await t.seedUser('usr_owner', '王老师');
  await t.seedProject(P, 'usr_owner');
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('后端接口对接', () => {
  it('ReviewsPort.close 已注册，agent 能关闭自己发起的审阅', async () => {
    const doc = await t.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${P}/docs`,
      headers: t.as('usr_owner'),
      payload: { title: '实验计划', kind: 'doc' },
    });
    expect(doc.statusCode).toBe(201);
    const docId = doc.json<{ id: string }>().id;
    const agent: ActorRef = { kind: 'agent', id: 'ses_agent1', name: '线程 agent' };
    const review: Review = await createReview(t.app.ctx, agent, P, {
      targetKind: 'plan',
      targetId: docId,
      title: '实验计划',
      reviewerIds: ['usr_owner'],
    });
    const close = collab('reviews')?.close;
    expect(typeof close).toBe('function');
    const closed = await close!(t.app.ctx, agent, P, review.id);
    expect(closed.status).toBe('closed');
  });

  it('协作写接口拒绝跨站来源，同源放行', async () => {
    const url = `/api/v1/projects/${P}/todos`;
    const bad = await t.app.inject({
      method: 'POST',
      url,
      headers: { ...t.as('usr_owner'), origin: 'https://evil.example' },
      payload: { title: '跨站' },
    });
    expect(bad.statusCode).toBe(403);
    const crossSite = await t.app.inject({
      method: 'POST',
      url,
      headers: { ...t.as('usr_owner'), 'sec-fetch-site': 'cross-site' },
      payload: { title: '跨站 2' },
    });
    expect(crossSite.statusCode).toBe(403);
    const ok = await t.app.inject({
      method: 'POST',
      url,
      headers: t.as('usr_owner'),
      payload: { title: '正常' },
    });
    expect(ok.statusCode).toBe(201);
  });
});
