import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ApiError, type ActorRef, type InboxItem, type Project, type WorkClaim } from '@srh/shared';
import { makeApp, setupProject, signup, type Session, type TestApp } from './helpers';
import { workClaims } from '../src/db/schema';
import {
  createClaim,
  findConflicts,
  findCoveringClaim,
  globsIntersect,
  listClaims,
  overlap,
  releaseThreadClaims,
  renewThreadClaims,
} from '../src/modules/claims/service';

let t: TestApp;
let project: Project;
let owner: Session;
let member: Session;
let member2: Session;
let advisor: Session;
let guest: Session;

const agent = (n: number): ActorRef => ({ kind: 'agent', id: `agt_${n}`, name: `研协${n}` });

beforeAll(async () => {
  t = await makeApp();
  const s = await setupProject(t.app);
  project = s.project;
  owner = s.owner;
  [member, advisor, guest] = s.others as [Session, Session, Session];
  member2 = await signup(t.app, '王五');
  const inv = await owner.req('POST', `/projects/${project.id}/invites`, { role: 'member' });
  await member2.req('POST', `/invites/${inv.json<{ token: string }>().token}/accept`);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

const base = () => `/projects/${project.id}/claims`;
const events = () => t.app.ctx.bus.listSince(project.id, 0, 1000);

async function expectConflict(p: Promise<unknown>): Promise<WorkClaim[]> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('claim_conflict');
    return (err as ApiError).details!.claims as WorkClaim[];
  }
  throw new Error('预期 claim_conflict');
}

describe('overlap helpers', () => {
  it('globsIntersect', () => {
    expect(globsIntersect('src/**', 'src/a.ts')).toBe(true);
    expect(globsIntersect('src/**', 'src/deep/x/a.ts')).toBe(true);
    expect(globsIntersect('src/*.ts', 'src/deep/a.ts')).toBe(false);
    expect(globsIntersect('src/?.ts', 'src/a.ts')).toBe(true);
    expect(globsIntersect('./src\\a.ts', '/src/a.ts')).toBe(true);
    expect(globsIntersect('data/raw/**', 'data/clean/**')).toBe(false);
    expect(globsIntersect('data/**', 'data/raw/*.csv')).toBe(true);
    expect(globsIntersect('src/**/a.ts', 'src/a.ts')).toBe(true);
    expect(globsIntersect('a.ts', 'b.ts')).toBe(false);
  });

  it('overlap: document ⊃ section, topic case-insensitive', () => {
    const doc = { resourceKind: 'document' as const, resourceRef: 'doc_A' };
    const sec = { resourceKind: 'doc_section' as const, resourceRef: 'doc_A#2 方法' };
    expect(overlap(doc, sec)).toBe(true);
    expect(overlap(sec, doc)).toBe(true);
    expect(overlap(sec, { resourceKind: 'doc_section', resourceRef: 'doc_A#3 实验' })).toBe(false);
    expect(overlap(sec, { resourceKind: 'doc_section', resourceRef: 'doc_B#2 方法' })).toBe(false);
    expect(
      overlap(
        { resourceKind: 'topic', resourceRef: ' Baseline 复现 ' },
        { resourceKind: 'topic', resourceRef: 'baseline 复现' },
      ),
    ).toBe(true);
    expect(overlap({ resourceKind: 'card', resourceRef: 'crd_1' }, doc)).toBe(false);
  });
});

