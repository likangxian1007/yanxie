import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ApiTokenCreated, Project } from '@srh/shared';
import { makeApp, setupProject, signup, type Session, type TestApp } from './helpers';

let t: TestApp;
let owner: Session;
let project: Project;
let otherProject: Project;
let guest: Session;
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

beforeAll(async () => {
  t = await makeApp({ API_TOKENS_ENABLED: 'true' });
  const setup = await setupProject(t.app, ['guest']);
  ({ owner, project } = setup);
  guest = setup.others[0]!;
  otherProject = (await owner.req('POST', '/projects', { name: '其他项目' })).json<Project>();
}, 60_000);
afterAll(async () => {
  await t?.close();
});

async function mint(scopes: string[], projectIds = [project.id]) {
  return (
    await owner.req('POST', '/auth/me/tokens', { name: '传输测试', scopes, projectIds })
  ).json<ApiTokenCreated>();
}
function call(
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return t.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

it('分块上传可安全重试，摘要验证后才发布，并可分块下载', async () => {
  const token = await mint(['read', 'write']);
  const data = Buffer.from('分块内容 abcdef');
  const begin = await call(token.token, 'POST', '/integrations/transfers', {
    projectId: project.id,
    path: 'uploads/test.txt',
    size: data.length,
    sha256: sha(data),
  });
  expect(begin.statusCode).toBe(201);
  const { transferId } = begin.json<{ transferId: string }>();
  const url = `/integrations/transfers/${transferId}`;
  expect((await owner.req('GET', `/projects/${project.id}/files`)).json<unknown[]>()).toHaveLength(
    0,
  );
  const a = data.subarray(0, 6),
    b = data.subarray(6);
  expect(
    (await call(token.token, 'PUT', `${url}/chunks`, { offset: 0, base64: a.toString('base64') }))
      .statusCode,
  ).toBe(200);
  expect(
    (await call(token.token, 'PUT', `${url}/chunks`, { offset: 0, base64: a.toString('base64') }))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await call(token.token, 'PUT', `${url}/chunks`, {
        offset: 0,
        base64: Buffer.from('wrong!').toString('base64'),
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (await call(token.token, 'PUT', `${url}/chunks`, { offset: 6, base64: b.toString('base64') }))
      .statusCode,
  ).toBe(200);
  const done = await call(token.token, 'POST', `${url}/complete`);
  expect(done.statusCode).toBe(200);
  const file = done.json<{ id: string }>();
  expect((await call(token.token, 'POST', `${url}/complete`)).json()).toEqual(file);
  const first = await call(
    token.token,
    'GET',
    `/projects/${project.id}/files/${file.id}/chunks?offset=0&limit=5`,
  );
  expect(first.statusCode).toBe(200);
  const chunk = first.json<{ base64: string; nextOffset: number; sha256: string }>();
  const second = (
    await call(
      token.token,
      'GET',
      `/projects/${project.id}/files/${file.id}/chunks?offset=${chunk.nextOffset}&limit=262144`,
    )
  ).json<{ base64: string; nextOffset: number | null }>();
  expect(
    Buffer.concat([Buffer.from(chunk.base64, 'base64'), Buffer.from(second.base64, 'base64')]),
  ).toEqual(data);
  expect(chunk.sha256).toBe(sha(data));
  expect(second.nextOffset).toBeNull();
});

it('隔离令牌、项目和角色，并拒绝错误摘要及撤销令牌', async () => {
  const write = await mint(['read', 'write']);
  const read = await mint(['read']);
  const secondWrite = await mint(['read', 'write']);
  const stranger = await signup(t.app);
  const bytes = Buffer.from('wrong checksum');
  const spec = {
    projectId: project.id,
    path: 'bad.txt',
    size: bytes.length,
    sha256: '0'.repeat(64),
  };
  expect((await call(read.token, 'POST', '/integrations/transfers', spec)).statusCode).toBe(403);
  expect((await guest.req('POST', '/integrations/transfers', spec)).statusCode).toBe(403);
  expect((await stranger.req('POST', '/integrations/transfers', spec)).statusCode).toBe(404);
  expect(
    (
      await call(write.token, 'POST', '/integrations/transfers', {
        ...spec,
        projectId: otherProject.id,
      })
    ).statusCode,
  ).toBe(404);
  const begin = await call(write.token, 'POST', '/integrations/transfers', spec);
  const url = `/integrations/transfers/${begin.json<{ transferId: string }>().transferId}`;
  expect(
    (
      await call(read.token, 'PUT', `${url}/chunks`, {
        offset: 0,
        base64: bytes.toString('base64'),
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await call(secondWrite.token, 'PUT', `${url}/chunks`, {
        offset: 0,
        base64: bytes.toString('base64'),
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (await call(write.token, 'PUT', `${url}/chunks`, { offset: 0, base64: '!!!!' })).statusCode,
  ).toBe(400);
  expect(
    (
      await call(write.token, 'PUT', `${url}/chunks`, {
        offset: 1,
        base64: bytes.toString('base64'),
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await call(write.token, 'PUT', `${url}/chunks`, {
        offset: 0,
        base64: bytes.toString('base64'),
      })
    ).statusCode,
  ).toBe(200);
  expect((await call(write.token, 'POST', `${url}/complete`)).statusCode).toBe(409);
  expect(
    (await owner.req('GET', `/projects/${project.id}/files`))
      .json<{ path: string }[]>()
      .some((f) => f.path === 'bad.txt'),
  ).toBe(false);
  await owner.req('DELETE', `/auth/me/tokens/${write.apiToken.id}`);
  expect((await call(write.token, 'POST', `${url}/complete`)).statusCode).toBe(401);
});

it('并发完成相同路径的两个传输时只发布一个文件，不覆盖胜出的内容', async () => {
  const token = await mint(['read', 'write']);
  const data = [Buffer.from('first candidate'), Buffer.from('second candidate')];
  const ids = await Promise.all(
    data.map(async (bytes) => {
      const begin = await call(token.token, 'POST', '/integrations/transfers', {
        projectId: project.id,
        path: 'uploads/race.txt',
        size: bytes.length,
        sha256: sha(bytes),
      });
      expect(begin.statusCode).toBe(201);
      const id = begin.json<{ transferId: string }>().transferId;
      expect(
        (
          await call(token.token, 'PUT', `/integrations/transfers/${id}/chunks`, {
            offset: 0,
            base64: bytes.toString('base64'),
          })
        ).statusCode,
      ).toBe(200);
      return id;
    }),
  );
  const replies = await Promise.all(
    ids.map((id) => call(token.token, 'POST', `/integrations/transfers/${id}/complete`)),
  );
  expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 409]);
  const winner = replies.findIndex((reply) => reply.statusCode === 200);
  const file = replies[winner]!.json<{ id: string }>();
  const saved = await call(token.token, 'GET', `/projects/${project.id}/files/${file.id}/chunks`);
  expect(Buffer.from(saved.json<{ base64: string }>().base64, 'base64')).toEqual(data[winner]);
});
