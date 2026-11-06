import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { newId, type FileObject, type OutputItem, type Page, type Project } from '@srh/shared';
import { makeApp, setupProject, signup, type Session, type TestApp } from './helpers';
import { outputs, threads } from '../src/db/schema';
import { normalizePath, readProjectFileText, writeProjectFile } from '../src/modules/files/service';

let t: TestApp;
let project: Project;
let owner: Session;
let member: Session;
let guest: Session;

beforeAll(async () => {
  t = await makeApp();
  const s = await setupProject(t.app);
  project = s.project;
  owner = s.owner;
  member = s.others[0]!;
  guest = s.others[2]!;
}, 60_000);

afterAll(async () => {
  await t?.close();
});

const base = () => `/projects/${project.id}/files`;

/** 手工拼 multipart/form-data */
function multipartBody(
  fields: Record<string, string>,
  file?: { name: string; type: string; data: Buffer | string },
) {
  const boundary = `----srhtest${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
      ),
    );
    chunks.push(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function upload(
  s: Session,
  fields: Record<string, string>,
  file?: { name: string; type: string; data: Buffer | string },
) {
  const { payload, contentType } = multipartBody(fields, file);
  return t.app.inject({
    method: 'POST',
    url: `/api/v1${base()}`,
    headers: { cookie: s.cookie, 'content-type': contentType },
    payload,
  });
}

describe('normalizePath', () => {
  it('normalizes and rejects traversal', () => {
    expect(normalizePath('\\data\\raw\\a.csv')).toBe('data/raw/a.csv');
    expect(normalizePath('./a/./b.txt')).toBe('a/b.txt');
    for (const bad of [
      '../x',
      'a/../../x',
      'C:/x',
      'c:\\x',
      '',
      '/',
      'a//b',
      'a\0b',
      'x'.repeat(301),
    ]) {
      expect(() => normalizePath(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('rejects names that break on Windows (reserved chars, trailing dot/space, device names)', () => {
    for (const bad of [
      'ads.txt:stream',
      '<img src=x onerror=alert(1)>.txt',
      'a/b|c.txt',
      'q?.txt',
      'star*.txt',
      'say"hi".txt',
      'trail.txt.',
      'dir./a.txt',
      'dir /a.txt',
      'a/b ./c.txt',
      'a\tb.txt',
      'a\nb.txt',
      'CON',
      'con.txt',
      'data/Nul.csv',
      'COM1.log',
      'lpt9',
      'aux.tar.gz',
    ]) {
      expect(() => normalizePath(bad), JSON.stringify(bad)).toThrow(/文件路径不合法/u);
    }
    for (const ok of ['console.txt', 'com10.txt', 'lpt0', 'auxiliary/a.md', 'a b/c d.txt']) {
      expect(normalizePath(ok), ok).toBe(ok);
    }
  });
});

describe('files REST', () => {
  let first: FileObject;

  it('uploads multipart to uploads/<name> (201 + file.created)', async () => {
    const res = await upload(
      member,
      {},
      { name: '实验 记录.csv', type: 'text/csv', data: 'a,b\n1,2\n' },
    );
    expect(res.statusCode).toBe(201);
    first = res.json<FileObject>();
    expect(first).toMatchObject({
      path: 'uploads/实验 记录.csv',
      name: '实验 记录.csv',
      mime: 'text/csv',
      size: 8,
      uploadedBy: { kind: 'user', id: member.user.id },
    });
    expect(existsSync(resolve(t.config.STORAGE_DIR, project.id, 'uploads/实验 记录.csv'))).toBe(
      true,
    );
    const evs = await t.app.ctx.bus.listSince(project.id, 0, 1000);
    expect(evs.some((e) => e.type === 'file.created' && e.payload.id === first.id)).toBe(true);
  });

  it('same default path gets a (1) suffix instead of overwriting', async () => {
    const res = await upload(member, {}, { name: '实验 记录.csv', type: 'text/csv', data: 'x' });
    expect(res.statusCode).toBe(201);
    expect(res.json<FileObject>().path).toBe('uploads/实验 记录 (1).csv');
  });

  it('explicit path (field after file) overwrites → file.updated', async () => {
    const { payload, contentType } = multipartBody(
      {},
      { name: 'n.md', type: 'text/plain', data: '# v1' },
    );
    // path 字段放在 file 之后
    const tail = Buffer.from(
      payload.toString('latin1').replace(/--([^\r\n]+)--\r\n$/u, ''),
      'latin1',
    );
    const boundary = contentType.split('boundary=')[1]!;
    const body = Buffer.concat([
      tail,
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\nnotes/n.md\r\n--${boundary}--\r\n`,
      ),
    ]);
    const res1 = await t.app.inject({
      method: 'POST',
      url: `/api/v1${base()}`,
      headers: { cookie: member.cookie, 'content-type': contentType },
      payload: body,
    });
    expect(res1.statusCode).toBe(201);
    const a = res1.json<FileObject>();
    expect(a).toMatchObject({ path: 'notes/n.md', mime: 'text/markdown' });
    const res2 = await upload(
      owner,
      { path: 'notes/n.md' },
      { name: 'whatever.md', type: 'text/markdown', data: '# v2!' },
    );
    expect(res2.statusCode).toBe(201);
    expect(res2.json<FileObject>()).toMatchObject({ id: a.id, size: 5 });
    const evs = await t.app.ctx.bus.listSince(project.id, 0, 1000);
    expect(evs.some((e) => e.type === 'file.updated' && e.payload.id === a.id)).toBe(true);
  });

  it('rejects path traversal, missing file, guest', async () => {
    const bad = await upload(
      member,
      { path: '../../evil.txt' },
      { name: 'e.txt', type: 'text/plain', data: 'x' },
    );
    expect(bad.statusCode).toBe(400);
    const bad2 = await upload(
      member,
      { path: 'C:\\evil.txt' },
      { name: 'e.txt', type: 'text/plain', data: 'x' },
    );
    expect(bad2.statusCode).toBe(400);
    expect(existsSync(resolve(t.config.STORAGE_DIR, 'evil.txt'))).toBe(false);
    const none = await upload(member, { path: 'a.txt' });
    expect(none.statusCode).toBe(400);
    const g = await upload(guest, {}, { name: 'g.txt', type: 'text/plain', data: 'x' });
    expect(g.statusCode).toBe(403);
    const json = await member.req('POST', base(), { path: 'a.txt' });
    expect(json.statusCode).toBe(400);
  });

  it('downloads inline and as attachment', async () => {
    const inline = await guest.req('GET', `${base()}/${first.id}`);
    expect(inline.statusCode).toBe(200);
    expect(inline.body).toBe('a,b\n1,2\n');
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1${base()}/${first.id}?download=1`,
      headers: { cookie: guest.cookie },
    });
    expect(res.headers['content-type']).toContain('text/csv');
    const cd = String(res.headers['content-disposition']);
    expect(cd.startsWith('attachment;')).toBe(true);
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent('实验 记录.csv')}`);
    const inl = await t.app.inject({
      method: 'GET',
      url: `/api/v1${base()}/${first.id}`,
      headers: { cookie: guest.cookie },
    });
    expect(String(inl.headers['content-disposition']).startsWith('inline;')).toBe(true);
    expect((await guest.req('GET', `${base()}/fil_nope`)).statusCode).toBe(404);
    const stranger = await signup(t.app, '路人');
    expect((await stranger.req('GET', `${base()}/${first.id}`)).statusCode).toBe(404);
  });

  it('lists by dir', async () => {
    const all = await guest.req('GET', base());
    const paths = all.json<FileObject[]>().map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths.length).toBeGreaterThanOrEqual(3);
    const notes = await guest.req('GET', `${base()}?dir=notes`);
    expect(notes.json<FileObject[]>().map((f) => f.path)).toEqual(['notes/n.md']);
    const notes2 = await guest.req('GET', `${base()}?dir=notes/`);
    expect(notes2.json<FileObject[]>()).toHaveLength(1);
    expect((await guest.req('GET', `${base()}?dir=../x`)).statusCode).toBe(400);
  });

  it('service: write string, read text, delete', async () => {
    const actor = { kind: 'agent' as const, id: 'agt_1', name: '研协' };
    const { file, created } = await writeProjectFile(
      t.app.ctx,
      actor,
      project.id,
      'drafts/a.md',
      '你好'.repeat(10),
    );
    expect(created).toBe(true);
    expect(file.mime).toBe('text/markdown');
    const full = await readProjectFileText(t.app.ctx, project.id, 'drafts/a.md');
    expect(full).toMatchObject({ text: '你好'.repeat(10), truncated: false });
    const cut = await readProjectFileText(t.app.ctx, project.id, file.id, 7);
    expect(cut.truncated).toBe(true);
    expect(cut.text).toBe('你好');
    const bin = await writeProjectFile(
      t.app.ctx,
      actor,
      project.id,
      'img/x.png',
      Buffer.from([0x89, 0x50]),
    );
    expect((await readProjectFileText(t.app.ctx, project.id, bin.file.id)).text).toBe('');
    await expect(readProjectFileText(t.app.ctx, project.id, 'nope.md')).rejects.toMatchObject({
      code: 'not_found',
    });

    expect((await guest.req('DELETE', `${base()}/${file.id}`)).statusCode).toBe(403);
    expect((await member.req('DELETE', `${base()}/${file.id}`)).statusCode).toBe(204);
    expect(existsSync(resolve(t.config.STORAGE_DIR, project.id, 'drafts/a.md'))).toBe(false);
    expect((await member.req('DELETE', `${base()}/${file.id}`)).statusCode).toBe(404);
    const evs = await t.app.ctx.bus.listSince(project.id, 0, 1000);
    expect(evs.some((e) => e.type === 'file.deleted' && e.payload.id === file.id)).toBe(true);
  });
});

