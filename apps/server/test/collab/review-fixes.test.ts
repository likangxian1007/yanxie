import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { AddressInfo } from 'node:net';
import type {
  Board,
  Card,
  DocumentContent,
  DocumentMeta,
  ProjectMember,
  Review,
  Todo,
} from '@srh/shared';
import { collab } from '../../src/agents/tools/collab-port';
import {
  boards,
  documents,
  messages,
  projectMembers,
  reports,
  reviewParticipants,
  threads,
  todos,
} from '../../src/db/schema';
import { documentConnections } from '../../src/realtime/collab';
import { setupCollabApp, type CollabTestApp } from './helpers';

/**
 * 协作模块代码审阅发现的问题的回归测试（审阅结论、卡片并发、快照可见性、文档归档、
 * 关联校验、个人线程、个人待办、汇报拆待办 / 存为文档、访客看板、成员变更断开协同连接）。
 */

const P = 'prj_fix';
const OTHER = 'prj_fix_other';
const FRESH = 'prj_fix_fresh';
const base = `/api/v1/projects/${P}`;

let t: CollabTestApp;

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
async function req(user: string, method: Method, url: string, payload?: unknown) {
  return t.app.inject({
    method,
    url: url.startsWith('/api') ? url : `${base}${url}`,
    headers: t.as(user),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const waitFor = async (check: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('超时');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  t = await setupCollabApp();
  await t.seedUser('usr_o', '王老师');
  await t.seedUser('usr_a', '张三');
  await t.seedUser('usr_b', '李四');
  await t.seedUser('usr_g', '访客');
  await t.seedUser('usr_out', '路人');
  await t.seedProject(P, 'usr_o');
  await t.addMember(P, 'usr_a', 'member');
  await t.addMember(P, 'usr_b', 'member');
  await t.addMember(P, 'usr_g', 'guest');
  await t.seedProject(OTHER, 'usr_out');
  await t.seedProject(FRESH, 'usr_o');
  await t.addMember(FRESH, 'usr_g', 'guest');

  await t.db.db.insert(threads).values([
    { id: 'thr_pub', projectId: P, rootMessageId: 'msg_pub_root', title: '公共线程' },
    {
      id: 'thr_pa',
      projectId: P,
      kind: 'personal',
      ownerUserId: 'usr_a',
      rootMessageId: 'msg_pa_root',
      title: '张三的个人线程',
    },
    {
      id: 'thr_pb',
      projectId: P,
      kind: 'personal',
      ownerUserId: 'usr_b',
      rootMessageId: 'msg_pb_root',
      title: '李四的个人线程',
    },
    { id: 'thr_foreign', projectId: OTHER, rootMessageId: 'msg_f_root', title: '别的项目' },
  ]);
  const msg = (id: string, threadId: string | null, body: string, agentVisible = true) => ({
    id,
    projectId: P,
    threadId,
    authorKind: 'user' as const,
    authorId: 'usr_a',
    authorName: '张三',
    body,
    agentVisible,
  });
  await t.db.db
    .insert(messages)
    .values([
      msg('msg_fix_pub', 'thr_pub', '公共线程里的计划'),
      msg('msg_fix_side', 'thr_pub', '旁聊内容', false),
      msg('msg_fix_pa', 'thr_pa', '张三的私人笔记'),
      msg('msg_fix_timeline', null, '时间线上的消息'),
    ]);
  await t.db.db.insert(documents).values({
    id: 'doc_fix',
    projectId: P,
    title: '方法',
    contentText: '## 方法',
    createdBy: { kind: 'user', id: 'usr_a', name: '张三' },
  });
}, 60_000);

afterAll(async () => {
  await t?.close();
});

// ---------------------------------------------------------------- 1. 审阅结论

describe('审阅结论', () => {
  it('关闭后的审阅拒绝结论（409），审阅人的结论不变', async () => {
    const created = await req('usr_o', 'POST', '/reviews', {
      targetKind: 'document',
      targetId: 'doc_fix',
      title: '关闭后不能再给结论',
      reviewerIds: ['usr_a', 'usr_b'],
    });
    expect(created.statusCode, created.body).toBe(201);
    const review = created.json<Review>();
    expect((await req('usr_o', 'POST', `/reviews/${review.id}/close`)).statusCode).toBe(200);

    const res = await req('usr_a', 'POST', `/reviews/${review.id}/verdict`, { verdict: 'lgtm' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'conflict' } });
    const [me] = await t.db.db
      .select()
      .from(reviewParticipants)
      .where(
        and(eq(reviewParticipants.reviewId, review.id), eq(reviewParticipants.userId, 'usr_a')),
      );
    expect(me?.verdict).toBe('pending');
    const detail = await req('usr_o', 'GET', `/reviews/${review.id}`);
    expect(detail.json<Review>().status).toBe('closed');
  });

  it('两个审阅人同时给结论：最终状态按全部结论重算', async () => {
    const created = await req('usr_o', 'POST', '/reviews', {
      targetKind: 'document',
      targetId: 'doc_fix',
      title: '并发结论',
      reviewerIds: ['usr_a', 'usr_b'],
    });
    const review = created.json<Review>();
    const [ra, rb] = await Promise.all([
      req('usr_a', 'POST', `/reviews/${review.id}/verdict`, { verdict: 'lgtm' }),
      req('usr_b', 'POST', `/reviews/${review.id}/verdict`, { verdict: 'lgtm' }),
    ]);
    expect([ra.statusCode, rb.statusCode]).toEqual([200, 200]);
    const detail = await req('usr_o', 'GET', `/reviews/${review.id}`);
    expect(detail.json<Review>().status).toBe('approved');
  });
});

// ---------------------------------------------------------------- 3. 审阅快照的消息可见性

describe('审阅快照：消息', () => {
  const reviewMessage = (user: string, targetId: string) =>
    req(user, 'POST', '/reviews', {
      targetKind: 'message',
      targetId,
      title: '审阅一条消息',
      reviewerIds: ['usr_o'],
    });

  it('公共线程 / 时间线上的消息可以审阅', async () => {
    for (const id of ['msg_fix_pub', 'msg_fix_timeline']) {
      const res = await reviewMessage('usr_b', id);
      expect(res.statusCode, res.body).toBe(201);
    }
  });

  it('别人的个人线程里的消息 → 404；主人自己可以', async () => {
    const res = await reviewMessage('usr_b', 'msg_fix_pa');
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('张三的私人笔记');
    const own = await reviewMessage('usr_a', 'msg_fix_pa');
    expect(own.statusCode, own.body).toBe(201);
  });

  it('旁聊（agentVisible=false）不进快照 → 404', async () => {
    const res = await reviewMessage('usr_a', 'msg_fix_side');
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------- 2 / 5 / 6 / 11. 看板

describe('看板', () => {
  let board: Board;

  beforeAll(async () => {
    const list = await req('usr_a', 'GET', '/boards');
    board = list.json<Board[]>()[0]!;
  });

  const createCard = (user: string, body: Record<string, unknown>) =>
    req(user, 'POST', `/boards/${board.id}/cards`, {
      columnId: board.columns[0]!.id,
      title: '卡片',
      ...body,
    });

  it('访客打开没有看板的项目：返回空列表，不自动建看板', async () => {
    const res = await req('usr_g', 'GET', `/api/v1/projects/${FRESH}/boards`);
    expect(res.statusCode).toBe(200);
    expect(res.json<Board[]>()).toEqual([]);
    const rows = await t.db.db.select().from(boards).where(eq(boards.projectId, FRESH));
    expect(rows).toHaveLength(0);
    // 能写的成员打开时照常建默认看板
    const owner = await req('usr_o', 'GET', `/api/v1/projects/${FRESH}/boards`);
    expect(owner.json<Board[]>()).toHaveLength(1);
  });

  it('卡片 threadId / experimentId 必须属于本项目（422）', async () => {
    expect((await createCard('usr_a', { threadId: 'thr_foreign' })).statusCode).toBe(422);
    expect((await createCard('usr_a', { threadId: 'thr_nope' })).statusCode).toBe(422);
    expect((await createCard('usr_a', { experimentId: 'exp_retired' })).statusCode).toBe(422);

    const ok = await createCard('usr_a', { threadId: 'thr_pub' });
    expect(ok.statusCode, ok.body).toBe(201);
    const card = ok.json<Card>();
    const patched = await req('usr_a', 'PATCH', `/cards/${card.id}`, {
      experimentId: 'exp_retired',
      baseVersion: card.version,
    });
    expect(patched.statusCode).toBe(422);
    const moved = await req('usr_a', 'PATCH', `/cards/${card.id}`, {
      threadId: 'thr_foreign',
      baseVersion: card.version,
    });
    expect(moved.statusCode).toBe(422);
  });

  it('卡片关联别人的个人线程 → 403；自己的可以', async () => {
    expect((await createCard('usr_b', { threadId: 'thr_pa' })).statusCode).toBe(403);
    const own = await createCard('usr_a', { threadId: 'thr_pa' });
    expect(own.statusCode, own.body).toBe(201);
    // 别人改这张卡的其他字段（threadId 原样带回）不受影响
    const card = own.json<Card>();
    const edit = await req('usr_b', 'PATCH', `/cards/${card.id}`, {
      title: '李四改了标题',
      threadId: 'thr_pa',
      baseVersion: card.version,
    });
    expect(edit.statusCode, edit.body).toBe(200);
  });

  it('同一 baseVersion 的并发修改：只有一次成功，另一次 409 带最新对象', async () => {
    const card = (await createCard('usr_a', { title: '并发' })).json<Card>();
    const results = await Promise.all(
      ['甲', '乙', '丙'].map((title) =>
        req('usr_a', 'PATCH', `/cards/${card.id}`, { title, baseVersion: card.version }),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409, 409]);
    const conflict = results.find((r) => r.statusCode === 409)!;
    expect(conflict.json()).toMatchObject({
      error: { code: 'version_conflict', details: { current: { version: card.version + 1 } } },
    });
  });
});

// ---------------------------------------------------------------- 6. 实验 / 审阅关联个人线程

describe('关联个人线程', () => {
  it('实验接口与端口已移除，不接受个人线程关联', async () => {
    expect(
      (await req('usr_a', 'POST', '/experiments', { title: 'x', threadId: 'thr_pa' })).statusCode,
    ).toBe(404);
    expect(collab('experiments')).toBeUndefined();
  });

  it('审阅：发起线程是别人的个人线程 → 403', async () => {
    const body = {
      targetKind: 'document',
      targetId: 'doc_fix',
      title: '审阅',
      reviewerIds: ['usr_o'],
      threadId: 'thr_pa',
    };
    expect((await req('usr_b', 'POST', '/reviews', body)).statusCode).toBe(403);
    expect((await req('usr_a', 'POST', '/reviews', body)).statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------- 7. 个人待办

describe('待办改成个人', () => {
  it('只有创建人能把共享待办改成个人待办', async () => {
    const todo = (await req('usr_a', 'POST', '/todos', { title: '共享待办' })).json<Todo>();
    const res = await req('usr_b', 'PATCH', `/todos/${todo.id}`, { personal: true });
    expect(res.statusCode).toBe(403);
    const [row] = await t.db.db.select().from(todos).where(eq(todos.id, todo.id));
    expect(row?.ownerUserId).toBeNull();

    const own = await req('usr_a', 'PATCH', `/todos/${todo.id}`, { personal: true });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json<Todo>().ownerUserId).toBe('usr_a');
  });
});

// ---------------------------------------------------------------- 8 / 10. 组会汇报

describe('组会汇报', () => {
  async function seedReport(id: string) {
    await t.db.db.insert(reports).values({
      id,
      projectId: P,
      title: `汇报 ${id}`,
      periodStart: new Date('2026-10-19T00:00:00Z'),
      periodEnd: new Date('2026-10-26T00:00:00Z'),
      content: '# 本周进展\n- 完成基线',
      createdBy: { kind: 'user', id: 'usr_a', name: '张三' },
    });
  }

  it('拆待办：有一个指派对象不合法时一条都不建', async () => {
    await seedReport('rpt_fix_todos');
    const before = await t.db.db.select().from(todos).where(eq(todos.projectId, P));
    const res = await req('usr_a', 'POST', '/reports/rpt_fix_todos/todos', {
      items: [
        { title: '合法的第一条', assigneeId: 'usr_b' },
        { title: '指派给路人', assigneeId: 'usr_out' },
      ],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: { details: { issues: [{ path: 'items.1.assigneeId' }] } },
    });
    const after = await t.db.db.select().from(todos).where(eq(todos.projectId, P));
    expect(after).toHaveLength(before.length);
  });

  it('并发“存为文档”只生效一次，另一次 409，不留下重复文档', async () => {
    await seedReport('rpt_fix_doc');
    const results = await Promise.all([
      req('usr_a', 'POST', '/reports/rpt_fix_doc/document'),
      req('usr_b', 'POST', '/reports/rpt_fix_doc/document'),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const docs = await t.db.db
      .select()
      .from(documents)
      .where(and(eq(documents.projectId, P), eq(documents.title, '汇报 rpt_fix_doc')));
    expect(docs).toHaveLength(1);
    const [report] = await t.db.db.select().from(reports).where(eq(reports.id, 'rpt_fix_doc'));
    expect(report?.documentId).toBe(docs[0]!.id);
    const conflict = results.find((r) => r.statusCode === 409)!;
    expect(conflict.json()).toMatchObject({ error: { details: { documentId: docs[0]!.id } } });
  });
});

// ---------------------------------------------------------------- 4 / 12. /collab 连接

describe('/collab 连接随权限变化断开', () => {
  let url = '';
  const opened: { close(): void }[] = [];

  beforeAll(async () => {
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = t.app.server.address() as AddressInfo;
    url = `ws://127.0.0.1:${port}/collab`;
  }, 30_000);

  afterAll(() => {
    for (const c of opened) c.close();
  });

  function connect(docId: string, user: string) {
    const doc = new Y.Doc();
    const socket = new HocuspocusProviderWebsocket({
      url: `${url}/${docId}?testUser=${user}`,
      WebSocketPolyfill: WebSocket,
    } as ConstructorParameters<typeof HocuspocusProviderWebsocket>[0]);
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: docId,
      document: doc,
      token: 'cookie',
    });
    provider.attach();
    const synced = new Promise<void>((resolve) => {
      if (provider.isSynced) resolve();
      provider.on('synced', () => resolve());
    });
    const handle = {
      doc,
      synced,
      close() {
        provider.destroy();
        socket.destroy();
      },
    };
    opened.push(handle);
    return handle;
  }

  async function createDoc(title: string): Promise<DocumentMeta> {
    const res = await req('usr_o', 'POST', '/docs', { title, kind: 'latex', markdown: 'x' });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<DocumentMeta>();
  }

  const read = async (docId: string) =>
    (await req('usr_o', 'GET', `/docs/${docId}/markdown`)).json<DocumentContent>().markdown;

  const writableConns = (docId: string, userId: string) =>
    documentConnections(t.app.ctx, docId).filter((c) => c.userId === userId && !c.readOnly);

  it('文档归档后断开在线编辑者，之后的编辑不再写进文档', async () => {
    const meta = await createDoc('归档测试');
    const a = connect(meta.id, 'usr_a');
    await a.synced;
    expect(writableConns(meta.id, 'usr_a')).toHaveLength(1);

    const res = await req('usr_a', 'PATCH', `/docs/${meta.id}`, { archived: true });
    expect(res.statusCode, res.body).toBe(200);
    await waitFor(() => writableConns(meta.id, 'usr_a').length === 0);

    a.doc.getText('source').insert(0, '归档后的编辑');
    await sleep(400);
    expect(await read(meta.id)).not.toContain('归档后的编辑');
  }, 15_000);

  it('成员被移出：断开他的连接，编辑不再生效', async () => {
    await t.seedUser('usr_kick', '被移出的人');
    await t.addMember(P, 'usr_kick', 'member');
    const meta = await createDoc('移出测试');
    const k = connect(meta.id, 'usr_kick');
    await k.synced;
    expect(writableConns(meta.id, 'usr_kick')).toHaveLength(1);

    await t.db.db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, P), eq(projectMembers.userId, 'usr_kick')));
    await t.app.ctx.bus.publish({
      projectId: P,
      type: 'member.removed',
      payload: { userId: 'usr_kick' },
      actor: { kind: 'user', id: 'usr_o', name: '王老师' },
    });
    await waitFor(() => writableConns(meta.id, 'usr_kick').length === 0);

    k.doc.getText('source').insert(0, '移出后的编辑');
    await sleep(400);
    expect(await read(meta.id)).not.toContain('移出后的编辑');
  }, 15_000);

  it('角色降为访客：断开后重连只读', async () => {
    const meta = await createDoc('降级测试');
    const b = connect(meta.id, 'usr_b');
    await b.synced;
    expect(writableConns(meta.id, 'usr_b')).toHaveLength(1);

    await t.db.db
      .update(projectMembers)
      .set({ role: 'guest' })
      .where(and(eq(projectMembers.projectId, P), eq(projectMembers.userId, 'usr_b')));
    const member: ProjectMember = {
      projectId: P,
      user: {
        id: 'usr_b',
        name: '李四',
        email: 'usr_b@example.com',
        avatarColor: 0,
        avatarUrl: null,
      },
      role: 'guest',
      joinedAt: new Date().toISOString(),
    };
    await t.app.ctx.bus.publish({
      projectId: P,
      type: 'member.updated',
      payload: member,
      actor: { kind: 'user', id: 'usr_o', name: '王老师' },
    });
    await waitFor(() => writableConns(meta.id, 'usr_b').length === 0);

    b.doc.getText('source').insert(0, '降级后的编辑');
    await sleep(400);
    expect(await read(meta.id)).not.toContain('降级后的编辑');

    // 恢复角色，免得影响其他用例
    await t.db.db
      .update(projectMembers)
      .set({ role: 'member' })
      .where(and(eq(projectMembers.projectId, P), eq(projectMembers.userId, 'usr_b')));
  }, 15_000);
});