describe('claims REST', () => {
  let first: WorkClaim;

  it('member claims a document (201 + claim.created)', async () => {
    const res = await member.req('POST', base(), {
      resourceKind: 'document',
      resourceRef: 'doc_A',
      intent: '改写方法部分',
    });
    expect(res.statusCode).toBe(201);
    first = res.json<WorkClaim>();
    expect(first).toMatchObject({
      status: 'active',
      mode: 'exclusive',
      holder: { kind: 'user', id: member.user.id },
      onBehalfOfUserId: member.user.id,
    });
    const ev = (await events()).find((e) => e.type === 'claim.created');
    expect(ev?.payload).toMatchObject({ id: first.id });
  });

  it('section claim by another user conflicts → 409 + claim.conflict + inbox for both', async () => {
    const res = await advisor.req('POST', base(), {
      resourceKind: 'doc_section',
      resourceRef: 'doc_A#2 方法',
      intent: '润色方法',
    });
    expect(res.statusCode).toBe(409);
    const body = res.json<{ error: { code: string; details: { claims: WorkClaim[] } } }>();
    expect(body.error.code).toBe('claim_conflict');
    expect(body.error.details.claims.map((c) => c.id)).toEqual([first.id]);

    const conflictEv = (await events()).find((e) => e.type === 'claim.conflict');
    expect(conflictEv).toBeDefined();
    if (conflictEv?.type === 'claim.conflict') {
      expect(conflictEv.payload.claim).toMatchObject({
        resourceRef: 'doc_A#2 方法',
        status: 'active',
      });
      expect(conflictEv.payload.conflictsWith.map((c) => c.id)).toEqual([first.id]);
    }

    for (const s of [member, advisor]) {
      const inbox = await s.req('GET', `/inbox?projectId=${project.id}`);
      const items = inbox.json<InboxItem[]>();
      expect(items.some((i) => i.kind === 'conflict' && i.sourceId === first.id)).toBe(true);
    }
    // 认领没有落库
    const list = await guest.req('GET', `${base()}?status=active`);
    expect(list.json<WorkClaim[]>().map((c) => c.id)).toEqual([first.id]);
  });

  it('list by resource returns overlapping claims', async () => {
    const res = await guest.req(
      'GET',
      `${base()}?resourceKind=doc_section&resourceRef=${encodeURIComponent('doc_A#9 结论')}`,
    );
    expect(res.json<WorkClaim[]>().map((c) => c.id)).toEqual([first.id]);
    const none = await guest.req('GET', `${base()}?resourceKind=document&resourceRef=doc_Z`);
    expect(none.json<WorkClaim[]>()).toEqual([]);
  });

  it('same holder re-claim renews (idempotent)', async () => {
    const res = await member.req('POST', base(), {
      resourceKind: 'document',
      resourceRef: 'doc_A',
      intent: '改写方法与实验',
      ttlSec: 3600,
    });
    expect(res.statusCode).toBe(201);
    const again = res.json<WorkClaim>();
    expect(again.id).toBe(first.id);
    expect(again.intent).toBe('改写方法与实验');
    expect(new Date(again.expiresAt).getTime()).toBeGreaterThan(
      new Date(first.expiresAt).getTime(),
    );
  });

  it('permissions: guest 403, non-holder member 403, advisor may release, 404 unknown', async () => {
    expect(
      (await guest.req('POST', base(), { resourceKind: 'topic', resourceRef: 'x', intent: 'x' }))
        .statusCode,
    ).toBe(403);
    expect((await member2.req('POST', `${base()}/${first.id}/renew`, {})).statusCode).toBe(403);
    expect((await member2.req('DELETE', `${base()}/${first.id}`)).statusCode).toBe(403);
    expect((await member.req('POST', `${base()}/clm_nope/renew`, {})).statusCode).toBe(404);
    const stranger = await signup(t.app, '路人');
    expect((await stranger.req('GET', base())).statusCode).toBe(404);

    const renewed = await member.req('POST', `${base()}/${first.id}/renew`, { ttlSec: 600 });
    expect(renewed.statusCode).toBe(200);
    const exp = new Date(renewed.json<WorkClaim>().expiresAt).getTime();
    expect(Math.abs(exp - (Date.now() + 600_000))).toBeLessThan(5000);

    expect((await advisor.req('DELETE', `${base()}/${first.id}`)).statusCode).toBe(204);
    // 重复释放是空操作
    expect((await member.req('DELETE', `${base()}/${first.id}`)).statusCode).toBe(204);
    const list = await guest.req('GET', `${base()}?status=released`);
    expect(list.json<WorkClaim[]>().some((c) => c.id === first.id)).toBe(true);
    // 释放后别人可以认领
    const res = await advisor.req('POST', base(), {
      resourceKind: 'doc_section',
      resourceRef: 'doc_A#2 方法',
      intent: '润色方法',
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('claims service semantics', () => {
  const ctx = () => t.app.ctx;

  it('glob overlap conflicts; disjoint paths do not', async () => {
    await createClaim(ctx(), agent(1), project.id, {
      resourceKind: 'file',
      resourceRef: 'src/**',
      mode: 'exclusive',
      intent: '重构',
      ttlSec: 1800,
      threadId: 'thr_1',
      onBehalfOfUserId: member.user.id,
    });
    const hits = await expectConflict(
      createClaim(ctx(), agent(2), project.id, {
        resourceKind: 'file',
        resourceRef: 'src/a.ts',
        mode: 'exclusive',
        intent: '修 bug',
        ttlSec: 1800,
        threadId: 'thr_2',
        onBehalfOfUserId: member2.user.id,
      }),
    );
    expect(hits[0]?.resourceRef).toBe('src/**');
    const ok = await createClaim(ctx(), agent(2), project.id, {
      resourceKind: 'file',
      resourceRef: 'lib/a.ts',
      mode: 'exclusive',
      intent: '修 bug',
      ttlSec: 1800,
      threadId: 'thr_2',
    });
    expect(ok.status).toBe('active');
  });

  it('shared + shared coexist; exclusive on top conflicts', async () => {
    const base = { resourceKind: 'topic' as const, intent: '复现', ttlSec: 1800 };
    await createClaim(ctx(), agent(3), project.id, {
      ...base,
      resourceRef: 'Baseline 复现',
      mode: 'shared',
    });
    await createClaim(ctx(), agent(4), project.id, {
      ...base,
      resourceRef: ' baseline 复现',
      mode: 'shared',
    });
    const hits = await expectConflict(
      createClaim(ctx(), agent(5), project.id, {
        ...base,
        resourceRef: 'BASELINE 复现',
        mode: 'exclusive',
      }),
    );
    expect(hits).toHaveLength(2);
  });

  it('same thread never conflicts', async () => {
    const input = {
      resourceKind: 'card' as const,
      resourceRef: 'crd_1',
      mode: 'exclusive' as const,
      intent: '更新卡片',
      ttlSec: 1800,
      threadId: 'thr_same',
    };
    await createClaim(ctx(), agent(6), project.id, input);
    const second = await createClaim(ctx(), agent(7), project.id, input);
    expect(second.status).toBe('active');
    await expectConflict(
      createClaim(ctx(), agent(8), project.id, { ...input, threadId: 'thr_other' }),
    );
  });

  it('findConflicts and findCoveringClaim', async () => {
    const res = await findConflicts(ctx(), project.id, [
      { resourceKind: 'file', resourceRef: 'src/x/y.ts', mode: 'shared' },
      { resourceKind: 'file', resourceRef: 'docs/readme.md', mode: 'exclusive' },
    ]);
    expect(res).toHaveLength(1);
    expect(res[0]?.conflictsWith[0]?.resourceRef).toBe('src/**');
    // 以持有者身份检查不算冲突
    expect(
      await findConflicts(
        ctx(),
        project.id,
        [{ resourceKind: 'file', resourceRef: 'src/x.ts', mode: 'exclusive' }],
        {
          holderId: 'agt_1',
        },
      ),
    ).toEqual([]);

    const cover = await findCoveringClaim(
      ctx(),
      project.id,
      { resourceKind: 'file', resourceRef: 'src/deep/z.ts' },
      { holderId: 'agt_1', threadId: null },
    );
    expect(cover?.resourceRef).toBe('src/**');
    const byThread = await findCoveringClaim(
      ctx(),
      project.id,
      { resourceKind: 'file', resourceRef: 'src/z.ts' },
      { holderId: 'agt_999', threadId: 'thr_1' },
    );
    expect(byThread?.holder.id).toBe('agt_1');
    expect(
      await findCoveringClaim(
        ctx(),
        project.id,
        { resourceKind: 'file', resourceRef: 'src/z.ts' },
        { holderId: 'agt_2', threadId: 'thr_2' },
      ),
    ).toBeNull();
  });

  it('expiry marks claims expired and frees the resource; renew of expired → 409', async () => {
    const c = await createClaim(ctx(), agent(10), project.id, {
      resourceKind: 'card',
      resourceRef: 'card_1',
      mode: 'exclusive',
      intent: '跑实验',
      ttlSec: 60,
      onBehalfOfUserId: member.user.id,
    });
    await t.db.db
      .update(workClaims)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(workClaims.id, c.id));
    const list = await listClaims(ctx(), project.id, { threadId: undefined, status: 'expired' });
    expect(list.map((x) => x.id)).toContain(c.id);
    const evs = await events();
    expect(
      evs.some(
        (e) =>
          e.type === 'claim.updated' && e.payload.id === c.id && e.payload.status === 'expired',
      ),
    ).toBe(true);
    const renew = await member.req('POST', `${base()}/${c.id}/renew`, {});
    expect(renew.statusCode).toBe(409);
    expect(renew.json()).toMatchObject({
      error: { code: 'conflict', message: '认领已过期，请重新认领' },
    });
    const other = await createClaim(ctx(), agent(11), project.id, {
      resourceKind: 'card',
      resourceRef: 'card_1',
      mode: 'exclusive',
      intent: '接着跑',
      ttlSec: 60,
    });
    expect(other.id).not.toBe(c.id);
  });

  it('thread heartbeat and release', async () => {
    const c = await createClaim(ctx(), agent(12), project.id, {
      resourceKind: 'card',
      resourceRef: 'crd_hb',
      mode: 'exclusive',
      intent: '心跳',
      ttlSec: 60,
      threadId: 'thr_hb',
    });
    await renewThreadClaims(ctx(), project.id, 'thr_hb', 3600);
    const [row] = await t.db.db.select().from(workClaims).where(eq(workClaims.id, c.id));
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3000_000);
    const n = await releaseThreadClaims(ctx(), project.id, 'thr_hb', agent(12));
    expect(n).toBe(1);
    const [after] = await t.db.db.select().from(workClaims).where(eq(workClaims.id, c.id));
    expect(after!.status).toBe('released');
  });

  it('concurrent claims are atomic (advisory lock)', async () => {
    const mk = (n: number) =>
      createClaim(ctx(), agent(100 + n), project.id, {
        resourceKind: 'document',
        resourceRef: 'doc_RACE',
        mode: 'exclusive',
        intent: '抢',
        ttlSec: 1800,
      });
    const results = await Promise.allSettled([mk(1), mk(2), mk(3), mk(4)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results.filter(
        (r) => r.status === 'rejected' && (r.reason as ApiError).code === 'claim_conflict',
      ),
    ).toHaveLength(3);
  });
});
