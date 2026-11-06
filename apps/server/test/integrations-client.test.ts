import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ApiTokenCreated, DocumentMeta, Message, Project, Todo } from '@srh/shared';
import { makeApp, setupProject, type Session, type TestApp } from './helpers';

let t: TestApp;
let owner: Session;
let project: Project;
let base: string;

beforeAll(async () => {
  t = await makeApp({ API_TOKENS_ENABLED: 'true', MCP_ENABLED: 'true' });
  ({ owner, project } = await setupProject(t.app, []));
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await t?.close();
});

async function mint() {
  const res = await owner.req('POST', '/auth/me/tokens', {
    name: '客户端验证',
    projectIds: [project.id],
    scopes: ['read', 'write'],
  });
  expect(res.statusCode).toBe(201);
  return res.json<ApiTokenCreated>();
}

it('官方 MCP HTTP 客户端完成读取个人上下文、回写结果、创建任务，再由 REST 完成任务', async () => {
  const token = await mint();
  const created = await owner.req('POST', `/projects/${project.id}/docs`, {
    title: '个人输入',
    kind: 'doc',
    space: 'personal',
  });
  expect(created.statusCode).toBe(201);
  const d = created.json<DocumentMeta>();
  expect(
    (
      await owner.req('POST', `/projects/${project.id}/docs/${d.id}/edit`, {
        op: 'append',
        markdown: '已核对三篇资料。',
      })
    ).statusCode,
  ).toBe(200);
  const client = new Client({ name: 'srh-personal-workflow-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/api/v1/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token.token}` } },
    }),
  );
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    const content = result.content as { type: string; text: string }[];
    return JSON.parse(content[0]!.text) as T;
  };
  try {
    expect((await client.listTools()).tools.map((x) => x.name)).toContain('read_document');
    expect((await call<Project[]>('list_projects', {})).map((x) => x.id)).toEqual([project.id]);
    const context = await call<{ documents: { id: string }[] }>('get_project', {
      projectId: project.id,
    });
    expect(context.documents.map((x) => x.id)).toContain(d.id);
    const document = await call<{ markdown: string }>('read_document', {
      projectId: project.id,
      documentId: d.id,
    });
    expect(document.markdown).toContain('三篇资料');
    const message = await call<Message>('post_message', {
      projectId: project.id,
      body: '外部分析结果：资料已核对。',
      agentVisible: false,
    });
    expect(message.agentVisible).toBe(false);
    expect(message.meta).toMatchObject({ viaToken: { id: token.apiToken.id } });
    const todo = await call<Todo>('create_todo', { projectId: project.id, title: '复核分析结果' });
    const done = await fetch(`${base}/api/v1/projects/${project.id}/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ done: true }),
    });
    expect(done.status).toBe(200);
    expect(((await done.json()) as Todo).done).toBe(true);
    await owner.req('DELETE', `/auth/me/tokens/${token.apiToken.id}`);
    await expect(client.listTools()).rejects.toThrow();
  } finally {
    await client.close();
  }
}, 30_000);

it('真实 Yjs 协同连接同步后，撤销令牌立即断开', async () => {
  const token = await mint();
  const d = (
    await owner.req('POST', `/projects/${project.id}/docs`, {
      title: '协同撤销验证',
      kind: 'latex',
    })
  ).json<DocumentMeta>();
  class AuthorizedSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, { headers: { authorization: `Bearer ${token.token}` } });
    }
  }
  const socket = new HocuspocusProviderWebsocket({
    url: `${base.replace('http:', 'ws:')}/collab/${d.id}`,
    WebSocketPolyfill: AuthorizedSocket,
  } as ConstructorParameters<typeof HocuspocusProviderWebsocket>[0]);
  const document = new Y.Doc();
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: d.id,
    document,
    token: 'header-auth',
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const synced = new Promise<void>((resolve, reject) => {
      provider.on('synced', () => resolve());
      timer = setTimeout(() => reject(new Error('协同同步超时')), 5000);
    });
    provider.attach();
    await synced;
    clearTimeout(timer);
    const closed = new Promise<number>((resolve, reject) => {
      socket.on('close', ({ event }: { event: { code: number } }) => resolve(event.code));
      timer = setTimeout(() => reject(new Error('撤销后协同连接未关闭')), 2000);
    });
    await owner.req('DELETE', `/auth/me/tokens/${token.apiToken.id}`);
    expect(await closed).toBe(4401);
  } finally {
    clearTimeout(timer);
    provider.destroy();
    socket.destroy();
    document.destroy();
  }
}, 15_000);
