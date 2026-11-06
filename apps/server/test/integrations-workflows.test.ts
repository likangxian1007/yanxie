import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as Y from 'yjs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  ActorRef,
  ApiTokenCreated,
  DocumentMeta,
  Message,
  Project,
  ResearchItem,
  ResearchRecord,
  ResearchRun,
  Thread,
  Todo,
} from '@srh/shared';
import { startAgentRuntime } from '../src/agents/runtime';
import type { ChatModel, ChatRequest, ChatResult } from '../src/agents/llm/complete';
import { setKernelManager } from '../src/modules/notebooks';
import type { KernelManager } from '../src/modules/notebooks/kernel/manager';
import { findCell } from '../src/modules/notebooks/nbformat';
import { withLiveDocument } from '../src/realtime/collab';
import { makeApp, setupProject, sleep, type Session, type TestApp } from './helpers';

let t: TestApp;
let owner: Session;
let project: Project;
let base: string;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

beforeAll(async () => {
  t = await makeApp({
    API_TOKENS_ENABLED: 'true',
    MCP_ENABLED: 'true',
    API_TOKENS_RATE_PER_MINUTE: '500',
  });
  ({ owner, project } = await setupProject(t.app, []));
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => {
  await t?.close();
});

async function connect() {
  const issued = await owner.req('POST', '/auth/me/tokens', {
    name: '通用工具工作流',
    scopes: ['read', 'write'],
    projectIds: [project.id],
  });
  expect(issued.statusCode).toBe(201);
  const token = issued.json<ApiTokenCreated>();
  const client = new Client({ name: 'srh-workflow-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/api/v1/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token.token}` } },
    }),
  );
  return client;
}
async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).not.toBe(true);
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text) as T;
}
type Invoked<T> = { status: number; data: T; segmented?: boolean };
const params = (extra: Record<string, string> = {}) => ({ projectId: project.id, ...extra });
async function read<T>(
  client: Client,
  operationId: string,
  pathParams: Record<string, string>,
  query?: Record<string, unknown>,
) {
  return call<Invoked<T>>(client, 'read_operation', {
    operationId,
    params: pathParams,
    ...(query ? { query } : {}),
  });
}
async function write<T>(
  client: Client,
  operationId: string,
  pathParams: Record<string, string>,
  body?: unknown,
) {
  return call<Invoked<T>>(client, 'write_operation', {
    operationId,
    params: pathParams,
    ...(body === undefined ? {} : { body }),
  });
}

it('官方 MCP 客户端独立完成文档、文件与待办工作流', async () => {
  const original = await owner.req('POST', `/projects/${project.id}/docs`, {
    title: '个人研究资料',
    kind: 'doc',
    space: 'personal',
  });
  expect(original.statusCode).toBe(201);
  const input = original.json<DocumentMeta>();
  expect(
    (
      await owner.req('POST', `/projects/${project.id}/docs/${input.id}/edit`, {
        op: 'append',
        markdown: '科研输入：三篇资料。',
      })
    ).statusCode,
  ).toBe(200);
  const client = await connect();
  try {
    const found = await call<{ operations: { id: string }[] }>(client, 'list_operations', {
      domain: 'docs',
      keyword: 'markdown',
    });
    expect(found.operations.map((x) => x.id)).toContain(
      'GET /projects/:projectId/docs/:docId/markdown',
    );
    const description = await call<{ effect: string; input: { params: string[] } }>(
      client,
      'describe_operation',
      { operationId: 'GET /projects/:projectId/docs/:docId/markdown' },
    );
    expect(description.effect).toBe('read');
    expect(description.input.params).toEqual(['projectId', 'docId']);
    const source = await read<{ markdown: string }>(
      client,
      'GET /projects/:projectId/docs/:docId/markdown',
      params({ docId: input.id }),
    );
    expect(source.data.markdown).toContain('三篇资料');
    const created = await write<DocumentMeta>(client, 'POST /projects/:projectId/docs', params(), {
      title: '外部工作流结果',
      kind: 'doc',
      space: 'personal',
    });
    expect(created.status).toBe(201);
    const docParams = params({ docId: created.data.id });
    await write(client, 'POST /projects/:projectId/docs/:docId/edit', docParams, {
      op: 'append',
      markdown: '已处理科研输入。',
    });
    expect(
      (
        await read<{ markdown: string }>(
          client,
          'GET /projects/:projectId/docs/:docId/markdown',
          docParams,
        )
      ).data.markdown,
    ).toContain('已处理科研输入');
    const bytes = Buffer.from('外部分析附件：已核验。');
    const begin = await write<{ transferId: string }>(
      client,
      'POST /integrations/transfers',
      {},
      {
        projectId: project.id,
        path: 'workflow/result.txt',
        size: bytes.length,
        sha256: sha(bytes),
      },
    );
    const transferParams = { transferId: begin.data.transferId };
    const cut = 8;
    await write(client, 'PUT /integrations/transfers/:transferId/chunks', transferParams, {
      offset: 0,
      base64: bytes.subarray(0, cut).toString('base64'),
    });
    await write(client, 'PUT /integrations/transfers/:transferId/chunks', transferParams, {
      offset: cut,
      base64: bytes.subarray(cut).toString('base64'),
    });
    const file = await write<{ id: string }>(
      client,
      'POST /integrations/transfers/:transferId/complete',
      transferParams,
    );
    const download = await read<{ base64: string; sha256: string; nextOffset: number | null }>(
      client,
      'GET /projects/:projectId/files/:fileId/chunks',
      params({ fileId: file.data.id }),
      { limit: 262144 },
    );
    expect(Buffer.from(download.data.base64, 'base64')).toEqual(bytes);
    expect(download.data.sha256).toBe(sha(bytes));
    expect(download.data.nextOffset).toBeNull();
    const todo = await write<Todo>(client, 'POST /projects/:projectId/todos', params(), {
      title: '检查外部分析',
    });
    const completed = await write<Todo>(
      client,
      'PATCH /projects/:projectId/todos/:todoId',
      params({ todoId: todo.data.id }),
      { done: true },
    );
    expect(completed.data.done).toBe(true);
  } finally {
    await client.close();
  }
}, 30_000);

