import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newId,
  type ApiTokenCreated,
  type DocumentMeta,
  type Message,
  type Project,
  type Thread,
} from '@srh/shared';
import { changeProposals, events, inboxItems, versions } from '../src/db/schema';
import { makeApp, setupProject, type Session, type TestApp } from './helpers';

let t: TestApp;
let owner: Session;
let member: Session;
let project: Project;
let token: string;
const actor = () => ({ kind: 'user' as const, id: owner.user.id, name: owner.user.name });

beforeAll(async () => {
  t = await makeApp({ API_TOKENS_ENABLED: 'true', MCP_ENABLED: 'true' });
  const setup = await setupProject(t.app, ['member']);
  owner = setup.owner;
  member = setup.others[0]!;
  project = setup.project;
  const minted = await member.req('POST', '/auth/me/tokens', {
    name: '分页测试',
    scopes: ['read'],
    projectIds: [project.id],
  });
  expect(minted.statusCode).toBe(201);
  token = minted.json<ApiTokenCreated>().token;
}, 60_000);
afterAll(async () => {
  await t?.close();
});

async function read(operationId: string, query: Record<string, unknown> = {}) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
    },
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'read_operation',
        arguments: {
          operationId,
          params: operationId.includes(':projectId') ? { projectId: project.id } : {},
          query,
        },
      },
    },
  });
  expect(response.statusCode).toBe(200);
  const result = response.json<{ result: { isError?: boolean; content: { text: string }[] } }>()
    .result;
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0]!.text) as {
    status: number;
    data: unknown;
    continuation?: { afterSeq: number };
    segmented?: boolean;
  };
}

