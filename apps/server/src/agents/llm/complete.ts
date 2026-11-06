import { ApiError } from '@srh/shared';
import type { AppContext } from '../../context';
import type OpenAI from 'openai';
import { createLlmClient, type LlmClient } from './client';
import { clientFor, isDeepSeekUrl, resolveModel, thinkingParams } from './registry';
import {
  assertCanSpend,
  chargeUsage,
  type BillingContext,
  type ProviderRef,
} from '../../modules/billing/service';

/**
 * 对模型的统一调用层。agent 运行时只依赖 ChatModel 接口（测试里换成脚本化的假模型），
 * 协作模块的一次性生成（组会汇报、文档内嵌 AI）用 completeText / streamText。
 */

export interface ChatToolCall {
  id: string;
  name: string;
  /** 原始 JSON 字符串 */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model?: 'default' | 'reasoning';
  /**
   * 按注册表路由（agent 会话的模型与强度，ARCHITECTURE.md §7.6）。不传时走 .env 主 provider 的旧路径
   * （model: 'default' | 'reasoning'）。脚本化的测试模型可以忽略它。
   */
  route?: { projectId: string; modelId: string | null; effort: string | null };
  messages: ChatMessage[];
  tools?: ChatToolSpec[];
  signal?: AbortSignal;
  /** 文字增量（流式） */
  onDelta?: (text: string) => void;
  /** 计费：谁付钱、算在哪个项目（不传则不计费，只有平台 provider 才收费） */
  billing?: BillingContext;
}

export interface ChatResult {
  content: string;
  reasoning: string;
  toolCalls: ChatToolCall[];
  usage: { input: number; output: number; cached: number };
  /** 上游报的真实成本（美元，OpenRouter usage.cost） */
  costUsd?: number;
  model: string;
  /** 实际使用的推理强度（走注册表路由时才有） */
  effort?: string;
}

export interface ChatModel {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResult>;
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

async function withRetry<T>(req: ChatRequest, fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { status?: number }).status;
      const aborted = req.signal?.aborted || (err as Error).name === 'AbortError';
      attempt += 1;
      if (aborted || attempt >= 4 || (status !== undefined && !RETRYABLE.has(status))) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
}

/** DeepSeek（OpenAI 兼容）实现：流式 + tool calling + 指数退避重试 */
export function createChatModel(llm: LlmClient): ChatModel {
  return {
    name: llm.model,
    async chat(req) {
      const model = req.model === 'reasoning' ? llm.reasoningModel : llm.model;
      return withRetry(req, () => streamOnce(llm.client, model, req, {}));
    },
  };
}

/**
 * agent 运行时用的模型：每次请求按 req.route 在注册表里解析 provider / 模型 / 推理强度
 * （会话改了模型或强度，下一次请求立即生效）；没有 route 时退回 fallback（.env 主 provider）。
 */
export function createRoutedChatModel(ctx: AppContext, fallback: ChatModel | null): ChatModel {
  return {
    name: fallback?.name ?? 'routed',
    async chat(req) {
      if (!req.route) {
        if (!fallback) throw new ApiError('llm_unavailable', '还没有配置模型密钥');
        return billed(ctx, primaryProvider(ctx), req, () => fallback.chat(req));
      }
      const r = await resolveModel(ctx, req.route.projectId, req.route.modelId, req.route.effort);
      const extra = thinkingParams(r.provider.thinkingFormat, r.effort);
      const res = await billed(ctx, r.provider, req, () =>
        withRetry(req, () => streamOnce(clientFor(r.provider), r.info.model, req, extra)),
      );
      return { ...res, model: r.id, effort: r.effort };
    },
  };
}

/** .env 主 provider（旧路径 createChatModel 用的就是它） */
function primaryProvider(ctx: AppContext): ProviderRef {
  return { id: isDeepSeekUrl(ctx.config.LLM_BASE_URL) ? 'deepseek' : 'default', source: 'env' };
}

/**
 * 计费包装：调用前过余额闸门，调用后按用量扣费（chargeUsage 是唯一扣费点）。
 * 没有 req.billing 的调用（测试、探活）不计费。
 */
async function billed(
  ctx: AppContext,
  provider: ProviderRef,
  req: ChatRequest,
  run: () => Promise<ChatResult>,
): Promise<ChatResult> {
  if (!req.billing) return run();
  await assertCanSpend(ctx, provider, req.billing);
  const res = await run();
  const slash = res.model.indexOf('/');
  const bare =
    slash > 0 && res.model.startsWith(`${provider.id}/`) ? res.model.slice(slash + 1) : res.model;
  await chargeUsage(ctx, req.billing, {
    provider,
    model: bare,
    inputTokens: res.usage.input,
    outputTokens: res.usage.output,
    costUsd: res.costUsd ?? null,
  });
  return res;
}