describe('files: inline whitelist and security headers', () => {
  const get = (id: string, query = '') =>
    t.app.inject({
      method: 'GET',
      url: `/api/v1${base()}/${id}${query}`,
      headers: { cookie: member.cookie },
    });

  it('only images / pdf / plain text are inline; everything else is an attachment', async () => {
    const cases: { name: string; type: string; inline: boolean; contentType: string }[] = [
      { name: 'x.png', type: 'image/png', inline: true, contentType: 'image/png' },
      { name: 'x.pdf', type: 'application/pdf', inline: true, contentType: 'application/pdf' },
      { name: 'x.txt', type: 'text/plain', inline: true, contentType: 'text/plain; charset=utf-8' },
      {
        name: 'x.md',
        type: 'text/markdown',
        inline: true,
        contentType: 'text/plain; charset=utf-8',
      },
      { name: 'x.csv', type: 'text/csv', inline: true, contentType: 'text/plain; charset=utf-8' },
      { name: 'x.xsl', type: 'text/xsl', inline: false, contentType: 'text/xsl; charset=utf-8' },
      {
        name: 'x.rss',
        type: 'application/rss+xml',
        inline: false,
        contentType: 'application/rss+xml',
      },
      { name: 'x.mht', type: 'multipart/related', inline: false, contentType: 'multipart/related' },
      { name: 'x.svg', type: 'image/svg+xml', inline: false, contentType: 'image/svg+xml' },
      { name: 'x.html', type: 'text/html', inline: false, contentType: 'text/html; charset=utf-8' },
      { name: 'x.json', type: 'application/json', inline: false, contentType: 'application/json' },
    ];
    for (const c of cases) {
      const up = await upload(
        member,
        { path: `sec/${c.name}` },
        { name: c.name, type: c.type, data: '<script>alert(1)</script>' },
      );
      expect(up.statusCode, c.name).toBe(201);
      const res = await get(up.json<FileObject>().id);
      expect(res.statusCode, c.name).toBe(200);
      const cd = String(res.headers['content-disposition']);
      expect(cd.startsWith(c.inline ? 'inline;' : 'attachment;'), `${c.name} ${cd}`).toBe(true);
      expect(String(res.headers['content-type']), c.name).toContain(c.contentType);
      expect(res.headers['x-content-type-options'], c.name).toBe('nosniff');
      if (c.name === 'x.pdf') {
        // Chrome 的 PDF 查看器在 sandbox 文档里无法显示，内联 PDF 不加 sandbox
        expect(res.headers['content-security-policy'], c.name).toBeUndefined();
        const dl = await get(up.json<FileObject>().id, '?download=1');
        expect(dl.headers['content-security-policy']).toBe('sandbox');
      } else {
        expect(res.headers['content-security-policy'], c.name).toBe('sandbox');
      }
    }
  });
});

