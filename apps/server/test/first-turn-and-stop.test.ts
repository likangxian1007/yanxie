import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, eq } from 'drizzle-orm';
import type { AgentSession, AgentStopResult, LlmProvider, Page, Thread } from '@srh/shared';
import { startAgentRuntime, type AgentRuntime } from '../src/agents/runtime';
import { enqueueWake } from '../src/agents/runtime/wake';
import type { ChatModel, ChatRequest, ChatResult, ChatToolCall } from '../src/agents/llm/complete';
import { resolveModel } from '../src/agents/llm/registry';
import { agentSessions, agentWakeups, messages, threads } from '../src/db/schema';
import { makeApp, setupProject, sleep, type Session, type TestApp } from './helpers';

/**
 * 1. 新会话首屏选的 profile：建会话时一起写入，第一轮就按它的角色和强度跑。
 * 2. 停止：不光中止在跑的一轮，也取消排队、还没开始的一轮，并说清停掉了什么。
 */
let seq = 0;
const call = (name: string, args: unknown): ChatToolCall => ({
  id: `c_${++seq}`,
  name,
  arguments: JSON.stringify(args),
});
const result = (toolCalls: ChatToolCall[]): ChatResult => ({
  content: '',
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
    // 一直想下去，直到被停下
    if (lastUser.includes('慢慢想')) {
      return new Promise<ChatResult>((_, reject) => {
        const abort = () => reject(new DOMException('stopped', 'AbortError'));
        if (req.signal?.aborted) abort();
        else req.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    return round(req) === 0 ? result([call('reply', { body: '收到' })]) : result([]);
  },
};

describe('新会话带 profile + 停止正在跑的一轮（运行时开着）', () => {
  let t: TestApp;
  let runtime: AgentRuntime;
  let owner: Session;
  let member: Session;
  let projectId: string;

  beforeAll(async () => {
    t = await makeApp({ LLM_API_KEY: 'sk-test', LLM_BASE_URL: 'https://api.deepseek.com' });
    runtime = startAgentRuntime(t.app.ctx, { model: fake, tickMs: 60_000 })!;
    const p = await setupProject(t.app);
    projectId = p.project.id;
    owner = p.owner;
    [member] = p.others as [Session];
  }, 60_000);

  afterAll(async () => {
    await runtime.stop();
    await t.close();
  });

  async function settle() {
    for (let i = 0; i < 6; i++) await runtime.idle();
  }

  async function sessionOf(s: Session, threadId: string) {
    const agents = (await s.req('GET', `/projects/${projectId}/agents`)).json<AgentSession[]>();
    return agents.find((a) => a.threadId === threadId)!;
  }

  it('POST P/threads 带 profile：会话一建好就有 profile，第一轮按它的角色和强度跑', async () => {
    fake.calls.length = 0;
    const res = await member.req('POST', `/projects/${projectId}/threads`, {
      body: '帮我想几个选题',
      profile: 'idea-brainstorm',
    });
    expect(res.statusCode).toBe(201);
    const thread = res.json<Thread>();
    await settle();
    expect((await sessionOf(member, thread.id)).profile).toBe('idea-brainstorm');
    const first = fake.calls[0]!;
    expect(first.route?.effort).toBe('max');
    expect(first.messages[0]!.content ?? '').toContain('<profile slug="idea-brainstorm"');
  });

  it('首轮显式模型和强度覆盖 profile，并持久化；null 强度回退到 profile', async () => {
    fake.calls.length = 0;
    const res = await member.req('POST', `/projects/${projectId}/threads`, {
      body: '按所选模型回答',
      profile: 'idea-brainstorm',
      model: 'deepseek/deepseek-v4-pro',
      effort: 'low',
    });
    expect(res.statusCode).toBe(201);
    const thread = res.json<Thread>();
    await settle();
    expect(await sessionOf(member, thread.id)).toMatchObject({
      model: 'deepseek/deepseek-v4-pro',
      effort: 'low',
      profile: 'idea-brainstorm',
    });
    expect(fake.calls[0]?.route).toEqual({
      projectId,
      modelId: 'deepseek/deepseek-v4-pro',
      effort: 'low',
    });
    expect(fake.calls[0]?.messages[0]?.content).toContain('<profile slug="idea-brainstorm"');

    fake.calls.length = 0;
    const fallback = await member.req('POST', `/projects/${projectId}/threads`, {
      body: '采用建议强度',
      profile: 'idea-brainstorm',
      model: null,
      effort: null,
    });
    expect(fallback.statusCode).toBe(201);
    await settle();
    expect(await sessionOf(member, fallback.json<Thread>().id)).toMatchObject({
      model: 'deepseek/deepseek-flash',
      effort: null,
      profile: 'idea-brainstorm',
    });
    expect(fake.calls[0]?.route).toEqual({
      projectId,
      modelId: 'deepseek/deepseek-flash',
      effort: 'max',
    });
  });

  it('只指定模型或强度时，另一项仍按原有默认规则回退', async () => {
    for (const [settings, expected] of [
      [
        { profile: 'idea-brainstorm', model: 'deepseek/deepseek-v4-pro' },
        { modelId: 'deepseek/deepseek-v4-pro', effort: 'max' },
      ],
      [{ effort: 'off' }, { modelId: 'deepseek/deepseek-flash', effort: 'off' }],
    ] as const) {
      fake.calls.length = 0;
      const res = await member.req('POST', `/projects/${projectId}/threads`, {
        body: '部分指定',
        ...settings,
      });
      expect(res.statusCode).toBe(201);
      await settle();
      expect(fake.calls[0]?.route).toEqual({ projectId, ...expected });
      expect(await sessionOf(member, res.json<Thread>().id)).toMatchObject({
        model: expected.modelId,
        effort: 'effort' in settings ? settings.effort : null,
      });
    }
  });

  it('不带 profile 照旧；不存在的 profile → 422，不建会话', async () => {
    fake.calls.length = 0;
    const plain = (
      await member.req('POST', `/projects/${projectId}/threads`, { body: '普通问题' })
    ).json<Thread>();
    await settle();
    const plainSession = await sessionOf(member, plain.id);
    expect(plainSession).toMatchObject({
      model: 'deepseek/deepseek-flash',
      effort: null,
      profile: null,
    });
    expect(fake.calls[0]?.route).toEqual({
      projectId,
      modelId: plainSession.model,
      effort: null,
    });
    expect((await resolveModel(t.app.ctx, projectId, plainSession.model, null)).effort).toBe(
      t.config.LLM_DEFAULT_EFFORT,
    );

    const before = (await member.req('GET', `/projects/${projectId}/threads?kind=personal`)).json<
      Page<Thread>
    >().items.length;
    const bad = await member.req('POST', `/projects/${projectId}/threads`, {
      body: '你好',
      profile: 'no-such-profile',
    });
    expect(bad.statusCode).toBe(422);
    const malformed = await member.req('POST', `/projects/${projectId}/threads`, {
      body: '你好',
      profile: '不是 slug',
    });
    expect(malformed.statusCode).toBe(422);
    const after = (await member.req('GET', `/projects/${projectId}/threads?kind=personal`)).json<
      Page<Thread>
    >().items.length;
    expect(after).toBe(before);
  });

  it('无效模型、强度或 profile 返回 422，且不产生线程、会话、消息或唤醒', async () => {
    const disabledResponse = await owner.req('POST', `/projects/${projectId}/providers`, {
      name: '停用的模型',
      baseUrl: 'https://provider.invalid/v1',
      models: [{ model: 'disabled-model' }],
      enabled: false,
    });
    expect(disabledResponse.statusCode).toBe(201);
    const disabled = disabledResponse.json<LlmProvider>();
    const privateProfile = await owner.req('POST', `/projects/${projectId}/profiles`, {
      scope: 'personal',
      slug: 'owner-private-profile',
      name: '个人角色',
      prompt: '用于测试个人范围',
    });
    expect(privateProfile.statusCode).toBe(201);
    const counts = async () => {
      const [ts, ss, ms, ws] = await Promise.all([
        t.db.db.select({ n: count() }).from(threads).where(eq(threads.projectId, projectId)),
        t.db.db
          .select({ n: count() })
          .from(agentSessions)
          .where(eq(agentSessions.projectId, projectId)),
        t.db.db.select({ n: count() }).from(messages).where(eq(messages.projectId, projectId)),
        t.db.db
          .select({ n: count() })
          .from(agentWakeups)
          .where(eq(agentWakeups.projectId, projectId)),
      ]);
      return [ts[0]!.n, ss[0]!.n, ms[0]!.n, ws[0]!.n];
    };
    await settle();
    const before = await counts();
    fake.calls.length = 0;
    for (const settings of [
      { model: 'unknown/model' },
      { model: '' },
      { model: `${disabled.id}/disabled-model` },
      { model: 'x'.repeat(201) },
      { effort: 'ultra' },
      { profile: 'no-such-profile' },
      { profile: 'owner-private-profile' },
      { profile: '不是 slug' },
    ]) {
      const res = await member.req('POST', `/projects/${projectId}/threads`, {
        body: '不能创建',
        ...settings,
      });
      expect(res.statusCode, res.body).toBe(422);
      expect(await counts()).toEqual(before);
    }
    expect(fake.calls).toEqual([]);
  });

  it('停止正在跑的一轮 → stopped=turn，状态 stopped，之后不再续跑', async () => {
    const thread = (
      await owner.req('POST', `/projects/${projectId}/threads`, { body: '慢慢想这个问题' })
    ).json<Thread>();
    // 等模型被调用（这一轮已经开始）
    const started = () =>
      fake.calls.some((c) => c.messages.some((m) => (m.content ?? '').includes('慢慢想')));
    for (let i = 0; i < 200 && !started(); i++) await sleep(20);
    expect(started()).toBe(true);
    const res = await owner.req(
      'POST',
      `/projects/${projectId}/agents/${thread.agentSessionId}/stop`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json<AgentStopResult>();
    expect(body.stopped).toBe('turn');
    expect(body.status).toBe('stopped');
    await settle();
    expect((await sessionOf(owner, thread.id)).status).toBe('stopped');
  });
});

describe('停止排队、还没开始的一轮（运行时没开）', () => {
  let t: TestApp;
  let owner: Session;
  let projectId: string;
  let coordinator: AgentSession;

  beforeAll(async () => {
    t = await makeApp();
    const p = await setupProject(t.app, ['member']);
    projectId = p.project.id;
    owner = p.owner;
    const agents = (await owner.req('GET', `/projects/${projectId}/agents`)).json<AgentSession[]>();
    coordinator = agents.find((a) => a.role === 'coordinator')!;
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  const stop = (id: string) => owner.req('POST', `/projects/${projectId}/agents/${id}/stop`);

  it('没有可用模型时提交不存在的模型仍返回 422，且不创建个人会话', async () => {
    const before = (await owner.req('GET', `/projects/${projectId}/threads?kind=personal`)).json<
      Page<Thread>
    >();
    const res = await owner.req('POST', `/projects/${projectId}/threads`, {
      body: '选择模型',
      model: 'missing/model',
    });
    expect(res.statusCode).toBe(422);
    const after = (await owner.req('GET', `/projects/${projectId}/threads?kind=personal`)).json<
      Page<Thread>
    >();
    expect(after).toEqual(before);
  });

  it('agent 显示空闲但已有待处理的唤醒 → stopped=queued，唤醒作废', async () => {
    expect(coordinator.status).toBe('idle');
    await enqueueWake(t.app.ctx, coordinator, 'mention', {
      type: 'system-note',
      text: '有人刚发了消息',
    });
    const res = await stop(coordinator.id);
    expect(res.statusCode).toBe(200);
    expect(res.json<AgentStopResult>()).toMatchObject({ stopped: 'queued', status: 'stopped' });
    const rows = await t.app.ctx.db.db
      .select()
      .from(agentWakeups)
      .where(eq(agentWakeups.sessionId, coordinator.id));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.consumedAt !== null && r.consumedTurnId === 'stopped')).toBe(true);
  });

  it('没有要停的 → stopped=none，状态不变', async () => {
    const res = await stop(coordinator.id);
    expect(res.json<AgentStopResult>()).toMatchObject({ stopped: 'none', status: 'stopped' });
  });

  it('排队中的个人会话（status=queued）→ stopped=queued', async () => {
    const thread = (
      await owner.req('POST', `/projects/${projectId}/threads`, { body: '你好' })
    ).json<Thread>();
    const res = await stop(thread.agentSessionId!);
    expect(res.json<AgentStopResult>()).toMatchObject({ stopped: 'queued', status: 'stopped' });
  });
});
