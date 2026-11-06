import { once } from 'node:events';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiTokenCreated, DocumentMeta, Message, Page, Project } from '@srh/shared';
import { apiTokens } from '../src/db/schema';
import { createInboxItem } from '../src/modules/inbox/service';
import { makeApp, setupProject, type Session, type TestApp } from './helpers';

let t: TestApp;
let owner: Session;
let member: Session;
let project: Project;
let other: Project;
let scoped: ApiTokenCreated;
let ownerRead: ApiTokenCreated;
let memberRead: ApiTokenCreated;
const accept = 'application/json, text/event-stream';

async function mint(session: Session, projectIds: string[] = [], scopes = ['read']) {
  const res = await session.req('POST', '/auth/me/tokens', {
    name: '接入回归',
    projectIds,
    scopes,
  });
  expect(res.statusCode).toBe(201);
  return res.json<ApiTokenCreated>();
}

async function rest(
  token: ApiTokenCreated,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  payload?: object,
) {
  return t.app.inject({
    method,
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${token.token}` },
    ...(payload ? { payload } : {}),
  });
}

async function tool(token: ApiTokenCreated, name: string, args: Record<string, unknown>) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: { accept, authorization: `Bearer ${token.token}` },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ result: { isError?: boolean; content: { text: string }[] } }>().result;
}

const payload = <T>(out: Awaited<ReturnType<typeof tool>>): T => {
  expect(out.isError).not.toBe(true);
  return JSON.parse(out.content[0]!.text) as T;
};

async function doc(session: Session, pid: string, title: string, space = 'team') {
  const res = await session.req('POST', `/projects/${pid}/docs`, { title, kind: 'doc', space });
  expect(res.statusCode).toBe(201);
  return res.json<DocumentMeta>();
}

beforeAll(async () => {
  t = await makeApp({ API_TOKENS_ENABLED: 'true', MCP_ENABLED: 'true' });
  const setup = await setupProject(t.app, ['member']);
  ({ owner, project } = setup);
  member = setup.others[0]!;
  other = (await owner.req('POST', '/projects', { name: '范围外项目' })).json<Project>();
  scoped = await mint(owner, [project.id], ['read', 'write']);
  ownerRead = await mint(owner);
  memberRead = await mint(member);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('令牌必须叠加资源级权限和项目围栏', () => {
  it('REST 文档读取和编辑不能越过项目范围，Cookie 访问保持有效', async () => {
    const d = await doc(owner, other.id, '范围外文档');
    expect((await owner.req('GET', `/projects/${other.id}/docs/${d.id}`)).statusCode).toBe(200);
    expect(
      (await rest(scoped, 'GET', `/projects/${other.id}/docs/${d.id}/markdown`)).statusCode,
    ).toBe(404);
    expect(
      (await rest(scoped, 'PATCH', `/projects/${other.id}/docs/${d.id}`, { title: '不应修改' }))
        .statusCode,
    ).toBe(404);
  });

  it('个人置顶列表同样遵守令牌的项目围栏', async () => {
    expect(
      (await owner.req('PUT', `/auth/me/pins/${project.id}`, { ids: ['timeline'] })).statusCode,
    ).toBe(200);
    expect(
      (await owner.req('PUT', `/auth/me/pins/${other.id}`, { ids: ['timeline'] })).statusCode,
    ).toBe(200);
    const list = await rest(scoped, 'GET', '/auth/me/pins');
    expect(list.statusCode).toBe(200);
    expect(Object.keys(list.json())).toEqual([project.id]);
  });

  it('分享链接解析不能绕过项目围栏', async () => {
    const d = await doc(owner, other.id, '范围外个人文档', 'personal');
    const share = await owner.req('PATCH', `/projects/${other.id}/shares/document/${d.id}/link`, {
      scope: 'anyone',
      level: 'view',
    });
    expect(share.statusCode).toBe(200);
    const link = share.json<{ link: { token: string } }>().link.token;
    expect((await rest(scoped, 'POST', `/share/${link}`)).statusCode).toBe(404);
  });

  it('REST 收件箱更新不能修改范围外条目', async () => {
    await createInboxItem(t.app.ctx, {
      projectId: other.id,
      userId: owner.user.id,
      kind: 'mention',
      title: '范围外提醒',
      href: '/',
      sourceId: 'scope-regression',
    });
    const list = (await owner.req('GET', `/inbox?projectId=${other.id}`)).json<{ id: string }[]>();
    expect(list.length).toBeGreaterThan(0);
    expect((await rest(scoped, 'PATCH', `/inbox/${list[0]!.id}`, { done: true })).statusCode).toBe(
      404,
    );
  });

  it('MCP 不能读同项目其他成员的未分享个人文档', async () => {
    const d = await doc(owner, project.id, '未分享草稿', 'personal');
    expect(
      (await member.req('GET', `/projects/${project.id}/docs/${d.id}/markdown`)).statusCode,
    ).toBe(404);
    const result = await tool(memberRead, 'read_document', {
      projectId: project.id,
      documentId: d.id,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('不存在');
  });

  it('MCP 发现文档应包含自己的个人文档，并排除他人的私有文档', async () => {
    const mine = await doc(owner, project.id, '我的个人草稿', 'personal');
    const theirs = await doc(member, project.id, '同事的个人草稿', 'personal');
    const result = payload<{ documents: { id: string }[] }>(
      await tool(ownerRead, 'get_project', { projectId: project.id }),
    );
    expect(result.documents.map((d) => d.id)).toContain(mine.id);
    expect(result.documents.map((d) => d.id)).not.toContain(theirs.id);
  });
});

describe('个人工作流能读完整上下文，并控制是否唤醒站内 Agent', () => {
  it('get_thread 支持用 nextCursor 继续读历史', async () => {
    const created = await owner.req('POST', `/projects/${project.id}/threads`, {
      title: '历史分页',
      body: '开始',
    });
    expect(created.statusCode).toBe(201);
    const thread = created.json<{ id: string }>();
    for (const body of ['第一条', '第二条', '第三条']) {
      expect(
        (await owner.req('POST', `/projects/${project.id}/threads/${thread.id}/messages`, { body }))
          .statusCode,
      ).toBe(201);
    }
    const args = { projectId: project.id, threadId: thread.id, limit: 1 };
    const first = payload<{ messages: Page<Message> }>(await tool(ownerRead, 'get_thread', args));
    expect(first.messages.nextCursor).toBeTruthy();
    const next = payload<{ messages: Page<Message> }>(
      await tool(ownerRead, 'get_thread', { ...args, cursor: first.messages.nextCursor }),
    );
    expect(next.messages.items[0]!.id).not.toBe(first.messages.items[0]!.id);
  });

  it('read_document 支持继续读被截断的正文', async () => {
    const d = await doc(owner, project.id, '长文档');
    const edit = await owner.req('POST', `/projects/${project.id}/docs/${d.id}/edit`, {
      op: 'append',
      markdown: 'x'.repeat(21_000) + '结尾证据',
    });
    expect(edit.statusCode).toBe(200);
    const args = { projectId: project.id, documentId: d.id };
    const first = payload<{ markdown: string; nextOffset: number }>(
      await tool(ownerRead, 'read_document', args),
    );
    expect(first.markdown).not.toContain('结尾证据');
    expect(first.nextOffset).toBe(20_000);
    const next = payload<{ markdown: string; nextOffset: number | null }>(
      await tool(ownerRead, 'read_document', { ...args, offset: first.nextOffset }),
    );
    expect(next.markdown).toContain('结尾证据');
    expect(next.nextOffset).toBeNull();
  });

  it('post_message 可明确关闭站内 Agent 唤醒', async () => {
    const result = payload<Message>(
      await tool(scoped, 'post_message', {
        projectId: project.id,
        body: '外部工作流同步结果',
        agentVisible: false,
      }),
    );
    expect(result.agentVisible).toBe(false);
  });
});

describe('持续连接不能在令牌失效后继续使用', () => {
  async function connect(token: ApiTokenCreated) {
    let ready!: () => void;
    const initialized = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const ws = await t.app.injectWS(
      '/ws',
      { headers: { authorization: `Bearer ${token.token}` } },
      {
        onInit: (socket) =>
          socket.on('message', (raw) => {
            if (JSON.parse(raw.toString()).op === 'ready') ready();
          }),
      },
    );
    await initialized;
    return ws;
  }

  it('撤销立即断开已建立的 /ws', async () => {
    const token = await mint(owner);
    const ws = await connect(token);
    const closed = once(ws, 'close');
    try {
      await owner.req('DELETE', `/auth/me/tokens/${token.apiToken.id}`);
      const [code] = await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('撤销后连接仍未断开')), 1000);
          timer.unref();
        }),
      ]);
      expect(code).toBe(4401);
    } finally {
      ws.close();
    }
  });

  it('到期关闭已建立的 /ws', async () => {
    const token = await mint(owner);
    await t.db.db
      .update(apiTokens)
      .set({ expiresAt: new Date(Date.now() + 800) })
      .where(eq(apiTokens.id, token.apiToken.id));
    const ws = await connect(token);
    const closed = once(ws, 'close');
    try {
      const [code] = await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('过期后连接仍未断开')), 2000);
          timer.unref();
        }),
      ]);
      expect(code).toBe(4401);
    } finally {
      ws.close();
    }
  });
});
