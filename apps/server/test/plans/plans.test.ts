import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type {
  BasisProposal,
  PersonalMemory,
  Plan,
  PlansOverview,
  PlanVersion,
  TeamBasis,
} from '@srh/shared';
import { inboxItems } from '../../src/db/schema';
import { setupCollabApp, type CollabTestApp } from '../collab/helpers';

/** 正式方案、探索副本、提案、个人记忆与团队依据（API.md §2.20） */
const OWNER = 'usr_owner';
const ADVISOR = 'usr_advisor';
const MEMBER = 'usr_member';
const MEMBER2 = 'usr_member2';
const GUEST = 'usr_guest';
const STRANGER = 'usr_stranger';

let t: CollabTestApp;

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
const call = (method: Method, url: string, user: string | null, payload?: unknown) =>
  t.app.inject({
    method,
    url: `/api/v1${url}`,
    ...(user ? { headers: t.as(user) } : {}),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

async function seedProject(projectId: string) {
  await t.seedProject(projectId, OWNER);
  await t.addMember(projectId, ADVISOR, 'advisor');
  await t.addMember(projectId, MEMBER, 'member');
  await t.addMember(projectId, MEMBER2, 'member');
  await t.addMember(projectId, GUEST, 'guest');
}

async function inbox(projectId: string, sourceId: string) {
  return t.db.db
    .select()
    .from(inboxItems)
    .where(and(eq(inboxItems.projectId, projectId), eq(inboxItems.sourceId, sourceId)));
}

async function eventTypes(projectId: string) {
  return (await t.app.ctx.bus.listSince(projectId, 0, 5000)).map((e) => e.type);
}

beforeAll(async () => {
  t = await setupCollabApp();
  await t.seedUser(OWNER, '负责人', 0);
  await t.seedUser(ADVISOR, '导师', 1);
  await t.seedUser(MEMBER, '张三', 2);
  await t.seedUser(MEMBER2, '李四', 3);
  await t.seedUser(GUEST, '访客', 4);
  await t.seedUser(STRANGER, '路人', 5);
}, 60_000);

afterAll(() => t?.close());

// ---------------------------------------------------------------- 方案与探索副本

describe('正式方案与探索副本', () => {
  const P = 'prj_plan';
  const B = `/projects/${P}/plans`;
  let official: Plan;
  let exploration: Plan;

  beforeAll(() => seedProject(P));

  it('鉴权：未登录 401，非成员 404', async () => {
    expect((await call('GET', B, null)).statusCode).toBe(401);
    expect((await call('GET', B, STRANGER)).statusCode).toBe(404);
  });

  it('总览：还没有正式方案', async () => {
    const res = await call('GET', B, MEMBER);
    expect(res.statusCode).toBe(200);
    const body = res.json<PlansOverview>();
    expect(body.official).toBeNull();
    expect(body.canManage).toBe(false);
    expect((await call('GET', B, ADVISOR)).json<PlansOverview>().canManage).toBe(true);
  });

  it('建立正式方案：只有负责人；校验 422；重复 409', async () => {
    expect((await call('POST', `${B}/official`, MEMBER, { content: 'x' })).statusCode).toBe(403);
    expect(
      (await call('POST', `${B}/official`, OWNER, { title: '', content: 'x' })).statusCode,
    ).toBe(422);
    const res = await call('POST', `${B}/official`, OWNER, { content: '# 方案\n\n第一步' });
    expect(res.statusCode).toBe(201);
    official = res.json<Plan>();
    expect(official).toMatchObject({ kind: 'official', version: 1, title: '团队正式方案' });
    expect((await call('POST', `${B}/official`, ADVISOR, { content: 'y' })).statusCode).toBe(409);
  });

  it('探索副本：从正式版本分叉；访客 403', async () => {
    expect((await call('POST', `${B}/explorations`, GUEST, { title: 'a' })).statusCode).toBe(403);
    expect((await call('POST', `${B}/explorations`, MEMBER, { title: '' })).statusCode).toBe(422);
    const res = await call('POST', `${B}/explorations`, MEMBER, {
      title: '换一种采样',
      summary: '试试分层采样',
    });
    expect(res.statusCode).toBe(201);
    exploration = res.json<Plan>();
    expect(exploration).toMatchObject({
      kind: 'exploration',
      content: official.content,
      forkedFromVersion: 1,
      ownerId: MEMBER,
      version: 1,
      status: 'active',
    });
  });

  it('保存正文：建立者和负责人可改，他人 403；版本冲突 409；每次保存留一版', async () => {
    const url = `${B}/${exploration.id}/content`;
    expect((await call('PUT', url, MEMBER2, { content: 'x', baseVersion: 1 })).statusCode).toBe(
      403,
    );
    let res = await call('PUT', url, MEMBER, { content: '# 方案\n\n分层采样', baseVersion: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json<Plan>().version).toBe(2);
    res = await call('PUT', url, MEMBER, { content: 'stale', baseVersion: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('version_conflict');
    expect(res.json().error.details.current.version).toBe(2);
    res = await call('PUT', url, ADVISOR, {
      content: '# 方案\n\n分层采样\n\n导师补充',
      note: '补充',
      baseVersion: 2,
    });
    expect(res.statusCode).toBe(200);
    exploration = res.json<Plan>();
    expect((await call('PUT', url, MEMBER, { baseVersion: 3 })).statusCode).toBe(422);

    const versions = (await call('GET', `${B}/${exploration.id}/versions`, GUEST)).json<
      PlanVersion[]
    >();
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    const v3 = await call('GET', `${B}/${exploration.id}/versions/3`, GUEST);
    expect(v3.json<PlanVersion>()).toMatchObject({ note: '补充', content: exploration.content });
    expect((await call('GET', `${B}/${exploration.id}/versions/9`, GUEST)).statusCode).toBe(404);
    expect((await call('GET', `${B}/${exploration.id}/versions/abc`, GUEST)).statusCode).toBe(422);
  });

  it('正式方案不能直接改正文（409）；不存在的方案 404', async () => {
    const res = await call('PUT', `${B}/${official.id}/content`, OWNER, {
      content: 'x',
      baseVersion: 1,
    });
    expect(res.statusCode).toBe(409);
    expect((await call('GET', `${B}/pln_missing`, MEMBER)).statusCode).toBe(404);
    expect(
      (await call('PUT', `${B}/pln_missing/content`, MEMBER, { content: '', baseVersion: 1 }))
        .statusCode,
    ).toBe(404);
  });

  it('改标题、归档：他人 403；归档后不能再改正文', async () => {
    expect(
      (await call('PATCH', `${B}/${exploration.id}`, MEMBER2, { title: 'x' })).statusCode,
    ).toBe(403);
    const other = (
      await call('POST', `${B}/explorations`, MEMBER2, { title: '临时副本' })
    ).json<Plan>();
    const res = await call('PATCH', `${B}/${other.id}`, MEMBER2, { title: '临时副本 2' });
    expect(res.json<Plan>().title).toBe('临时副本 2');
    expect((await call('POST', `${B}/${other.id}/archive`, MEMBER, {})).statusCode).toBe(403);
    const archived = await call('POST', `${B}/${other.id}/archive`, MEMBER2, {});
    expect(archived.json<Plan>().status).toBe('archived');
    const save = await call('PUT', `${B}/${other.id}/content`, MEMBER2, {
      content: 'x',
      baseVersion: 1,
    });
    expect(save.statusCode).toBe(409);
    expect((await call('PATCH', `${B}/${official.id}`, MEMBER, { title: 'x' })).statusCode).toBe(
      403,
    );
  });

  it('采纳 plan_change：正式方案出新版本、副本标记为已纳入、审批待办完成', async () => {
    const res = await call('POST', `${B}/proposals`, MEMBER, {
      kind: 'plan_change',
      title: '改用分层采样',
      rationale: '方差更小',
      sourcePlanId: exploration.id,
      submit: true,
    });
    expect(res.statusCode).toBe(201);
    const proposal = res.json<BasisProposal>();
    expect(proposal).toMatchObject({
      status: 'submitted',
      basePlanVersion: 1,
      content: exploration.content,
      authorId: MEMBER,
    });
    const review = await inbox(P, proposal.id);
    expect(review.map((r) => r.userId).sort()).toEqual([ADVISOR, OWNER].sort());
    expect(review.every((r) => r.kind === 'review')).toBe(true);

    const url = `${B}/proposals/${proposal.id}/decide`;
    expect((await call('POST', url, MEMBER, { decision: 'accept' })).statusCode).toBe(403);
    expect((await call('POST', url, OWNER, { decision: 'maybe' })).statusCode).toBe(422);
    const decided = await call('POST', url, OWNER, { decision: 'accept', note: '同意' });
    expect(decided.statusCode).toBe(200);
    expect(decided.json<BasisProposal>()).toMatchObject({
      status: 'accepted',
      resultPlanVersion: 2,
      decisionNote: '同意',
    });
    expect((await call('POST', url, OWNER, { decision: 'accept' })).statusCode).toBe(409);

    const overview = (await call('GET', B, MEMBER)).json<PlansOverview>();
    expect(overview.official).toMatchObject({ version: 2, content: exploration.content });
    expect(overview.explorations.find((p) => p.id === exploration.id)?.status).toBe('merged');
    const v2 = (await call('GET', `${B}/${official.id}/versions/2`, MEMBER)).json<PlanVersion>();
    expect(v2).toMatchObject({
      proposalId: proposal.id,
      approvedBy: { kind: 'user', id: OWNER },
      createdBy: { kind: 'user', id: MEMBER },
    });
    expect((await inbox(P, proposal.id)).every((r) => r.doneAt !== null)).toBe(true);

    const types = await eventTypes(P);
    expect(types).toEqual(
      expect.arrayContaining([
        'plan.created',
        'plan.updated',
        'plan.version_created',
        'basis_proposal.created',
        'basis_proposal.updated',
      ]),
    );
  });

  it('采纳基于旧版本的 plan_change：409 version_conflict', async () => {
    const res = await call('POST', `${B}/proposals`, MEMBER2, {
      kind: 'plan_change',
      title: '基于旧版',
      content: '旧版改动',
      basePlanVersion: 1,
      submit: true,
    });
    expect(res.statusCode).toBe(201);
    const p = res.json<BasisProposal>();
    const decided = await call('POST', `${B}/proposals/${p.id}/decide`, ADVISOR, {
      decision: 'accept',
    });
    expect(decided.statusCode).toBe(409);
    expect(decided.json().error.code).toBe('version_conflict');
    expect(decided.json().error.details.current.version).toBe(2);
    // 提出者更新基于版本后可以采纳
    const patched = await call('PATCH', `${B}/proposals/${p.id}`, MEMBER2, {
      basePlanVersion: 2,
      baseVersion: p.version,
    });
    expect(patched.statusCode).toBe(200);
    const ok = await call('POST', `${B}/proposals/${p.id}/decide`, ADVISOR, { decision: 'accept' });
    expect(ok.json<BasisProposal>().resultPlanVersion).toBe(3);
  });
});

// ---------------------------------------------------------------- 提案生命周期

describe('提案：草稿、修改、提交、撤回、删除、驳回', () => {
  const P = 'prj_plan_prop';
  const B = `/projects/${P}/plans/proposals`;

  beforeAll(() => seedProject(P));

  it('草稿只有作者能看；他人改 / 删 404', async () => {
    const res = await call('POST', B, MEMBER, {
      kind: 'team_basis',
      title: '学习率结论',
      content: 'lr=3e-4 最稳',
    });
    expect(res.statusCode).toBe(201);
    const draft = res.json<BasisProposal>();
    expect(draft).toMatchObject({ status: 'draft', version: 1, draftedBy: { id: MEMBER } });
    expect((await call('GET', `${B}/${draft.id}`, MEMBER)).statusCode).toBe(200);
    expect((await call('GET', `${B}/${draft.id}`, OWNER)).statusCode).toBe(404);
    expect((await call('GET', B, OWNER)).json<BasisProposal[]>()).toHaveLength(0);
    expect((await call('GET', B, MEMBER)).json<BasisProposal[]>()).toHaveLength(1);
    expect(
      (await call('PATCH', `${B}/${draft.id}`, MEMBER2, { title: 'x', baseVersion: 1 })).statusCode,
    ).toBe(404);
    expect((await call('DELETE', `${B}/${draft.id}`, MEMBER2)).statusCode).toBe(404);
    expect((await call('GET', `${B}?status=bogus`, MEMBER)).statusCode).toBe(422);
  });

  it('修改：乐观并发；提交时缺 claimType 422；提交后待审批；他人 403；撤回；删除', async () => {
    const draft = (
      await call('POST', B, MEMBER, { kind: 'team_basis', title: '数据清洗规则', content: '去重' })
    ).json<BasisProposal>();
    expect((await call('POST', `${B}/${draft.id}/submit`, MEMBER)).statusCode).toBe(422);
    const patched = await call('PATCH', `${B}/${draft.id}`, MEMBER, {
      claimType: 'decision',
      baseVersion: 1,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<BasisProposal>().version).toBe(2);
    const stale = await call('PATCH', `${B}/${draft.id}`, MEMBER, { title: 'x', baseVersion: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('version_conflict');
    expect((await call('PATCH', `${B}/${draft.id}`, MEMBER, { title: 'x' })).statusCode).toBe(422);

    const submitted = await call('POST', `${B}/${draft.id}/submit`, MEMBER);
    expect(submitted.json<BasisProposal>().status).toBe('submitted');
    expect((await call('POST', `${B}/${draft.id}/submit`, MEMBER)).statusCode).toBe(409);
    expect((await call('GET', `${B}/${draft.id}`, MEMBER2)).statusCode).toBe(200);
    expect((await call('POST', `${B}/${draft.id}/withdraw`, MEMBER2)).statusCode).toBe(403);
    expect((await inbox(P, draft.id)).filter((r) => r.doneAt === null)).toHaveLength(2);
    expect((await call('DELETE', `${B}/${draft.id}`, MEMBER)).statusCode).toBe(409);

    const withdrawn = await call('POST', `${B}/${draft.id}/withdraw`, MEMBER);
    expect(withdrawn.json<BasisProposal>().status).toBe('withdrawn');
    expect((await inbox(P, draft.id)).every((r) => r.doneAt !== null)).toBe(true);
    expect((await call('DELETE', `${B}/${draft.id}`, MEMBER)).statusCode).toBe(204);
    expect((await call('GET', `${B}/${draft.id}`, MEMBER)).statusCode).toBe(404);
    expect(await eventTypes(P)).toContain('basis_proposal.deleted');
  });

  it('plan_change：没有正式方案时不能提交（422）', async () => {
    const res = await call('POST', B, MEMBER, {
      kind: 'plan_change',
      title: '改方案',
      content: 'x',
      submit: true,
    });
    expect(res.statusCode).toBe(422);
  });

  it('驳回：状态变为未采纳，审批待办完成，不生成依据', async () => {
    const p = (
      await call('POST', B, MEMBER, {
        kind: 'team_basis',
        title: '可疑结论',
        content: '只跑了一次',
        claimType: 'observation',
        submit: true,
      })
    ).json<BasisProposal>();
    expect(
      (await call('POST', `${B}/${p.id}/decide`, GUEST, { decision: 'reject' })).statusCode,
    ).toBe(403);
    expect(
      (await call('POST', `${B}/prp_missing/decide`, OWNER, { decision: 'reject' })).statusCode,
    ).toBe(404);
    const res = await call('POST', `${B}/${p.id}/decide`, OWNER, {
      decision: 'reject',
      note: '再多跑几次',
    });
    expect(res.json<BasisProposal>()).toMatchObject({
      status: 'rejected',
      decisionNote: '再多跑几次',
      decidedBy: { id: OWNER },
      resultBasisId: null,
    });
    expect((await inbox(P, p.id)).every((r) => r.doneAt !== null)).toBe(true);
    expect(
      (await call('GET', `/projects/${P}/plans/basis`, MEMBER)).json<TeamBasis[]>(),
    ).toHaveLength(0);
    expect(
      (await call('PATCH', `${B}/${p.id}`, MEMBER, { title: 'x', baseVersion: 2 })).statusCode,
    ).toBe(409);
  });
});

// ---------------------------------------------------------------- 个人工作记忆

describe('个人工作记忆：本人可写，本人和负责人可读', () => {
  const P = 'prj_plan_mem';
  const B = `/projects/${P}/plans/memory`;
  let mem: PersonalMemory;

  beforeAll(() => seedProject(P));

  it('新建与权限', async () => {
    expect(
      (await call('POST', B, null, { title: 'x', content: '', baseVersion: 0 })).statusCode,
    ).toBe(401);
    expect(
      (await call('POST', B, GUEST, { title: 'x', content: '', baseVersion: 0 })).statusCode,
    ).toBe(403);
    expect(
      (await call('POST', B, MEMBER, { title: '', content: '', baseVersion: 0 })).statusCode,
    ).toBe(422);
    expect(
      (await call('POST', B, MEMBER, { title: 'x', content: '', baseVersion: 1 })).statusCode,
    ).toBe(422);
    const res = await call('POST', B, MEMBER, {
      title: '今天的发现',
      content: 'batch=64 时 loss 抖动',
      baseVersion: 0,
    });
    expect(res.statusCode).toBe(201);
    mem = res.json<PersonalMemory>();
    expect(mem).toMatchObject({ userId: MEMBER, version: 1 });
  });

  it('可见性：本人、负责人可读；其他成员 403；默认只看自己的', async () => {
    expect((await call('GET', B, MEMBER)).json<PersonalMemory[]>().map((m) => m.id)).toEqual([
      mem.id,
    ]);
    expect((await call('GET', B, MEMBER2)).json<PersonalMemory[]>()).toHaveLength(0);
    expect(
      (await call('GET', `${B}?userId=${MEMBER}`, OWNER)).json<PersonalMemory[]>(),
    ).toHaveLength(1);
    expect((await call('GET', `${B}?userId=${MEMBER}`, ADVISOR)).statusCode).toBe(200);
    expect((await call('GET', `${B}?userId=${MEMBER}`, MEMBER2)).statusCode).toBe(403);
    expect((await call('GET', `${B}?userId=${MEMBER}`, GUEST)).statusCode).toBe(403);
    expect((await call('GET', B, STRANGER)).statusCode).toBe(404);
  });

  it('修改与删除只有本人：负责人 403，其他成员 404；版本冲突 409', async () => {
    const url = `${B}/${mem.id}`;
    const body = { title: '改', content: '改', baseVersion: 1 };
    expect((await call('PUT', url, OWNER, body)).statusCode).toBe(403);
    expect((await call('PUT', url, MEMBER2, body)).statusCode).toBe(404);
    expect((await call('DELETE', url, OWNER)).statusCode).toBe(403);
    expect((await call('PUT', `${B}/pmm_missing`, MEMBER, body)).statusCode).toBe(404);
    const res = await call('PUT', url, MEMBER, body);
    expect(res.json<PersonalMemory>().version).toBe(2);
    const stale = await call('PUT', url, MEMBER, body);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('version_conflict');
    expect((await call('DELETE', url, MEMBER)).statusCode).toBe(204);
    expect((await call('GET', B, MEMBER)).json<PersonalMemory[]>()).toHaveLength(0);
  });

  it('个人记忆不广播事件', async () => {
    const events = await t.app.ctx.bus.listSince(P, 0, 5000);
    expect(events.filter((e) => JSON.stringify(e.payload).includes(mem.id))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- 团队依据与复核

describe('团队依据：采纳、替代、复核', () => {
  const P = 'prj_plan_basis';
  const B = `/projects/${P}/plans`;
  let memId: string;
  let a: TeamBasis;
  let b: TeamBasis;
  let c: TeamBasis;

  beforeAll(async () => {
    await seedProject(P);
    await call('POST', `${B}/official`, OWNER, { content: '# 方案 v1' });
    memId = (
      await call('POST', `${B}/memory`, MEMBER, { title: '笔记', content: '观察', baseVersion: 0 })
    ).json<PersonalMemory>().id;
  });

  async function acceptBasis(user: string, body: Record<string, unknown>) {
    const p = (
      await call('POST', `${B}/proposals`, user, { kind: 'team_basis', submit: true, ...body })
    ).json<BasisProposal>();
    expect(p.status).toBe('submitted');
    const res = await call('POST', `${B}/proposals/${p.id}/decide`, OWNER, { decision: 'accept' });
    expect(res.statusCode).toBe(200);
    const decided = res.json<BasisProposal>();
    expect(decided.status).toBe('accepted');
    return (await call('GET', `${B}/basis/${decided.resultBasisId}`, GUEST)).json<TeamBasis>();
  }

  it('采纳 team_basis：生成依据，记录提出者、审批人，冻结证据版本', async () => {
    a = await acceptBasis(MEMBER, {
      title: 'batch=64 时 loss 抖动',
      content: '三次复现都抖动',
      claimType: 'observation',
      conditions: 'lr=1e-3',
      evidence: [{ kind: 'personal_memory', ref: memId, label: '笔记' }],
    });
    expect(a).toMatchObject({
      status: 'active',
      claimType: 'observation',
      conditions: 'lr=1e-3',
      planVersion: 1,
      proposerId: MEMBER,
      proposer: { kind: 'user', id: MEMBER, name: '张三' },
      approvedBy: { kind: 'user', id: OWNER },
    });
    expect(a.evidence[0]).toMatchObject({ kind: 'personal_memory', ref: memId, version: '1' });
    expect(await eventTypes(P)).toContain('team_basis.created');
  });

  it('依据列表任何成员可看；按状态筛选；不存在 404', async () => {
    expect((await call('GET', `${B}/basis`, GUEST)).json<TeamBasis[]>()).toHaveLength(1);
    expect(
      (await call('GET', `${B}/basis?status=retired`, GUEST)).json<TeamBasis[]>(),
    ).toHaveLength(0);
    expect((await call('GET', `${B}/basis/tbs_missing`, GUEST)).statusCode).toBe(404);
    expect((await call('GET', `${B}/basis`, null)).statusCode).toBe(401);
  });

  it('替代依据：旧依据 superseded，引用它的依据待复核并提醒提出者和负责人', async () => {
    b = await acceptBasis(MEMBER2, {
      title: '改用 batch=32',
      content: '基于抖动观察',
      claimType: 'decision',
      evidence: [{ kind: 'team_basis', ref: a.id, label: '抖动观察' }],
    });
    expect(b.evidence[0]?.version).toBeTruthy();
    c = await acceptBasis(MEMBER, {
      title: 'batch=64 抖动来自 warmup 不足',
      content: '加 warmup 后不抖',
      claimType: 'observation',
      supersedesBasisId: a.id,
    });
    const oldA = (await call('GET', `${B}/basis/${a.id}`, MEMBER)).json<TeamBasis>();
    expect(oldA).toMatchObject({ status: 'superseded', supersededBy: c.id });
    b = (await call('GET', `${B}/basis/${b.id}`, MEMBER)).json<TeamBasis>();
    expect(b.status).toBe('needs_review');
    expect(b.reviewReason).toContain(a.title);
    expect((await call('GET', `${B}/basis/${c.id}`, MEMBER)).json<TeamBasis>().status).toBe(
      'active',
    );

    const recheck = (await inbox(P, b.id)).filter((r) => r.kind === 'recheck');
    expect(recheck.map((r) => r.userId).sort()).toEqual([ADVISOR, MEMBER2, OWNER].sort());
  });

  it('替代已被替代的依据：409', async () => {
    const p = (
      await call('POST', `${B}/proposals`, MEMBER, {
        kind: 'team_basis',
        title: '再改 a',
        content: 'x',
        claimType: 'hypothesis',
        supersedesBasisId: a.id,
        submit: true,
      })
    ).json<BasisProposal>();
    expect(
      (await call('POST', `${B}/proposals/${p.id}/decide`, OWNER, { decision: 'accept' }))
        .statusCode,
    ).toBe(409);
  });

  it('正式方案出新版本：依赖旧版本的有效依据待复核', async () => {
    const official = (await call('GET', B, MEMBER)).json<PlansOverview>().official!;
    const p = (
      await call('POST', `${B}/proposals`, MEMBER2, {
        kind: 'plan_change',
        title: '方案 v2',
        content: '# 方案 v2',
        submit: true,
      })
    ).json<BasisProposal>();
    expect(p.basePlanVersion).toBe(official.version);
    await call('POST', `${B}/proposals/${p.id}/decide`, ADVISOR, { decision: 'accept' });
    c = (await call('GET', `${B}/basis/${c.id}`, MEMBER)).json<TeamBasis>();
    expect(c.status).toBe('needs_review');
    expect(c.reviewReason).toContain('第 2 版');
    const recheck = (await inbox(P, c.id)).filter((r) => r.kind === 'recheck');
    expect(recheck.map((r) => r.userId).sort()).toEqual([ADVISOR, MEMBER, OWNER].sort());
  });

  it('复核：只有负责人；确认后回到有效并跟上当前版本；停用；非法状态 409', async () => {
    const url = (id: string) => `${B}/basis/${id}/review`;
    expect((await call('POST', url(b.id), MEMBER2, { action: 'confirm' })).statusCode).toBe(403);
    expect((await call('POST', url(b.id), OWNER, { action: 'keep' })).statusCode).toBe(422);
    expect((await call('POST', url('tbs_missing'), OWNER, { action: 'confirm' })).statusCode).toBe(
      404,
    );
    const confirmed = await call('POST', url(b.id), OWNER, { action: 'confirm' });
    expect(confirmed.json<TeamBasis>()).toMatchObject({
      status: 'active',
      reviewReason: '',
      planVersion: 2,
    });
    expect((await inbox(P, b.id)).every((r) => r.doneAt !== null)).toBe(true);
    expect((await call('POST', url(b.id), OWNER, { action: 'confirm' })).statusCode).toBe(409);
    const retired = await call('POST', url(c.id), ADVISOR, { action: 'retire', note: '已过时' });
    expect(retired.json<TeamBasis>()).toMatchObject({ status: 'retired', reviewReason: '已过时' });
    expect((await call('POST', url(a.id), OWNER, { action: 'retire' })).statusCode).toBe(409);
    expect(await eventTypes(P)).toContain('team_basis.updated');
  });
});
