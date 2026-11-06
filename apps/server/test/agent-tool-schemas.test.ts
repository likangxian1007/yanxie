import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentSession, Message, Page } from '@srh/shared';
import { createChatModel } from '../src/agents/llm/complete';
import { startAgentRuntime } from '../src/agents/runtime';
import { ALL_TOOLS } from '../src/agents/tools';
import { defineTool, toolSpec } from '../src/agents/tools/types';
import { makeApp, setupProject } from './helpers';

describe('模型接口的工具参数契约', () => {
  it('所有内置工具都公开 object 参数，联合分支不能代替顶层对象', () => {
    for (const tool of ALL_TOOLS) {
      const { parameters } = toolSpec(tool);
      expect(parameters.type, tool.name).toBe('object');
      expect(parameters.properties, tool.name).toBeDefined();
      expect(parameters, tool.name).not.toHaveProperty('anyOf');
      expect(parameters, tool.name).not.toHaveProperty('oneOf');
    }
  });

  it('模型仍能看到各分支字段与嵌套参数，只把共同必填字段设为顶层必填', () => {
    const read = toolSpec(ALL_TOOLS.find((tool) => tool.name === 'research_read')!).parameters;
    expect(Object.keys(read.properties as object)).toEqual(
      expect.arrayContaining(['record_id', 'include_evidence', 'kind', 'source_id', 'snapshot_id']),
    );
    expect(read.required).toEqual([]);
    const create = toolSpec(ALL_TOOLS.find((tool) => tool.name === 'research_create')!).parameters;
    expect(create.required).toEqual(['kind', 'input']);
    expect(create.properties).toMatchObject({
      kind: { anyOf: [{ const: 'record' }, { const: 'source' }] },
      input: { anyOf: [{ type: 'object' }, { type: 'object' }] },
    });
  });

  it('生成模型参数不改变局部更新的原始分支及默认值', () => {
    const tool = ALL_TOOLS.find((tool) => tool.name === 'research_finding')!;
    const input = {
      op: 'update',
      record_id: 'record_a',
      finding_id: 'finding_a',
      base_version: 1,
      input: { statement: '修订结论' },
    };
    const before = tool.schema.parse(input);
    toolSpec(tool);
    expect(tool.schema.parse(input)).toEqual(before);
    expect((before as typeof input).input).toEqual({ statement: '修订结论' });
  });

  it('保留 MCP 提供的 object schema，不替换其属性及限制', () => {
    const jsonSchema = {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    };
    const tool = defineTool({
      name: 'mcp_example',
      description: '外部工具',
      roles: ['coordinator'],
      schema: z.object({}).passthrough(),
      jsonSchema,
      run: async (_tc, input) => input,
    });
    expect(toolSpec(tool).parameters).toBe(jsonSchema);
  });

  it.each([
    ['research_read', { record_id: 'record_a' }, { include_evidence: true }],
    ['research_read', { kind: 'source', source_id: 'source_a' }, { source_id: 'source_a' }],
    [
      'research_read',
      { kind: 'snapshot', snapshot_id: 'snapshot_a' },
      { snapshot_id: 'snapshot_a' },
    ],
    [
      'research_code',
      { op: 'update', record_id: 'record_a', code_id: 'code_a', base_version: 1, group: null },
      { group: null },
    ],
    [
      'research_finding',
      {
        op: 'update',
        record_id: 'record_a',
        finding_id: 'finding_a',
        base_version: 1,
        input: { statement: '修订结论' },
      },
      { input: { statement: '修订结论' } },
    ],
  ])('%s 保留既有调用格式与默认值', (name, input, expected) => {
    const tool = ALL_TOOLS.find((tool) => tool.name === name)!;
    expect(tool.schema.parse(input)).toMatchObject(expected);
  });

  it.each([
    ['research_read', {}],
    ['research_read', { kind: 'source', snapshot_id: 'snapshot_a' }],
    ['research_create', { kind: 'source', input: { title: '缺少来源类型' } }],
    ['research_code', { op: 'update', record_id: 'record_a', input: { name: '不能代替版本号' } }],
    [
      'research_finding',
      { op: 'update', record_id: 'record_a', input: { statement: '缺少发现与版本' } },
    ],
  ])('%s 的分支校验没有因模型参数兼容而放宽', (name, input) => {
    expect(ALL_TOOLS.find((tool) => tool.name === name)!.schema.safeParse(input).success).toBe(
      false,
    );
  });

  it('简单回复通过实际 SDK 请求与流解析，不因未调用的研究工具被接口拒绝', async () => {
    let requests = 0;
    const client = new OpenAI({
      apiKey: 'unused-test-placeholder',
      baseURL: 'http://model.invalid/v1',
      maxRetries: 0,
      fetch: async (_url, init) => {
        requests++;
        const body = JSON.parse(String(init?.body)) as {
          tools: { function: { name: string; parameters: Record<string, unknown> } }[];
          messages: { role: string }[];
        };
        const invalid = body.tools.find((tool) => tool.function.parameters.type !== 'object');
        if (invalid)
          return new Response(
            JSON.stringify({
              error: {
                message: `Invalid schema for function '${invalid.function.name}': schema must be a JSON Schema of 'type: "object"'`,
                type: 'invalid_request_error',
              },
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          );
        const replied = body.messages.some((message) => message.role === 'tool');
        const chunk = {
          id: 'completion_test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [
            {
              index: 0,
              delta: replied
                ? {}
                : {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_reply',
                        type: 'function',
                        function: {
                          name: 'post_message',
                          arguments: JSON.stringify({ body: 'ok' }),
                        },
                      },
                    ],
                  },
              finish_reason: replied ? 'stop' : 'tool_calls',
            },
          ],
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    const t = await makeApp();
    const runtime = startAgentRuntime(t.app.ctx, {
      model: createChatModel({ client, model: 'test-model', reasoningModel: 'test-model' }),
      tickMs: 60_000,
    })!;
    try {
      const { project, owner } = await setupProject(t.app, []);
      expect(
        (await owner.req('POST', `/projects/${project.id}/timeline`, { body: '测试，回复ok' }))
          .statusCode,
      ).toBe(201);
      for (let i = 0; i < 5; i++) await runtime.idle();
      const timeline = (await owner.req('GET', `/projects/${project.id}/timeline`)).json<
        Page<Message>
      >();
      expect(
        timeline.items
          .filter((message) => message.author.kind === 'agent')
          .map((message) => message.body),
      ).toEqual(['ok']);
      expect(timeline.items.some((message) => message.body.includes('这一轮出错停下了'))).toBe(
        false,
      );
      const sessions = (await owner.req('GET', `/projects/${project.id}/agents`)).json<
        AgentSession[]
      >();
      expect(sessions.find((session) => session.role === 'coordinator')?.status).toBe('idle');
      expect(requests).toBe(2);
    } finally {
      await runtime.stop();
      await t.close();
    }
  }, 60_000);
});
