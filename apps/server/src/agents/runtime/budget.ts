import type { AppConfig } from '../../config';
import type { ChatMessage } from '../llm/complete';

/**
 * 上下文预算（ARCHITECTURE.md §7.2、prompts/README.md §2.2）。
 *
 * 所有「够不够放」的判断都走这里，按估算 token 计：
 * - 中日韩字符（含全角标点）≈ 1 token / 字；其他文本 ≈ 3.5 字符 / token。
 * - 模型窗口默认 128K（AGENT_CONTEXT_TOKENS），预留输出（AGENT_OUTPUT_RESERVE_TOKENS），
 *   剩下的是整条 prompt（system + 历史 + 本轮唤醒 + 本轮工具往返）的预算。
 * - system 基础段、记忆、压缩摘要、本轮唤醒各有上限；历史用剩下的部分。
 * 估算偏保守即可：目标是不超窗口，不是精确计费。
 */

const CJK =
  /[\u2E80-\u2FFF\u3000-\u303F\u3040-\u30FF\u3100-\u312F\u3130-\u318F\u3190-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/gu;
/** 每条消息的固定开销（角色、分隔符） */
const MESSAGE_OVERHEAD = 4;

/** 估算一段文本的 token 数 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 3.5);
}

export function messageTokens(m: ChatMessage): number {
  let n = MESSAGE_OVERHEAD + estimateTokens(m.content);
  if (m.role === 'assistant')
    for (const c of m.tool_calls ?? [])
      n += MESSAGE_OVERHEAD + estimateTokens(c.name + c.arguments);
  return n;
}

export function messagesTokens(msgs: readonly ChatMessage[]): number {
  let n = 0;
  for (const m of msgs) n += messageTokens(m);
  return n;
}

/** 摘要的长度上限（字）：压缩 prompt 里写的上限与落库截断用同一个数 */
export const SUMMARY_MAX_CHARS = 3000;

export interface ContextBudget {
  /** 模型窗口 */
  window: number;
  /** 给输出（含推理）预留 */
  outputReserve: number;
  /** 整条 prompt 的上限 = window - outputReserve */
  prompt: number;
  /** shared-protocol + 角色 + session-context + harness 段的预期上限（超了只告警，不裁） */
  systemBase: number;
  /** <memory> 整块上限 */
  memory: number;
  /** <context-summary> 上限 */
  summary: number;
  /** 本轮唤醒（新消息）上限；超过时截断并提示用 read_thread / read_message 读原文 */
  wake: number;
  /** 压缩时一次送进摘要模型的对话上限（超过就分块逐段并入） */
  compactChunk: number;
  /** 压缩后保留的最近 turn：最多几个、合计最多占历史预算的多少 */
  keepRecentTurns: number;
  keepRecentShare: number;
}

export function contextBudget(
  config?: Partial<Pick<AppConfig, 'AGENT_CONTEXT_TOKENS' | 'AGENT_OUTPUT_RESERVE_TOKENS'>>,
): ContextBudget {
  const window = config?.AGENT_CONTEXT_TOKENS ?? 128_000;
  const outputReserve = Math.min(
    config?.AGENT_OUTPUT_RESERVE_TOKENS ?? 16_000,
    Math.floor(window / 2),
  );
  const prompt = window - outputReserve;
  return {
    window,
    outputReserve,
    prompt,
    systemBase: Math.round(prompt * 0.3),
    memory: Math.min(6_000, Math.round(prompt * 0.06)),
    summary: SUMMARY_MAX_CHARS,
    wake: Math.round(prompt * 0.15),
    compactChunk: Math.min(60_000, Math.round(prompt * 0.5)),
    keepRecentTurns: 2,
    keepRecentShare: 0.5,
  };
}

/** 历史可用的 token：整条 prompt 预算减去 system 与本轮唤醒的实际大小 */
export function historyBudget(b: ContextBudget, systemTokens: number, wakeTokens: number): number {
  return Math.max(0, b.prompt - systemTokens - wakeTokens);
}

/**
 * 压缩时保留几个最近 turn：从最新往前数，合计不超过历史预算的 keepRecentShare，
 * 最多 keepRecentTurns 个；最近一个 turn 本身就很大时可以是 0（整段并入摘要）。
 */
export function turnsToKeep(
  turnTokens: readonly number[],
  historyTokens: number,
  b: ContextBudget,
): number {
  const cap = historyTokens * b.keepRecentShare;
  let keep = 0;
  let sum = 0;
  for (let i = turnTokens.length - 1; i >= 0 && keep < b.keepRecentTurns; i--) {
    sum += turnTokens[i]!;
    if (sum > cap) break;
    keep += 1;
  }
  return keep;
}

export const OMITTED_TOOL_OUTPUT = (chars: number) =>
  `[已省略较早的工具输出 ${chars} 字，需要时重新调用]`;

/**
 * 本轮工具往返越积越多时（24 步 × 每步最多 12K 字），把较早的工具结果换成一行占位，
 * 直到整条 prompt 回到预算内。最近 keepLatest 条工具结果原样保留。原地修改，返回省略的条数。
 * 已经换过的消息之后不再变化，前缀缓存在被换掉的位置之后才失效。
 */
export function shrinkToolResults(
  messages: ChatMessage[],
  budgetTokens: number,
  keepLatest = 4,
  from = 0,
): number {
  let total = messagesTokens(messages);
  if (total <= budgetTokens) return 0;
  const toolIdx: number[] = [];
  for (let i = from; i < messages.length; i++) if (messages[i]!.role === 'tool') toolIdx.push(i);
  const candidates = toolIdx.slice(0, Math.max(0, toolIdx.length - keepLatest));
  let shrunk = 0;
  for (const i of candidates) {
    if (total <= budgetTokens) break;
    const m = messages[i] as Extract<ChatMessage, { role: 'tool' }>;
    if (m.content.startsWith('[已省略较早的工具输出')) continue;
    const before = messageTokens(m);
    m.content = OMITTED_TOOL_OUTPUT(m.content.length);
    total -= before - messageTokens(m);
    shrunk += 1;
  }
  return shrunk;
}

/** 按 token 上限截文本（保留开头），截掉时附说明 */
export function clipToTokens(
  text: string,
  maxTokens: number,
  note = '…（超出预算，已截断）',
): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + note;
}
