import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AgentSession,
  HarnessSummary,
  McpServer,
  ModelCatalog,
  Skill,
  SlashCommand,
  Thread,
} from '@srh/shared';
import { startAgentRuntime, type AgentRuntime } from '../src/agents/runtime';
import type { ChatModel, ChatRequest, ChatResult, ChatToolCall } from '../src/agents/llm/complete';
import { fitEffort, thinkingParams } from '../src/agents/llm/registry';
import { parseSkillMarkdown } from '../src/modules/harness/service';
import { makeApp, setupProject, type Session, type TestApp } from './helpers';

/**
 * harness 能力（假模型 + 真 MCP stdio 子进程）：
 * 模型目录与会话设置、路由参数、MCP 工具发现与调用、skill 点名与 load_skill、/goal、/clear、权限。
 */
let seq = 0;
const call = (name: string, args: unknown): ChatToolCall => ({
  id: `c_${++seq}`,
  name,
  arguments: JSON.stringify(args),
});
const result = (toolCalls: ChatToolCall[], content = ''): ChatResult => ({
  content,
  reasoning: '',
  toolCalls,
  usage: { input: 10, output: 1, cached: 0 },
  model: 'fake',
});
function round(req: ChatRequest) {
  let n = 0;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role === 'user') break;
    if (m.role === 'assistant') n += 1;
  }
  return n;
}

const fake: ChatModel & { calls: ChatRequest[] } = {
  name: 'fake',
  calls: [],
  async chat(req) {
    this.calls.push(req);
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const r = round(req);
    if (lastUser.includes('用 MCP')) {
      if (r === 0)
        return result([
          call('load_skill', { name: 'paper-deep-read' }),
          call('mcp__echo__echo', { text: '你好' }),
        ]);
      if (r === 1) return result([call('reply', { body: '完成' })]);
      return result([]);
    }
    if (r === 0) return result([call('reply', { body: '收到' })]);
    return result([]);
  },
};

const fixture = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));

