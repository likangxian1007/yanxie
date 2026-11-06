import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiTokenCreated, InboxItem, Project } from '@srh/shared';
import { makeApp, setupProject, signup, type Session, type TestApp } from './helpers';

/**
 * 入站 MCP（API.md §2.22）。
 * 四类用例：成功、未登录 401、无权限 403/404、参数错 422 + 只读裁剪 / 每日写上限 / 开关。
 */
let t: TestApp;
let project: Project;
let otherProject: Project;
let owner: Session;
let member: Session;

const ACCEPT = 'application/json, text/event-stream';
const WRITE = ['read', 'write'];
const READ = ['read'];

beforeAll(async () => {
  t = await makeApp({ API_TOKENS_ENABLED: 'true', MCP_ENABLED: 'true' });
  const setup = await setupProject(t.app, ['member', 'guest']);
  project = setup.project;
  owner = setup.owner;
  member = setup.others[0]!;
  const other = await owner.req('POST', '/projects', { name: '另一个课题' });
  otherProject = other.json<Project>();
}, 60_000);

afterAll(async () => {
  await t?.close();
});

// ---------------------------------------------------------------- 帮助函数

async function mintToken(
  session: Session,
  body: Record<string, unknown>,
): Promise<ApiTokenCreated> {
  const res = await session.req('POST', '/auth/me/tokens', body);
  expect(res.statusCode).toBe(201);
  return res.json<ApiTokenCreated>();
}

interface RpcResult {
  statusCode: number;
  json: <T = any>() => T; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
}

/** 发一条 JSON-RPC 到 /api/v1/mcp（带 Accept，符合 Streamable HTTP 规范） */
async function rpc(raw: string | null, body: unknown): Promise<RpcResult> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: {
      accept: ACCEPT,
      ...(raw ? { authorization: `Bearer ${raw}` } : {}),
    },
    payload: body as object,
  });
  return { statusCode: res.statusCode, json: () => res.json(), text: res.body };
}

const initialize = (id = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'srh-test', version: '1.0.0' },
  },
});

const listTools = (id = 2) => ({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });

const callTool = (name: string, args: Record<string, unknown> = {}, id = 3) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

/** tools/call 的 content[0].text 是 JSON 字符串；解析出来方便断言 */
function toolPayload(res: RpcResult): { isError: boolean; data: unknown; text: string } {
  const body = res.json<{
    result?: { isError?: boolean; content?: { type: string; text?: string }[] };
    error?: unknown;
  }>();
  const content = body.result?.content ?? [];
  const text = content[0]?.text ?? '';
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { isError: body.result?.isError === true, data, text };
}

function toolNames(res: RpcResult): string[] {
  const body = res.json<{ result?: { tools?: { name: string }[] } }>();
  return (body.result?.tools ?? []).map((x) => x.name);
}

// ---------------------------------------------------------------- 握手与鉴权

