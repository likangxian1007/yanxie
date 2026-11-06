import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Message, Page, Paper, Thread } from '@srh/shared';
import { agentSessions, llmProviders } from '../src/db/schema';
import { startAgentRuntime, type AgentRuntime } from '../src/agents/runtime';
import { setLibraryDepsForTest } from '../src/modules/library/pipeline';
import { ParserUnavailable } from '../src/modules/library/parser';
import { waitForQueueIdle } from '../src/modules/library/queue';
import { makeApp, setupProject, type Session, type TestApp } from './helpers';
import { tinyPdf } from './library/util';

let t: TestApp,
  owner: Session,
  other: Session,
  pid: string,
  runtime: AgentRuntime | null,
  server: Server;
const calls: {
  model: string;
  messages: { role: string; content: string }[];
  tools?: unknown[];
  stream?: boolean;
}[] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'quartz, experiment' }, finish_reason: 'stop' }],
        }),
      );
      return;
    }
    const hasReply = body.messages.some((m: { role: string }) => m.role === 'tool');
    const delta =
      body.tools && !hasReply
        ? {
            tool_calls: [
              {
                index: 0,
                id: 'call_test_reply',
                type: 'function',
                function: { name: 'reply', arguments: JSON.stringify({ body: '个人模型已回复' }) },
              },
            ],
          }
        : { content: body.tools ? '' : 'quartz 结果有依据 [p.1 ¶1]' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  t = await makeApp();
  // 没有任何环境模型时先启动，再添加数据库里的项目模型。
  runtime = startAgentRuntime(t.app.ctx, { tickMs: 60_000 });
  const team = await setupProject(t.app, ['member']);
  owner = team.owner;
  other = team.others[0]!;
  pid = team.project.id;
  await t.db.db.insert(llmProviders).values({
    id: 'provider_local_test',
    projectId: pid,
    name: '本地测试服务',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    thinkingFormat: 'none',
    createdBy: { kind: 'user', id: owner.user.id, name: owner.user.name },
    models: ['first', 'chosen'].map((model) => ({
      model,
      name: model,
      description: null,
      efforts: ['off'] as ['off'],
      defaultEffort: 'off' as const,
    })),
  });
  setLibraryDepsForTest(t.app.ctx, {
    parser: () => ({
      name: 'grobid',
      url: 'http://parser.test',
      probe: async () => ({ reachable: false, version: null }),
      parse: async () => {
        throw new ParserUnavailable('测试纯文本');
      },
    }),
  });
}, 60_000);

afterAll(async () => {
  await runtime?.stop();
  await t?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('个人工作区与个人文献的项目模型调用（真实 HTTP、隔离假服务）', () => {
  it('仅数据库模型也能启动；第一轮使用选定模型，回复仍是私人的', async () => {
    expect(runtime).not.toBeNull();
    const res = await owner.req('POST', `/projects/${pid}/threads`, {
      body: 'PRIVATE_SESSION_SENTINEL',
      model: 'provider_local_test/chosen',
    });
    expect(res.statusCode, res.body).toBe(201);
    const thread = res.json<Thread>();
    await runtime!.idle();
    const [session] = await t.db.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, thread.agentSessionId!));
    expect(session).toMatchObject({ model: 'provider_local_test/chosen', status: 'idle' });
    const selectedCalls = calls.filter((c) =>
      c.messages.some((m) => m.content?.includes('PRIVATE_SESSION_SENTINEL')),
    );
    expect(selectedCalls.length).toBeGreaterThan(0);
    expect(selectedCalls.every((c) => c.model === 'chosen')).toBe(true);
    const messages = (
      await owner.req('GET', `/projects/${pid}/threads/${thread.id}/messages`)
    ).json<Page<Message>>();
    expect(messages.items.some((m) => m.body === '个人模型已回复')).toBe(true);
    expect((await other.req('GET', `/projects/${pid}/threads/${thread.id}`)).statusCode).toBe(404);
    const timeline = (await owner.req('GET', `/projects/${pid}/timeline`)).json<Page<Message>>();
    expect(
      timeline.items.some(
        (m) => m.body.includes('PRIVATE_SESSION_SENTINEL') || m.body === '个人模型已回复',
      ),
    ).toBe(false);
  });
  it('不指定模型选择项目默认，显式无权或禁用模型拒绝，不能静默换到别的服务', async () => {
    const res = await owner.req('POST', `/projects/${pid}/threads`, { body: '使用默认模型' });
    expect(res.statusCode).toBe(201);
    await runtime!.idle();
    const [session] = await t.db.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, res.json<Thread>().agentSessionId!));
    expect(session?.model).toBe('provider_local_test/first');
    expect(
      (
        await owner.req('POST', `/projects/${pid}/threads`, {
          body: '不能发送',
          model: 'other/secret',
        })
      ).statusCode,
    ).toBe(422);
    await t.db.db
      .update(llmProviders)
      .set({ enabled: false })
      .where(eq(llmProviders.id, 'provider_local_test'));
    try {
      expect(
        (
          await owner.req('POST', `/projects/${pid}/threads`, {
            body: '不能发送',
            model: 'provider_local_test/chosen',
          })
        ).statusCode,
      ).toBe(422);
    } finally {
      await t.db.db
        .update(llmProviders)
        .set({ enabled: true })
        .where(eq(llmProviders.id, 'provider_local_test'));
    }
  });
  it('个人文献状态与问答使用项目模型，关键词与回答走同一个允许的服务', async () => {
    const boundary = '----model-test';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="paper.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      tinyPdf([
        [{ x: 72, y: 720, text: 'quartz experiment evidence in the private paper', size: 12 }],
      ]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploaded = await t.app.inject({
      method: 'POST',
      url: '/api/v1/library/papers',
      payload,
      headers: {
        cookie: owner.cookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    await waitForQueueIdle(t.app.ctx);
    const paper = uploaded.json<{ paper: Paper }>().paper;
    const status = await owner.req('GET', '/library/status');
    expect(status.json()).toMatchObject({ llm: true, reachable: false });
    const start = calls.length;
    const answer = await owner.req('POST', '/library/qa', {
      question: 'quartz 实验说明了什么？',
      paperId: paper.id,
    });
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.body).toContain('quartz 结果有依据');
    expect(calls.slice(start)).toHaveLength(2);
    expect(calls.slice(start).every((c) => c.model === 'first')).toBe(true);
    expect(
      (await other.req('POST', '/library/qa', { question: 'quartz?', paperId: paper.id }))
        .statusCode,
    ).toBe(404);
  });
});
