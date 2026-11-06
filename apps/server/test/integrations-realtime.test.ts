import { once } from 'node:events';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { ApiTokenCreated, DocumentMeta, ServerFrame } from '@srh/shared';
import { makeApp, setupProject, signup, type TestApp } from './helpers';

let t: TestApp;
let base: string;

beforeAll(async () => {
  t = await makeApp({ API_TOKENS_ENABLED: 'true' });
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  base = `ws://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await t?.close();
});

it('项目归档后实时订阅退出，协同连接断开，分享用户不能重新连接', async () => {
  const { owner, project } = await setupProject(t.app, []);
  const outsider = await signup(t.app, '获分享者');
  const doc = (
    await owner.req('POST', `/projects/${project.id}/docs`, {
      title: '归档项目的个人文档',
      kind: 'latex',
      space: 'personal',
    })
  ).json<DocumentMeta>();
  const grant = await owner.req(
    'POST',
    `/projects/${project.id}/shares/document/${doc.id}/grants`,
    {
      emails: [outsider.user.email],
      level: 'edit',
    },
  );
  expect(grant.statusCode).toBe(200);
  const tokenResponse = await outsider.req('POST', '/auth/me/tokens', {
    name: '协同连接',
    scopes: ['read', 'write'],
    projectIds: [],
  });
  expect(tokenResponse.statusCode).toBe(201);
  const token = tokenResponse.json<ApiTokenCreated>().token;
  class AuthorizedSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, { headers: { authorization: `Bearer ${token}` } });
    }
  }
  const socket = new HocuspocusProviderWebsocket({
    url: `${base}/collab/${doc.id}`,
    WebSocketPolyfill: AuthorizedSocket,
  } as ConstructorParameters<typeof HocuspocusProviderWebsocket>[0]);
  const document = new Y.Doc();
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: doc.id,
    document,
    token: 'header-auth',
  });
  const frames: ServerFrame[] = [];
  const ws = await t.app.injectWS(
    '/ws',
    { headers: { cookie: owner.cookie } },
    {
      onInit: (s) =>
        s.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as ServerFrame)),
    },
  );
  const wait = async (condition: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('等待实时状态超时');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    const synced = new Promise<void>((resolve) => provider.on('synced', () => resolve()));
    provider.attach();
    await Promise.race([
      synced,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('同步超时')), 5000)),
    ]);
    await wait(() => frames.some((f) => f.op === 'ready'));
    ws.send(JSON.stringify({ op: 'subscribe', projectId: project.id, afterSeq: 0 }));
    await wait(() => frames.some((f) => f.op === 'subscribed'));
    const closed = new Promise<number>((resolve) =>
      socket.on('close', ({ event }: { event: { code: number } }) => resolve(event.code)),
    );
    expect((await owner.req('DELETE', `/projects/${project.id}`)).statusCode).toBe(204);
    expect(
      await Promise.race([
        closed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('协同连接未关闭')), 5000),
        ),
      ]),
    ).toBe(4205);
    await wait(() => frames.some((f) => f.op === 'error' && f.code === 'forbidden'));
    frames.length = 0;
    ws.send(JSON.stringify({ op: 'subscribe', projectId: project.id, afterSeq: 0 }));
    await wait(() => frames.some((f) => f.op === 'error' && f.code === 'forbidden'));
    const retry = new WebSocket(`${base}/collab/${doc.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await once(retry, 'close'))[0]).toBe(4404);
  } finally {
    ws.terminate();
    provider.destroy();
    socket.destroy();
    document.destroy();
  }
}, 20_000);