describe('files: Windows-safe and case-insensitive paths', () => {
  it('explicit paths with reserved characters / names → 400, nothing written', async () => {
    for (const path of [
      'ads.txt:stream',
      '<img src=x onerror=alert(1)>.txt',
      'trail.txt.',
      'nul.txt',
    ]) {
      const res = await upload(member, { path }, { name: 'a.txt', type: 'text/plain', data: 'x' });
      expect(res.statusCode, path).toBe(400);
      expect(res.json(), path).toMatchObject({ error: { code: 'bad_request' } });
    }
  });

  it('default upload path sanitizes the file name instead of failing', async () => {
    const res = await upload(
      member,
      {},
      { name: '<img src=x onerror=alert(1)>.txt', type: 'text/plain', data: 'x' },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json<FileObject>().path).toBe('uploads/_img src=x onerror=alert(1)_.txt');
    const dev = await upload(member, {}, { name: 'CON.txt.', type: 'text/plain', data: 'x' });
    expect(dev.statusCode).toBe(201);
    expect(dev.json<FileObject>().path).toBe('uploads/_CON.txt');
  });

  it('a path differing only in case is the same file (overwritten in place)', async () => {
    const a = await upload(
      member,
      { path: 'case/Case.txt' },
      { name: 'a.txt', type: 'text/plain', data: 'UPPER' },
    );
    expect(a.statusCode).toBe(201);
    const first = a.json<FileObject>();
    const b = await upload(
      owner,
      { path: 'CASE/case.TXT' },
      { name: 'b.txt', type: 'text/plain', data: 'lower!' },
    );
    expect(b.statusCode).toBe(201);
    expect(b.json<FileObject>()).toMatchObject({ id: first.id, path: 'case/Case.txt', size: 6 });
    const all = (await member.req('GET', base())).json<FileObject[]>();
    expect(all.filter((f) => f.path.toLowerCase() === 'case/case.txt')).toHaveLength(1);
    const body = await member.req('GET', `${base()}/${first.id}`);
    expect(body.body).toBe('lower!');
    const read = await readProjectFileText(t.app.ctx, project.id, 'CASE/CASE.TXT');
    expect(read).toMatchObject({ file: { id: first.id }, text: 'lower!' });

    // 默认路径的 (1) 后缀也按不区分大小写判断
    const u1 = await upload(member, {}, { name: 'Report.md', type: 'text/markdown', data: '1' });
    expect(u1.json<FileObject>().path).toBe('uploads/Report.md');
    const u2 = await upload(member, {}, { name: 'report.MD', type: 'text/markdown', data: '2' });
    expect(u2.json<FileObject>().path).toBe('uploads/report (1).MD');
  });
});

