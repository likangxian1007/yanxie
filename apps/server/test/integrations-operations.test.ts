import { eq } from 'drizzle-orm';
import { apiOperationAudit } from '../src/db/schema';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ApiTokenCreated, DocumentMeta, Project } from '@srh/shared';
import { makeApp, setupProject, type Session, type TestApp } from './helpers';

let t: TestApp;
let owner: Session;
let member: Session;
let project: Project;

beforeAll(async () => {
  t = await makeApp({ API_TOKENS_ENABLED: 'true', MCP_ENABLED: 'true' });
  const setup = await setupProject(t.app, ['member']);
  ({ owner, project } = setup);
  member = setup.others[0]!;
}, 60_000);
afterAll(async () => {
  await t?.close();
});

async function mint(session: Session, scopes: string[], projects: string[] = [project.id]) {
  const response = await session.req('POST', '/auth/me/tokens', {
    name: '操作目录测试',
    scopes,
    projectIds: projects,
  });
  expect(response.statusCode).toBe(201);
  return response.json<ApiTokenCreated>().token;
}
async function rest(
  app: TestApp,
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
  key?: string,
) {
  return app.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) },
    ...(body === undefined ? {} : { payload: body as object }),
  });
}
async function tool(app: TestApp, token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await app.app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: { accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(response.statusCode).toBe(200);
  const json = response.json<{
    result?: { isError?: boolean; content?: { text: string }[]; structuredContent?: unknown };
  }>();
  return {
    isError: json.result?.isError === true,
    data: json.result?.structuredContent ?? JSON.parse(json.result?.content?.[0]?.text ?? 'null'),
  };
}
const projectParams = () => ({ projectId: project.id });

it('操作目录覆盖全部注册路由，MCP 可分页发现并描述开放操作', async () => {
  const token = await mint(owner, ['read', 'write']);
  const response = await rest(t, token, 'GET', '/integrations/operations');
  expect(response.statusCode).toBe(200);
  const catalog = response.json<{ coverage: { registered: number; unclassified: string[] } }>();
  expect(catalog.coverage.registered).toBeGreaterThan(100);
  expect(catalog.coverage.unclassified).toEqual([]);
  const first = await tool(t, token, 'list_operations', { domain: 'todos', limit: 1 });
  expect(first.isError).toBe(false);
  expect(first.data.total).toBeGreaterThan(1);
  expect(first.data.operations).toHaveLength(1);
  expect(first.data.nextOffset).toBe(1);
  const next = await tool(t, token, 'list_operations', { domain: 'todos', limit: 1, offset: 1 });
  expect(next.data.operations[0].id).not.toBe(first.data.operations[0].id);
  const id = 'POST /projects/:projectId/todos';
  const desc = await tool(t, token, 'describe_operation', { operationId: id });
  expect(desc.isError).toBe(false);
  expect(desc.data).toMatchObject({
    id,
    method: 'POST',
    effect: 'write',
    access: 'open',
    input: { params: ['projectId'] },
  });
  expect(desc.data.input.body).toBeTruthy();
  const hidden = await tool(t, token, 'describe_operation', {
    operationId: 'DELETE /projects/:projectId',
  });
  expect(hidden.isError).toBe(true);
  expect(hidden.data.error.code).toBe('not_found');
  const readOnly = await mint(owner, ['read']);
  const reads = await tool(t, readOnly, 'list_operations', { effect: 'write' });
  expect(reads.data.operations).toEqual([]);
  expect((await tool(t, readOnly, 'describe_operation', { operationId: id })).isError).toBe(true);
  const invalid = await tool(t, token, 'read_operation', {
    operationId: 'GET https://example.com',
  });
  expect(invalid.isError).toBe(true);
  expect(invalid.data.error.code).toBe('not_found');
});

it('敏感管理操作通过 REST 与 MCP 均不能绕过网页登录', async () => {
  const token = await mint(owner, ['read', 'write']);
  for (const [method, path, body] of [
    ['DELETE', `/projects/${project.id}`, undefined],
    ['POST', `/projects/${project.id}/invites`, { role: 'member' }],
    ['PATCH', `/projects/${project.id}/members/${member.user.id}`, { role: 'guest' }],
    ['POST', `/projects/${project.id}/providers`, {}],
    ['POST', '/auth/me/tokens', { name: '额外令牌', scopes: ['read'] }],
  ] as const) {
    expect((await rest(t, token, method, path, body)).statusCode).toBe(403);
  }
  const result = await tool(t, token, 'write_operation', {
    operationId: 'DELETE /projects/:projectId',
    params: projectParams(),
  });
  expect(result.isError).toBe(true);
  expect(result.data.error.code).toBe('not_found');
  expect((await owner.req('GET', `/projects/${project.id}`)).statusCode).toBe(200);
});

it('只读令牌可通过 REST 和 MCP 调用语义为读取的 POST 操作', async () => {
  const token = await mint(owner, ['read']);
  const notebook = await owner.req('POST', `/projects/${project.id}/notebooks`, {
    title: '补全测试',
  });
  expect(notebook.statusCode).toBe(201);
  const notebookId = notebook.json<{ id: string }>().id;
  for (const action of ['complete', 'inspect']) {
    const path = `/projects/${project.id}/notebooks/${notebookId}/${action}`;
    const body = { code: 'a', cursorPos: 1 };
    expect((await rest(t, token, 'POST', path, body)).statusCode).toBe(200);
    const result = await tool(t, token, 'read_operation', {
      operationId: `POST /projects/:projectId/notebooks/:notebookId/${action}`,
      params: { ...projectParams(), notebookId },
      body,
    });
    expect(result.isError).toBe(false);
    expect(result.data.status).toBe(200);
  }
  const doc = (
    await owner.req('POST', `/projects/${project.id}/docs`, {
      title: '只读分享',
      kind: 'doc',
      space: 'personal',
    })
  ).json<DocumentMeta>();
  const share = await owner.req('PATCH', `/projects/${project.id}/shares/document/${doc.id}/link`, {
    scope: 'anyone',
    level: 'view',
  });
  expect(share.statusCode).toBe(200);
  const link = share.json<{ link: { token: string } }>().link.token;
  expect((await rest(t, token, 'POST', `/share/${link}`)).statusCode).toBe(403);
  const result = await tool(t, token, 'read_operation', {
    operationId: 'POST /share/:token',
    params: { token: link },
  });
  expect(result.isError).toBe(true);
  expect(result.data.error.code).toBe('forbidden');
});

it('同一幂等键跨 REST 与 MCP 重放任务和消息，不得因角色变化重放', async () => {
  const token = await mint(member, ['read', 'write']);
  const todoOp = 'POST /projects/:projectId/todos';
  const todoBody = { title: '复核幂等任务' };
  const todo = await tool(t, token, 'write_operation', {
    operationId: todoOp,
    params: projectParams(),
    body: todoBody,
    idempotencyKey: 'todo_test_001',
  });
  expect(todo.isError).toBe(false);
  expect(todo.data.status).toBe(201);
  const replay = await rest(
    t,
    token,
    'POST',
    `/projects/${project.id}/todos`,
    todoBody,
    'todo_test_001',
  );
  expect(replay.statusCode).toBe(201);
  expect(replay.headers['idempotency-replayed']).toBe('true');
  expect(replay.json()).toEqual(todo.data.data);
  const conflict = await rest(
    t,
    token,
    'POST',
    `/projects/${project.id}/todos`,
    { title: '不同的请求' },
    'todo_test_001',
  );
  expect(conflict.statusCode).toBe(409);
  const messageBody = { body: '工作流消息', agentVisible: false };
  const message = await rest(
    t,
    token,
    'POST',
    `/projects/${project.id}/timeline`,
    messageBody,
    'message_test_001',
  );
  expect(message.statusCode).toBe(201);
  const messageReplay = await tool(t, token, 'write_operation', {
    operationId: 'POST /projects/:projectId/timeline',
    params: projectParams(),
    body: messageBody,
    idempotencyKey: 'message_test_001',
  });
  expect(messageReplay.isError).toBe(false);
  expect(messageReplay.data).toMatchObject({ status: 201, replayed: true, data: message.json() });
  expect(
    (
      await owner.req('PATCH', `/projects/${project.id}/members/${member.user.id}`, {
        role: 'guest',
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await rest(t, token, 'POST', `/projects/${project.id}/todos`, todoBody, 'todo_test_001'))
      .statusCode,
  ).toBe(403);
  expect(
    (await owner.req('DELETE', `/projects/${project.id}/members/${member.user.id}`)).statusCode,
  ).toBe(204);
  const removed = await tool(t, token, 'write_operation', {
    operationId: 'POST /projects/:projectId/timeline',
    params: projectParams(),
    body: messageBody,
    idempotencyKey: 'message_test_001',
  });
  expect(removed.isError).toBe(true);
  expect(removed.data.error.details.httpStatus).toBe(404);
});

it('令牌写额度在 REST 与 MCP 间共享，成功的幂等重放不重复计费', async () => {
  const limited = await makeApp({
    API_TOKENS_ENABLED: 'true',
    MCP_ENABLED: 'true',
    MCP_WRITE_PER_DAY: '2',
  });
  try {
    const setup = await setupProject(limited.app, []);
    const issued = await setup.owner.req('POST', '/auth/me/tokens', {
      name: '共享额度测试',
      scopes: ['read', 'write'],
      projectIds: [setup.project.id],
    });
    expect(issued.statusCode).toBe(201);
    const token = issued.json<ApiTokenCreated>().token;
    const body = { title: '第一次写入' };
    const path = `/projects/${setup.project.id}/todos`;
    expect((await rest(limited, token, 'POST', path, body, 'quota_test_001')).statusCode).toBe(201);
    const again = await tool(limited, token, 'write_operation', {
      operationId: 'POST /projects/:projectId/todos',
      params: { projectId: setup.project.id },
      body,
      idempotencyKey: 'quota_test_001',
    });
    expect(again.isError).toBe(false);
    expect(again.data.replayed).toBe(true);
    const second = await tool(limited, token, 'write_operation', {
      operationId: 'POST /projects/:projectId/todos',
      params: { projectId: setup.project.id },
      body: { title: '第二次写入' },
    });
    expect(second.isError).toBe(false);
    const exhausted = await rest(limited, token, 'POST', path, { title: '超过限额' });
    expect(exhausted.statusCode).toBe(429);
    const list = await rest(limited, token, 'GET', path);
    expect(list.statusCode).toBe(200);
    expect(list.json<unknown[]>()).toHaveLength(2);
  } finally {
    await limited.close();
  }
}, 90_000);

it('REST、兼容工具与通用工具都留下带关联请求的审计，失败也留痕且不存正文', async () => {
  const token = await mint(owner, ['read']);
  expect((await rest(t, token, 'GET', `/projects/${project.id}`)).statusCode).toBe(200);
  expect((await tool(t, token, 'get_project', projectParams())).isError).toBe(false);
  expect(
    (
      await tool(t, token, 'read_operation', {
        operationId: 'GET /projects/:projectId',
        params: projectParams(),
      })
    ).isError,
  ).toBe(false);
  const missing = await tool(t, token, 'get_project', { projectId: 'prj_missing_audit' });
  expect(missing.isError).toBe(true);
  const rows = await t.db.db
    .select()
    .from(apiOperationAudit)
    .where(eq(apiOperationAudit.userId, owner.user.id));
  const calls = rows.filter(
    (row) => row.operationId === 'GET /projects/:projectId' || row.operationId === 'get_project',
  );
  expect(
    calls.filter((row) => row.target.projectId === project.id && row.status === 200).length,
  ).toBeGreaterThanOrEqual(3);
  expect(
    calls.some(
      (row) =>
        row.target.projectId === 'prj_missing_audit' &&
        row.status === 404 &&
        row.errorCode === 'not_found',
    ),
  ).toBe(true);
  expect(calls.every((row) => typeof row.requestId === 'string' && row.requestId.length > 0)).toBe(
    true,
  );
  expect(JSON.stringify(calls)).not.toContain(token);
  expect(calls.every((row) => !('body' in row) && !('responseBody' in row))).toBe(true);
});
