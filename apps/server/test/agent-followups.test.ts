import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import {
  newId,
  type AgentSession,
  type DocumentMeta,
  type Message,
  type Page,
  type Report,
  type Thread,
} from '@srh/shared';
import { startAgentRuntime, type AgentRuntime } from '../src/agents/runtime';
import type { ChatModel, ChatRequest, ChatResult, ChatToolCall } from '../src/agents/llm/complete';
import { agentSessions, agentSteps, agentWakeups } from '../src/db/schema';
import { makeApp, setupProject, signup, sleep, type Session, type TestApp } from './helpers';

/**
 * 终验 R3：平台替 agent 记住「谁在等谁」，不用成员推。
 * - D2 线程交付后唤醒协调者推进下一阶段
 * - D3 有人加入项目时唤醒在等人的线程
 * - D5 上游文档改了，据它写过产出的线程被唤醒去同步，线程里标出「可能已过期」
 * - D1 停机（部署重启）打断的一轮，重启后自动接着做，不停在「已停止」
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
function roundOf(req: ChatRequest) {
  let n = 0;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role === 'user') break;
    if (m.role === 'assistant') n += 1;
  }
  return n;
}
const lastUserOf = (req: ChatRequest) =>
  [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

const fake: ChatModel & { coord: string[]; thread: string[] } = {
  name: 'fake',
  coord: [],
  thread: [],
  async chat(req) {
    const tools = new Set((req.tools ?? []).map((t) => t.name));
    const last = lastUserOf(req);
    const round = roundOf(req);
    if (tools.has('start_thread')) {
      if (round > 0) return result([]);
      this.coord.push(last);
      const id = /trust="principal" id="(msg_[0-9A-Z]+)"/u.exec(last)?.[1];
      if (!id) return result([call('no_reply_needed', { reason: 'nothing_to_add' })]);
      return result([
        call('start_thread', {
          anchor_message_id: id,
          title: '文献调研',
          brief: '见引用的成员原话。',
          ack: '先检索。',
          project_ack: '好的。',
        }),
      ]);
    }
    if (round > 0) return result([]);
    this.thread.push(last);
    if (last.includes('慢慢做')) {
      return new Promise<ChatResult>((_, reject) => {
        const abort = () => reject(new DOMException('stopped', 'AbortError'));
        if (req.signal?.aborted) abort();
        else req.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    if (last.includes('role="initiator"')) {
      return result([
        call('update_status', {
          text: '文献调研\n\n✓ 检索完成\n○ 等导师加入项目后发起审阅（当前无法发起）',
        }),
        call('reply', { body: '调研笔记写好了，导师还不在项目里，暂时没法送审。' }),
      ]);
    }
    return result([call('no_reply_needed', { reason: 'nothing_to_add' })]);
  },
};

describe('跨会话的下一步（运行时开着）', () => {
  let t: TestApp;
  let runtime: AgentRuntime;
  let owner: Session;
  let projectId: string;
  let thread: Thread;

  beforeAll(async () => {
    t = await makeApp();
    runtime = startAgentRuntime(t.app.ctx, {
      model: fake,
      tickMs: 60_000,
      depsDebounceMs: 60_000,
    })!;
    const p = await setupProject(t.app, ['member']);
    projectId = p.project.id;
    owner = p.owner;
  }, 60_000);

  afterAll(async () => {
    await runtime.stop();
    await t.close();
  });

  async function settle() {
    for (let i = 0; i < 8; i++) await runtime.idle();
  }

  it('D2 线程回帖交付后，协调者被单独唤醒（带 <thread-delivered>），不用成员推', async () => {
    await owner.req('POST', `/projects/${projectId}/timeline`, { body: '帮我调研对比学习' });
    await settle();
    thread = (await owner.req('GET', `/projects/${projectId}/threads`)).json<Page<Thread>>()
      .items[0]!;
    expect(thread.title).toBe('文献调研');
    const delivered = fake.coord.find((w) => w.includes('<thread-delivered'));
    expect(delivered).toBeDefined();
    expect(delivered).toContain(`thread="${thread.id}"`);
    expect(delivered).toContain('等导师加入项目后发起审阅');
    expect(delivered).toContain('说清等谁、等什么');
  });

  it('D3 导师加入项目：协调者和清单里在等人加入的线程都被唤醒', async () => {
    const coordBefore = fake.coord.length;
    const threadBefore = fake.thread.length;
    const advisor = await signup(t.app, '周老师');
    const inv = await owner.req('POST', `/projects/${projectId}/invites`, { role: 'advisor' });
    await advisor.req('POST', `/invites/${inv.json<{ token: string }>().token}/accept`);
    await settle();
    const coordWakes = fake.coord.slice(coordBefore);
    const threadWakes = fake.thread.slice(threadBefore);
    expect(coordWakes.some((w) => w.includes('周老师（导师）刚加入了项目'))).toBe(true);
    expect(threadWakes.some((w) => w.includes('先 list_members 重新核对成员'))).toBe(true);
  });

  it('D5 上游文档改了：据它写过 PPT 的线程被唤醒同步，线程里标出可能已过期', async () => {
    const paper = (
      await owner.req('POST', `/projects/${projectId}/docs`, {
        title: '论文',
        markdown: '# 结果\n\n1-shot 准确率 84.5%',
      })
    ).json<DocumentMeta>();
    const slides = (
      await owner.req('POST', `/projects/${projectId}/docs`, {
        title: '组会 PPT',
        kind: 'slides',
        markdown: '## 结果\n\n84.5%',
      })
    ).json<DocumentMeta>();
    // 线程 agent 读过论文、改过 PPT（依赖关系从它的步骤里推出来）
    const turnId = 'trn_test_deps';
    const steps = [
      { name: 'read_document', content: JSON.stringify({ doc_id: paper.id }) },
      {
        name: 'edit_document',
        content: JSON.stringify({ doc_id: slides.id, op: 'replace_slides' }),
      },
    ];
    for (const [i, s] of steps.entries()) {
      await t.app.ctx.db.db.insert(agentSteps).values({
        id: newId('agentStep'),
        sessionId: thread.agentSessionId!,
        turnId,
        index: i,
        kind: 'tool_call',
        name: s.name,
        content: s.content,
        data: { round: 1, callId: `x${i}` },
      });
    }
    await sleep(5);
    const before = fake.thread.length;
    const edit = await owner.req('POST', `/projects/${projectId}/docs/${paper.id}/edit`, {
      op: 'append',
      markdown: '修订：留出类别后增益几乎消失（+0.91）',
    });
    expect(edit.statusCode).toBe(200);
    await settle();
    await runtime.flushDeps();
    await settle();
    const wakes = fake.thread.slice(before);
    const w = wakes.find((x) => x.includes('<upstream-changed'));
    expect(w).toBeDefined();
    expect(w).toContain(`ref="${paper.id}"`);
    expect(w).toContain('组会 PPT');
    const msgs = (
      await owner.req('GET', `/projects/${projectId}/threads/${thread.id}/messages?order=asc`)
    ).json<Page<Message>>().items;
    const stale = msgs.find((m) => m.body.includes('可能已经过期'));
    expect(stale?.author.kind).toBe('system');
    expect(stale?.body).toContain('「组会 PPT」');

    // 它还没重新读论文：再改一次不重复提醒
    const again = fake.thread.length;
    await owner.req('POST', `/projects/${projectId}/docs/${paper.id}/edit`, {
      op: 'append',
      markdown: '再补一句',
    });
    await settle();
    await runtime.flushDeps();
    await settle();
    expect(fake.thread.slice(again).some((x) => x.includes('<upstream-changed'))).toBe(false);
  });

  it('D5 组会汇报生成后论文又改了：GET 汇报带 outdatedBy，重新写入后清空', async () => {
    const created = (
      await owner.req('POST', `/projects/${projectId}/reports`, {
        periodStart: '2026-10-20',
        periodEnd: '2026-10-27',
        generate: false,
      })
    ).json<Report>();
    await owner.req('PATCH', `/projects/${projectId}/reports/${created.id}`, {
      content: '## 结果\n\n1-shot 84.5%',
    });
    const fresh = (
      await owner.req('GET', `/projects/${projectId}/reports/${created.id}`)
    ).json<Report>();
    expect(fresh.outdatedBy).toEqual([]);
    await sleep(5);
    const paper = (
      await owner.req('POST', `/projects/${projectId}/docs`, {
        title: '论文 v2',
        markdown: '增益几乎消失',
      })
    ).json<DocumentMeta>();
    const stale = (
      await owner.req('GET', `/projects/${projectId}/reports/${created.id}`)
    ).json<Report>();
    expect(stale.outdatedBy?.map((s) => s.id)).toContain(paper.id);
    expect(stale.outdatedBy?.find((s) => s.id === paper.id)?.kind).toBe('document');
    await sleep(5);
    await owner.req('PATCH', `/projects/${projectId}/reports/${created.id}`, {
      content: '## 结果\n\n留出类别后增益几乎消失',
    });
    const again = (
      await owner.req('GET', `/projects/${projectId}/reports/${created.id}`)
    ).json<Report>();
    expect(again.outdatedBy).toEqual([]);
  });

  it('D1 停机打断的一轮记成排队并补一条「接着做」，重启后自动恢复', async () => {
    await owner.req('POST', `/projects/${projectId}/threads/${thread.id}/messages`, {
      body: '请慢慢做下一步',
    });
    const started = () => fake.thread.some((w) => w.includes('慢慢做'));
    for (let i = 0; i < 200 && !started(); i++) await sleep(20);
    expect(started()).toBe(true);
    await runtime.stop();

    const [s] = await t.app.ctx.db.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, thread.agentSessionId!));
    expect(s!.status).toBe('queued');
    const pending = await t.app.ctx.db.db
      .select()
      .from(agentWakeups)
      .where(and(eq(agentWakeups.sessionId, s!.id), isNull(agentWakeups.consumedAt)));
    expect(pending.map((p) => p.reason)).toContain('resume');

    const before = fake.thread.length;
    runtime = startAgentRuntime(t.app.ctx, { model: fake, tickMs: 60_000 })!;
    await sleep(50);
    await settle();
    expect(fake.thread.slice(before).some((w) => w.includes('服务刚才重启'))).toBe(true);
    const agents = (await owner.req('GET', `/projects/${projectId}/agents`)).json<AgentSession[]>();
    expect(agents.find((a) => a.id === s!.id)?.status).toBe('idle');
  });
});
