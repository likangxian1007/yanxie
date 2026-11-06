import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentSession, AgentStep, Message, Page, Thread } from '@srh/shared';
import { startAgentRuntime, type AgentRuntime } from '../src/agents/runtime';
import type { ChatModel, ChatRequest, ChatResult, ChatToolCall } from '../src/agents/llm/complete';
import { makeApp, openWs, setupProject, type Session, type TestApp } from './helpers';

/**
 * agent 引擎端到端（脚本化假模型，不调用真实 LLM）：
 * 成员在协作台发需求 → 协调者 start_thread → 线程 agent update_status + memory_write + reply
 * → 其他成员通过 /ws 实时看到；导师只能看、guest 不能驱动 agent。
 */
let callSeq = 0;
const call = (name: string, args: unknown): ChatToolCall => ({
  id: `call_${++callSeq}`,
  name,
  arguments: JSON.stringify(args),
});
const result = (toolCalls: ChatToolCall[], content = ''): ChatResult => ({
  content,
  reasoning: '',
  toolCalls,
  usage: { input: 100, output: 10, cached: 0 },
  model: 'fake',
});

/** 本轮（最后一条 user 之后）模型已经回答了几次 */
function roundOf(req: ChatRequest): number {
  let n = 0;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role === 'user') break;
    if (m.role === 'assistant') n += 1;
  }
  return n;
}

const fakeModel: ChatModel & { calls: ChatRequest[] } = {
  name: 'fake',
  calls: [],
  async chat(req) {
    this.calls.push(req);
    const tools = new Set((req.tools ?? []).map((t) => t.name));
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const round = roundOf(req);
    if (tools.has('start_thread')) {
      // 协调者
      if (round > 0) return result([]);
      const id = /trust="principal" id="(msg_[0-9A-Z]+)"/u.exec(lastUser)?.[1];
      if (!id) return result([call('no_reply_needed', { reason: 'nothing_to_add' })]);
      return result([
        call('start_thread', {
          anchor_message_id: id,
          title: '图对比学习调研',
          brief: '请求：见引用的张三消息。默认：先收核心工作。',
          ack: '先把相关论文检索一遍。',
          project_ack: '好，这就开始。',
        }),
      ]);
    }
    // 线程 agent
    if (round === 0) {
      return result([
        call('update_status', { text: '图对比学习调研\n\n✱ 正在检索相关论文\n○ 整理结论' }),
        call('memory_write', {
          path: 'decisions.md',
          description: '项目已作出的决定',
          type: 'project',
          content: '- 调研范围：2023 年以后的图对比学习',
          base_version: 0,
        }),
      ]);
    }
    if (round === 1) {
      return result([
        call('reply', { body: '调研完成：核心工作有 GraphCL、MolCLR 两篇，结论已记入项目记忆。' }),
      ]);
    }
    return result([], '');
  },
};

