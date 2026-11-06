import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  ApiTokenCreated,
  Project,
  ResearchItem,
  ResearchRecord,
  ResearchRun,
} from '@srh/shared';
import {
  setExecutionModel,
  setExecutionRunners,
  type ExecutionRunners,
} from '../src/modules/research/execution-runners';
import { makeApp, setupProject, sleep, type Session, type TestApp } from './helpers';

let t: TestApp;
let owner: Session;
let project: Project;
let serverUrl: string;
let planningCalls = 0;
const runners: ExecutionRunners = {
  async selectModel(_ctx, _projectId, _userId, requested) {
    return {
      model: requested.model ?? 'test/model',
      effort: requested.effort ?? 'high',
      profile: null,
      profilePrompt: null,
    };
  },
  async checkNotebook() {},
  async ai(_ctx, _projectId, _selection, input) {
    return {
      outputs: [
        { title: input.definition.title, content: '按主题整理的材料。', origin: 'ai_draft' },
      ],
      logs: [],
    };
  },
  async notebook() {
    throw new Error('不应执行 Notebook');
  },
};

beforeAll(async () => {
  t = await makeApp({
    API_TOKENS_ENABLED: 'true',
    MCP_ENABLED: 'true',
    API_TOKENS_RATE_PER_MINUTE: '500',
  });
  ({ owner, project } = await setupProject(t.app, []));
  setExecutionRunners(t.app.ctx, runners);
  setExecutionModel(t.app.ctx, {
    name: 'scripted',
    async chat() {
      planningCalls++;
      const content =
        planningCalls === 1
          ? { question: { questionId: 'q1', question: '希望如何整理？', reason: 'ambiguous' } }
          : {
              plan: {
                summary: '整理材料',
                steps: [
                  {
                    id: 'organize',
                    title: '整理',
                    operation: 'organize',
                    inputKeys: ['input:1'],
                    instructions: '归纳',
                  },
                ],
                outputs: [{ key: 'result', kind: 'note', stepId: 'organize' }],
              },
            };
      return {
        content: JSON.stringify(content),
        reasoning: '',
        toolCalls: [],
        usage: { input: 1, output: 1, cached: 0 },
        model: 'test/model',
        effort: 'high',
      };
    },
  });
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  serverUrl = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await t?.close();
});

async function token(scopes: string[]) {
  const response = await owner.req('POST', '/auth/me/tokens', {
    name: `澄清测试 ${scopes.join('-')}`,
    scopes,
    projectIds: [project.id],
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<ApiTokenCreated>().token;
}

async function connect(value: string) {
  const client = new Client({ name: 'clarification-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${serverUrl}/api/v1/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${value}` } },
    }),
  );
  return client;
}

async function invoke<T>(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).not.toBe(true);
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text) as { status: number; data: T };
}