describe('outputs', () => {
  it('paginates newest first and hides other people’s personal threads', async () => {
    const db = t.db.db;
    const personal = newId('thread');
    await db.insert(threads).values({
      id: personal,
      projectId: project.id,
      kind: 'personal',
      rootMessageId: newId('message'),
      title: '私聊',
      ownerUserId: owner.user.id,
    });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = newId('output', Date.now() + i);
      ids.push(id);
      await db.insert(outputs).values({
        id,
        projectId: project.id,
        threadId: null,
        kind: i % 2 ? 'link' : 'file',
        ref: `ref_${i}`,
        title: `产出 ${i}`,
      });
    }
    const privateId = newId('output', Date.now() + 10);
    await db.insert(outputs).values({
      id: privateId,
      projectId: project.id,
      threadId: personal,
      kind: 'document',
      ref: 'doc_private',
      title: '私有',
    });

    const p1 = (await member.req('GET', `/projects/${project.id}/outputs?limit=2`)).json<
      Page<OutputItem>
    >();
    expect(p1.items.map((o) => o.id)).toEqual([ids[4], ids[3]]);
    expect(p1.items[0]).toMatchObject({
      threadId: null,
      messageId: null,
      kind: 'file',
      title: '产出 4',
    });
    expect(p1.nextCursor).toBe(ids[3]);
    const p2 = (
      await member.req('GET', `/projects/${project.id}/outputs?limit=2&cursor=${p1.nextCursor}`)
    ).json<Page<OutputItem>>();
    expect(p2.items.map((o) => o.id)).toEqual([ids[2], ids[1]]);
    const p3 = (
      await member.req('GET', `/projects/${project.id}/outputs?limit=2&cursor=${p2.nextCursor}`)
    ).json<Page<OutputItem>>();
    expect(p3.items.map((o) => o.id)).toEqual([ids[0]]);
    expect(p3.nextCursor).toBeNull();

    const links = (await member.req('GET', `/projects/${project.id}/outputs?kind=link`)).json<
      Page<OutputItem>
    >();
    expect(links.items.map((o) => o.id)).toEqual([ids[3], ids[1]]);

    const mine = (await owner.req('GET', `/projects/${project.id}/outputs?limit=1`)).json<
      Page<OutputItem>
    >();
    expect(mine.items[0]?.id).toBe(privateId);
  });
});
