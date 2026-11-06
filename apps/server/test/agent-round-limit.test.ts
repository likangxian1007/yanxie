import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentSession, AgentStep, Message, Page, Thread } from '@srh/shared';
import { startAgentRuntime, type AgentRuntime } from '../src/agents/runtime';
import { MAX_CONTINUATIONS, MAX_ROUNDS } from '../src/agents/runtime/turn';
import type { ChatModel, ChatRequest, ChatResult, ChatToolCall } from '../src/agents/llm/complete';
import { makeApp, setupProject, type Session, type TestApp } from './helpers';

/**
 * 验收报告附录 A 第 1 条（严重）：线程 agent 一轮跑满步数就静默停下，线程显示「待审阅」。
 * 现在：自动续跑 MAX_CONTINUATIONS 次 → 仍没做完就停下（status=idle，不算失败）、发系统消息；
 * 成员 POST …/resume 后从停下的地方继续。用量在每次模型调用后实时更新。
 */
let seq = 0;
const call = (name: string, args: unknown): ChatToolCall => ({
  id: `call_${++seq}`,
  name,
  arguments: JSON.stringify(args),
});
const result = (toolCalls: ChatToolCall[]): ChatResult => ({
  content: '',
  reasoning: '',
  toolCalls,
  usage: { input: 100, output: 10, cached: 0 },
  model: 'fake',
});
function roundOf(req: ChatRequest): number {
  let n = 0;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role === 'user') break;
    if (m.role === 'assistant') n += 1;
  }
  return n;
}

let threadCalls = 0;
const model: ChatModel = {
  name: 'fake',
  async chat(req) {
    const tools = new Set((req.tools ?? []).map((t) => t.name));
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const round = roundOf(req);
    if (tools.has('start_thread')) {
      if (round > 0) return result([]);
      const id = /trust="principal" id="(msg_[0-9A-Z]+)"/u.exec(lastUser)?.[1];
      if (!id) return result([call('no_reply_needed', { reason: 'nothing_to_add' })]);
      return result([
        call('start_thread', {
          anchor_message_id: id,
          title: '无穷检索',
          brief: '检索相关工作',
          ack: '先检索。',
          project_ack: '好。',
        }),
      ]);
    }
    threadCalls += 1;
    if (lastUser.includes('<continue by=')) {
      if (round === 0) return result([call('reply', { body: '接着做完了。' })]);
      return result([]);
    }
    // 永远在检索，从不收尾
    return result([call('list_members', {})]);
  },
};

describe('步数用尽：自动续跑、如实停下、可继续', () => {
  let t: TestApp;
  let runtime: AgentRuntime;
  let owner: Session;
  let guest: Session;
  let projectId: string;

  beforeAll(async () => {
    t = await makeApp();
    runtime = startAgentRuntime(t.app.ctx, { model, tickMs: 60_000 })!;
    const p = await setupProject(t.app, ['guest']);
    projectId = p.project.id;
    owner = p.owner;
    guest = p.others[0]!;
  }, 60_000);

  afterAll(async () => {
    await runtime.stop();
    await t.close();
  });

  async function settle() {
    for (let i = 0; i < 8; i++) await runtime.idle();
  }

  it('跑满后自动续跑，续跑用完就停下（idle）并发系统消息；resume 后继续', async () => {
    const P = `/projects/${projectId}`;
    await owner.req('POST', `${P}/timeline`, { body: '帮我调研一下相关工作' });
    await settle();

    const thread = (await owner.req('GET', `${P}/threads`)).json<Page<Thread>>().items[0]!;
    const agents = (await owner.req('GET', `${P}/agents`)).json<AgentSession[]>();
    const ta = agents.find((a) => a.threadId === thread.id)!;
    // 终验 R2：步数用满不是「失败」，停下等成员
    expect(ta.status).toBe('idle');
    expect(threadCalls).toBe(MAX_ROUNDS * (MAX_CONTINUATIONS + 1));
    expect(ta.tokenUsage.input).toBe(100 * threadCalls);

    const steps: AgentStep[] = [];
    for (let cursor: string | null = ''; cursor !== null;) {
      const page: Page<AgentStep> = (
        await owner.req(
          'GET',
          `${P}/agents/${ta.id}/steps?limit=100${cursor ? `&cursor=${cursor}` : ''}`,
        )
      ).json<Page<AgentStep>>();
      steps.push(...page.items);
      cursor = page.nextCursor;
    }
    const limits = steps.filter((s) => s.kind === 'note' && s.name === 'round_limit');
    expect(limits).toHaveLength(MAX_CONTINUATIONS + 1);
    expect(limits.at(-1)!.content).toContain('先停下');
    expect(steps.some((s) => s.name === 'nudge' && s.content.includes('还剩'))).toBe(true);
    // 最后一轮的收尾提醒要求先交付
    expect(steps.some((s) => s.name === 'nudge' && s.content.includes('最后一轮'))).toBe(true);
    // 每隔几步把任务目标重新放进提醒
    expect(
      steps.some((s) => s.name === 'goal_reminder' && s.content.includes('线程「无穷检索」')),
    ).toBe(true);

    const t1 = (await owner.req('GET', `${P}/threads/${thread.id}`)).json<Thread>();
    expect(t1.statusBucket).toBe('idle');
    const msgs = (await owner.req('GET', `${P}/threads/${thread.id}/messages?order=asc`)).json<
      Page<Message>
    >().items;
    const stop = msgs.find((m) => m.author.kind === 'system' && m.body.includes('停下'));
    expect(stop).toBeTruthy();
    expect((stop!.meta as { agentStopped?: { sessionId: string } }).agentStopped?.sessionId).toBe(
      ta.id,
    );

    // 访客不能让它继续
    expect((await guest.req('POST', `${P}/agents/${ta.id}/resume`)).statusCode).toBe(403);
    const res = await owner.req('POST', `${P}/agents/${ta.id}/resume`);
    expect(res.statusCode).toBe(200);
    expect(res.json<AgentSession>().status).toBe('queued');
    await settle();

    const after = (await owner.req('GET', `${P}/agents/${ta.id}`)).json<AgentSession>();
    expect(after.status).toBe('idle');
    const msgs2 = (await owner.req('GET', `${P}/threads/${thread.id}/messages?order=asc`)).json<
      Page<Message>
    >().items;
    expect(msgs2.at(-1)!.body).toBe('接着做完了。');
    expect((await owner.req('GET', `${P}/threads/${thread.id}`)).json<Thread>().statusBucket).toBe(
      'review_ready',
    );
  }, 120_000);
});
