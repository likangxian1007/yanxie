import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { ApiTokenCreated, Paper, PaperNote, ShareSettings } from '@srh/shared';
import { makeApp, setupProject, type Session, type TestApp } from '../helpers';
import { importByRef } from '../../src/modules/library/service';
import { noteAccess, noteState } from '../../src/modules/library/notes';
import { qaState } from '../../src/modules/library/qa-records';
import { documentConnections } from '../../src/realtime/collab';
import { canSeeResourceEvent, setPersonalAudience } from '../../src/realtime/audience';
import {
  papers,
  paperChunks,
  paperAnnotations,
  paperQaSessions,
  paperQaTurns,
} from '../../src/db/schema';
import { setLibraryLlmForTest } from '../../src/modules/library/llm';
import { waitForQaJobs } from '../../src/modules/library/qa-jobs';
import { invalidateIndex } from '../../src/modules/library/search';
import type { LlmClient } from '../../src/agents/llm/client';

let t: TestApp, owner: Session, member: Session, pid: string;
let personal: Paper, account: Paper;
const actor = (s: Session) => ({ kind: 'user' as const, id: s.user.id, name: s.user.name });
const route = (id: string) => `/projects/${pid}/library/papers/${id}`;
beforeAll(async () => {
  t = await makeApp({ API_TOKENS_ENABLED: 'true' });
  const setup = await setupProject(t.app, ['member']);
  owner = setup.owner;
  member = setup.others[0]!;
  pid = setup.project.id;
}, 60_000);
afterAll(async () => {
  await t?.close();
});

it('账号个人库、项目内个人库和团队库可保存同一篇论文，互不混用', async () => {
  const input = { doi: '10.1234/scope-compatibility' };
  const a = await importByRef(t.app.ctx, actor(owner), pid, input, owner.user.id);
  const b = await importByRef(
    t.app.ctx,
    actor(owner),
    { kind: 'personal', ownerUserId: owner.user.id },
    input,
  );
  personal = (await owner.req('GET', route(a.row.id))).json<Paper>();
  account = (await owner.req('GET', `/library/papers/${b.row.id}`)).json<Paper>();
  expect(personal).toMatchObject({ projectId: pid, space: 'personal', ownerUserId: owner.user.id });
  expect(account).toMatchObject({ projectId: null, space: 'personal', ownerUserId: owner.user.id });
  expect((await member.req('GET', route(personal.id))).statusCode).toBe(404);
  expect((await member.req('GET', `/library/papers/${account.id}`)).statusCode).toBe(404);
  const candidates = await owner.req(
    'GET',
    `/library/papers/${account.id}/publish-targets?projectId=${pid}`,
  );
  expect(candidates.statusCode).toBe(200);
  expect(candidates.json()).toEqual([]);
});

it('项目内个人论文的笔记、标注和问答沿用分享权限，关闭分享立即失效', async () => {
  const created = await owner.req('POST', route(personal.id) + '/notes', {
    title: '私人笔记',
    kind: 'note',
    body: '仅授权人员阅读',
  });
  expect(created.statusCode, created.body).toBe(201);
  const note = created.json<PaperNote>();
  for (const suffix of ['/notes', '/annotations', '/qa/sessions'])
    expect((await member.req('GET', route(personal.id) + suffix)).statusCode).toBe(404);
  expect(await noteAccess(t.app.ctx, note.id, member.user.id)).toBe('none');
  const shared = (
    await owner.req('PATCH', `/projects/${pid}/shares/paper/${personal.id}/link`, {
      scope: 'project',
      level: 'view',
    })
  ).json<ShareSettings>();
  expect((await member.req('POST', `/share/${shared.link.token}`)).statusCode).toBe(200);
  expect((await member.req('GET', route(personal.id) + '/notes')).statusCode).toBe(200);
  expect(
    (
      await member.req('POST', route(personal.id) + '/notes', {
        title: '不允许修改',
        kind: 'note',
        body: '',
      })
    ).statusCode,
  ).toBe(403);
  expect(await noteAccess(t.app.ctx, note.id, member.user.id)).toBe('view');
  await owner.req('PATCH', `/projects/${pid}/shares/paper/${personal.id}/link`, { level: 'edit' });
  expect(
    (
      await member.req('POST', route(personal.id) + '/notes', {
        title: '授权编辑',
        kind: 'note',
        body: '',
      })
    ).statusCode,
  ).toBe(201);
  expect(await noteAccess(t.app.ctx, note.id, member.user.id)).toBe('edit');
  await owner.req('PATCH', `/projects/${pid}/shares/paper/${personal.id}/link`, {
    scope: 'invited',
  });
  expect(await noteAccess(t.app.ctx, note.id, member.user.id)).toBe('none');
});