it('可写令牌通过 MCP 回答自动处理澄清，只读令牌和人工确认受到限制', async () => {
  const writeToken = await token(['read', 'write']);
  const readToken = await token(['read']);
  const client = await connect(writeToken);
  const readClient = await connect(readToken);
  try {
    const workspace = await owner.req('POST', `/projects/${project.id}/research/workspaces`, {
      title: '澄清集成测试',
    });
    expect(workspace.statusCode, workspace.body).toBe(201);
    const recordId = workspace.json<ResearchRecord>().id;
    const base = `/projects/${project.id}/research/records/${recordId}`;
    const source = await owner.req('POST', `${base}/items`, {
      kind: 'note',
      title: '材料',
      body: '固定的原始材料。',
    });
    expect(source.statusCode, source.body).toBe(201);
    const actionResponse = await owner.req('POST', `${base}/items`, {
      kind: 'action',
      title: '自动整理',
      action: {
        kind: 'ai',
        instructions: '整理',
        inputItemIds: [source.json<ResearchItem>().id],
        processing: { mode: 'auto', expectedOutputs: ['note'] },
      },
    });
    expect(actionResponse.statusCode, actionResponse.body).toBe(201);
    const stepId = actionResponse.json<ResearchItem>().id;
    const params = { projectId: project.id, recordId };
    const started = await invoke<ResearchRun>(client, 'write_operation', {
      operationId: 'POST /projects/:projectId/research/records/:recordId/runs',
      params,
      body: { steps: [{ itemId: stepId }], idempotencyKey: 'clarify_start_001' },
    });
    expect(started.status).toBe(201);
    const runParams = { ...params, runId: started.data.id };
    async function waitFor(statuses: string[]) {
      for (let i = 0; i < 300; i++) {
        const current = await invoke<ResearchRun>(client, 'read_operation', {
          operationId: 'GET /projects/:projectId/research/records/:recordId/runs/:runId',
          params: runParams,
        });
        if (statuses.includes(current.data.status)) return current.data;
        await sleep(20);
      }
      throw new Error('运行未到达期望状态');
    }
    const waiting = await waitFor(['waiting', 'failed']);
    expect(waiting.status).toBe('waiting');
    expect(waiting.webUrl).toBe(`/p/${project.id}/research/${recordId}?item=${stepId}`);
    const step = waiting.steps[0]!;
    expect(step.waitingFor).toMatchObject({ kind: 'clarification', questionId: 'q1' });
    const version = step.attempts[0]!.processing!.version;
    const answerPath = `${base}/runs/${waiting.id}/steps/${stepId}/answer`;
    const answer = { questionId: 'q1', answer: '按主题整理', baseVersion: version };
    const stale = await t.app.inject({
      method: 'POST',
      url: `/api/v1${answerPath}`,
      headers: { authorization: `Bearer ${writeToken}` },
      payload: { ...answer, baseVersion: version + 1, idempotencyKey: 'clarify_stale_001' },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    const denied = await t.app.inject({
      method: 'POST',
      url: `/api/v1${answerPath}`,
      headers: { authorization: `Bearer ${readToken}` },
      payload: { ...answer, idempotencyKey: 'clarify_read_001' },
    });
    expect(denied.statusCode, denied.body).toBe(403);
    expect((await readClient.listTools()).tools.map((tool) => tool.name)).not.toContain(
      'write_operation',
    );
    const confirmPath = `${base}/runs/${waiting.id}/steps/${stepId}/confirm`;
    const confirm = await t.app.inject({
      method: 'POST',
      url: `/api/v1${confirmPath}`,
      headers: { authorization: `Bearer ${writeToken}` },
      payload: { note: '需要人工确认' },
    });
    expect(confirm.statusCode, confirm.body).toBe(403);
    const confirmMcp = await client.callTool({
      name: 'write_operation',
      arguments: {
        operationId:
          'POST /projects/:projectId/research/records/:recordId/runs/:runId/steps/:stepId/confirm',
        params: { ...runParams, stepId },
        body: { note: '需要人工确认' },
      },
    });
    expect(confirmMcp.isError).toBe(true);
    const saved = await invoke<ResearchRun>(client, 'write_operation', {
      operationId:
        'POST /projects/:projectId/research/records/:recordId/runs/:runId/steps/:stepId/answer',
      params: { ...runParams, stepId },
      body: { ...answer, idempotencyKey: 'clarify_answer_001' },
    });
    expect(saved.status).toBe(200);
    const done = await waitFor(['succeeded', 'failed']);
    expect(done.status).toBe('succeeded');
    expect(done.steps[0]!.attempts).toHaveLength(1);
    expect(done.steps[0]!.attempts[0]!.processing?.answers).toHaveLength(1);
    expect(done.steps[0]!.attempts[0]!.outputs[0]?.outputKey).toBe('result');
    expect(planningCalls).toBe(2);
  } finally {
    await readClient.close();
    await client.close();
  }
}, 30_000);