it('Notebook 单元格、执行状态和导出通过 MCP 闭环（受控假内核）', async () => {
  const observed: string[][] = [];
  const fake = {
    available: true,
    async close() {},
    kernelStatus: () => 'idle',
    async enqueue(notebookId: string, _projectId: string, cellIds: string[], actor: ActorRef) {
      observed.push(cellIds);
      await withLiveDocument(t.app.ctx, notebookId, actor, (doc) => {
        for (const id of cellIds) {
          const cell = findCell(doc, id)?.cell;
          const output = cell?.get('outputs');
          if (output instanceof Y.Array)
            output.push([{ output_type: 'stream', name: 'stdout', text: '受控输出 42\n' }]);
          cell?.set('execution_count', 1);
        }
      });
      return cellIds.map((id) => ({
        runId: `fake-${id}`,
        state: 'queued' as const,
        by: actor,
        at: new Date().toISOString(),
      }));
    },
  };
  setKernelManager(t.app.ctx, fake as unknown as KernelManager);
  const client = await connect();
  try {
    const nb = await write<{ id: string }>(
      client,
      'POST /projects/:projectId/notebooks',
      params(),
      { title: '可编排计算' },
    );
    const p = params({ notebookId: nb.data.id });
    const contents = await read<{ contentHash: string; json: string }>(
      client,
      'GET /projects/:projectId/notebooks/:notebookId/contents',
      p,
    );
    const cellId = (JSON.parse(contents.data.json) as { cells: { id: string }[] }).cells[0]!.id;
    const edit = await write<{ contentHash: string }>(
      client,
      'POST /projects/:projectId/notebooks/:notebookId/cells',
      p,
      {
        contentHash: contents.data.contentHash,
        operations: [{ op: 'replace', cellId, source: 'print(42)' }],
      },
    );
    expect(edit.data.contentHash).not.toBe(contents.data.contentHash);
    const run = await write<{ runs: { runId: string }[] }>(
      client,
      'POST /projects/:projectId/notebooks/:notebookId/execute',
      p,
      { cellIds: [cellId] },
    );
    expect(run.data.runs[0]?.runId).toBe(`fake-${cellId}`);
    expect(observed).toEqual([[cellId]]);
    const execution = await read<{ json: string }>(
      client,
      'GET /projects/:projectId/notebooks/:notebookId/execution',
      p,
    );
    expect(execution.data.json).toContain('受控输出 42');
    const exported = await read<{ base64: string; encoding: string }>(
      client,
      'GET /projects/:projectId/notebooks/:notebookId/export',
      p,
      { format: 'py' },
    );
    expect(exported.segmented).not.toBe(true);
    expect(Buffer.from(exported.data.base64, 'base64').toString()).toContain('print(42)');
  } finally {
    await client.close();
  }
}, 30_000);

