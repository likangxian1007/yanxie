import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MemoryFile, Project } from '@srh/shared';
import { makeApp, setupProject, signup, type Session, type TestApp } from './helpers';
import { readMemory, writeMemory } from '../src/modules/memory/service';

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
  await t?.close();
});

const base = () => `/projects/${project.id}/memory`;

describe('memory', () => {
  it('lists MEMORY.md created with the project', async () => {
    const res = await guest.req('GET', base());
    expect(res.statusCode).toBe(200);
    const list = res.json<Omit<MemoryFile, 'content'>[]>();
    expect(list[0]?.path).toBe('MEMORY.md');
    expect(list[0]).not.toHaveProperty('content');
  });

  it('creates, reads, updates with optimistic concurrency', async () => {
    const created = await owner.req('PUT', base(), {
      path: 'methods/baseline.md',
      content: '# 基线\nGCN',
      description: '基线方法',
      type: 'project',
      baseVersion: 0,
    });
    expect(created.statusCode).toBe(200);
    expect(created.json<MemoryFile>()).toMatchObject({ version: 1, path: 'methods/baseline.md' });

    const got = await member.req('GET', `${base()}/methods/baseline.md`);
    expect(got.statusCode).toBe(200);
    expect(got.json<MemoryFile>().content).toBe('# 基线\nGCN');

    // 再次以 baseVersion=0 新建 → 版本冲突，附带当前对象
    const dup = await owner.req('PUT', base(), {
      path: 'methods/baseline.md',
      content: 'x',
      baseVersion: 0,
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({
      error: { code: 'version_conflict', details: { current: { version: 1 } } },
    });

    const upd = await advisor.req('PUT', base(), {
      path: 'methods/baseline.md',
      content: '# 基线\nGAT',
      baseVersion: 1,
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json<MemoryFile>()).toMatchObject({
      version: 2,
      updatedBy: { kind: 'user', id: advisor.user.id },
    });

    const stale = await owner.req('PUT', base(), {
      path: 'methods/baseline.md',
      content: 'stale',
      baseVersion: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: {
        code: 'version_conflict',
        details: { current: { version: 2, content: '# 基线\nGAT' } },
      },
    });

    const missing = await owner.req('PUT', base(), {
      path: 'nope.md',
      content: 'x',
      baseVersion: 3,
    });
    expect(missing.statusCode).toBe(404);

    const events = await t.app.ctx.bus.listSince(project.id, 0, 1000);
    const mem = events.filter((e) => e.type === 'memory.updated');
    expect(mem.map((e) => (e.payload as MemoryFile).version)).toEqual([1, 2]);
  });

  it('enforces permissions', async () => {
    const body = { path: 'm.md', content: 'x', baseVersion: 0 };
    expect((await member.req('PUT', base(), body)).statusCode).toBe(403);
    expect((await guest.req('PUT', base(), body)).statusCode).toBe(403);
    const stranger = await signup(t.app, '路人');
    expect((await stranger.req('GET', base())).statusCode).toBe(404);
    expect((await stranger.req('PUT', base(), body)).statusCode).toBe(404);
  });

  it('rejects bad paths and missing files', async () => {
    for (const path of ['../x.md', 'a/../../x.md', '/abs.md', 'a//b.md', 'x.txt']) {
      const res = await owner.req('PUT', base(), { path, content: 'x', baseVersion: 0 });
      expect([400, 422]).toContain(res.statusCode);
    }
    expect((await owner.req('GET', `${base()}/none.md`)).statusCode).toBe(404);
  });

  it('deletes with baseVersion; MEMORY.md cannot be deleted', async () => {
    await owner.req('PUT', base(), { path: 'tmp/del.md', content: 'x', baseVersion: 0 });
    expect((await member.req('DELETE', `${base()}/tmp/del.md?baseVersion=1`)).statusCode).toBe(403);
    const stale = await owner.req('DELETE', `${base()}/tmp/del.md?baseVersion=5`);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'version_conflict' } });
    expect((await owner.req('DELETE', `${base()}/tmp/del.md?baseVersion=1`)).statusCode).toBe(204);
    expect((await owner.req('GET', `${base()}/tmp/del.md`)).statusCode).toBe(404);
    const idx = await owner.req('DELETE', `${base()}/MEMORY.md?baseVersion=1`);
    expect(idx.statusCode).toBe(409);
    expect(idx.json()).toMatchObject({ error: { code: 'conflict' } });
    const events = await t.app.ctx.bus.listSince(project.id, 0, 1000);
    expect(events.some((e) => e.type === 'memory.deleted' && e.payload.path === 'tmp/del.md')).toBe(
      true,
    );
  });

  it('agents write through the service', async () => {
    const actor = { kind: 'agent' as const, id: 'agt_x', name: '研协' };
    const f = await writeMemory(t.app.ctx, actor, project.id, {
      path: 'feedback/style.md',
      content: '少用被动句',
      description: '',
      type: 'feedback',
      baseVersion: 0,
    });
    expect(f.updatedBy).toEqual(actor);
    expect((await readMemory(t.app.ctx, project.id, 'feedback/style.md'))?.content).toBe(
      '少用被动句',
    );
    const list = await owner.req('GET', base());
    const paths = list.json<{ path: string }[]>().map((m) => m.path);
    expect(paths[0]).toBe('MEMORY.md');
    expect(paths.slice(1)).toEqual([...paths.slice(1)].sort());
  });
});
