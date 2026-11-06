import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ApiTokenCreated, Notebook } from '@srh/shared';
import { makeApp, setupProject, type Session, type TestApp } from './helpers';

let t: TestApp;
let owner: Session;
let projectId: string;
let notebookId: string;
let readToken: string;
let writeToken: string;

type Page = { json: string; contentHash: string; nextOffset: number | null; totalLength: number };
type Snapshot = { cells: { id: string; source: string }[] };

async function request(token: string, method: 'GET' | 'POST', suffix: string, payload?: object) {
  return t.app.inject({
    method,
    url: `/api/v1/projects/${projectId}/notebooks/${notebookId}${suffix}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });
}

beforeAll(async () => {
  t = await makeApp({ API_TOKENS_ENABLED: 'true' });
  const setup = await setupProject(t.app, []);
  owner = setup.owner;
  projectId = setup.project.id;
  const nb = await owner.req('POST', `/projects/${projectId}/notebooks`, { title: '外部工作流' });
  expect(nb.statusCode).toBe(201);
  notebookId = nb.json<Notebook>().id;
  const mint = async (scopes: string[]) => {
    const res = await owner.req('POST', '/auth/me/tokens', {
      name: 'Notebook 测试',
      projectIds: [projectId],
      scopes,
    });
    expect(res.statusCode).toBe(201);
    return res.json<ApiTokenCreated>().token;
  };
  readToken = await mint(['read']);
  writeToken = await mint(['read', 'write']);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

it('支持结构化编辑、长内容分段读取，并拒绝失效快照和部分操作', async () => {
  const first = (await request(readToken, 'GET', '/contents')).json<Page>();
  const initial = JSON.parse(first.json) as Snapshot;
  const cellId = initial.cells[0]!.id;
  const change = {
    contentHash: first.contentHash,
    operations: [{ op: 'replace', cellId, source: 'x'.repeat(21_000) + '结尾' }],
  };
  expect((await request(readToken, 'POST', '/cells', change)).statusCode).toBe(403);
  expect((await request(writeToken, 'POST', '/cells', change)).statusCode).toBe(200);
  expect((await request(writeToken, 'POST', '/cells', change)).statusCode).toBe(409);
  const page = (await request(readToken, 'GET', '/contents?limit=10000')).json<Page>();
  let json = page.json;
  let next = page.nextOffset;
  while (next !== null) {
    const response = await request(
      readToken,
      'GET',
      `/contents?limit=10000&offset=${next}&contentHash=${page.contentHash}`,
    );
    expect(response.statusCode).toBe(200);
    const part = response.json<Page>();
    json += part.json;
    next = part.nextOffset;
  }
  expect(json.length).toBe(page.totalLength);
  expect((JSON.parse(json) as Snapshot).cells[0]!.source).toContain('结尾');
  const bad = await request(writeToken, 'POST', '/cells', {
    contentHash: page.contentHash,
    operations: [
      { op: 'replace', cellId, source: '不应生效' },
      { op: 'delete', cellId: 'missing' },
    ],
  });
  expect(bad.statusCode).toBe(404);
  expect(
    (await request(readToken, 'GET', `/contents?contentHash=${page.contentHash}`)).statusCode,
  ).toBe(200);
  const execute = await request(readToken, 'GET', '/execution');
  expect(execute.statusCode).toBe(200);
  expect(JSON.parse(execute.json<Page>().json)).toMatchObject({
    kernel: { status: 'unavailable' },
    runs: {},
    cells: [{ id: cellId, outputs: [] }],
  });
}, 20_000);

it('限定项目的令牌不能读取范围外 Notebook', async () => {
  const other = await owner.req('POST', '/projects', { name: '另一个课题' });
  const otherId = other.json<{ id: string }>().id;
  const nb = await owner.req('POST', `/projects/${otherId}/notebooks`, { title: '范围外' });
  const res = await t.app.inject({
    method: 'GET',
    url: `/api/v1/projects/${otherId}/notebooks/${nb.json<Notebook>().id}/contents`,
    headers: { authorization: `Bearer ${readToken}` },
  });
  expect(res.statusCode).toBe(404);
});