function round(req: ChatRequest) {
  let n = 0;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i]!.role === 'user') break;
    if (req.messages[i]!.role === 'assistant') n++;
  }
  return n;
}
const model: ChatModel = {
  name: 'workflow-scripted',
  async chat(req): Promise<ChatResult> {
    return {
      content: '',
      reasoning: '',
      toolCalls:
        round(req) === 0
          ? [
              {
                id: 'workflow-reply',
                name: 'reply',
                arguments: JSON.stringify({ body: '脚本化模型已完成处理。' }),
              },
            ]
          : [],
      usage: { input: 10, output: 1, cached: 0 },
      model: 'workflow-scripted',
    };
  },
};

it('通过 MCP 建立个人会话并读取真实运行时的脚本化模型回复', async () => {
  const runtime = startAgentRuntime(t.app.ctx, { model, tickMs: 60_000 });
  expect(runtime).not.toBeNull();
  const client = await connect();
  try {
    const thread = await write<Thread>(client, 'POST /projects/:projectId/threads', params(), {
      body: '请整理研究材料。',
    });
    for (let i = 0; i < 6; i++) await runtime!.idle();
    const sessions = await read<{ id: string; threadId: string; status: string }[]>(
      client,
      'GET /projects/:projectId/agents',
      params(),
    );
    const session = sessions.data.find((s) => s.threadId === thread.data.id);
    expect(session).toBeTruthy();
    const detail = await read<{ id: string; webUrl?: string }>(
      client,
      'GET /projects/:projectId/agents/:sessionId',
      params({ sessionId: session!.id }),
    );
    expect(detail.data.id).toBe(session!.id);
    expect(detail.data.webUrl).toBe(`/p/${project.id}/threads/${thread.data.id}`);
    const messages = await read<{ items: Message[] }>(
      client,
      'GET /projects/:projectId/threads/:threadId/messages',
      params({ threadId: thread.data.id }),
      { order: 'asc' },
    );
    expect(messages.data.items.some((m) => m.body.includes('脚本化模型已完成处理'))).toBe(true);
  } finally {
    await runtime?.stop();
    await client.close();
  }
}, 30_000);

it('人工确认只能由网页登录完成，MCP 可以查询等待和完成状态', async () => {
  const client = await connect();
  try {
    const workspace = await write<ResearchRecord>(
      client,
      'POST /projects/:projectId/research/workspaces',
      params(),
      { title: '人工核对工作流' },
    );
    const p = params({ recordId: workspace.data.id });
    const item = await write<ResearchItem>(
      client,
      'POST /projects/:projectId/research/records/:recordId/items',
      p,
      {
        kind: 'action',
        title: '人工核验',
        action: { kind: 'human', instructions: '由研究者核对', inputItemIds: [] },
      },
    );
    const run = await write<ResearchRun>(
      client,
      'POST /projects/:projectId/research/records/:recordId/runs',
      p,
      { steps: [{ itemId: item.data.id }], idempotencyKey: 'human_workflow_001' },
    );
    const runParams = { ...p, runId: run.data.id };
    let status = run.data.status;
    for (let i = 0; i < 100 && status !== 'waiting'; i++) {
      await sleep(30);
      status = (
        await read<ResearchRun>(
          client,
          'GET /projects/:projectId/research/records/:recordId/runs/:runId',
          runParams,
        )
      ).data.status;
    }
    expect(status).toBe('waiting');
    const waiting = await read<ResearchRun>(
      client,
      'GET /projects/:projectId/research/records/:recordId/runs/:runId',
      runParams,
    );
    expect(waiting.data.webUrl).toBe(
      `/p/${project.id}/research/${workspace.data.id}?item=${item.data.id}`,
    );
    const restWaiting = await owner.req(
      'GET',
      `/projects/${project.id}/research/records/${workspace.data.id}/runs/${run.data.id}`,
    );
    expect(restWaiting.json<ResearchRun>().webUrl).toBe(waiting.data.webUrl);
    const denied = await client.callTool({
      name: 'write_operation',
      arguments: {
        operationId:
          'POST /projects/:projectId/research/records/:recordId/runs/:runId/steps/:stepId/confirm',
        params: { ...runParams, stepId: item.data.id },
        body: { note: '不能代签' },
      },
    });
    expect(denied.isError).toBe(true);
    const confirmed = await owner.req(
      'POST',
      `/projects/${project.id}/research/records/${workspace.data.id}/runs/${run.data.id}/steps/${item.data.id}/confirm`,
      { note: '本人已核对' },
    );
    expect(confirmed.statusCode).toBe(200);
    for (let i = 0; i < 100 && status !== 'succeeded'; i++) {
      await sleep(30);
      status = (
        await read<ResearchRun>(
          client,
          'GET /projects/:projectId/research/records/:recordId/runs/:runId',
          runParams,
        )
      ).data.status;
    }
    expect(status).toBe('succeeded');
  } finally {
    await client.close();
  }
}, 30_000);