describe('agent 引擎端到端（假模型）', () => {
  let t: TestApp;
  let runtime: AgentRuntime;
  let owner: Session;
  let member: Session;
  let advisor: Session;
  let guest: Session;
  let projectId: string;

  beforeAll(async () => {
    t = await makeApp();
    runtime = startAgentRuntime(t.app.ctx, { model: fakeModel, tickMs: 60_000 })!;
    const p = await setupProject(t.app);
    projectId = p.project.id;
    owner = p.owner;
    [member, advisor, guest] = p.others as [Session, Session, Session];
  }, 60_000);

  afterAll(async () => {
    await runtime.stop();
    await t.close();
  });

  async function settle() {
    for (let i = 0; i < 5; i++) await runtime.idle();
  }

  it('协调者开线程，线程 agent 干活、写记忆、回帖，其他成员实时看到', async () => {
    const live = await openWs(t.app, member.cookie);
    await live.waitFor((f) => f.op === 'ready');
    live.ws.send(JSON.stringify({ op: 'subscribe', projectId, afterSeq: 0 }));
    await live.waitFor((f) => f.op === 'subscribed');

    const post = await owner.req('POST', `/projects/${projectId}/timeline`, {
      body: '帮我调研一下 2023 年以后图对比学习的工作',
    });
    expect(post.statusCode).toBe(201);
    const ask = post.json<Message>();
    await settle();

    const threads = (await member.req('GET', `/projects/${projectId}/threads`)).json<
      Page<Thread>
    >();
    expect(threads.items).toHaveLength(1);
    const thread = threads.items[0]!;
    expect(thread.rootMessageId).toBe(ask.id);
    expect(thread.title).toBe('图对比学习调研');
    expect(thread.ownerUserId).toBe(owner.user.id);
    expect(thread.statusText).toContain('✱ 正在检索相关论文');
    expect(thread.statusBucket).toBe('review_ready');

    const msgs = (
      await member.req('GET', `/projects/${projectId}/threads/${thread.id}/messages?order=asc`)
    ).json<Page<Message>>();
    expect(msgs.items.map((m) => m.body)).toEqual([
      '先把相关论文检索一遍。',
      '调研完成：核心工作有 GraphCL、MolCLR 两篇，结论已记入项目记忆。',
    ]);
    expect(msgs.items.every((m) => m.author.kind === 'agent')).toBe(true);

    const timeline = (await member.req('GET', `/projects/${projectId}/timeline`)).json<
      Page<Message>
    >();
    expect(timeline.items.map((m) => m.body)).toContain('好，这就开始。');
    expect(timeline.items.find((m) => m.id === ask.id)?.rootOfThreadId).toBe(thread.id);

    const mem = await member.req('GET', `/projects/${projectId}/memory/decisions.md`);
    expect(mem.statusCode).toBe(200);
    expect(mem.json<{ content: string }>().content).toContain('图对比学习');

    // 线程 agent 的 wake 带了成员原话（服务器逐字展开）
    const threadCall = fakeModel.calls.find(
      (c) => !(c.tools ?? []).some((x) => x.name === 'start_thread'),
    );
    const wake = threadCall!.messages.find((m) => m.role === 'user')!.content!;
    expect(wake).toContain('reason="spawn"');
    expect(wake).toContain('<cited');
    expect(wake).toContain('author="user"');
    expect(wake).toContain('帮我调研一下 2023 年以后图对比学习的工作');

    // 实时：另一位成员收到了线程、回复和记忆事件
    await live.waitFor(
      (f) =>
        f.op === 'event' &&
        f.event.type === 'message.created' &&
        f.event.payload.body.startsWith('调研完成'),
    );
    const types = new Set(live.frames.flatMap((f) => (f.op === 'event' ? [f.event.type] : [])));
    for (const ty of [
      'thread.created',
      'thread.updated',
      'memory.updated',
      'agent.updated',
      'agent.step',
    ]) {
      expect(types.has(ty as never)).toBe(true);
    }
    live.ws.terminate();
  });

  it('导师能看 agent 思路（steps），但不能写记忆；guest 不能驱动 agent', async () => {
    const agents = (await advisor.req('GET', `/projects/${projectId}/agents`)).json<
      AgentSession[]
    >();
    const coord = agents.find((a) => a.role === 'coordinator')!;
    expect(coord.tokenUsage.input).toBeGreaterThan(0);
    const steps = (
      await advisor.req('GET', `/projects/${projectId}/agents/${coord.id}/steps`)
    ).json<Page<AgentStep>>();
    expect(steps.items.some((s) => s.kind === 'tool_call' && s.name === 'start_thread')).toBe(true);

    const put = await member.req('PUT', `/projects/${projectId}/memory`, {
      path: 'x.md',
      content: 'x',
      baseVersion: 0,
    });
    expect(put.statusCode).toBe(403);
    const g = await guest.req('POST', `/projects/${projectId}/timeline`, { body: '我也想要' });
    expect(g.statusCode).toBe(403);
    const stop = await guest.req('POST', `/projects/${projectId}/agents/${coord.id}/stop`);
    expect(stop.statusCode).toBe(403);
  });

  it('旁聊（agentVisible=false）不唤醒协调者', async () => {
    const before = fakeModel.calls.length;
    const r = await member.req('POST', `/projects/${projectId}/timeline`, {
      body: '@张三 晚上吃啥',
      agentVisible: false,
    });
    expect(r.statusCode).toBe(201);
    await settle();
    expect(fakeModel.calls.length).toBe(before);
  });

  it('个人会话：只有主人能看；转发后出现在时间线并唤醒协调者', async () => {
    const created = await member.req('POST', `/projects/${projectId}/threads`, {
      body: '帮我想想消融实验怎么设计',
    });
    expect(created.statusCode).toBe(201);
    const personal = created.json<Thread>();
    await settle();
    expect(
      (await owner.req('GET', `/projects/${projectId}/threads/${personal.id}`)).statusCode,
    ).toBe(404);
    const mine = (await member.req('GET', `/projects/${projectId}/threads?kind=personal`)).json<
      Page<Thread>
    >();
    expect(mine.items.map((x) => x.id)).toContain(personal.id);
    const ownerList = (await owner.req('GET', `/projects/${projectId}/threads?kind=personal`)).json<
      Page<Thread>
    >();
    expect(ownerList.items).toHaveLength(0);

    const before = fakeModel.calls.length;
    const fwd = await member.req('POST', `/projects/${projectId}/threads/${personal.id}/forward`, {
      note: '这个思路团队可以一起做',
    });
    expect(fwd.statusCode).toBe(201);
    expect(fwd.json<Message>().kind).toBe('forward');
    await settle();
    const coordCalls = fakeModel.calls
      .slice(before)
      .filter((c) => (c.tools ?? []).some((x) => x.name === 'start_thread'));
    expect(coordCalls.length).toBeGreaterThan(0);
    const lastWake = [...coordCalls[0]!.messages]
      .reverse()
      .find((m) => m.role === 'user')!.content!;
    expect(lastWake).toContain('reason="forward"');
    expect(lastWake).toContain('<note-from-forwarder>这个思路团队可以一起做</note-from-forwarder>');
    // 协调者的历史里带着上一轮（从 agent_steps 重建）
    expect(
      coordCalls[0]!.messages.some(
        (m) => m.role === 'assistant' && m.tool_calls?.[0]?.name === 'start_thread',
      ),
    ).toBe(true);
  });
});
