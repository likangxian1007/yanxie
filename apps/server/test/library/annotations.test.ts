import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { newId, ulid, type PaperAnnotation, type Paper, type AnyProjectEvent } from '@srh/shared';
import { files, paperAnnotations, papers, projectMembers } from '../../src/db/schema';
import { withLiveDocument, liveDocument, documentConnections } from '../../src/realtime/collab';
import { toPaper } from '../../src/modules/library/service';
import { libraryDiskPath } from '../../src/modules/library/storage';
import { makeApp, setupProject, signup, type Session, type TestApp } from '../helpers';
import { tinyPdf } from './util';

let t: TestApp, owner: Session, member: Session, guest: Session, outsider: Session;
let pid: string, url: string;
const events: AnyProjectEvent[] = [];
beforeAll(async () => {
  t = await makeApp();
  const group = await setupProject(t.app, ['member', 'guest']);
  owner = group.owner;
  [member, guest] = group.others as [Session, Session];
  pid = group.project.id;
  outsider = await signup(t.app);
  t.app.ctx.bus.onEvent((e) => events.push(e));
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  url = `ws://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/collab`;
}, 60000);
afterAll(async () => {
  await t?.close();
});
const actor = (who = owner) => ({ kind: 'user' as const, id: who.user.id, name: who.user.name });
async function seed(team = false) {
  const id = `ppr_${ulid()}`,
    fileId = newId('file');
  const scope = team ? pid : { kind: 'personal' as const, ownerUserId: owner.user.id };
  const ownership = team ? { projectId: pid } : { ownerUserId: owner.user.id };
  const bytes = tinyPdf([[{ x: 72, y: 720, size: 12, text: `Evidence ${id}` }]]);
  const path = `library/${fileId}/test.pdf`;
  const disk = libraryDiskPath(t.app.ctx, scope, path);
  await mkdir(dirname(disk), { recursive: true });
  await writeFile(disk, bytes);
  await t.db.db.insert(files).values({
    id: fileId,
    ...ownership,
    name: 'test.pdf',
    path,
    mime: 'application/pdf',
    size: bytes.length,
    uploadedBy: actor(),
  });
  const [row] = await t.db.db
    .insert(papers)
    .values({
      id,
      ...ownership,
      title: '标注测试论文',
      citekey: `evidence${ulid()}`,
      source: 'upload',
      status: 'ready',
      fileId,
      pdfSha256: createHash('sha256').update(bytes).digest('hex'),
      pageCount: 1,
      createdBy: actor(),
    })
    .returning();
  return toPaper(row!);
}
const path = (p: Paper) =>
  `${p.projectId ? `/projects/${p.projectId}` : ''}/library/papers/${p.id}/annotations`;
