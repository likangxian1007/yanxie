import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, type Project, type Routine } from '@srh/shared';
import { makeApp, setupProject, signup, sleep, type Session, type TestApp } from './helpers';
import { runtimeHooks } from '../src/agents/runtime/hooks';
import {
  listDueRoutines,
  markRoutineRan,
  nextRunAt,
  validateSchedule,
} from '../src/modules/routines/service';

let t: TestApp;
let project: Project;
let owner: Session;
let member: Session;
let advisor: Session;
let guest: Session;

beforeAll(async () => {
  t = await makeApp();
  const s = await setupProject(t.app);
  project = s.project;
  owner = s.owner;
  [member, advisor, guest] = s.others as [Session, Session, Session];
}, 60_000);

afterAll(async () => {
  runtimeHooks.fireRoutine = undefined;
  runtimeHooks.routinesChanged = undefined;
  await t?.close();
});

const base = () => `/projects/${project.id}/routines`;

describe('schedule parsing', () => {
  it('cron in Asia/Shanghai', () => {
    // 2026-10-26 是周一；上海 09:00 = UTC 01:00
    const from = new Date('2026-10-26T00:00:00Z');
    expect(nextRunAt('0 9 * * 1', from)?.toISOString()).toBe('2026-10-26T01:00:00.000Z');
    expect(nextRunAt('0 9 * * 1', new Date('2026-10-26T01:00:00Z'))?.toISOString()).toBe(
      '2026-11-02T01:00:00.000Z',
    );
    expect(nextRunAt('*/15 * * * *', new Date('2026-10-26T00:07:00Z'))?.toISOString()).toBe(
      '2026-10-26T00:15:00.000Z',
    );
  });

  it('every: and at:', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    expect(nextRunAt('every:3600000', from)?.toISOString()).toBe('2026-01-01T01:00:00.000Z');
    expect(nextRunAt('at:2026-02-01T00:00:00Z', from)?.toISOString()).toBe(
      '2026-02-01T00:00:00.000Z',
    );
    expect(nextRunAt('at:2025-02-01T00:00:00Z', from)).toBeNull();
  });

  it('rejects invalid schedules', () => {
    for (const s of [
      'every:1000',
      'every:abc',
      'at:not-a-date',
      '0 9 * *',
      '0 0 9 * * 1',
      '61 * * * *',
      '',
    ]) {
      expect(() => validateSchedule(s), s).toThrow(ApiError);
    }
  });
});

