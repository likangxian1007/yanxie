import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newId,
  type AnyProjectEvent,
  type ApiTokenCreated,
  type DocumentMeta,
  type Thread,
} from '@srh/shared';
import { documents, inboxItems, messages } from '../src/db/schema';
import { operationCatalog } from '../src/app';
import { authenticateBearer } from '../src/modules/integrations/service';
import { resultPermissionVersion, stageOperationResult } from '../src/modules/integrations/results';
import { makeApp, setupProject, type Session, type TestApp } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await makeApp({ API_TOKENS_ENABLED: 'true', MCP_ENABLED: 'true' });
}, 60_000);
afterAll(async () => {
  await t?.close();
});

async function mint(session: Session): Promise<string> {
  const response = await session.req('POST', '/auth/me/tokens', {
    name: '缓存回归',
    scopes: ['read', 'write'],
    projectIds: [],
  });
  expect(response.statusCode).toBe(201);
  return response.json<ApiTokenCreated>().token;
}
async function call(
  token: string,
  operationId: string,
  params: Record<string, string> = {},
  query?: Record<string, unknown>,
) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'read_operation',
        arguments: { operationId, params, ...(query ? { query } : {}) },
      },
    },
  });
  expect(response.statusCode).toBe(200);
  const result = response.json<{ result: { isError?: boolean; content: { text: string }[] } }>()
    .result;
  expect(result.isError).not.toBe(true);
  const envelope = JSON.parse(result.content[0]!.text) as {
    segmented: boolean;
    data: { resultId: string; base64: string; nextOffset: number | null };
  };
  expect(envelope.segmented).toBe(true);
  expect(envelope.data.nextOffset).not.toBeNull();
  return envelope.data;
}
async function chunk(token: string, resultId: string, offset = 0) {
  return t.app.inject({
    method: 'GET',
    url: `/api/v1/integrations/results/${resultId}/chunks?offset=${offset}`,
    headers: { authorization: `Bearer ${token}` },
  });
}
async function decodeResult(
  token: string,
  initial: { resultId: string; base64: string; nextOffset: number | null },
) {
  const chunks = [Buffer.from(initial.base64, 'base64')];
  let next = initial.nextOffset;
  while (next !== null) {
    const response = await chunk(token, initial.resultId, next);
    expect(response.statusCode).toBe(200);
    const part = response.json<{ base64: string; nextOffset: number | null }>();
    chunks.push(Buffer.from(part.base64, 'base64'));
    next = part.nextOffset;
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
async function scene() {
  const setup = await setupProject(t.app, ['member']);
  return { owner: setup.owner, member: setup.others[0]!, project: setup.project };
}

describe('缓存续读权限变化', () => {
  it('全局收件箱的大结果在成员被移出后失效', async () => {
    const { owner, member, project } = await scene();
    const token = await mint(member);
    await t.db.db.insert(inboxItems).values(
      Array.from({ length: 100 }, (_, i) => ({
        id: newId('inbox'),
        projectId: project.id,
        userId: member.user.id,
        kind: 'mention' as const,
        title: `提醒 ${i} ${'大'.repeat(400)}`,
        href: '/',
        sourceId: `large-${i}`,
      })),
    );
    const result = await call(token, 'GET /inbox');
    const saved = (await decodeResult(token, result)) as { projectId: string }[];
    expect(saved.some((item) => item.projectId === project.id)).toBe(true);
    expect(
      (await owner.req('DELETE', `/projects/${project.id}/members/${member.user.id}`)).statusCode,
    ).toBe(204);
    expect((await chunk(token, result.resultId, result.nextOffset!)).statusCode).toBe(404);
  }, 30_000);

  it('大文档列表的共享权限撤回后失效', async () => {
    const { owner, member, project } = await scene();
    const privateDoc = (
      await owner.req('POST', `/projects/${project.id}/docs`, {
        title: '仅分享的私人文档',
        kind: 'doc',
        space: 'personal',
      })
    ).json<DocumentMeta>();
    expect(
      (
        await owner.req('POST', `/projects/${project.id}/shares/document/${privateDoc.id}/grants`, {
          userIds: [member.user.id],
          level: 'view',
        })
      ).statusCode,
    ).toBe(200);
    await t.db.db.insert(documents).values(
      Array.from({ length: 250 }, (_, i) => ({
        id: newId('document'),
        projectId: project.id,
        kind: 'doc' as const,
        title: `团队文档 ${i} ${'长'.repeat(150)}`,
        createdBy: { kind: 'user' as const, id: owner.user.id, name: owner.user.name },
        space: 'team' as const,
      })),
    );
    const token = await mint(member);
    const result = await call(token, 'GET /projects/:projectId/docs', { projectId: project.id });
    const saved = (await decodeResult(token, result)) as { id: string }[];
    expect(saved.some((doc) => doc.id === privateDoc.id)).toBe(true);
    expect(
      (
        await owner.req(
          'DELETE',
          `/projects/${project.id}/shares/document/${privateDoc.id}/grants/${member.user.id}`,
        )
      ).statusCode,
    ).toBe(200);
    expect((await chunk(token, result.resultId, result.nextOffset!)).statusCode).toBe(404);
  }, 30_000);

  it('分享链接幂等重放支持只读分享，撤回后拒绝旧结果', async () => {
    const { owner, member, project } = await scene();
    const document = (
      await owner.req('POST', `/projects/${project.id}/docs`, {
        title: '链接可见',
        kind: 'doc',
        space: 'personal',
      })
    ).json<DocumentMeta>();
    const link = await owner.req(
      'PATCH',
      `/projects/${project.id}/shares/document/${document.id}/link`,
      { scope: 'project', level: 'view' },
    );
    expect(link.statusCode).toBe(200);
    const shareToken = link.json<{ link: { token: string } }>().link.token;
    const token = await mint(member);
    const send = () =>
      t.app.inject({
        method: 'POST',
        url: `/api/v1/share/${shareToken}`,
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'share_replay_test_01' },
      });
    const first = await send();
    expect(first.statusCode).toBe(200);
    const replay = await send();
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(
      (
        await owner.req('PATCH', `/projects/${project.id}/shares/document/${document.id}/link`, {
          scope: 'invited',
        })
      ).statusCode,
    ).toBe(200);
    expect((await send()).statusCode).toBe(404);
  });

  it('删除个人线程后不能继续读取缓存的大消息页', async () => {
    const { owner, project } = await scene();
    const response = await owner.req('POST', `/projects/${project.id}/threads`, {
      body: '个人会话',
    });
    expect(response.statusCode).toBe(201);
    const thread = response.json<Thread>();
    const sessions = await owner.req('GET', `/projects/${project.id}/agents`);
    expect(sessions.statusCode).toBe(200);
    const session = sessions
      .json<{ id: string; threadId: string | null }[]>()
      .find((item) => item.threadId === thread.id);
    expect(session).toBeDefined();
    expect(
      (await owner.req('POST', `/projects/${project.id}/agents/${session!.id}/stop`)).statusCode,
    ).toBe(200);
    await t.db.db.insert(messages).values(
      Array.from({ length: 8 }, (_, i) => ({
        id: newId('message'),
        projectId: project.id,
        threadId: thread.id,
        authorKind: 'user' as const,
        authorId: owner.user.id,
        authorName: owner.user.name,
        body: `第 ${i} 条 ${'正文'.repeat(6000)}`,
      })),
    );
    const token = await mint(owner);
    const result = await call(
      token,
      'GET /projects/:projectId/threads/:threadId/messages',
      { projectId: project.id, threadId: thread.id },
      { limit: 20 },
    );
    const saved = (await decodeResult(token, result)) as { items: { body: string }[] };
    expect(saved.items.some((item) => item.body.includes('正文'))).toBe(true);
    expect(
      (await owner.req('DELETE', `/projects/${project.id}/threads/${thread.id}`)).statusCode,
    ).toBe(204);
    expect((await chunk(token, result.resultId, result.nextOffset!)).statusCode).toBe(404);
  }, 30_000);

  it('写入幂等目标取业务正文，不能由无关查询参数替换资源权限', async () => {
    const { owner, member, project } = await scene();
    const privateDoc = (
      await owner.req('POST', `/projects/${project.id}/docs`, {
        title: '私人版本',
        kind: 'doc',
        space: 'personal',
      })
    ).json<DocumentMeta>();
    const publicDoc = (
      await owner.req('POST', `/projects/${project.id}/docs`, { title: '公开诱饵', kind: 'doc' })
    ).json<DocumentMeta>();
    expect(
      (
        await owner.req('POST', `/projects/${project.id}/shares/document/${privateDoc.id}/grants`, {
          userIds: [member.user.id],
          level: 'edit',
        })
      ).statusCode,
    ).toBe(200);
    const token = await mint(member);
    const body = { targetKind: 'document', targetId: privateDoc.id, note: '私人版本备注' };
    const query = { targetKind: 'document', targetId: publicDoc.id };
    const url = `/api/v1/projects/${project.id}/versions?${new URLSearchParams(query)}`;
    const headers = {
      authorization: `Bearer ${token}`,
      'idempotency-key': 'private_version_target_01',
    };
    const send = () => t.app.inject({ method: 'POST', url, headers, payload: body });
    expect((await send()).statusCode).toBe(201);
    expect(
      (
        await owner.req(
          'DELETE',
          `/projects/${project.id}/shares/document/${privateDoc.id}/grants/${member.user.id}`,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await member.req('GET', `/projects/${project.id}/docs/${publicDoc.id}`)).statusCode,
    ).toBe(200);
    expect((await send()).statusCode).toBe(404);
    const replay = await t.app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'write_operation',
          arguments: {
            operationId: 'POST /projects/:projectId/versions',
            params: { projectId: project.id },
            query,
            body,
            idempotencyKey: 'private_version_target_01',
          },
        },
      },
    });
    const result = replay.json<{ result: { isError?: boolean; content: { text: string }[] } }>()
      .result;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).error.code).toBe('not_found');
  }, 30_000);

  it('权限事件都清空暂存，读取与暂存之间发生权限变化时不返回旧结果', async () => {
    const { owner, project } = await scene();
    const token = await mint(owner);
    const auth = await authenticateBearer(t.app.ctx, token);
    const op = operationCatalog(t.app.ctx).get('GET /projects/:projectId')!;
    const types = [
      'project.updated',
      'member.joined',
      'member.updated',
      'member.removed',
      'share.updated',
      'thread.deleted',
      'document.deleted',
      'paper.deleted',
      'notebook.deleted',
      'file.deleted',
    ] as const;
    for (const type of types) {
      const before = resultPermissionVersion(t.app.ctx);
      const staged = stageOperationResult(
        t.app.ctx,
        auth,
        op,
        { projectId: project.id },
        Buffer.alloc(70_000, 1),
        'application/octet-stream',
        before,
      );
      const payload =
        type === 'member.joined' || type === 'member.updated'
          ? { user: owner.user, role: 'owner' }
          : type === 'member.removed'
            ? { userId: 'usr_cache_absent' }
            : type === 'project.updated'
              ? project
              : type === 'share.updated'
                ? { resourceKind: 'document', resourceId: 'doc_cache_absent' }
                : { id: 'cache_absent' };
      const event = {
        seq: 1,
        projectId: project.id,
        threadId: null,
        type,
        payload,
        actor: { kind: 'user', id: owner.user.id, name: owner.user.name },
        createdAt: new Date().toISOString(),
      } as unknown as AnyProjectEvent;
      t.app.ctx.bus.emit(event);
      expect(resultPermissionVersion(t.app.ctx)).toBe(before + 1);
      expect((await chunk(token, staged.resultId)).statusCode).toBe(404);
      expect(() =>
        stageOperationResult(
          t.app.ctx,
          auth,
          op,
          { projectId: project.id },
          Buffer.alloc(70_000, 1),
          'application/octet-stream',
          before,
        ),
      ).toThrow(/权限发生变化/u);
    }
  }, 30_000);
});
