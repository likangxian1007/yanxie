import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@srh/shared';
import { startAgentRuntime } from '../src/agents/runtime';
import {
  clipToTokens,
  contextBudget,
  estimateTokens,
  messagesTokens,
  OMITTED_TOOL_OUTPUT,
  shrinkToolResults,
  SUMMARY_MAX_CHARS,
  turnsToKeep,
} from '../src/agents/runtime/budget';
import { compact } from '../src/agents/runtime/turn';
import type {
  ChatMessage,
  ChatModel,
  ChatRequest,
  ChatResult,
  ChatToolCall,
} from '../src/agents/llm/complete';
import { writeProjectFile } from '../src/modules/files/service';
import { SYSTEM_ACTOR } from '../src/modules/projects/service';
import type { SessionRow } from '../src/agents/tools/types';
import { makeApp, setupProject } from './helpers';

/**
 * 上下文预算：token 估算、按整条 prompt 触发压缩、轮内裁剪工具输出、压缩失败兜底。
 * 用脚本化的假模型：每个请求都检查「整条 prompt（消息 + 工具定义）≤ 预算」。
 */

describe('budget.ts', () => {
  it('估算：中文约 1 token/字，英文约 3.5 字符/token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('研究协作')).toBe(4);
    expect(estimateTokens('a'.repeat(35))).toBe(10);
    expect(estimateTokens('研究 abc')).toBe(2 + Math.ceil(4 / 3.5));
  });

  it('默认预算：128K 窗口、预留 16K 输出', () => {
    const b = contextBudget();
    expect(b.prompt).toBe(112_000);
    expect(b.summary).toBe(SUMMARY_MAX_CHARS);
    expect(contextBudget({ AGENT_CONTEXT_TOKENS: 8000 }).outputReserve).toBe(4000);
  });

  it('turnsToKeep 按大小决定，最近一个 turn 很大时可以是 0', () => {
    const b = contextBudget();
    expect(turnsToKeep([100, 100, 100], 10_000, b)).toBe(2);
    expect(turnsToKeep([100, 4000, 100], 10_000, b)).toBe(2);
    expect(turnsToKeep([100, 6000, 100], 10_000, b)).toBe(1);
    expect(turnsToKeep([100, 100, 6000], 10_000, b)).toBe(0);
  });

  it('shrinkToolResults 只换较早的工具输出，最近的原样保留', () => {
    const big = '研'.repeat(1000);
    const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 6; i++) {
      msgs.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `c${i}`, name: 'read_file', arguments: '{}' }],
      });
      msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: big });
    }
    expect(shrinkToolResults(msgs, 100_000)).toBe(0);
    const n = shrinkToolResults(msgs, 3500, 2);
    expect(n).toBe(3);
    const tools = msgs.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(tools.slice(0, 3)).toEqual(Array(3).fill(OMITTED_TOOL_OUTPUT(1000)));
    expect(tools.slice(3)).toEqual([big, big, big]);
    expect(messagesTokens(msgs)).toBeLessThanOrEqual(3500);
  });

  it('clipToTokens 截断并附说明', () => {
    const s = clipToTokens('研'.repeat(100), 10, '…');
    expect(s).toBe(`${'研'.repeat(10)}…`);
  });
});

describe('compact', () => {
  it('转录太长时分块并入，每块都带上一块的摘要，摘要上限与 prompt 一致', async () => {
    const t = await makeApp({ AGENT_CONTEXT_TOKENS: '8000' });
    const reqs: ChatRequest[] = [];
    const model: ChatModel = {
      name: 'fake',
      async chat(req) {
        reqs.push(req);
        return {
          content: `摘要${reqs.length}` + '长'.repeat(SUMMARY_MAX_CHARS),
          reasoning: '',
          toolCalls: [],
          usage: { input: 0, output: 0, cached: 0 },
          model: 'fake',
        };
      },
    };
    const turns = Array.from({ length: 4 }, (_, i) => ({
      turnId: `t${i}`,
      messages: [{ role: 'user', content: `第${i}轮` + '字'.repeat(1500) } as ChatMessage],
    }));
    const ok = await compact(
      t.app.ctx,
      model,
      { id: 'ags_none', contextSummary: '旧摘要' } as SessionRow,
      turns,
      0,
    );
    expect(ok).toBe(true);
    // 8000 窗口 → 一块最多 2000 token：4 轮各 ~1500 字要分 4 块
    expect(reqs.length).toBe(4);
    expect(reqs[0]!.messages[0]!.content).toContain(`不超过 ${SUMMARY_MAX_CHARS} 字`);
    expect(reqs[0]!.messages[1]!.content).toContain('旧摘要');
    expect(reqs[1]!.messages[1]!.content).toContain('摘要1');
    expect(reqs[1]!.messages[1]!.content).toContain('第 2/4 段');
    expect(reqs[3]!.messages[1]!.content).toContain('第3轮');
    await t.close();
  }, 60_000);
});