describe('MCP 握手与鉴权', () => {
  it('initialize 成功（Bearer 令牌，返回 application/json）', async () => {
    const token = await mintToken(owner, { name: 'mcp 握手', scopes: READ });
    const res = await rpc(token.token, initialize());
    expect(res.statusCode).toBe(200);
    const body = res.json<{ result: { serverInfo: { name: string }; protocolVersion: string } }>();
    expect(body.result.serverInfo.name).toBe('srh');
    expect(body.result.protocolVersion).toBe('2025-06-18');
  });

  it('未登录 → 401，且带 WWW-Authenticate（规范 MUST）', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { accept: ACCEPT },
      payload: initialize() as object,
    });
    expect(res.statusCode).toBe(401);
    expect(String(res.headers['www-authenticate'])).toContain('Bearer');
  });

  it('伪造令牌 → 401；撤销后 → 401', async () => {
    const fake = await rpc('srh_pat_not-a-real-token', initialize());
    expect(fake.statusCode).toBe(401);
    expect(String(fake.json<{ error: { code: string } }>().error?.code ?? '')).toBe('unauthorized');

    const token = await mintToken(owner, { name: '待撤 mcp', scopes: READ });
    expect((await rpc(token.token, initialize())).statusCode).toBe(200);
    expect((await owner.req('DELETE', `/auth/me/tokens/${token.apiToken.id}`)).statusCode).toBe(
      204,
    );
    const after = await rpc(token.token, initialize());
    expect(after.statusCode).toBe(401);
    expect(String(after.json<{ error: { code: string } }>().error.code ?? '')).toBeDefined();
  });

  it('GET / DELETE 按规范回 405（不开 SSE、不管理会话）', async () => {
    const token = await mintToken(owner, { name: 'mcp 方法', scopes: READ });
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await t.app.inject({
        method,
        url: '/api/v1/mcp',
        headers: { accept: ACCEPT, authorization: `Bearer ${token.token}` },
      });
      expect(res.statusCode).toBe(405);
    }
  });

  it('MCP_ENABLED=false → 403；API_TOKENS_ENABLED=false → 401', async () => {
    const off = await makeApp({ API_TOKENS_ENABLED: 'true', MCP_ENABLED: 'false' });
    try {
      const s = await signup(off.app, 'mcp 关掉');
      const created = await s.req('POST', '/auth/me/tokens', { name: 'x', scopes: READ });
      const raw = created.json<ApiTokenCreated>().token;
      const res = await off.app.inject({
        method: 'POST',
        url: '/api/v1/mcp',
        headers: { accept: ACCEPT, authorization: `Bearer ${raw}` },
        payload: initialize() as object,
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await off.close();
    }

    const noTokens = await makeApp({ API_TOKENS_ENABLED: 'false', MCP_ENABLED: 'true' });
    try {
      const res = await noTokens.app.inject({
        method: 'POST',
        url: '/api/v1/mcp',
        headers: { accept: ACCEPT, authorization: 'Bearer srh_pat_whatever' },
        payload: initialize() as object,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await noTokens.close();
    }
  }, 90_000);
});

// ---------------------------------------------------------------- 工具裁剪与权限

describe('工具清单按 scope 裁剪', () => {
  it('只读令牌看不到任何写工具', async () => {
    const token = await mintToken(owner, { name: 'mcp 只读', scopes: READ });
    const names = toolNames(await rpc(token.token, listTools()));
    expect(names).toContain('list_projects');
    expect(names).toContain('get_timeline');
    expect(names).not.toContain('post_message');
    expect(names).not.toContain('create_todo');
    expect(names).not.toContain('mark_inbox_done');
  });

  it('可写令牌能看到 9 个兼容工具与 4 个通用工具', async () => {
    const token = await mintToken(owner, { name: 'mcp 可写', scopes: WRITE });
    const names = toolNames(await rpc(token.token, listTools()));
    expect(names).toHaveLength(13);
    expect(names).toEqual(
      expect.arrayContaining([
        'list_operations',
        'describe_operation',
        'read_operation',
        'write_operation',
        'list_projects',
        'get_project',
        'get_timeline',
        'get_thread',
        'read_document',
        'list_inbox',
        'post_message',
        'create_todo',
        'mark_inbox_done',
      ]),
    );
  });

  it('只读令牌强行调写工具 → 工具级错误（不是 500）', async () => {
    const token = await mintToken(owner, { name: 'mcp 硬闯', scopes: READ });
    const res = await rpc(
      token.token,
      callTool('post_message', { projectId: project.id, body: 'x' }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.json<{ error?: unknown; result?: { isError?: boolean } }>();
    // 工具未注册 → JSON-RPC error；总之不能是 500，也不能真的发出去
    expect(body.result?.isError === true || body.error !== undefined).toBe(true);
  });
});

describe('工具行为与越权防线', () => {
  it('list_projects 只返回令牌限定的项目', async () => {
    const token = await mintToken(owner, {
      name: 'mcp 限项目',
      scopes: READ,
      projectIds: [project.id],
    });
    const out = toolPayload(await rpc(token.token, callTool('list_projects')));
    expect(out.isError).toBe(false);
    const list = out.data as { id: string }[];
    expect(list.map((p) => p.id)).toEqual([project.id]);
  });

  it('限项目令牌读别的项目 → 工具级错误（404 语义）', async () => {
    const token = await mintToken(owner, {
      name: 'mcp 围栏',
      scopes: READ,
      projectIds: [project.id],
    });
    const out = toolPayload(
      await rpc(token.token, callTool('get_project', { projectId: otherProject.id })),
    );
    expect(out.isError).toBe(true);
    expect(out.text).toContain('不存在');
  });

  it('可写令牌能发消息，且消息带「来自令牌」标记', async () => {
    const token = await mintToken(owner, { name: 'dots 实测', scopes: WRITE });
    const out = toolPayload(
      await rpc(
        token.token,
        callTool('post_message', { projectId: project.id, body: '来自 MCP 的一条消息' }),
      ),
    );
    expect(out.isError).toBe(false);
    const message = out.data as { id: string; meta: { viaToken?: { id: string; name: string } } };
    expect(message.meta.viaToken?.id).toBe(token.apiToken.id);
    expect(message.meta.viaToken?.name).toBe('dots 实测');
  });

  it('参数错 → 工具级错误（中文提示，不 500）', async () => {
    const token = await mintToken(owner, { name: 'mcp 参数', scopes: WRITE });
    const out = toolPayload(
      await rpc(token.token, callTool('post_message', { projectId: project.id })),
    );
    expect(out.isError).toBe(true);
  });

  it('list_inbox 只返回本人的条目；别人的条目标不了', async () => {
    const ownerToken = await mintToken(owner, { name: 'mcp 收件箱', scopes: WRITE });
    const memberToken = await mintToken(member, { name: 'mcp 成员', scopes: WRITE });

    // owner 发消息 @member，给 member 造一条收件箱
    await rpc(
      ownerToken.token,
      callTool('post_message', {
        projectId: project.id,
        body: `@${member.user.name} 请看一下`,
        mentions: [
          {
            userId: member.user.id,
            label: member.user.name,
            start: 0,
            end: member.user.name.length + 1,
          },
        ],
      }),
    );
    const mine = toolPayload(await rpc(memberToken.token, callTool('list_inbox', {})));
    const items = mine.data as InboxItem[];
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);

    // member 的收件箱里若拿到 owner 的条目，说明过滤漏了
    for (const item of items) expect(item.userId).toBe(member.user.id);

    const stolen = toolPayload(
      await rpc(ownerToken.token, callTool('mark_inbox_done', { itemId: items[0]!.id })),
    );
    expect(stolen.isError).toBe(true);
    const done = toolPayload(
      await rpc(memberToken.token, callTool('mark_inbox_done', { itemId: items[0]!.id })),
    );
    expect(done.isError).toBe(false);
  });

  it('访客令牌可以读但不能写（403 语义）', async () => {
    const guest = await signup(t.app, '访客甲');
    const inv = await owner.req('POST', `/projects/${project.id}/invites`, { role: 'guest' });
    await guest.req('POST', `/invites/${inv.json<{ token: string }>().token}/accept`);
    const token = await mintToken(guest, { name: 'mcp 访客', scopes: WRITE });
    const read = toolPayload(
      await rpc(token.token, callTool('get_timeline', { projectId: project.id })),
    );
    expect(read.isError).toBe(false);
    const write = toolPayload(
      await rpc(
        token.token,
        callTool('post_message', { projectId: project.id, body: '访客不该发出' }),
      ),
    );
    expect(write.isError).toBe(true);
  });
});

// ---------------------------------------------------------------- 每日写上限

describe('每日写上限', () => {
  it('超过 MCP_WRITE_PER_DAY 后写操作被拒，读操作不受影响', async () => {
    const limited = await makeApp({
      API_TOKENS_ENABLED: 'true',
      MCP_ENABLED: 'true',
      MCP_WRITE_PER_DAY: '2',
    });
    try {
      const setup = await setupProject(limited.app, []);
      const created = await setup.owner.req('POST', '/auth/me/tokens', {
        name: 'mcp 额度',
        scopes: WRITE,
      });
      const raw = created.json<ApiTokenCreated>().token;
      const send = (body: string) =>
        limited.app.inject({
          method: 'POST',
          url: '/api/v1/mcp',
          headers: { accept: ACCEPT, authorization: `Bearer ${raw}` },
          payload: callTool('post_message', { projectId: setup.project.id, body }) as object,
        });
      const payloadOf = (res: { json: () => unknown }) => {
        const body = res.json() as { result?: { isError?: boolean; content?: { text: string }[] } };
        return {
          isError: body.result?.isError === true,
          text: body.result?.content?.[0]?.text ?? '',
        };
      };
      expect(payloadOf(await send('第 1 条')).isError).toBe(false);
      expect(payloadOf(await send('第 2 条')).isError).toBe(false);
      const third = payloadOf(await send('第 3 条'));
      expect(third.isError).toBe(true);
      expect(third.text).toContain('写操作');

      // 读操作不占额度
      const read = await limited.app.inject({
        method: 'POST',
        url: '/api/v1/mcp',
        headers: { accept: ACCEPT, authorization: `Bearer ${raw}` },
        payload: callTool('list_projects') as object,
      });
      expect(payloadOf(read).isError).toBe(false);
    } finally {
      await limited.close();
    }
  }, 90_000);
});
