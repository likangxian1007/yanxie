import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MyPins, Project } from '@srh/shared';
import { makeApp, setupProject, signup, type Session, type TestApp } from './helpers';

/** 置顶跟账号走（API.md §2.1）：GET /auth/me/pins、PUT /auth/me/pins/:projectId */
let t: TestApp;
let project: Project;
let owner: Session;
let member: Session;
let guest: Session;

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

const put = (s: Session, pid: string, ids: unknown) =>
  s.req('PUT', `/auth/me/pins/${pid}`, { ids });

describe('pins', () => {
  it('starts empty; unauthenticated → 401', async () => {
    expect((await owner.req('GET', '/auth/me/pins')).json<MyPins>()).toEqual({});
    const anon = await t.app.inject({ method: 'GET', url: '/api/v1/auth/me/pins' });
    expect(anon.statusCode).toBe(401);
  });

  it('PUT replaces the list (deduped, order kept); each user has their own', async () => {
    const res = await put(owner, project.id, ['thr_b', 'thr_a', 'thr_b']);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ projectId: project.id, ids: ['thr_b', 'thr_a'] });
    expect((await owner.req('GET', '/auth/me/pins')).json<MyPins>()).toEqual({
      [project.id]: ['thr_b', 'thr_a'],
    });
    // 再 PUT 整组替换
    await put(owner, project.id, ['thr_c']);
    expect((await owner.req('GET', '/auth/me/pins')).json<MyPins>()).toEqual({
      [project.id]: ['thr_c'],
    });
    // 别人的置顶互不影响；访客也能置顶
    expect((await member.req('GET', '/auth/me/pins')).json<MyPins>()).toEqual({});
    expect((await put(guest, project.id, ['thr_x'])).statusCode).toBe(200);
    expect((await guest.req('GET', '/auth/me/pins')).json<MyPins>()).toEqual({
      [project.id]: ['thr_x'],
    });
    // 清空后不再出现在结果里
    await put(guest, project.id, []);
    expect((await guest.req('GET', '/auth/me/pins')).json<MyPins>()).toEqual({});
  });

  it('validation: not an array / too many / empty id → 422', async () => {
    expect((await put(owner, project.id, 'thr_a')).statusCode).toBe(422);
    expect((await put(owner, project.id, [''])).statusCode).toBe(422);
    const many = Array.from({ length: 51 }, (_, i) => `thr_${i}`);
    expect((await put(owner, project.id, many)).statusCode).toBe(422);
  });

  it('non-member → 404; pins of projects you left disappear', async () => {
    const outsider = await signup(t.app, '外人');
    expect((await put(outsider, project.id, ['thr_a'])).statusCode).toBe(404);
    await put(member, project.id, ['thr_m']);
    const del = await owner.req('DELETE', `/projects/${project.id}/members/${member.user.id}`);
    expect(del.statusCode).toBe(204);
    expect((await member.req('GET', '/auth/me/pins')).json<MyPins>()).toEqual({});
  });
});