async function streamOnce(
  client: OpenAI,
  model: string,
  req: ChatRequest,
  extra: Record<string, unknown>,
): Promise<ChatResult> {
  const stream = await client.chat.completions.create(
    {
      ...extra,
      model,
      messages: req.messages.map((m) =>
        m.role === 'assistant'
          ? {
              role: 'assistant' as const,
              content: m.content ?? '',
              ...(m.tool_calls?.length
                ? {
                    tool_calls: m.tool_calls.map((c) => ({
                      id: c.id,
                      type: 'function' as const,
                      function: { name: c.name, arguments: c.arguments },
                    })),
                  }
                : {}),
            }
          : m,
      ),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
      stream: true,
      stream_options: { include_usage: true },
    },
    { signal: req.signal },
  );
  let content = '';
  let reasoning = '';
  const calls = new Map<number, ChatToolCall>();
  const usage = { input: 0, output: 0, cached: 0 };
  let costUsd: number | undefined;
  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    const delta = choice?.delta as
      (NonNullable<typeof choice>['delta'] & { reasoning_content?: string | null }) | undefined;
    if (delta?.reasoning_content) reasoning += delta.reasoning_content;
    if (delta?.content) {
      content += delta.content;
      req.onDelta?.(delta.content);
    }
    for (const tc of delta?.tool_calls ?? []) {
      let call = calls.get(tc.index);
      if (!call) calls.set(tc.index, (call = { id: '', name: '', arguments: '' }));
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.name += tc.function.name;
      if (tc.function?.arguments) call.arguments += tc.function.arguments;
    }
    if (chunk.usage) {
      const u = chunk.usage as typeof chunk.usage & {
        prompt_cache_hit_tokens?: number;
        cost?: number;
      };
      usage.input = u.prompt_tokens;
      usage.output = u.completion_tokens;
      usage.cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
      if (typeof u.cost === 'number' && Number.isFinite(u.cost) && u.cost >= 0) costUsd = u.cost;
    }
  }
  return {
    content,
    reasoning,
    toolCalls: [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, c]) => ({ ...c, id: c.id || `call_${i}` })),
    usage,
    ...(costUsd !== undefined ? { costUsd } : {}),
    model,
  };
}

let cached: { key: string; model: ChatModel } | null = null;

function modelFor(ctx: AppContext): ChatModel {
  const key = `${ctx.config.LLM_BASE_URL}|${ctx.config.LLM_MODEL}|${ctx.config.LLM_API_KEY.slice(-6)}`;
  if (cached?.key === key) return cached.model;
  const llm = createLlmClient(ctx.config);
  if (!llm) throw new ApiError('llm_unavailable', '还没有配置模型密钥，暂时不能生成');
  cached = { key, model: createChatModel(llm) };
  return cached.model;
}

interface TextInput {
  system: string;
  user: string;
  reasoning?: boolean;
  signal?: AbortSignal;
  billing?: BillingContext;
}

/** 一次性无工具生成（组会汇报等）。reasoning=true 用推理模型。 */
export async function completeText(ctx: AppContext, input: TextInput): Promise<string> {
  const req: ChatRequest = {
    model: input.reasoning ? 'reasoning' : 'default',
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user },
    ],
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.billing ? { billing: input.billing } : {}),
  };
  const res = await billed(ctx, primaryProvider(ctx), req, () => modelFor(ctx).chat(req));
  return res.content;
}

/** 流式生成：逐段产出文字（文档内嵌 AI 等）。 */
export async function* streamText(ctx: AppContext, input: TextInput): AsyncIterable<string> {
  const queue: string[] = [];
  let done = false;
  let error: unknown = null;
  let wake: (() => void) | null = null;
  const req: ChatRequest = {
    model: input.reasoning ? 'reasoning' : 'default',
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user },
    ],
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.billing ? { billing: input.billing } : {}),
    onDelta: (t) => {
      queue.push(t);
      wake?.();
    },
  };
  const p = billed(ctx, primaryProvider(ctx), req, () => modelFor(ctx).chat(req))
    .catch((err: unknown) => {
      error = err;
    })
    .finally(() => {
      done = true;
      wake?.();
    });
  while (!done || queue.length) {
    if (queue.length) {
      yield queue.shift()!;
      continue;
    }
    await new Promise<void>((r) => (wake = r));
    wake = null;
  }
  await p;
  if (error) throw error;
}