describe('harness：模型、MCP、skill、指令', () => {
  let t: TestApp;
  let runtime: AgentRuntime;
  let owner: Session;
  let member: Session;
  let guest: Session;
  let projectId: string;
  let personal: Thread;
  let sessionId: string;

  beforeAll(async () => {
    t = await makeApp({
      LLM_API_KEY: 'sk-test',
      LLM_BASE_URL: 'https://api.deepseek.com',
      MCP_ALLOW_STDIO: 'true',
      LLM_PROVIDERS: JSON.stringify([
        {
          id: 'lab',
          name: '实验室网关',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'x',
          models: ['qwen-test'],
        },
      ]),
    });
    runtime = startAgentRuntime(t.app.ctx, { model: fake, tickMs: 60_000 })!;
    const p = await setupProject(t.app);
    projectId = p.project.id;
    owner = p.owner;
    [member, , guest] = p.others as [Session, Session, Session];
    const created = await member.req('POST', `/projects/${projectId}/threads`, { body: '你好' });
    personal = created.json<Thread>();
    await settle();
    const agents = (await member.req('GET', `/projects/${projectId}/agents`)).json<
      AgentSession[]
    >();
    sessionId = agents.find((a) => a.threadId === personal.id)!.id;
  }, 60_000);

  afterAll(async () => {
    await runtime.stop();
    await t.close();
  });

  async function settle() {
    for (let i = 0; i < 6; i++) await runtime.idle();
  }

  it('模型目录：env 主 provider（DeepSeek 两个模型）+ LLM_PROVIDERS', async () => {
    const cat = (await member.req('GET', `/projects/${projectId}/models`)).json<ModelCatalog>();
    expect(cat.defaultModel).toBe('deepseek/deepseek-flash');
    const ids = cat.providers.flatMap((p) => p.models.map((m) => m.id));
    expect(ids).toEqual(['deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro', 'lab/qwen-test']);
    expect(JSON.stringify(cat)).not.toContain('sk-test');
    expect(cat.providers.every((p) => p.hasApiKey)).toBe(true);
  });

  it('强度映射：DeepSeek thinking + reasoning_effort；OpenAI 格式', () => {
    expect(thinkingParams('deepseek', 'off')).toEqual({ thinking: { type: 'disabled' } });
    expect(thinkingParams('deepseek', 'max')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
    expect(thinkingParams('openai', 'max')).toEqual({ reasoning_effort: 'high' });
    expect(thinkingParams('openai', 'off')).toEqual({});
    expect(
      fitEffort(
        {
          model: 'x',
          name: 'x',
          description: null,
          efforts: ['off', 'low', 'high', 'max'],
          defaultEffort: 'high',
        },
        'medium',
      ),
    ).toBe('high');
  });

  it('会话设置：切模型 / 强度 / profile 后，下一次请求按新路由走', async () => {
    const bad = await member.req('PATCH', `/projects/${projectId}/agents/${sessionId}/settings`, {
      model: 'nope/x',
    });
    expect(bad.statusCode).toBe(422);
    const res = await member.req('PATCH', `/projects/${projectId}/agents/${sessionId}/settings`, {
      model: 'lab/qwen-test',
      effort: 'low',
      profile: 'paper-reader',
    });
    expect(res.statusCode).toBe(200);
    const s = res.json<AgentSession>();
    expect([s.model, s.effort, s.profile]).toEqual(['lab/qwen-test', 'low', 'paper-reader']);
    // 别人看不到也改不了这个个人会话
    expect(
      (
        await owner.req('PATCH', `/projects/${projectId}/agents/${sessionId}/settings`, {
          effort: 'max',
        })
      ).statusCode,
    ).toBe(404);

    fake.calls.length = 0;
    await member.req('POST', `/projects/${projectId}/threads/${personal.id}/messages`, {
      body: '再说一句',
    });
    await settle();
    const req = fake.calls.at(-1)!;
    expect(req.route).toEqual({ projectId, modelId: 'lab/qwen-test', effort: 'low' });
    const system = req.messages[0]!.content ?? '';
    expect(system).toContain('<profile slug="paper-reader"');
    expect(system).toContain('<skills>');
    expect(system).toContain('- paper-deep-read：');
  });

  it('工作区可选组会彩排角色，首轮注入导师逐题追问与卡点总结流程', async () => {
    const summary = (
      await member.req('GET', `/projects/${projectId}/harness`)
    ).json<HarnessSummary>();
    const profile = summary.profiles.find((p) => p.slug === 'group-meeting-rehearsal');
    expect(profile).toMatchObject({
      name: '组会彩排',
      scope: 'builtin',
      effort: 'high',
    });
    expect(profile?.starters).toContain('扮演导师对我的研究进展做一轮组会彩排，每次问我一个问题');

    fake.calls.length = 0;
    const created = await member.req('POST', `/projects/${projectId}/threads`, {
      body: '帮我彩排这份研究报告：我们提出方法 A，在数据集 B 上比基线高 2 个百分点。',
      profile: 'group-meeting-rehearsal',
    });
    expect(created.statusCode).toBe(201);
    await settle();

    const system = fake.calls[0]!.messages[0]!.content ?? '';
    expect(system).toContain('<profile slug="group-meeting-rehearsal" name="组会彩排">');
    expect(system).toContain('每轮只提出一个主要问题');
    expect(system).toContain('总结卡壳点');
    expect(system).toContain('不要替用户捏造答案或实验结果');
  }, 60_000);

  it('MCP：添加 stdio 服务器 → 发现工具 → agent 调用；skill 点名展开并 load_skill', async () => {
    // 成员不能加项目级 MCP；访客什么都不能加
    const denied = await member.req('POST', `/projects/${projectId}/mcp-servers`, {
      scope: 'project',
      name: 'echo',
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
    });
    expect(denied.statusCode).toBe(403);
    expect(
      (
        await guest.req('POST', `/projects/${projectId}/mcp-servers`, {
          scope: 'personal',
          name: 'g',
          transport: 'http',
          url: 'http://x',
        })
      ).statusCode,
    ).toBe(403);

    const created = await owner.req('POST', `/projects/${projectId}/mcp-servers`, {
      scope: 'project',
      name: 'echo',
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      env: { ECHO_TOKEN: 'secret-value' },
    });
    expect(created.statusCode).toBe(201);
    const srv = created.json<McpServer>();
    expect(srv.state).toBe('ready');
    expect(srv.tools.map((x) => x.exposedName).sort()).toEqual([
      'mcp__echo__echo',
      'mcp__echo__fail',
    ]);
    expect(srv.envKeys).toEqual(['ECHO_TOKEN']);
    expect(JSON.stringify(srv)).not.toContain('secret-value');

    // 停用 fail 工具
    const patched = await owner.req('PATCH', `/projects/${projectId}/mcp-servers/${srv.id}`, {
      disabledTools: ['fail'],
    });
    expect(patched.json<McpServer>().tools.find((x) => x.name === 'fail')!.enabled).toBe(false);

    fake.calls.length = 0;
    await member.req('POST', `/projects/${projectId}/threads/${personal.id}/messages`, {
      body: '/paper-deep-read 用 MCP 打个招呼',
    });
    await settle();
    const first = fake.calls[0]!;
    const names = (first.tools ?? []).map((x) => x.name);
    expect(names).toContain('mcp__echo__echo');
    expect(names).not.toContain('mcp__echo__fail');
    expect(names).toContain('load_skill');
    const wake = [...first.messages].reverse().find((m) => m.role === 'user')!.content ?? '';
    expect(wake).toContain('<command-expansion');
    expect(wake).toContain('<skill_content name="paper-deep-read"');
    const second = fake.calls[1]!;
    const toolOut = second.messages.filter((m) => m.role === 'tool').map((m) => m.content ?? '');
    expect(toolOut.some((c) => c.includes('echo: 你好'))).toBe(true);
    expect(toolOut.some((c) => c.includes('<skill_instructions>'))).toBe(true);
  }, 60_000);

  it('/goal 写入会话目标并进 system prompt；/clear 清空上下文', async () => {
    fake.calls.length = 0;
    await member.req('POST', `/projects/${projectId}/threads/${personal.id}/messages`, {
      body: '/goal 整理三篇 GNN 论文的对比表',
    });
    await settle();
    const s = (
      await member.req('GET', `/projects/${projectId}/agents/${sessionId}`)
    ).json<AgentSession>();
    expect(s.goal).toBe('整理三篇 GNN 论文的对比表');
    expect(fake.calls[0]!.messages[0]!.content).toContain('<goal>');

    const cleared = await member.req('POST', `/projects/${projectId}/commands/run`, {
      threadId: personal.id,
      name: 'goal',
      args: 'clear',
    });
    expect(cleared.json<{ ok: boolean }>().ok).toBe(true);
    const clr = await member.req('POST', `/projects/${projectId}/commands/run`, {
      threadId: personal.id,
      name: 'clear',
      args: '',
    });
    expect(clr.json<{ ok: boolean }>().ok).toBe(true);
    fake.calls.length = 0;
    await member.req('POST', `/projects/${projectId}/threads/${personal.id}/messages`, {
      body: '还记得吗',
    });
    await settle();
    const msgs = fake.calls[0]!.messages;
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(msgs[0]!.content).not.toContain('<goal>');
  }, 60_000);

  it('skill 导入（SKILL.md）、自定义指令、个人作用域不外泄', async () => {
    const md =
      '---\nname: lab-weekly\ndescription: 写实验室周报时使用\ndisable-model-invocation: true\n---\n# 周报\n按模板写。';
    expect(parseSkillMarkdown(md).meta.name).toBe('lab-weekly');
    const imp = await member.req('POST', `/projects/${projectId}/skills/import`, {
      scope: 'personal',
      markdown: md,
      attachments: [],
    });
    expect(imp.statusCode).toBe(201);
    const sk = imp.json<Skill>();
    expect([sk.slug, sk.modelInvocable, sk.scope]).toEqual(['lab-weekly', false, 'personal']);
    // 导师 / 负责人看不到成员的个人 skill
    const ownerSkills = (await owner.req('GET', `/projects/${projectId}/skills`)).json<Skill[]>();
    expect(ownerSkills.some((x) => x.slug === 'lab-weekly')).toBe(false);

    const cmd = await member.req('POST', `/projects/${projectId}/commands`, {
      scope: 'personal',
      name: 'tldr',
      description: '三句话总结',
      template: '用三句话总结：$ARGUMENTS',
    });
    expect(cmd.statusCode).toBe(201);
    expect(
      (
        await member.req('POST', `/projects/${projectId}/commands`, {
          scope: 'personal',
          name: 'goal',
          description: 'x',
          template: 'x',
        })
      ).statusCode,
    ).toBe(409);

    const sum = (await member.req('GET', `/projects/${projectId}/harness`)).json<HarnessSummary>();
    expect(sum.commands[0]!.name).toBe('goal');
    expect(sum.commands.some((c: SlashCommand) => c.name === 'tldr')).toBe(true);
    expect(sum.profiles.length).toBeGreaterThanOrEqual(9);
    expect(sum.profiles.some((p) => p.slug === 'group-meeting-rehearsal')).toBe(true);

    fake.calls.length = 0;
    await member.req('POST', `/projects/${projectId}/threads/${personal.id}/messages`, {
      body: '/tldr 图神经网络的过平滑问题',
    });
    await settle();
    const wake =
      [...fake.calls[0]!.messages].reverse().find((m) => m.role === 'user')!.content ?? '';
    expect(wake).toContain('用三句话总结：图神经网络的过平滑问题');
  }, 60_000);
});