async function allData(envelope: Awaited<ReturnType<typeof read>>): Promise<unknown> {
  if (!envelope.segmented) return envelope.data;
  const first = envelope.data as { resultId: string; base64: string; nextOffset: number | null };
  const parts = [Buffer.from(first.base64, 'base64')];
  let next = first.nextOffset;
  while (next !== null) {
    const response = await t.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/results/${first.resultId}/chunks?offset=${next}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const part = response.json<{ base64: string; nextOffset: number | null }>();
    parts.push(Buffer.from(part.base64, 'base64'));
    next = part.nextOffset;
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
}

describe('个人 Agent 读取完整列表和事件游标', () => {
  it('不可见个人线程事件占满整页时 REST 与 MCP 都能继续扫描', async () => {
    const created = await owner.req('POST', `/projects/${project.id}/threads`, {
      body: '私密讨论',
    });
    expect(created.statusCode).toBe(201);
    const thread = created.json<Thread>();
    const [last] = await t.db.db
      .select({ seq: events.seq })
      .from(events)
      .where(eq(events.projectId, project.id))
      .orderBy(desc(events.seq))
      .limit(1);
    const afterSeq = last?.seq ?? 0;
    const hidden = await owner.req(
      'POST',
      `/projects/${project.id}/threads/${thread.id}/messages`,
      { body: '私人内容', agentVisible: false },
    );
    expect(hidden.statusCode).toBe(201);
    const visible = await owner.req('POST', `/projects/${project.id}/timeline`, {
      body: '公开内容',
      agentVisible: false,
    });
    expect(visible.statusCode).toBe(201);
    const publicId = visible.json<Message>().id;
    const path = `/projects/${project.id}/events`;
    const first = await member.req('GET', `${path}?afterSeq=${afterSeq}&limit=2`);
    expect(first.statusCode).toBe(200);
    expect(first.json<unknown[]>()).toEqual([]);
    const next = Number(first.headers['x-next-event-seq']);
    expect(next).toBeGreaterThan(afterSeq);
    const second = await member.req('GET', `${path}?afterSeq=${next}&limit=10`);
    expect(second.statusCode).toBe(200);
    expect(
      second.json<{ payload: { id?: string } }[]>().some((event) => event.payload.id === publicId),
    ).toBe(true);
    const mcpFirst = await read('GET /projects/:projectId/events', { afterSeq, limit: 2 });
    expect(mcpFirst.data).toEqual([]);
    expect(mcpFirst.continuation?.afterSeq).toBe(next);
    const mcpSecond = await read('GET /projects/:projectId/events', { afterSeq: next, limit: 10 });
    expect(
      (mcpSecond.data as { payload: { id?: string } }[]).some(
        (event) => event.payload.id === publicId,
      ),
    ).toBe(true);
  }, 30_000);

  it('收件箱超过 500 条时 REST 与 MCP 均保留最早条目', async () => {
    const ids = Array.from({ length: 501 }, () => newId('inbox'));
    await t.db.db.insert(inboxItems).values(
      ids.map((id, i) => ({
        id,
        projectId: project.id,
        userId: member.user.id,
        kind: 'mention' as const,
        title: `分页提醒 ${i}`,
        href: '/',
        sourceId: `pagination-${i}`,
        createdAt: new Date(i === 0 ? '2020-01-01T00:00:00Z' : '2024-01-01T00:00:00Z'),
      })),
    );
    const rest = await member.req('GET', `/inbox?projectId=${project.id}`);
    expect(rest.statusCode).toBe(200);
    const rows = rest.json<{ id: string }[]>();
    expect(rows.length).toBeGreaterThanOrEqual(501);
    expect(rows.some((item) => item.id === ids[0])).toBe(true);
    const mcp = (await allData(await read('GET /inbox', { projectId: project.id }))) as {
      id: string;
    }[];
    expect(mcp.length).toBeGreaterThanOrEqual(501);
    expect(mcp.some((item) => item.id === ids[0])).toBe(true);
  }, 30_000);

  it('版本超过 200 条和提案超过 100 条时不会丢失最早记录', async () => {
    const created = await owner.req('POST', `/projects/${project.id}/docs`, {
      kind: 'doc',
      title: '分页目标',
    });
    expect(created.statusCode).toBe(201);
    const doc = created.json<DocumentMeta>();
    const versionIds = Array.from({ length: 201 }, () => newId('version'));
    await t.db.db.insert(versions).values(
      versionIds.map((id, i) => ({
        id,
        projectId: project.id,
        targetKind: 'document' as const,
        targetId: doc.id,
        kind: 'manual' as const,
        note: `版本 ${i}`,
        content: { format: 'text', unit: 'block', language: 'markdown', text: '' },
        contentHash: `hash-${i}`,
        createdBy: actor(),
        createdAt: new Date(i === 0 ? '2020-01-01T00:00:00Z' : '2024-01-01T00:00:00Z'),
      })),
    );
    const proposalIds = Array.from({ length: 101 }, () => newId('proposal'));
    await t.db.db.insert(changeProposals).values(
      proposalIds.map((id, i) => ({
        id,
        projectId: project.id,
        targetKind: 'document' as const,
        targetId: doc.id,
        title: `提案 ${i}`,
        author: actor(),
        baseState: Buffer.alloc(0),
        draftState: Buffer.alloc(0),
        hunks: [],
        updatedAt: new Date(i === 0 ? '2020-01-01T00:00:00Z' : '2024-01-01T00:00:00Z'),
      })),
    );
    for (const [path, operation, sentinel, expected] of [
      [
        `/projects/${project.id}/versions`,
        'GET /projects/:projectId/versions',
        versionIds[0]!,
        201,
      ],
      [
        `/projects/${project.id}/proposals`,
        'GET /projects/:projectId/proposals',
        proposalIds[0]!,
        101,
      ],
    ] as const) {
      const query = { targetKind: 'document', targetId: doc.id };
      const rest = await member.req('GET', `${path}?targetKind=document&targetId=${doc.id}`);
      expect(rest.statusCode).toBe(200);
      const rows = rest.json<{ id: string }[]>();
      expect(rows.length).toBeGreaterThanOrEqual(expected);
      expect(rows.some((item) => item.id === sentinel)).toBe(true);
      const mcp = (await allData(await read(operation, query))) as { id: string }[];
      expect(mcp.length).toBeGreaterThanOrEqual(expected);
      expect(mcp.some((item) => item.id === sentinel)).toBe(true);
    }
  }, 60_000);
});
