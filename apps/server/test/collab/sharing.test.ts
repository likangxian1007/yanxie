import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { DocumentMeta, ShareResolveResult, ShareSettings } from '@srh/shared';
import { collabTools } from '../../src/agents/tools/collab';
import type { ToolContext } from '../../src/agents/tools/types';
import { documents } from '../../src/db/schema';
import { setupCollabApp, type CollabTestApp } from './helpers';

/**
 * 个人 / 团队空间与飞书式分享（API.md §2.19）：
 * A 的个人文档 B 看不到；链接只读 → B 能看不能改；改成可编辑 → 能协同；关闭链接 → B 失去访问；
 * 移入团队 → C 能看到；agent 只看到它代表的人能看到的内容。文献库见 test/library-spaces.test.ts。
 */
let t: CollabTestApp;
const PID = 'prj_share';
const base = `/api/v1/projects/${PID}`;

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  user: string,
  payload?: unknown,
) {
  return t.app.inject({
    method,
    url: url.startsWith('/api') ? url : `${base}${url}`,
    headers: t.as(user),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function createDoc(user: string, body: Record<string, unknown>): Promise<DocumentMeta> {
  const res = await call('POST', '/docs', user, { kind: 'doc', title: '草稿', ...body });
  expect(res.statusCode).toBe(201);
  return res.json<DocumentMeta>();
}

const listIds = async (user: string, space?: string) =>
  (await call('GET', `/docs${space ? `?space=${space}` : ''}`, user))
    .json<DocumentMeta[]>()
    .map((d) => d.id);

async function openLink(token: string, user: string) {
  return t.app.inject({ method: 'POST', url: `/api/v1/share/${token}`, headers: t.as(user) });
}

beforeAll(async () => {
  t = await setupCollabApp({ STORAGE_DIR: '.data/test-storage-sharing' });
  await t.seedUser('usr_a', '甲');
  await t.seedUser('usr_b', '乙');
  await t.seedUser('usr_c', '丙');
  await t.seedUser('usr_g', '访客');
  await t.seedUser('usr_x', '课题外');
  await t.seedProject(PID, 'usr_a');
  await t.addMember(PID, 'usr_b', 'member');
  await t.addMember(PID, 'usr_c', 'member');
  await t.addMember(PID, 'usr_g', 'guest');
}, 60_000);

afterAll(async () => {
  await t.close();
});

describe('迁移默认', () => {
  it('不指定空间建的文档在团队空间，所有成员可见（现有行为不变）', async () => {
    const doc = await createDoc('usr_b', { title: '团队文档' });
    expect(doc.space).toBe('team');
    expect(doc.ownerUserId ?? null).toBeNull();
    expect(await listIds('usr_c')).toContain(doc.id);
    expect(await listIds('usr_g')).toContain(doc.id);
    // 列上的默认值就是 team：已有数据迁移后全在团队空间
    const [row] = await t.db.db
      .insert(documents)
      .values({
        id: 'doc_legacy',
        projectId: PID,
        kind: 'doc',
        title: '旧文档',
        createdBy: { kind: 'user', id: 'usr_a', name: '甲' },
      })
      .returning();
    expect(row!.space).toBe('team');
    expect(row!.ownerUserId).toBeNull();
  });
});

describe('个人文档与链接分享', () => {
  let doc: DocumentMeta;
  let token = '';

  it('A 的个人文档：B、C、访客都看不到，访问 404', async () => {
    doc = await createDoc('usr_a', { title: 'A 的草稿', space: 'personal' });
    expect(doc.space).toBe('personal');
    expect(doc.ownerUserId).toBe('usr_a');
    expect(doc.access).toBe('manage');
    expect(await listIds('usr_a', 'personal')).toContain(doc.id);
    expect(await listIds('usr_a', 'team')).not.toContain(doc.id);
    for (const u of ['usr_b', 'usr_c', 'usr_g']) {
      expect(await listIds(u)).not.toContain(doc.id);
      expect((await call('GET', `/docs/${doc.id}`, u)).statusCode).toBe(404);
      expect((await call('GET', `/docs/${doc.id}/markdown`, u)).statusCode).toBe(404);
      expect((await call('GET', `/docs/${doc.id}/versions`, u)).statusCode).toBe(404);
    }
    // 搜索也搜不到
    const hits = (
      await call('GET', `/docs/search?q=${encodeURIComponent('A 的草稿')}`, 'usr_b')
    ).json<{ id: string }[]>();
    expect(JSON.stringify(hits)).not.toContain(doc.id);
    // 课题负责人以外的人不能改分享设置；非所有者看不到 token
    expect((await call('PATCH', `/shares/document/${doc.id}/link`, 'usr_b', {})).statusCode).toBe(
      404,
    );
  });

  it('链接只读：B 打开后能看不能改', async () => {
    const res = await call('PATCH', `/shares/document/${doc.id}/link`, 'usr_a', {
      scope: 'project',
      level: 'view',
    });
    expect(res.statusCode).toBe(200);
    const s = res.json<ShareSettings>();
    expect(s.link.scope).toBe('project');
    token = s.link.token!;
    expect(token).toBeTruthy();

    // 没打开过链接之前 B 还是看不到
    expect((await call('GET', `/docs/${doc.id}`, 'usr_b')).statusCode).toBe(404);
    const opened = await openLink(token, 'usr_b');
    expect(opened.statusCode).toBe(200);
    const r = opened.json<ShareResolveResult>();
    expect(r).toMatchObject({ resourceKind: 'document', resourceId: doc.id, access: 'view' });

    const got = await call('GET', `/docs/${doc.id}`, 'usr_b');
    expect(got.statusCode).toBe(200);
    expect(got.json<DocumentMeta>().access).toBe('view');
    expect(await listIds('usr_b', 'shared')).toContain(doc.id);
    expect(await listIds('usr_b', 'team')).not.toContain(doc.id);

    // 能看不能改：编辑 403、评论 403、改名 403、移动 403
    expect(
      (await call('POST', `/docs/${doc.id}/edit`, 'usr_b', { op: 'append', markdown: 'x' }))
        .statusCode,
    ).toBe(403);
    expect((await call('PATCH', `/docs/${doc.id}`, 'usr_b', { title: '改名' })).statusCode).toBe(
      403,
    );
    expect(
      (await call('POST', `/docs/${doc.id}/comments`, 'usr_b', { body: '评论', anchor: null }))
        .statusCode,
    ).toBe(403);
    // 设置里看不到 token
    const seen = (await call('GET', `/shares/document/${doc.id}`, 'usr_b')).json<ShareSettings>();
    expect(seen.link.token).toBeNull();
    expect(seen.access).toBe('view');
    // C 没打开链接：仍然看不到
    expect((await call('GET', `/docs/${doc.id}`, 'usr_c')).statusCode).toBe(404);
  });

  it('课题外账号：链接仅课题成员时 403；改成知道链接的人后能读', async () => {
    expect((await openLink(token, 'usr_x')).statusCode).toBe(403);
    await call('PATCH', `/shares/document/${doc.id}/link`, 'usr_a', { scope: 'anyone' });
    const opened = await openLink(token, 'usr_x');
    expect(opened.statusCode).toBe(200);
    expect(opened.json<ShareResolveResult>().member).toBe(false);
    expect((await call('GET', `/docs/${doc.id}/markdown`, 'usr_x')).statusCode).toBe(200);
    // 团队空间仍然看不到
    expect((await call('GET', '/docs', 'usr_x')).statusCode).toBe(404);
    await call('PATCH', `/shares/document/${doc.id}/link`, 'usr_a', { scope: 'project' });
    expect((await call('GET', `/docs/${doc.id}/markdown`, 'usr_x')).statusCode).toBe(404);
  });

  it('链接改成可编辑：B 能编辑；可评论级别能评论不能改', async () => {
    await call('PATCH', `/shares/document/${doc.id}/link`, 'usr_a', { level: 'comment' });
    const cm = await call('POST', `/docs/${doc.id}/comments`, 'usr_b', { body: '这里要改' });
    expect(cm.statusCode, cm.body).toBe(201);
    expect(
      (await call('POST', `/docs/${doc.id}/edit`, 'usr_b', { op: 'append', markdown: 'x' }))
        .statusCode,
    ).toBe(403);

    await call('PATCH', `/shares/document/${doc.id}/link`, 'usr_a', { level: 'edit' });
    const res = await call('POST', `/docs/${doc.id}/edit`, 'usr_b', {
      op: 'append',
      markdown: '乙补充的段落',
    });
    expect(res.statusCode).toBe(200);
    const md = (await call('GET', `/docs/${doc.id}/markdown`, 'usr_a')).json<{
      markdown: string;
    }>();
    expect(md.markdown).toContain('乙补充的段落');
    // 版本历史在个人空间照样能用
    const v = await call('POST', `/docs/${doc.id}/versions`, 'usr_b', { label: '乙存的版本' });
    expect(v.statusCode).toBe(201);
  });

  it('关闭链接：B 立即失去访问；重新打开旧 token 也不行', async () => {
    await call('PATCH', `/shares/document/${doc.id}/link`, 'usr_a', { scope: 'invited' });
    expect((await call('GET', `/docs/${doc.id}`, 'usr_b')).statusCode).toBe(404);
    expect(await listIds('usr_b')).not.toContain(doc.id);
    expect((await openLink(token, 'usr_b')).statusCode).toBe(403);
  });

  it('重置链接：旧链接 404，靠旧链接获得的访问失效', async () => {
    await call('PATCH', `/shares/document/${doc.id}/link`, 'usr_a', { scope: 'project' });
    expect((await openLink(token, 'usr_c')).statusCode).toBe(200);
    expect((await call('GET', `/docs/${doc.id}`, 'usr_c')).statusCode).toBe(200);
    const s = (
      await call('POST', `/shares/document/${doc.id}/link/reset`, 'usr_a')
    ).json<ShareSettings>();
    expect(s.link.token).not.toBe(token);
    expect((await openLink(token, 'usr_c')).statusCode).toBe(404);
    expect((await call('GET', `/docs/${doc.id}`, 'usr_c')).statusCode).toBe(404);
    token = s.link.token!;
  });

  it('按人邀请：被邀请的人不用链接就能访问，可以改级别、移除', async () => {
    await call('PATCH', `/shares/document/${doc.id}/link`, 'usr_a', { scope: 'invited' });
    const s = (
      await call('POST', `/shares/document/${doc.id}/grants`, 'usr_a', {
        userIds: ['usr_c'],
        level: 'view',
      })
    ).json<ShareSettings>();
    expect(s.grants.map((g) => g.userId)).toEqual(['usr_c']);
    expect((await call('GET', `/docs/${doc.id}`, 'usr_c')).json<DocumentMeta>().access).toBe(
      'view',
    );
    await call('PATCH', `/shares/document/${doc.id}/grants/usr_c`, 'usr_a', { level: 'edit' });
    expect((await call('GET', `/docs/${doc.id}`, 'usr_c')).json<DocumentMeta>().access).toBe(
      'edit',
    );
    // 用邮箱邀请课题外账号
    const ext = await call('POST', `/shares/document/${doc.id}/grants`, 'usr_a', {
      emails: ['usr_x@example.com'],
      level: 'view',
    });
    expect(ext.json<ShareSettings>().grants.find((g) => g.userId === 'usr_x')?.external).toBe(true);
    // 邀请非成员 id → 422；不存在的邮箱 → 422
    expect(
      (await call('POST', `/shares/document/${doc.id}/grants`, 'usr_a', { userIds: ['usr_zzz'] }))
        .statusCode,
    ).toBe(422);
    expect(
      (await call('POST', `/shares/document/${doc.id}/grants`, 'usr_a', { emails: ['no@x.com'] }))
        .statusCode,
    ).toBe(422);
    await call('DELETE', `/shares/document/${doc.id}/grants/usr_c`, 'usr_a');
    await call('DELETE', `/shares/document/${doc.id}/grants/usr_x`, 'usr_a');
    expect((await call('GET', `/docs/${doc.id}`, 'usr_c')).statusCode).toBe(404);
  });

  it('只有所有者能删除个人文档；团队文档不能设分享', async () => {
    await call('POST', `/shares/document/${doc.id}/grants`, 'usr_a', {
      userIds: ['usr_b'],
      level: 'edit',
    });
    expect((await call('DELETE', `/docs/${doc.id}`, 'usr_b')).statusCode).toBe(403);
    const team = await createDoc('usr_a', { title: '团队的' });
    expect(
      (await call('PATCH', `/shares/document/${team.id}/link`, 'usr_a', { scope: 'project' }))
        .statusCode,
    ).toBe(409);
  });

  it('移入团队空间：C 能看到，分享设置清空；子文档跟着移动', async () => {
    const childRes = await call('POST', '/docs', 'usr_a', {
      kind: 'doc',
      title: '子页',
      parentId: doc.id,
      space: 'personal',
    });
    expect(childRes.statusCode, childRes.body).toBe(201);
    const child = childRes.json<DocumentMeta>();
    expect(child.space).toBe('personal');
    // 只读的人不能移动
    await call('PATCH', `/shares/document/${doc.id}/grants/usr_b`, 'usr_a', { level: 'view' });
    expect(
      (await call('POST', `/docs/${doc.id}/move`, 'usr_b', { space: 'team' })).statusCode,
    ).toBe(403);
    const moved = await call('POST', `/docs/${doc.id}/move`, 'usr_a', { space: 'team' });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json<DocumentMeta>().space).toBe('team');
    expect(await listIds('usr_c', 'team')).toEqual(expect.arrayContaining([doc.id, child.id]));
    expect((await call('GET', `/docs/${doc.id}`, 'usr_c')).json<DocumentMeta>().access).toBe(
      'edit',
    );
    expect((await call('GET', `/docs/${doc.id}`, 'usr_g')).json<DocumentMeta>().access).toBe(
      'view',
    );
    const s = (await call('GET', `/shares/document/${doc.id}`, 'usr_a')).json<ShareSettings>();
    expect(s.grants).toEqual([]);
    expect(s.link.token).toBeNull();
    // 移回个人空间：普通成员不能把别人建的团队文档收进自己的个人空间；创建者可以
    expect(
      (await call('POST', `/docs/${doc.id}/move`, 'usr_c', { space: 'personal' })).statusCode,
    ).toBe(403);
    const back = await call('POST', `/docs/${doc.id}/move`, 'usr_a', { space: 'personal' });
    expect(back.statusCode).toBe(200);
    expect(back.json<DocumentMeta>().ownerUserId).toBe('usr_a');
    expect((await call('GET', `/docs/${doc.id}`, 'usr_c')).statusCode).toBe(404);
    expect((await call('GET', `/docs/${child.id}`, 'usr_c')).statusCode).toBe(404);
  });
});

describe('实时协同按分享权限', () => {
  let url = '';
  beforeAll(async () => {
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = t.app.server.address() as AddressInfo;
    url = `ws://127.0.0.1:${port}/collab`;
  }, 30_000);

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
    return {
      doc,
      synced,
      close() {
        provider.destroy();
        socket.destroy();
      },
    };
  }

  const closeCode = (docId: string, user: string) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(`${url}/${docId}?testUser=${user}`);
      ws.on('close', (code) => resolve(code));
    });

  const waitFor = async (check: () => boolean, ms = 4000) => {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) throw new Error('超时');
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it('没权限 4404；只读分享改了不落库；可编辑分享两人实时同步', async () => {
    const doc = await createDoc('usr_a', { kind: 'latex', title: '论文', space: 'personal' });
    expect(await closeCode(doc.id, 'usr_b')).toBe(4404);

    const s = (
      await call('PATCH', `/shares/document/${doc.id}/link`, 'usr_a', {
        scope: 'project',
        level: 'view',
      })
    ).json<ShareSettings>();
    await openLink(s.link.token!, 'usr_b');
    const ro = connect(doc.id, 'usr_b');
    await ro.synced;
    ro.doc.getText('source').insert(0, '乙偷偷改的');
    await new Promise((r) => setTimeout(r, 400));
    ro.close();
    const md = (await call('GET', `/docs/${doc.id}/markdown`, 'usr_a')).json<{
      markdown: string;
    }>();
    expect(md.markdown).not.toContain('乙偷偷改的');

    await call('PATCH', `/shares/document/${doc.id}/link`, 'usr_a', { level: 'edit' });
    const a = connect(doc.id, 'usr_a');
    const b = connect(doc.id, 'usr_b');
    await Promise.all([a.synced, b.synced]);
    b.doc.getText('source').insert(0, '% 乙写的\n');
    await waitFor(() => a.doc.getText('source').toString().startsWith('% 乙写的'));
    a.close();
    b.close();

    // 关闭链接后 B 连不上
    await call('PATCH', `/shares/document/${doc.id}/link`, 'usr_a', { scope: 'invited' });
    expect(await closeCode(doc.id, 'usr_b')).toBe(4404);
  }, 20_000);
});