const draft = (p: Paper, kind: 'comment' | 'highlight' = 'comment') => ({
  kind,
  fileId: p.fileId!,
  page: 1,
  quote: 'scientific evidence',
  boxes: [{ page: 1, x: 72, y: 60, w: 108, h: 14 }],
  body: kind === 'comment' ? '初始批注' : '',
});
async function create(
  p: Paper,
  kind: 'comment' | 'highlight' = 'comment',
  who = owner,
  body?: string,
) {
  const r = await who.req('POST', path(p), {
    ...draft(p, kind),
    ...(body === undefined ? {} : { body }),
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<PaperAnnotation>();
}
async function read(p: Paper, who = owner, deleted = false) {
  const r = await who.req('GET', path(p) + (deleted ? '?includeDeleted=true' : ''));
  expect(r.statusCode, r.body).toBe(200);
  return r.json<PaperAnnotation[]>();
}
describe('L06 说明稿与 L10 标注追加', () => {
  it.each(['highlight', 'comment'] as const)(
    '从 %s 制作独立个人说明稿，保留来源且不公开其他批注',
    async (kind) => {
      const p = await seed(),
        a = await create(p, kind);
      await create(p, 'comment', owner, 'UNSELECTED_SECRET');
      const endpoint = `${path(p)}/${a.id}/brief`,
        body = { title: '团队说明', sourceVersion: a.version };
      const result = await owner.req('POST', endpoint, body);
      expect(result.statusCode, result.body).toBe(201);
      expect(result.json()).toMatchObject({ kind: 'brief', paperId: p.id });
      expect(result.json().body).toContain(a.quote);
      expect(result.json().body).toContain('第 1 页');
      expect(result.body).not.toContain('UNSELECTED_SECRET');
      expect((await member.req('GET', `/library/papers/${p.id}/notes`)).statusCode).toBe(404);
      expect((await member.req('POST', endpoint, body)).statusCode).toBe(404);
      expect((await owner.req('POST', endpoint, { ...body, sourceVersion: 999 })).statusCode).toBe(
        409,
      );
    },
  );
  it('相同 PDF 可追加标注，版本不一致则整次回滚且不替换项目 PDF', async () => {
    const p = await seed(),
      a = await create(p, 'highlight');
    const target = (
      await owner.req('POST', `/library/papers/${p.id}/publish`, {
        projectId: pid,
        requestId: randomUUID(),
        sourceUpdatedAt: p.updatedAt,
      })
    ).json().paper as Paper;
    const body = {
      projectId: pid,
      requestId: randomUUID(),
      sourceUpdatedAt: p.updatedAt,
      targetPaperId: target.id,
      targetUpdatedAt: target.updatedAt,
      annotations: [{ id: a.id, version: a.version }],
    };
    const r = await owner.req('POST', `/library/papers/${p.id}/publish`, body);
    expect(r.statusCode, r.body).toBe(201);
    expect((await read(target))[0]!.fileId).toBe(target.fileId);
    const b = await create(p, 'comment');
    await t.db.db.update(papers).set({ pdfSha256: 'different' }).where(eq(papers.id, target.id));
    const failed = await owner.req('POST', `/library/papers/${p.id}/publish`, {
      ...body,
      requestId: randomUUID(),
      annotations: [{ id: b.id, version: b.version }],
    });
    expect(failed.statusCode).toBe(409);
    expect(failed.body).toContain('PDF 版本不一致');
    expect(await read(target)).toHaveLength(1);
    expect(
      (await owner.req('GET', `/projects/${pid}/library/papers/${target.id}`)).json().fileId,
    ).toBe(target.fileId);
  });
});
async function edit(id: string, text: string, who = owner) {
  await withLiveDocument(t.app.ctx, id, actor(who), (d) => {
    const b = d.getText('body');
    b.delete(0, b.length);
    b.insert(0, text);
  });
}
function connect(id: string, session: Session) {
  class CookieSocket extends WebSocket {
    constructor(address: string | URL) {
      super(address, { headers: { cookie: session.cookie } });
    }
  }
  const doc = new Y.Doc();
  const socket = new HocuspocusProviderWebsocket({
    url: `${url}/${id}`,
    WebSocketPolyfill: CookieSocket,
  } as ConstructorParameters<typeof HocuspocusProviderWebsocket>[0]);
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: id,
    document: doc,
    token: 'cookie',
  });
  provider.attach();
  return {
    doc,
    socket,
    provider,
    close() {
      provider.destroy();
      socket.destroy();
      doc.destroy();
    },
  };
}
const wait = (check: () => boolean) =>
  vi.waitFor(() => expect(check()).toBe(true), { timeout: 7000, interval: 30 });
const publish = (p: Paper, selected: PaperAnnotation[]) => ({
  projectId: pid,
  requestId: randomUUID(),
  sourceUpdatedAt: p.updatedAt,
  annotations: selected.map((a) => ({ id: a.id, version: a.version })),
});

