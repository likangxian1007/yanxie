import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ApiTokenCreated, DocumentMeta, FileObject, Project, Todo } from '@srh/shared';
import { makeApp, setupProject, type Session, type TestApp } from './helpers';

let t: TestApp;
let owner: Session;
let member: Session;
let project: Project;
let other: Project;
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

beforeAll(async () => {
  t = await makeApp({ API_TOKENS_ENABLED: 'true', MCP_ENABLED: 'true' });
  const setup = await setupProject(t.app, ['member']);
  ({ owner, project } = setup);
  member = setup.others[0]!;
  other = (await owner.req('POST', '/projects', { name: '另一个项目' })).json<Project>();
}, 60_000);
afterAll(async () => {
  await t?.close();
});

async function mint(session: Session, scopes: string[], projectIds: string[] = []) {
  const r = await session.req('POST', '/auth/me/tokens', {
    name: '可靠性测试',
    scopes,
    projectIds,
  });
  expect(r.statusCode).toBe(201);
  return r.json<ApiTokenCreated>().token;
}
async function request(
  app: TestApp,
  token: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  key?: string,
) {
  return app.app.inject({
    method,
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) },
    ...(body === undefined ? {} : { payload: body as object }),
  });
}
async function tool(app: TestApp, token: string, name: string, args: Record<string, unknown>) {
  const response = await app.app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: { accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(response.statusCode).toBe(200);
  const result = response.json<{ result: { isError?: boolean; content: { text: string }[] } }>()
    .result;
  return { error: result.isError === true, data: JSON.parse(result.content[0]!.text) };
}

it('持久数据库重启后仍可重放同一任务且额度保持一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'srh-idempotency-'));
  const options = {
    DATABASE_URL: `pglite:${join(dir, 'db')}`,
    STORAGE_DIR: join(dir, 'storage'),
    API_TOKENS_ENABLED: 'true',
    MCP_ENABLED: 'true',
    MCP_WRITE_PER_DAY: '2',
  };
  let app: TestApp | undefined;
  try {
    app = await makeApp(options);
    const setup = await setupProject(app.app, []);
    const token = await mint(setup.owner, ['read', 'write'], [setup.project.id]);
    const path = `/projects/${setup.project.id}/todos`;
    const body = { title: '持久化任务' };
    const first = await request(app, token, 'POST', path, body, 'persistent_key_001');
    expect(first.statusCode).toBe(201);
    const id = first.json<Todo>().id;
    await app.close();
    app = undefined;
    app = await makeApp(options);
    const replay = await request(app, token, 'POST', path, body, 'persistent_key_001');
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json<Todo>().id).toBe(id);
    expect((await request(app, token, 'POST', path, { title: '第二次写入' })).statusCode).toBe(201);
    expect((await request(app, token, 'POST', path, { title: '第三次写入' })).statusCode).toBe(429);
    const items = await request(app, token, 'GET', path);
    expect(items.json<Todo[]>()).toHaveLength(2);
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 90_000);

it('大结果分段可完整还原并绑定令牌，分享撤回后不得继续读取', async () => {
  const document = (
    await owner.req('POST', `/projects/${project.id}/docs`, {
      title: '大份个人资料',
      kind: 'doc',
      space: 'personal',
    })
  ).json<DocumentMeta>();
  const content = `${'内容'.repeat(25_000)}独有结尾`;
  expect(
    (
      await owner.req('POST', `/projects/${project.id}/docs/${document.id}/edit`, {
        op: 'append',
        markdown: content,
      })
    ).statusCode,
  ).toBe(200);
  const grant = await owner.req(
    'POST',
    `/projects/${project.id}/shares/document/${document.id}/grants`,
    { userIds: [member.user.id], level: 'view' },
  );
  expect(grant.statusCode).toBe(200);
  const token = await mint(member, ['read'], [project.id]);
  const secondToken = await mint(member, ['read'], [project.id]);
  const operation = 'GET /projects/:projectId/docs/:docId/markdown';
  const result = await tool(t, token, 'read_operation', {
    operationId: operation,
    params: { projectId: project.id, docId: document.id },
  });
  expect(result.error).toBe(false);
  expect(result.data.segmented).toBe(true);
  const initial = result.data.data as {
    resultId: string;
    base64: string;
    nextOffset: number | null;
    size: number;
  };
  let next = initial.nextOffset;
  const parts = [Buffer.from(initial.base64, 'base64')];
  expect(
    (await request(t, secondToken, 'GET', `/integrations/results/${initial.resultId}/chunks`))
      .statusCode,
  ).toBe(404);
  while (next !== null) {
    const response = await request(
      t,
      token,
      'GET',
      `/integrations/results/${initial.resultId}/chunks?offset=${next}&limit=16384`,
    );
    expect(response.statusCode).toBe(200);
    const page = response.json<{ base64: string; nextOffset: number | null }>();
    parts.push(Buffer.from(page.base64, 'base64'));
    next = page.nextOffset;
  }
  const all = Buffer.concat(parts);
  expect(all.length).toBe(initial.size);
  expect((JSON.parse(all.toString()) as { markdown: string }).markdown).toContain(content);
  expect(
    (
      await owner.req(
        'DELETE',
        `/projects/${project.id}/shares/document/${document.id}/grants/${member.user.id}`,
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (await request(t, token, 'GET', `/integrations/results/${initial.resultId}/chunks?offset=0`))
      .statusCode,
  ).toBe(404);
  const metadata = await tool(t, token, 'describe_operation', { operationId: operation });
  expect(metadata.error).toBe(false);
  expect(JSON.stringify(metadata.data)).not.toContain('独有结尾');
  const denied = await tool(t, token, 'read_operation', {
    operationId: operation,
    params: { projectId: project.id, docId: document.id },
  });
  expect(denied.error).toBe(true);
  expect(JSON.stringify(denied.data)).not.toContain('独有结尾');
}, 30_000);

it('multipart 相同字段与字节在不同 boundary 下幂等，变更内容冲突', async () => {
  const token = await mint(owner, ['read', 'write'], [project.id]);
  const bytes = Buffer.from('外部文件内容');
  const send = (boundary: string, data: Buffer) => {
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\nuploads/retry.txt\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="retry.txt"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return t.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/files`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'idempotency-key': 'multipart_test_001',
      },
      payload,
    });
  };
  const first = await send('boundary_one', bytes);
  expect(first.statusCode).toBe(201);
  const replay = await send('boundary_two', bytes);
  expect(replay.statusCode).toBe(201);
  expect(replay.headers['idempotency-replayed']).toBe('true');
  expect(replay.json<FileObject>().id).toBe(first.json<FileObject>().id);
  expect((await send('boundary_three', Buffer.from('更改的内容'))).statusCode).toBe(409);
});

it('通用工具允许引用同项目文件上传，拒绝跨项目引用', async () => {
  const token = await mint(owner, ['read', 'write'], [project.id, other.id]);
  const data = Buffer.from('引用文件内容');
  const begin = await request(t, token, 'POST', '/integrations/transfers', {
    projectId: project.id,
    path: 'uploads/source.txt',
    size: data.length,
    sha256: sha(data),
  });
  expect(begin.statusCode).toBe(201);
  const id = begin.json<{ transferId: string }>().transferId;
  expect(
    (
      await request(t, token, 'PUT', `/integrations/transfers/${id}/chunks`, {
        offset: 0,
        base64: data.toString('base64'),
      })
    ).statusCode,
  ).toBe(200);
  const done = await request(t, token, 'POST', `/integrations/transfers/${id}/complete`);
  expect(done.statusCode).toBe(200);
  const file = done.json<FileObject>();
  const args = {
    operationId: 'POST /projects/:projectId/files',
    params: { projectId: project.id },
    transfer: {
      encoding: 'multipart',
      file: { filename: 'copy.txt', mimeType: 'text/plain', fileId: file.id },
      fields: { path: 'uploads/copy.txt' },
    },
  };
  const copy = await tool(t, token, 'write_operation', args);
  expect(copy.error).toBe(false);
  expect(copy.data.status).toBe(201);
  const downloaded = await request(
    t,
    token,
    'GET',
    `/projects/${project.id}/files/${copy.data.data.id}/chunks`,
  );
  expect(Buffer.from(downloaded.json<{ base64: string }>().base64, 'base64')).toEqual(data);
  const denied = await tool(t, token, 'write_operation', {
    ...args,
    params: { projectId: other.id },
  });
  expect(denied.error).toBe(true);
  expect(denied.data.error.code).toBe('not_found');
});