// ---------------------------------------------------------------- 整轮场景

let seq = 0;
const call = (name: string, args: unknown): ChatToolCall => ({
  id: `call_${++seq}`,
  name,
  arguments: JSON.stringify(args),
});
const result = (toolCalls: ChatToolCall[], content = ''): ChatResult => ({
  content,
  reasoning: '',
  toolCalls,
  usage: { input: 1, output: 1, cached: 0 },
  model: 'fake',
});

interface Script {
  reads: number;
  compactFails?: boolean;
}

/** 协调者：每条成员消息读 reads 次大文件，然后 no_reply_needed。记录每次请求的 token 数 */
function scripted(s: Script) {
  const log = { maxPrompt: 0, compactions: 0, requests: [] as ChatMessage[][] };
  const model: ChatModel = {
    name: 'fake',
    async chat(req) {
      if (!req.tools) {
        log.compactions += 1;
        if (s.compactFails) throw new Error('模型挂了');
        return result([], '摘要：成员让读 big.txt，已读完。');
      }
      const tokens = messagesTokens(req.messages) + estimateTokens(JSON.stringify(req.tools));
      log.maxPrompt = Math.max(log.maxPrompt, tokens);
      log.requests.push(req.messages.map((m) => ({ ...m })) as ChatMessage[]);
      const start = req.messages.findLastIndex(
        (m) => m.role === 'user' && /trust="principal"/u.test(m.content ?? ''),
      );
      const done = req.messages.slice(start).filter((m) => m.role === 'assistant').length;
      if (start < 0) return result([call('no_reply_needed', { reason: 'nothing_to_add' })]);
      if (done < s.reads) return result([call('read_file', { path_or_id: 'big.txt' })]);
      return result([call('no_reply_needed', { reason: 'nothing_to_add' })]);
    },
  };
  return { model, log };
}

async function run(s: Script, posts: number) {
  const t = await makeApp();
  const p = await setupProject(t.app, []);
  await writeProjectFile(t.app.ctx, SYSTEM_ACTOR, p.project.id, 'big.txt', '研'.repeat(20_000));
  const { model, log } = scripted(s);
  const runtime = startAgentRuntime(t.app.ctx, { model, tickMs: 60_000 })!;
  const P = `/projects/${p.project.id}`;
  for (let i = 0; i < posts; i++) {
    await p.owner.req('POST', `${P}/timeline`, { body: `第 ${i + 1} 次：读一下 big.txt` });
    for (let k = 0; k < 4; k++) await runtime.idle();
  }
  const agents = (await p.owner.req('GET', `${P}/agents`)).json<AgentSession[]>();
  await runtime.stop();
  await t.close();
  return { log, coordinator: agents.find((a) => a.role === 'coordinator')! };
}

describe('上下文预算（整轮）', () => {
  const budget = contextBudget();
  afterEach(() => vi.restoreAllMocks());

  it('一轮里工具输出越积越多：较早的被换成占位，最近的保留，整条 prompt 不超预算', async () => {
    const { log } = await run({ reads: 10 }, 1);
    expect(log.maxPrompt).toBeLessThanOrEqual(budget.prompt);
    const last = log.requests.at(-1)!;
    const tools = last.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(tools.length).toBe(10);
    expect(tools.some((c) => c.startsWith('[已省略较早的工具输出'))).toBe(true);
    expect(tools.at(-1)).toContain('研'.repeat(1000));
    expect(log.compactions).toBe(0);
  }, 120_000);

  it('按整条 prompt 触发压缩：历史 + system 超预算时把旧 turn 并入摘要', async () => {
    const { log, coordinator } = await run({ reads: 4 }, 3);
    expect(log.compactions).toBeGreaterThanOrEqual(1);
    expect(log.maxPrompt).toBeLessThanOrEqual(budget.prompt);
    const sys = log.requests.at(-1)![0]!.content!;
    expect(sys).toContain('<context-summary>');
    expect(sys).toContain('摘要：成员让读 big.txt');
    expect(coordinator.status).toBe('idle');
  }, 120_000);

  it('压缩失败：记日志，本轮改用截断的历史继续，不超预算', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { log, coordinator } = await run({ reads: 4, compactFails: true }, 3);
    expect(log.compactions).toBeGreaterThanOrEqual(1);
    expect(log.maxPrompt).toBeLessThanOrEqual(budget.prompt);
    expect(errors.mock.calls.some((c) => String(c[0]).includes('压缩历史失败'))).toBe(true);
    expect(log.requests.at(-1)![0]!.content).not.toContain('<context-summary>');
    // 第 3 条消息照常处理完
    expect(coordinator.status).toBe('idle');
    const lastReq = log.requests.at(-1)!;
    expect(lastReq.some((m) => m.role === 'user' && m.content?.includes('第 3 次'))).toBe(true);
  }, 120_000);
});