describe('L04 私人标注', () => {
  it('持久保存原文、位置、颜色；私人数据与事件隔离，输入和访问受保护', async () => {
    const p = await seed(),
      before = events.length;
    const a = await create(p, 'highlight'),
      b = await create(p);
    expect(a).toMatchObject({
      anchorStatus: 'current',
      body: '',
      version: 1,
      metadataVersion: 1,
      quote: draft(p).quote,
      boxes: draft(p).boxes,
    });
    expect(await read(p)).toHaveLength(2);
    expect((await read(p))[1]!.body).toBe(b.body);
    expect(events).toHaveLength(before);
    expect((await member.req('GET', path(p))).statusCode).toBe(404);
    expect((await member.req('POST', path(p), draft(p))).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1' + path(p) })).statusCode).toBe(401);
    for (const invalid of [
      { quote: '' },
      { body: 'x'.repeat(100001) },
      { boxes: [] },
      { page: 2 },
      { boxes: [{ page: 1, x: -1, y: 0, w: 1, h: 1 }] },
      { boxes: [{ page: 2, x: 1, y: 1, w: 1, h: 1 }] },
      { kind: 'highlight', body: '偷偷附带批注' },
      { unexpected: true },
    ]) {
      expect((await owner.req('POST', path(p), { ...draft(p), ...invalid })).statusCode).toBe(422);
    }
    expect(
      (await owner.req('POST', path(p), { ...draft(p), fileId: 'fil_wrong' })).statusCode,
    ).toBe(409);
    const ws = await t.app.injectWS(`/collab/${b.id}`, { headers: { cookie: member.cookie } });
    expect(await new Promise((resolve) => ws.on('close', resolve))).toBe(4404);
    const changed = await owner.req('PATCH', `${path(p)}/${a.id}`, {
      color: 'green',
      label: '待复核',
      baseMetadataVersion: 1,
    });
    expect(changed.statusCode).toBe(200);
    expect((await read(p))[0]).toMatchObject({
      color: 'green',
      label: '待复核',
      metadataVersion: 2,
      boxes: a.boxes,
    });
  });
  it('文件身份变化保留记录但标记定位待确认，禁止把旧位置发布到新 PDF', async () => {
    const p = await seed(),
      a = await create(p);
    await t.db.db.update(papers).set({ pdfSha256: 'changed-content' }).where(eq(papers.id, p.id));
    expect((await read(p))[0]).toMatchObject({ id: a.id, anchorStatus: 'mismatch', body: a.body });
    const r = await owner.req('POST', `/library/papers/${p.id}/publish`, publish(p, [a]));
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.message).toContain('PDF');
  });
});

describe('L08 选择发布标注', () => {
  it.each(['highlight', 'comment'] as const)(
    '只选 %s 时不泄露其他记录/旧正文；团队副本独立且重试安全',
    async (kind) => {
      const p = await seed(),
        highlight = await create(p, 'highlight'),
        comment = await create(p, 'comment', owner, 'SECRET_DELETED_HISTORY');
      const omitted = await create(p, 'comment', owner, 'SECRET_PRIVATE_COMMENT');
      await edit(comment.id, '可以公开的解释');
      const chosen = (await read(p)).find(
        (a) => a.id === (kind === 'comment' ? comment.id : highlight.id),
      )!;
      const before = events.length;
      const input = publish(p, [chosen]);
      const r = await owner.req('POST', `/library/papers/${p.id}/publish`, input);
      expect(r.statusCode, r.body).toBe(201);
      const copy = r.json().paper as Paper;
      const rows = await read(copy, member);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind,
        quote: chosen.quote,
        boxes: chosen.boxes,
        body: chosen.body,
        anchorStatus: 'current',
        fileId: copy.fileId,
        publishedFrom: { author: actor(), publishedBy: actor(), sourceVersion: chosen.version },
      });
      expect(rows[0]!.fileId).not.toBe(p.fileId);
      expect(rows[0]!.id).not.toBe(chosen.id);
      expect(JSON.stringify(rows)).not.toContain(omitted.id);
      expect(JSON.stringify(rows)).not.toContain(chosen.id);
      expect(JSON.stringify(events.slice(before))).not.toContain(p.id);
      const [stored] = await t.db.db
        .select()
        .from(paperAnnotations)
        .where(eq(paperAnnotations.id, rows[0]!.id));
      expect(Buffer.from(stored!.ydocState).toString()).not.toContain('SECRET');
      if (kind === 'comment') {
        await edit(rows[0]!.id, '团队编辑', member);
        expect((await read(p)).find((a) => a.id === comment.id)?.body).toBe('可以公开的解释');
      }
      expect(
        (await owner.req('POST', `/library/papers/${p.id}/publish`, input)).json().replayed,
      ).toBe(true);
      expect(
        (await owner.req('POST', `/library/papers/${p.id}/publish`, { ...input, annotations: [] }))
          .statusCode,
      ).toBe(409);
      await owner.req('DELETE', `/library/papers/${p.id}`);
      expect(await read(copy, guest)).toHaveLength(1);
      expect(
        (await owner.req('POST', `/library/papers/${p.id}/publish`, input)).json().replayed,
      ).toBe(true);
    },
  );
  it('过期预览、跨论文和已删除标注拒绝发布，不残留团队数据或文件', async () => {
    const p = await seed(),
      a = await create(p),
      other = await seed(),
      otherA = await create(other);
    const beforeFiles = await t.db.db.select().from(files).where(eq(files.projectId, pid));
    const teamDir = dirname(libraryDiskPath(t.app.ctx, pid, 'library/placeholder'));
    const beforeDisk = await readdir(teamDir, { recursive: true }).catch(() => []);
    await edit(a.id, '预览后改变了');
    expect(
      (await owner.req('POST', `/library/papers/${p.id}/publish`, publish(p, [a]))).statusCode,
    ).toBe(409);
    expect(
      (await owner.req('POST', `/library/papers/${p.id}/publish`, publish(p, [otherA]))).statusCode,
    ).toBe(404);
    const latest = (await read(p))[0]!;
    expect(
      (await owner.req('POST', `${path(p)}/${a.id}/trash`, { baseVersion: latest.version }))
        .statusCode,
    ).toBe(204);
    expect(
      (await owner.req('POST', `/library/papers/${p.id}/publish`, publish(p, [latest]))).statusCode,
    ).toBe(404);
    expect(
      await t.db.db
        .select()
        .from(papers)
        .where(and(eq(papers.projectId, pid), eq(papers.citekey, p.citekey))),
    ).toHaveLength(0);
    expect(await t.db.db.select().from(files).where(eq(files.projectId, pid))).toEqual(beforeFiles);
    expect(await readdir(teamDir, { recursive: true }).catch(() => [])).toEqual(beforeDisk);
  });
});