it('新协作事件只发给对应私人论文的授权受众', () => {
  setPersonalAudience(personal.id, owner.user.id);
  for (const type of [
    'paper.notes.changed',
    'paper.annotations.changed',
    'paper.qa.changed',
  ] as const) {
    const event = { type, projectId: pid, payload: { paperId: personal.id } } as Parameters<
      typeof canSeeResourceEvent
    >[1];
    expect(canSeeResourceEvent(owner.user.id, event)).toBe(true);
    expect(canSeeResourceEvent(member.user.id, event)).toBe(false);
  }
});

it('撤销论文分享会断开已同步且空闲的笔记、批注、问答连接', async () => {
  const note = (
    await owner.req('POST', route(personal.id) + '/notes', {
      title: '撤销连接测试',
      kind: 'note',
      body: '初始笔记',
    })
  ).json<PaperNote>();
  const annotationId = `lan_${randomUUID()}`,
    sessionId = `lqs_${randomUUID()}`,
    turnId = `lqt_${randomUUID()}`;
  await t.db.db.insert(paperAnnotations).values({
    id: annotationId,
    paperId: personal.id,
    kind: 'comment',
    fileId: 'test-pdf',
    page: 1,
    quote: 'evidence',
    boxes: [],
    body: '初始批注',
    ydocState: noteState('初始批注'),
    createdBy: actor(owner),
    updatedBy: actor(owner),
  });
  await t.db.db.insert(paperQaSessions).values({
    id: sessionId,
    paperId: personal.id,
    title: '测试',
    createdBy: actor(owner),
    updatedBy: actor(owner),
  });
  await t.db.db.insert(paperQaTurns).values({
    id: turnId,
    sessionId,
    paperId: personal.id,
    generationId: randomUUID(),
    requestId: randomUUID(),
    requestSignature: 'test',
    requestedByUserId: owner.user.id,
    question: '问题',
    originalQuestion: '问题',
    answer: '回答',
    modelName: '测试模型',
    status: 'done',
    ydocState: qaState('问题', '回答'),
    createdBy: actor(owner),
    updatedBy: actor(owner),
  });
  const shared = (
    await owner.req('PATCH', `/projects/${pid}/shares/paper/${personal.id}/link`, {
      scope: 'project',
      level: 'edit',
    })
  ).json<ShareSettings>();
  expect((await member.req('POST', `/share/${shared.link.token}`)).statusCode).toBe(200);
  const base = (await t.app.listen({ host: '127.0.0.1', port: 0 })).replace('http:', 'ws:');
  const closed = new Set<string>();
  const clients = [note.id, annotationId, turnId].map((id) => {
    class CookieSocket extends WebSocket {
      constructor(address: string | URL) {
        super(address, { headers: { cookie: member.cookie } });
        this.on('close', () => closed.add(id));
      }
    }
    const doc = new Y.Doc();
    const socket = new HocuspocusProviderWebsocket({
      url: `${base}/collab/${id}`,
      WebSocketPolyfill: CookieSocket,
    } as ConstructorParameters<typeof HocuspocusProviderWebsocket>[0]);
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: id,
      document: doc,
      token: 'cookie',
    });
    provider.attach();
    return { id, doc, socket, provider };
  });
  try {
    await vi.waitFor(
      () => {
        for (const c of clients) {
          expect(c.provider.synced).toBe(true);
          expect(documentConnections(t.app.ctx, c.id)).toContainEqual({
            userId: member.user.id,
            readOnly: false,
          });
        }
      },
      { timeout: 7000 },
    );
    expect(closed.size).toBe(0);
    expect(
      (
        await owner.req('PATCH', `/projects/${pid}/shares/paper/${personal.id}/link`, {
          scope: 'invited',
        })
      ).statusCode,
    ).toBe(200);
    await vi.waitFor(() => expect(closed.size).toBe(3), { timeout: 7000 });
    await vi.waitFor(
      () => {
        for (const c of clients) expect(documentConnections(t.app.ctx, c.id)).toEqual([]);
      },
      { timeout: 7000 },
    );
  } finally {
    for (const c of clients) {
      c.provider.destroy();
      c.socket.destroy();
      c.doc.destroy();
    }
  }
}, 25000);

