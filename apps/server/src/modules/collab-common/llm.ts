import { ApiError } from '@srh/shared';
import type { AppContext } from '../../context';
import { createLlmClient, type LlmClient } from '../../agents/llm/client';
import { isDeepSeekUrl } from '../../agents/llm/registry';
import {
  assertCanSpend,
  chargeUsage,
  type BillingContext,
  type ProviderRef,
} from '../billing/service';

/**
 * 协作模块用的 LLM 调用（DeepSeek，OpenAI 兼容接口）。
 * 后端线程的 agents/llm/complete.ts（completeText / streamText）合并后改为转调它们，签名一致。
 */
export interface CompleteInput {
  system: string;
  user: string;
  /** true = 用推理模型（组会汇报、规划） */
  reasoning?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** 计费：谁付钱（不传则不计费）。走的是 .env 主 provider，属于平台 provider */
  billing?: BillingContext;
}

function envProvider(ctx: AppContext): ProviderRef {
  return { id: isDeepSeekUrl(ctx.config.LLM_BASE_URL) ? 'deepseek' : 'default', source: 'env' };
}

const clients = new WeakMap<AppContext, LlmClient | null>();

function client(ctx: AppContext): LlmClient {
  if (!clients.has(ctx)) clients.set(ctx, createLlmClient(ctx.config));
  const c = clients.get(ctx);
  if (!c)
    throw new ApiError(
      'llm_unavailable',
      '还没有配置大模型 API Key（LLM_API_KEY），AI 功能暂不可用',
    );
  return c;
}

/** 测试注入：替换某个 ctx 的 LLM 客户端（null = 未配置） */
export function setLlmClientForTest(ctx: AppContext, c: LlmClient | null) {
  clients.set(ctx, c);
}

export function llmAvailable(ctx: AppContext): boolean {
  if (!clients.has(ctx)) clients.set(ctx, createLlmClient(ctx.config));
  return clients.get(ctx) !== null;
}

function wrap(err: unknown): never {
  if (err instanceof ApiError) throw err;
  if (err instanceof Error && err.name === 'AbortError') throw err;
  const status = (err as { status?: number }).status;
  if (status === 401 || status === 403) {
    throw new ApiError(
      'llm_unavailable',
      '大模型 API Key 无效或已过期，请在服务器 .env 里更新 LLM_API_KEY',
    );
  }
  if (status === 429) throw new ApiError('rate_limited', '大模型调用太频繁了，请稍等片刻再试');
  if (status === 402) throw new ApiError('llm_unavailable', '大模型账户余额不足，请充值后再试');
  throw new ApiError('llm_unavailable', '大模型暂时不可用，请稍后再试');
}

export async function completeText(ctx: AppContext, input: CompleteInput): Promise<string> {
  const c = client(ctx);
  const model = input.reasoning ? c.reasoningModel : c.model;
  if (input.billing) await assertCanSpend(ctx, envProvider(ctx), input.billing);
  try {
    const res = await c.client.chat.completions.create(
      {
        model,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
        temperature: input.reasoning ? undefined : (input.temperature ?? 0.5),
        max_tokens: input.maxTokens ?? 4096,
      },
      { signal: input.signal },
    );
    if (input.billing)
      await chargeUsage(ctx, input.billing, {
        provider: envProvider(ctx),
        model,
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      });
    return res.choices[0]?.message?.content?.trim() ?? '';
  } catch (err) {
    return wrap(err);
  }
}

export async function* streamText(ctx: AppContext, input: CompleteInput): AsyncIterable<string> {
  const c = client(ctx);
  const model = input.reasoning ? c.reasoningModel : c.model;
  if (input.billing) await assertCanSpend(ctx, envProvider(ctx), input.billing);
  let stream;
  try {
    stream = await c.client.chat.completions.create(
      {
        model,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
        temperature: input.reasoning ? undefined : (input.temperature ?? 0.6),
        max_tokens: input.maxTokens ?? 4096,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: input.signal },
    );
  } catch (err) {
    wrap(err);
  }
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    for await (const part of stream) {
      if (part.usage) {
        inputTokens = part.usage.prompt_tokens;
        outputTokens = part.usage.completion_tokens;
      }
      const delta = part.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  } finally {
    // 中途取消也按已产生的用量记账（拿不到 usage 时 tokens 为 0，不扣）
    if (input.billing)
      await chargeUsage(ctx, input.billing, {
        provider: envProvider(ctx),
        model,
        inputTokens,
        outputTokens,
      });
  }
}
