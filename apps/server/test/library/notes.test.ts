import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { ulid, type PaperNote, type Paper, type AnyProjectEvent } from '@srh/shared';
import { paperNotes, papers, projectMembers } from '../../src/db/schema';
import { withLiveDocument, liveDocument, documentConnections } from '../../src/realtime/collab';
import { toPaper } from '../../src/modules/library/service';
import { makeApp, setupProject, signup, type Session, type TestApp } from '../helpers';

let t: TestApp, owner: Session, member: Session, guest: Session, outsider: Session;
let pid: string, url: string;
const events: AnyProjectEvent[] = [];
beforeAll(async () => {
  t = await makeApp();
  const team = await setupProject(t.app, ['member', 'guest']);
  owner = team.owner;
  [member, guest] = team.others as [Session, Session];
  pid = team.project.id;
  outsider = await signup(t.app);
  t.app.ctx.bus.onEvent((e) => events.push(e));
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  url = `ws://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/collab`;
}, 60000);
afterAll(async () => {
  await t?.close();
});
async function seed(team = false) {
  const id = `ppr_${ulid()}`;
  const [p] = await t.db.db
    .insert(papers)
    .values({
      id,
      ...(team ? { projectId: pid } : { ownerUserId: owner.user.id }),
      title: '论文',
      citekey: id,
      source: 'doi',
      status: 'needs_pdf',
      note: '旧笔记仍保留',
      createdBy: { kind: 'user', id: owner.user.id, name: owner.user.name },
    })
    .returning();
  return toPaper(p!);
}
const path = (paper: Paper) =>
  `${paper.projectId ? `/projects/${paper.projectId}` : ''}/library/papers/${paper.id}/notes`;