it('限项目令牌不能借账号个人库入口读写私人资料，非受限只读令牌不能写入', async () => {
  const limited = (
    await owner.req('POST', '/auth/me/tokens', {
      name: '范围测试',
      scopes: ['read', 'write'],
      projectIds: [pid],
      expiresInDays: 1,
    })
  ).json<ApiTokenCreated>();
  const readonly = (
    await owner.req('POST', '/auth/me/tokens', {
      name: '只读测试',
      scopes: ['read'],
      projectIds: [],
      expiresInDays: 1,
    })
  ).json<ApiTokenCreated>();
  for (const suffix of [
    '',
    `/${account.id}`,
    `/${account.id}/notes`,
    `/${account.id}/annotations`,
    `/${account.id}/qa/sessions`,
  ]) {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/library/papers' + suffix,
      headers: { authorization: `Bearer ${limited.token}` },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.message).toBe('这个操作需要在网页中完成');
  }
  const denied = await t.app.inject({
    method: 'POST',
    url: `/api/v1/library/papers/${account.id}/publish`,
    headers: { authorization: `Bearer ${readonly.token}` },
    payload: { projectId: pid, requestId: randomUUID(), sourceUpdatedAt: account.updatedAt },
  });
  expect(denied.statusCode).toBe(403);
});

it('团队持久问答不把提问者的私人论文写入共享回答上下文', async () => {
  const team = await importByRef(t.app.ctx, actor(owner), pid, { doi: '10.1234/team-evidence' });
  for (const [paperId, text] of [
    [
      team.row.id,
      'Experiment evidence from shared observations is reproducible and available to the entire team.',
    ],
    [
      personal.id,
      'Experiment confidential private observation PRIVATE_ONLY_MARKER must remain private to the owner.',
    ],
  ]) {
    await t.db.db.update(papers).set({ status: 'ready' }).where(eq(papers.id, paperId!));
    await t.db.db.insert(paperChunks).values({
      id: paperId + ':0',
      paperId: paperId!,
      projectId: pid,
      seq: 0,
      kind: 'paragraph',
      page: 1,
      para: 1,
      text: text!,
    });
  }
  invalidateIndex(t.app.ctx, pid);
  const prompts: string[] = [];
  setLibraryLlmForTest(t.app.ctx, {
    model: 'local-test',
    reasoningModel: 'local-test',
    client: {
      chat: {
        completions: {
          async create(body: { stream?: boolean; messages: { content: string }[] }) {
            if (!body.stream) return { choices: [{ message: { content: 'experiment' } }] };
            prompts.push(body.messages.map((m) => m.content).join('\n'));
            return (async function* () {
              yield { choices: [{ delta: { content: '仅使用团队公开材料。' } }] };
            })();
          },
        },
      },
    } as unknown as LlmClient['client'],
  });
  const session = (
    await owner.req('POST', route(team.row.id) + '/qa/sessions', { title: '团队验证' })
  ).json<{ id: string }>();
  const asked = await owner.req('POST', route(team.row.id) + `/qa/sessions/${session.id}/turns`, {
    requestId: randomUUID(),
    question: 'experiment',
    searchScope: 'all',
  });
  expect(asked.statusCode, asked.body).toBe(202);
  await waitForQaJobs(t.app.ctx);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('shared observations');
  expect(prompts[0]).not.toContain('PRIVATE_ONLY_MARKER');
});
