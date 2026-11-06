import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { YDOC_FIELD, type DocumentMeta } from '@srh/shared';
import { collab } from '../../src/agents/tools/collab-port';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createDb, type DbHandle } from '../../src/db/client';
import { migrationsFolder } from '../../src/db/migrate';
import { agentSessions, documents, projectMembers, projects, users } from '../../src/db/schema';
import { AGENT_PRESENCE_MS } from '../../src/realtime/collab';
import { setupCollabApp, type CollabTestApp } from './helpers';

const PID = 'prj_presence';
const base = `/api/v1/projects/${PID}`;

const waitFor = async (check: () => boolean, ms = 4000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('超时');
    await new Promise((r) => setTimeout(r, 25));
  }
};

interface AwarenessUser {
  id: string;
  name: string;
  kind: 'user' | 'agent';
}

// ---------------------------------------------------------------- agent 在线状态（表 #9）

describe('agent 编辑时的 awareness（头像 + 光标，写完停留几秒）', () => {
  let t: CollabTestApp;
  let url = '';

  beforeAll(async () => {
    t = await setupCollabApp();
    await t.seedUser('usr_a', '张三', 1);
    await t.seedProject(PID, 'usr_a');
    await t.allowAgentDirectWrite(PID);
    await t.db.db.insert(agentSessions).values({
      id: 'ses_presence',
      projectId: PID,
      role: 'thread',
      model: 'test',
      workingForUserId: 'usr_a',
    });
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = t.app.server.address() as AddressInfo;
    url = `ws://127.0.0.1:${port}/collab`;
  }, 60_000);
  afterAll(async () => {
    await t?.close();
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
    return {
      doc,
      provider,
      synced,
      close() {
        provider.destroy();
        socket.destroy();
      },
    };
  }

  function agentState(p: HocuspocusProvider) {
    for (const state of p.awareness?.getStates().values() ?? []) {
      const s = state as { user?: AwarenessUser; cursor?: { anchor: unknown; head: unknown } };
      if (s.user?.kind === 'agent') return s;
    }
    return null;
  }

  async function createDoc(body: Record<string, unknown>): Promise<DocumentMeta> {
    const res = await t.app.inject({
      method: 'POST',
      url: `${base}/docs`,
      headers: t.as('usr_a'),
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  it('富文本：agent 写入期间出现「张三的 agent」和指向新内容的光标，约 6 秒后消失', async () => {
    const meta = await createDoc({ kind: 'doc', markdown: '# 计划\n\n## 背景\n\n旧的背景' });
    const a = connect(meta.id, 'usr_a');
    await a.synced;
    expect(agentState(a.provider)).toBeNull();

    const actor = { kind: 'agent' as const, id: 'ses_presence', name: '研协' };
    await collab('documents')!.applyEdit(t.app.ctx, actor, PID, meta.id, {
      op: 'append',
      markdown: '## 方法\n\nagent 写的方法段',
    });
    await waitFor(() => agentState(a.provider)?.cursor != null);
    const s = agentState(a.provider)!;
    expect(s.user).toMatchObject({ id: 'agent:ses_presence', name: '张三的 agent', kind: 'agent' });

    // 光标能在客户端文档里解析，并且落在 agent 写的那段文字里（正文 fragment 之内）
    await waitFor(() =>
      a.doc.getXmlFragment(YDOC_FIELD.doc).toString().includes('agent 写的方法段'),
    );
    const rel = Y.createRelativePositionFromJSON(s.cursor!.head);
    const abs = Y.createAbsolutePositionFromRelativePosition(rel, a.doc);
    expect(abs).not.toBeNull();
    expect(abs!.type).toBeInstanceOf(Y.XmlText);
    expect(abs!.type.toString()).toContain('agent 写的方法段');
    expect(abs!.index).toBe((abs!.type as Y.XmlText).length);
    const fragment = a.doc.getXmlFragment(YDOC_FIELD.doc);
    expect(Y.isParentOf(fragment, abs!.type._item)).toBe(true);

    // 写完后停留一会儿（不是一闪而过），之后自动消失
    await new Promise((r) => setTimeout(r, 1000));
    expect(agentState(a.provider)).not.toBeNull();
    await waitFor(() => agentState(a.provider) === null, AGENT_PRESENCE_MS + 3000);
    a.close();
  }, 20_000);

  it('LaTeX：光标是 Y.Text 里的相对位置（y-codemirror 可用）；没有代表成员的 agent 用 actor 名', async () => {
    const meta = await createDoc({ kind: 'latex', markdown: '\\section{A}\n' });
    const a = connect(meta.id, 'usr_a');
    await a.synced;
    const actor = { kind: 'agent' as const, id: 'ses_unknown', name: '协调者' };
    await collab('documents')!.applyEdit(t.app.ctx, actor, PID, meta.id, {
      op: 'append',
      markdown: '\\section{B}',
    });
    await waitFor(() => agentState(a.provider)?.cursor != null);
    const s = agentState(a.provider)!;
    expect(s.user?.name).toBe('协调者');
    // 先实例化 Y.Text（根类型是懒创建的），再解析相对位置
    const text = a.doc.getText(YDOC_FIELD.latex);
    await waitFor(() => text.toString().includes('\\section{B}'));
    const abs = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(s.cursor!.anchor),
      a.doc,
    );
    expect(abs?.type).toBe(text);
    // 光标落在 agent 追加的 \section{B} 之后
    expect(text.toString().slice(0, abs!.index)).toContain('\\section{B}');
    a.close();
  }, 15_000);
});

// ---------------------------------------------------------------- REALTIME_DEV_ANON（表 #11）

describe('REALTIME_DEV_ANON=true：匿名请求不再被当成负责人', () => {
  let db: DbHandle;
  let app: FastifyInstance;
  let url = '';
  const ANON_PID = 'prj_anon';

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'pglite:memory',
      LOG_LEVEL: 'silent',
      LLM_API_KEY: '',
      STORAGE_DIR: '.data/test-storage',
      REALTIME_DEV_ANON: 'true',
    });
    db = await createDb(config.DATABASE_URL);
    await db.migrate(migrationsFolder());
    app = await buildApp({ config, db, logger: false });
    await app.ready();
    await db.db
      .insert(users)
      .values({ id: 'usr_o', email: 'o@example.com', name: '负责人', passwordHash: 'x' });
    await db.db.insert(projects).values({ id: ANON_PID, name: '课题', createdBy: 'usr_o' });
    await db.db
      .insert(projectMembers)
      .values({ projectId: ANON_PID, userId: 'usr_o', role: 'owner' });
    await db.db.insert(documents).values({
      id: 'doc_anon',
      projectId: ANON_PID,
      kind: 'latex',
      title: '机密',
      contentText: '机密内容',
      createdBy: { kind: 'user', id: 'usr_o', name: '负责人' },
      updatedBy: { kind: 'user', id: 'usr_o', name: '负责人' },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    url = `ws://127.0.0.1:${port}/collab`;
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await db?.close();
  });

  it.each([
    ['GET', `/api/v1/projects/${ANON_PID}/docs`],
    ['GET', `/api/v1/projects/${ANON_PID}/docs/doc_anon/markdown`],
    ['POST', `/api/v1/projects/${ANON_PID}/docs`],
    ['GET', `/api/v1/projects/${ANON_PID}/notebooks`],
    ['GET', `/api/v1/projects/${ANON_PID}/todos`],
  ])('REST %s %s 不带 Cookie → 401', async (method, path) => {
    const res = await app.inject({
      method: method as 'GET' | 'POST',
      url: path,
      ...(method === 'POST' ? { payload: { title: '匿名创建' } } : {}),
    });
    expect(res.statusCode).toBe(401);
  });

  it('/collab 不带 Cookie → 4401，连不上', async () => {
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${url}/doc_anon`);
      ws.on('close', (c) => resolve(c));
    });
    expect(code).toBe(4401);
  });
});