async function create(p: Paper, body = '个人正文', who = owner) {
  const r = await who.req('POST', path(p), { title: '阅读笔记', body });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<PaperNote>();
}
async function read(p: Paper, who = owner) {
  const r = await who.req('GET', path(p));
  expect(r.statusCode, r.body).toBe(200);
  return r.json<PaperNote[]>();
}
const actor = () => ({ kind: 'user' as const, id: owner.user.id, name: owner.user.name });
async function edit(id: string, text: string) {
  await withLiveDocument(t.app.ctx, id, actor(), (d) => {
    const body = d.getText('body');
    body.delete(0, body.length);
    body.insert(0, text);
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

describe('L03 / L06 笔记隔离与说明稿', () => {
  it('创建多份笔记、输入校验、未登录和越权读取均受保护；私人事件不广播', async () => {
    const p = await seed();
    const before = events.length;
    const a = await create(p);
    const b = await create(p, '第二份');
    expect(a.id).not.toBe(b.id);
    expect(await read(p)).toHaveLength(2);
    expect((await member.req('GET', path(p))).statusCode).toBe(404);
    expect((await owner.req('POST', path(p), { title: '' })).statusCode).toBe(422);
    expect(
      (await owner.req('POST', path(p), { title: '越界', body: 'x'.repeat(100001) })).statusCode,
    ).toBe(422);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1' + path(p) })).statusCode).toBe(401);
    expect(events.length).toBe(before);
    expect((await owner.req('GET', `/library/papers/${p.id}`)).json().note).toBe('旧笔记仍保留');
    const socket = await t.app.injectWS(`/collab/${a.id}`, { headers: { cookie: member.cookie } });
    const code = await new Promise<number>((resolve) => socket.on('close', resolve));
    expect(code).toBe(4404);
  });
  it('团队说明稿复制当前正文且双方独立；标题更新做版本检查', async () => {
    const p = await seed(),
      n = await create(p);
    const r = await owner.req('POST', `${path(p)}/${n.id}/brief`, {
      title: '团队解释',
      sourceVersion: n.version,
    });
    expect(r.statusCode, r.body).toBe(201);
    const brief = r.json<PaperNote>();
    expect(brief).toMatchObject({ kind: 'brief', body: n.body });
    expect(brief.id).not.toBe(n.id);
    await edit(n.id, '原笔记新正文');
    expect((await read(p)).find((x) => x.id === brief.id)?.body).toBe(n.body);
    await edit(brief.id, '说明稿新正文');
    expect((await read(p)).find((x) => x.id === n.id)?.body).toBe('原笔记新正文');
    expect(
      (
        await owner.req('PATCH', `${path(p)}/${n.id}`, {
          title: '旧版本不能覆盖',
          baseVersion: n.version,
        })
      ).statusCode,
    ).toBe(409);
    const latest = (await read(p)).find((x) => x.id === n.id)!;
    expect(
      (
        await owner.req('PATCH', `${path(p)}/${n.id}`, {
          title: '新标题',
          baseVersion: latest.version,
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe('L08 选择发布', () => {
  it('只复制明确选择的当前正文和安全来源，团队 CRDT 不含私人历史；重试幂等', async () => {
    const p = await seed(),
      chosen = await create(p, 'SECRET_DELETED_HISTORY'),
      omitted = await create(p, 'SECRET_OMITTED');
    await edit(chosen.id, '可以公开的结论');
    const latest = (await read(p)).find((n) => n.id === chosen.id)!;
    const input = {
      projectId: pid,
      requestId: randomUUID(),
      sourceUpdatedAt: p.updatedAt,
      notes: [{ id: chosen.id, version: latest.version }],
    };
    const response = await owner.req('POST', `/library/papers/${p.id}/publish`, input);
    expect(response.statusCode, response.body).toBe(201);
    const copy = response.json().paper as Paper;
    const notes = await read(copy, member);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe(latest.body);
    expect(notes[0]!.id).not.toBe(chosen.id);
    expect(notes[0]!.publishedFrom).toMatchObject({
      sourceVersion: latest.version,
      author: actor(),
      publishedBy: actor(),
    });
    expect(JSON.stringify(notes)).not.toContain(chosen.id);
    expect(JSON.stringify(notes)).not.toContain(omitted.id);
    const [row] = await t.db.db.select().from(paperNotes).where(eq(paperNotes.id, notes[0]!.id));
    expect(Buffer.from(row!.ydocState).toString()).not.toContain('SECRET');
    await edit(notes[0]!.id, '团队单独修改');
    expect((await read(p)).find((n) => n.id === chosen.id)?.body).toBe(latest.body);
    expect(
      (await owner.req('POST', `/library/papers/${p.id}/publish`, input)).json().replayed,
    ).toBe(true);
    expect(
      (await owner.req('POST', `/library/papers/${p.id}/publish`, { ...input, notes: [] }))
        .statusCode,
    ).toBe(409);
    await owner.req('DELETE', `/library/papers/${p.id}`);
    expect((await read(copy, guest))[0]!.body).toBe('团队单独修改');
    expect(
      (await owner.req('POST', `/library/papers/${p.id}/publish`, input)).json().replayed,
    ).toBe(true);
  });
  it('预览后改变、跨论文混选、删除后发布都拒绝，事务没有残留团队论文', async () => {
    const p = await seed(),
      n = await create(p),
      other = await seed(),
      otherNote = await create(other);
    const input = {
      projectId: pid,
      requestId: randomUUID(),
      sourceUpdatedAt: p.updatedAt,
      notes: [{ id: n.id, version: n.version }],
    };
    await edit(n.id, '变了');
    expect((await owner.req('POST', `/library/papers/${p.id}/publish`, input)).statusCode).toBe(
      409,
    );
    expect(
      (
        await owner.req('POST', `/library/papers/${p.id}/publish`, {
          ...input,
          notes: [{ id: otherNote.id, version: 1 }],
        })
      ).statusCode,
    ).toBe(404);
    await owner.req('DELETE', `${path(p)}/${n.id}`);
    expect((await owner.req('POST', `/library/papers/${p.id}/publish`, input)).statusCode).toBe(
      404,
    );
    const rows = await t.db.db
      .select()
      .from(papers)
      .where(and(eq(papers.projectId, pid), eq(papers.citekey, p.citekey)));
    expect(rows).toHaveLength(0);
  });
});

describe('L12 真实协同通道', () => {
  it('两账号在同一段及不同位置编辑都合并；访客可写笔记，刷新重新连接读到持久正文', async () => {
    const p = await seed(true),
      n = await create(p, '共同研究', guest);
    const a = connect(n.id, owner),
      b = connect(n.id, guest);
    try {
      await wait(() => a.provider.isSynced && b.provider.isSynced);
      a.doc.getText('body').insert(2, '甲');
      b.doc.getText('body').insert(2, '乙');
      await wait(() => a.doc.getText('body').toString() === b.doc.getText('body').toString());
      expect(a.doc.getText('body').toString()).toContain('甲');
      expect(a.doc.getText('body').toString()).toContain('乙');
      a.doc.getText('body').insert(0, '开头');
      b.doc.getText('body').insert(b.doc.getText('body').length, '结尾');
      await wait(
        () =>
          a.doc.getText('body').toString() === b.doc.getText('body').toString() &&
          a.provider.unsyncedChanges === 0 &&
          b.provider.unsyncedChanges === 0,
      );
      const saved = await guest.req('POST', `${path(p)}/${n.id}/flush`);
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().body).toBe(a.doc.getText('body').toString());
      const c = connect(n.id, member);
      try {
        await wait(() => c.provider.isSynced);
        expect(c.doc.getText('body').toString()).toBe(saved.json().body);
      } finally {
        c.close();
      }
      expect(
        documentConnections(t.app.ctx, n.id).find((c) => c.userId === guest.user.id)?.readOnly,
      ).toBe(false);
    } finally {
      a.close();
      b.close();
    }
  });
  it('断线编辑恢复合并，删除后迟到保存不能复活', async () => {
    const p = await seed(true),
      n = await create(p, '起点');
    const a = connect(n.id, owner),
      b = connect(n.id, member);
    try {
      await wait(() => a.provider.isSynced && b.provider.isSynced);
      a.socket.disconnect();
      await wait(() => a.socket.status !== 'connected');
      a.doc.getText('body').insert(0, '离线');
      b.doc.getText('body').insert(2, '在线');
      void a.socket.connect();
      await wait(
        () =>
          a.provider.isSynced &&
          a.doc.getText('body').toString() === b.doc.getText('body').toString() &&
          b.doc.getText('body').toString().includes('离线'),
      );
      const live = liveDocument(t.app.ctx, n.id)!;
      expect((await owner.req('DELETE', `${path(p)}/${n.id}`)).statusCode).toBe(204);
      live.getText('body').insert(0, '迟到');
      expect(await read(p)).toHaveLength(0);
      expect((await member.req('POST', `${path(p)}/${n.id}/flush`)).statusCode).toBe(404);
      await wait(() => documentConnections(t.app.ctx, n.id).length === 0);
    } finally {
      a.close();
      b.close();
    }
  });
  it('成员移出后既有连接关闭，REST、重连与迟到提交均不能越权', async () => {
    const p = await seed(true),
      n = await create(p, '权限基线');
    const c = connect(n.id, member);
    try {
      await wait(() => c.provider.isSynced);
      await owner.req('DELETE', `/projects/${pid}/members/${member.user.id}`);
      await wait(
        () => !documentConnections(t.app.ctx, n.id).some((x) => x.userId === member.user.id),
      );
      c.doc.getText('body').insert(0, '不该提交');
      expect((await member.req('GET', path(p))).statusCode).toBe(404);
      expect((await read(p))[0]!.body).not.toContain('不该提交');
    } finally {
      c.close();
      await t.db.db
        .insert(projectMembers)
        .values({ projectId: pid, userId: member.user.id, role: 'member' })
        .onConflictDoNothing();
    }
    expect((await outsider.req('POST', path(p), { title: '越权' })).statusCode).toBe(404);
  });
});