describe('agent 只看到它代表的人能看到的', () => {
  let secret: DocumentMeta;
  let shared: DocumentMeta;

  function toolCtx(role: 'coordinator' | 'thread' | 'personal', userId: string | null) {
    return {
      ctx: t.app.ctx,
      session: { id: `ses_${role}_${userId}`, role, workingForUserId: userId },
      project: { id: PID },
      thread: null,
      turnId: 'turn_test',
      actor: { kind: 'agent', id: `ses_${role}`, name: 'agent' },
      requesterUserId: userId,
      visible: new Set(),
      setActivity: async () => {},
    } as unknown as ToolContext;
  }
  const run = (tc: ToolContext, name: string, args: unknown) => {
    const def = collabTools.find((d) => d.name === name)!;
    return def.run(tc, def.schema.parse(args) as never) as Promise<unknown>;
  };

  beforeAll(async () => {
    secret = await createDoc('usr_a', { title: 'SECRET-A-7781', space: 'personal' });
    shared = await createDoc('usr_a', { title: 'SHARED-A-5521', space: 'personal' });
    await call('POST', `/shares/document/${shared.id}/grants`, 'usr_a', {
      userIds: ['usr_b'],
      level: 'view',
    });
  });

  it('协调者 / 团队线程只看团队空间', async () => {
    for (const tc of [toolCtx('coordinator', 'usr_a'), toolCtx('thread', 'usr_a')]) {
      const list = JSON.stringify(await run(tc, 'list_documents', {}));
      expect(list).not.toContain('SECRET-A-7781');
      expect(list).not.toContain('SHARED-A-5521');
      await expect(run(tc, 'read_document', { doc_id: secret.id })).rejects.toThrow();
    }
  });

  it('B 的个人工作区：看不到 A 的个人文档，能看到分享给 B 的；只读的不能改', async () => {
    const tc = toolCtx('personal', 'usr_b');
    const list = JSON.stringify(await run(tc, 'list_documents', {}));
    expect(list).not.toContain('SECRET-A-7781');
    expect(list).toContain('SHARED-A-5521');
    await expect(run(tc, 'read_document', { doc_id: secret.id })).rejects.toThrow();
    await expect(
      run(tc, 'edit_document', {
        doc_id: shared.id,
        op: 'append',
        markdown: 'agent 改的',
      }),
    ).rejects.toThrow();
  });

  it('A 的个人工作区：能看到、能在自己的个人空间建文档', async () => {
    const tc = toolCtx('personal', 'usr_a');
    const list = JSON.stringify(await run(tc, 'list_documents', {}));
    expect(list).toContain('SECRET-A-7781');
    const coord = toolCtx('coordinator', 'usr_a');
    await expect(
      run(coord, 'create_document', { title: 'x', kind: 'doc', space: 'personal' }),
    ).rejects.toThrow();
  });
});