describe('L13 团队维护与真实协作连接', () => {
  it('论文删除准备期间新建的批注连接也必须关闭', async () => {
    const p = await seed(true);
    const original = t.db.db.transaction.bind(t.db.db);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;
    const spy = vi.spyOn(t.db.db, 'transaction').mockImplementation(async (callback, config) => {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return original(callback, config);
    });
    const deleting = owner.req('DELETE', `/projects/${pid}/library/papers/${p.id}`);
    let client: ReturnType<typeof connect> | undefined;
    try {
      await started;
      const added = await create(p, 'comment', member);
      client = connect(added.id, member);
      await wait(() => client!.provider.isSynced);
      release();
      expect((await deleting).statusCode).toBe(204);
      expect(documentConnections(t.app.ctx, added.id)).toHaveLength(0);
    } finally {
      release();
      await deleting;
      spy.mockRestore();
      client?.close();
    }
  });
  it('访客可新增修改；正文变化不阻塞颜色修改，但同字段过期更新拒绝', async () => {
    const p = await seed(true),
      a = await create(p, 'comment', guest);
    await edit(a.id, '共同编辑正文', member);
    const r = await guest.req('PATCH', `${path(p)}/${a.id}`, {
      color: 'blue',
      label: '共同核对',
      baseMetadataVersion: 1,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      body: '共同编辑正文',
      metadataVersion: 2,
      updatedBy: actor(guest),
    });
    const stale = await owner.req('PATCH', `${path(p)}/${a.id}`, {
      color: 'pink',
      label: '过期修改',
      baseMetadataVersion: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.details.current.color).toBe('blue');
    expect((await outsider.req('GET', path(p))).statusCode).toBe(404);
    expect(
      events.some((e) => e.type === 'paper.annotations.changed' && e.payload.annotationId === a.id),
    ).toBe(true);
    await t.db.db.update(papers).set({ archivedAt: new Date() }).where(eq(papers.id, p.id));
    expect((await owner.req('POST', path(p), draft(p))).statusCode).toBe(409);
    expect(
      (
        await guest.req('PATCH', `${path(p)}/${a.id}`, {
          color: 'pink',
          label: '不能改',
          baseMetadataVersion: 2,
        })
      ).statusCode,
    ).toBe(409);
  });
  it('两个账号同时编辑同一句、离线恢复都合并；刷新连接读到已保存正文', async () => {
    const p = await seed(true),
      row = await create(p);
    const a = connect(row.id, owner),
      b = connect(row.id, guest);
    try {
      await wait(() => a.provider.isSynced && b.provider.isSynced);
      a.doc.getText('body').insert(2, '甲');
      b.doc.getText('body').insert(2, '乙');
      await wait(
        () =>
          a.doc.getText('body').toString() === b.doc.getText('body').toString() &&
          a.provider.unsyncedChanges === 0 &&
          b.provider.unsyncedChanges === 0,
      );
      expect(a.doc.getText('body').toString()).toContain('甲');
      expect(a.doc.getText('body').toString()).toContain('乙');
      a.socket.disconnect();
      await wait(() => a.socket.status !== 'connected');
      a.doc.getText('body').insert(0, '离线');
      b.doc.getText('body').insert(0, '在线');
      void a.socket.connect();
      await wait(
        () =>
          a.doc.getText('body').toString() === b.doc.getText('body').toString() &&
          b.doc.getText('body').toString().includes('离线') &&
          a.provider.unsyncedChanges === 0 &&
          b.provider.unsyncedChanges === 0,
      );
      const r = await guest.req('POST', `${path(p)}/${row.id}/flush`);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().body).toBe(a.doc.getText('body').toString());
      const c = connect(row.id, member);
      try {
        await wait(() => c.provider.isSynced);
        expect(c.doc.getText('body').toString()).toBe(r.json().body);
      } finally {
        c.close();
      }
    } finally {
      a.close();
      b.close();
    }
  });
  it('删除前核对最新版本；迟到编辑不能复活，恢复生成独立新记录', async () => {
    const p = await seed(true),
      row = await create(p, 'comment', owner, 'SECRET_OLD_TEXT');
    await edit(row.id, '删除前的最终正文');
    expect(
      (await owner.req('POST', `${path(p)}/${row.id}/trash`, { baseVersion: row.version }))
        .statusCode,
    ).toBe(409);
    const a = connect(row.id, owner),
      b = connect(row.id, member);
    try {
      await wait(() => a.provider.isSynced && b.provider.isSynced);
      const saved = (await owner.req('POST', `${path(p)}/${row.id}/flush`)).json<PaperAnnotation>();
      const live = liveDocument(t.app.ctx, row.id)!;
      expect(
        (await guest.req('POST', `${path(p)}/${row.id}/trash`, { baseVersion: saved.version }))
          .statusCode,
      ).toBe(204);
      live.getText('body').insert(0, '迟到的编辑');
      await wait(() => documentConnections(t.app.ctx, row.id).length === 0);
      expect(await read(p)).toHaveLength(0);
      expect((await owner.req('POST', `${path(p)}/${row.id}/flush`)).statusCode).toBe(404);
      const deleted = (await read(p, owner, true))[0]!;
      expect(deleted.body).toBe('删除前的最终正文');
      const r = await member.req('POST', `${path(p)}/${row.id}/restore`, {
        baseVersion: deleted.version,
      });
      expect(r.statusCode, r.body).toBe(200);
      const restored = r.json<PaperAnnotation>();
      expect(restored.id).not.toBe(row.id);
      expect(restored).toMatchObject({
        deletedAt: null,
        body: deleted.body,
        quote: row.quote,
        boxes: row.boxes,
      });
      const [stored] = await t.db.db
        .select()
        .from(paperAnnotations)
        .where(eq(paperAnnotations.id, restored.id));
      expect(Buffer.from(stored!.ydocState).toString()).not.toContain('SECRET');
      expect(
        (
          await member.req('POST', `${path(p)}/${row.id}/restore`, { baseVersion: deleted.version })
        ).json().id,
      ).toBe(restored.id);
      expect(await read(p)).toHaveLength(1);
    } finally {
      a.close();
      b.close();
    }
  });
  it('移出成员立即关闭连接，之后迟到更新不保存；论文删除关闭批注连接', async () => {
    const p = await seed(true),
      row = await create(p),
      c = connect(row.id, member);
    try {
      await wait(() => c.provider.isSynced);
      expect(
        (await owner.req('DELETE', `/projects/${pid}/members/${member.user.id}`)).statusCode,
      ).toBe(204);
      await wait(
        () => !documentConnections(t.app.ctx, row.id).some((x) => x.userId === member.user.id),
      );
      c.doc.getText('body').insert(0, '撤权后编辑');
      expect((await member.req('GET', path(p))).statusCode).toBe(404);
      expect((await member.req('POST', `${path(p)}/${row.id}/flush`)).statusCode).toBe(404);
      expect((await read(p))[0]!.body).not.toContain('撤权后');
    } finally {
      c.close();
      await t.db.db
        .insert(projectMembers)
        .values({ projectId: pid, userId: member.user.id, role: 'member' })
        .onConflictDoNothing();
    }
    const d = connect(row.id, owner);
    try {
      await wait(() => d.provider.isSynced);
      expect(
        (await owner.req('DELETE', `/projects/${pid}/library/papers/${p.id}`)).statusCode,
      ).toBe(204);
      await wait(() => documentConnections(t.app.ctx, row.id).length === 0);
      expect(
        await t.db.db.select().from(paperAnnotations).where(eq(paperAnnotations.id, row.id)),
      ).toHaveLength(0);
    } finally {
      d.close();
    }
  });
});