describe('routines REST', () => {
  let r: Routine;
  const changed: string[] = [];

  it('creates (201) with nextRunAt and event', async () => {
    runtimeHooks.routinesChanged = (pid) => changed.push(pid);
    const res = await member.req('POST', base(), {
      title: '周报',
      schedule: '0 9 * * 1',
      prompt: '汇总本周进展',
    });
    expect(res.statusCode).toBe(201);
    r = res.json<Routine>();
    expect(r).toMatchObject({
      createdBy: member.user.id,
      enabled: true,
      lastRunAt: null,
      targetThreadId: null,
    });
    expect(new Date(r.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    expect(changed).toContain(project.id);
    const evs = await t.app.ctx.bus.listSince(project.id, 0, 1000);
    expect(evs.some((e) => e.type === 'routine.created' && e.payload.id === r.id)).toBe(true);

    const list = await guest.req('GET', base());
    expect(list.json<Routine[]>().map((x) => x.id)).toEqual([r.id]);
  });

  it('validates schedule and target thread', async () => {
    const bad = await member.req('POST', base(), { title: 'x', schedule: 'every:5', prompt: 'x' });
    expect(bad.statusCode).toBe(422);
    const noThread = await member.req('POST', base(), {
      title: 'x',
      schedule: 'every:60000',
      prompt: 'x',
      targetThreadId: 'thr_nope',
    });
    expect(noThread.statusCode).toBe(404);
  });

  it('permissions', async () => {
    expect(
      (await guest.req('POST', base(), { title: 'x', schedule: 'every:60000', prompt: 'x' }))
        .statusCode,
    ).toBe(403);
    const other = await signup(t.app, '王五');
    const inv = await owner.req('POST', `/projects/${project.id}/invites`, { role: 'member' });
    await other.req('POST', `/invites/${inv.json<{ token: string }>().token}/accept`);
    expect((await other.req('PATCH', `${base()}/${r.id}`, { title: '改' })).statusCode).toBe(403);
    expect((await other.req('DELETE', `${base()}/${r.id}`)).statusCode).toBe(403);
    const stranger = await signup(t.app, '路人');
    expect((await stranger.req('GET', base())).statusCode).toBe(404);
    expect((await member.req('PATCH', `${base()}/rtn_nope`, { title: 'x' })).statusCode).toBe(404);
  });

  it('updates and recomputes nextRunAt; disabling clears it', async () => {
    const res = await advisor.req('PATCH', `${base()}/${r.id}`, { schedule: 'every:120000' });
    expect(res.statusCode).toBe(200);
    const u = res.json<Routine>();
    expect(Math.abs(new Date(u.nextRunAt!).getTime() - (Date.now() + 120_000))).toBeLessThan(5000);
    const off = await member.req('PATCH', `${base()}/${r.id}`, { enabled: false });
    expect(off.json<Routine>()).toMatchObject({ enabled: false, nextRunAt: null });
    // 只改标题不能把 enabled / targetThreadId 重置成默认值
    const renamed = await member.req('PATCH', `${base()}/${r.id}`, { title: '周报（改）' });
    expect(renamed.json<Routine>()).toMatchObject({
      title: '周报（改）',
      enabled: false,
      nextRunAt: null,
      schedule: 'every:120000',
    });
    const on = await member.req('PATCH', `${base()}/${r.id}`, { enabled: true });
    expect(on.json<Routine>().nextRunAt).not.toBeNull();
  });

  it('run endpoint returns 202 and fires the hook', async () => {
    const fired: { id: string; by: string }[] = [];
    runtimeHooks.fireRoutine = async (_ctx, routine, by) => {
      fired.push({ id: routine.id, by });
    };
    const res = await member.req('POST', `${base()}/${r.id}/run`);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });
    await sleep(20);
    expect(fired).toEqual([{ id: r.id, by: member.user.id }]);

    // 钩子失败不影响响应
    runtimeHooks.fireRoutine = async () => {
      throw new Error('boom');
    };
    expect((await member.req('POST', `${base()}/${r.id}/run`)).statusCode).toBe(202);
    expect((await guest.req('POST', `${base()}/${r.id}/run`)).statusCode).toBe(403);
  });

  it('due routines and markRoutineRan', async () => {
    const res = await member.req('POST', base(), {
      title: '一次性',
      schedule: `at:${new Date(Date.now() + 60_000).toISOString()}`,
      prompt: '提醒',
    });
    const once = res.json<Routine>();
    const due = await listDueRoutines(t.app.ctx, new Date(Date.now() + 120_000));
    expect(due.map((d) => d.id)).toContain(once.id);
    const ran = await markRoutineRan(t.app.ctx, once.id, new Date(Date.now() + 61_000));
    expect(ran.nextRunAt).toBeNull();
    expect(ran.lastRunAt).not.toBeNull();
    const due2 = await listDueRoutines(t.app.ctx, new Date(Date.now() + 120_000));
    expect(due2.map((d) => d.id)).not.toContain(once.id);
  });

  it('deletes (204) with event', async () => {
    expect((await owner.req('DELETE', `${base()}/${r.id}`)).statusCode).toBe(204);
    const evs = await t.app.ctx.bus.listSince(project.id, 0, 1000);
    expect(evs.some((e) => e.type === 'routine.deleted' && e.payload.id === r.id)).toBe(true);
    expect((await owner.req('DELETE', `${base()}/${r.id}`)).statusCode).toBe(404);
  });
});
