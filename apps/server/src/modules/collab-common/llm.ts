import { ApiError, type HybridPrivacy, type HybridTask } from '@srh/shared';
import type { AppContext } from '../../context';
import { createLlmClient, type LlmClient } from '../../agents/llm/client';
import { isDeepSeekUrl } from '../../agents/llm/registry';
import {
  createRestorer,
  decide,
  hybridEnabled,
  localClient,
  localSystemSuffix,
  markLocalDown,
  recordCall,
  redact,
  REDACT_NOTE,
  restore,
  stripThink,
  type HybridDecision,
} from '../../agents/llm/hybrid';
import {
  assertCanSpend,
  chargeUsage,
  type BillingContext,
  type ProviderRef,
} from '../billing/service';

/**
 * 协作模块用的 LLM 调用（DeepSeek，OpenAI 兼容接口）。
 * 带 task 的调用走混合 AI 分流（agents/llm/hybrid.ts）：本地优先的任务交给本机模型，
 * 走云端的调用在配置了本地模型时先脱敏、回来再还原。
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
  /** 混合 AI：任务类型（不传 = 只走云端，与以前一样） */
  task?: HybridTask;
  /** local_only = 只用本机模型 */
  privacy?: HybridPrivacy;
  /** 告诉调用方这次实际走了哪边（流式接口用来写响应头） */
  onRoute?: (info: { target: 'local' | 'cloud'; fallback: boolean; redacted: number }) => void;
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
  return clients.get(ctx) !== null || hybridEnabled(ctx.config);
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

function isAbort(err: unknown, signal?: AbortSignal) {
  return Boolean(signal?.aborted) || (err instanceof Error && err.name === 'AbortError');
}

async function route(ctx: AppContext, input: CompleteInput): Promise<HybridDecision | null> {
  if (!input.task) return null;
  return decide(
    ctx.config,
    input.task,
    input.system.length + input.user.length,
    input.privacy ?? 'auto',
  );
}

/** 云端调用前的脱敏（只在配置了本地模型、且开启 HYBRID_REDACT 时） */
async function prepareCloud(ctx: AppContext, input: CompleteInput) {
  if (!input.task || !hybridEnabled(ctx.config) || !ctx.config.HYBRID_REDACT)
    return {
      system: input.system,
      user: input.user,
      items: [] as { placeholder: string; original: string; kind: string }[],
    };
  const r = await redact(ctx.config, [input.user], input.signal ? { signal: input.signal } : {});
  return {
    system: r.items.length ? input.system + REDACT_NOTE : input.system,
    user: r.texts[0]!,
    items: r.items,
  };
}

// ---------------------------------------------------------------- 本地

async function completeLocal(ctx: AppContext, input: CompleteInput): Promise<string> {
  const t0 = Date.now();
  const res = await localClient(ctx.config).chat.completions.create(
    {
      model: ctx.config.LOCAL_LLM_MODEL,
      messages: [
        { role: 'system', content: input.system + localSystemSuffix() },
        { role: 'user', content: input.user },
      ],
      temperature: input.temperature ?? 0.5,
      max_tokens: input.maxTokens ?? 2048,
    },
    { signal: input.signal },
  );
  recordCall({
    task: input.task!,
    target: 'local',
    model: ctx.config.LOCAL_LLM_MODEL,
    fallback: false,
    redacted: 0,
    ms: Date.now() - t0,
    firstTokenMs: null,
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: res.usage?.completion_tokens ?? 0,
    ok: true,
  });
  return stripThink(res.choices[0]?.message?.content ?? '').trim();
}

async function* streamLocal(ctx: AppContext, input: CompleteInput): AsyncGenerator<string> {
  const t0 = Date.now();
  const stream = await localClient(ctx.config).chat.completions.create(
    {
      model: ctx.config.LOCAL_LLM_MODEL,
      messages: [
        { role: 'system', content: input.system + localSystemSuffix() },
        { role: 'user', content: input.user },
      ],
      temperature: input.temperature ?? 0.6,
      max_tokens: input.maxTokens ?? 2048,
      stream: true,
      stream_options: { include_usage: true },
    },
    { signal: input.signal },
  );
  let first: number | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let chars = 0;
  // 去掉开头可能出现的空 <think></think>
  let head = '';
  let headDone = false;
  try {
    for await (const part of stream) {
      if (part.usage) {
        inputTokens = part.usage.prompt_tokens;
        outputTokens = part.usage.completion_tokens;
      }
      const delta = part.choices[0]?.delta?.content;
      if (!delta) continue;
      first ??= Date.now() - t0;
      chars += delta.length;
      if (headDone) {
        yield delta;
        continue;
      }
      head += delta;
      const t = head.trimStart();
      if (t.startsWith('<think>') ? !t.includes('</think>') : '<think>'.startsWith(t)) continue;
      headDone = true;
      const cleaned = stripThink(head).replace(/^\s+/u, '');
      if (cleaned) yield cleaned;
    }
    if (!headDone) {
      const cleaned = stripThink(head).trim();
      if (cleaned) yield cleaned;
    }
  } finally {
    recordCall({
      task: input.task!,
      target: 'local',
      model: ctx.config.LOCAL_LLM_MODEL,
      fallback: false,
      redacted: 0,
      ms: Date.now() - t0,
      firstTokenMs: first,
      inputTokens,
      // 部分服务流式不报 usage：按约 1.6 字符 / token 估
      outputTokens: outputTokens || Math.round(chars / 1.6),
      ok: chars > 0,
    });
  }
}

// ---------------------------------------------------------------- 入口

export async function completeText(ctx: AppContext, input: CompleteInput): Promise<string> {
  const d = await route(ctx, input);
  if (d?.target === 'local') {
    try {
      const text = await completeLocal(ctx, input);
      input.onRoute?.({ target: 'local', fallback: false, redacted: 0 });
      return text;
    } catch (err) {
      if (isAbort(err, input.signal) || d.route === 'local')
        throw err instanceof ApiError ? err : localError(err);
      markLocalDown((err as Error).message);
      return completeCloud(ctx, input, true);
    }
  }
  return completeCloud(ctx, input, d?.fallback ?? false);
}

function localError(err: unknown): ApiError {
  console.error('[hybrid] 本地模型调用失败', (err as Error).message);
  return new ApiError('llm_unavailable', '本地模型调用失败，内容设为仅本地处理，没有发往云端');
}

async function completeCloud(
  ctx: AppContext,
  input: CompleteInput,
  fallback: boolean,
): Promise<string> {
  const c = client(ctx);
  const model = input.reasoning ? c.reasoningModel : c.model;
  if (input.billing) await assertCanSpend(ctx, envProvider(ctx), input.billing);
  const prep = await prepareCloud(ctx, input);
  input.onRoute?.({ target: 'cloud', fallback, redacted: prep.items.length });
  const t0 = Date.now();
  try {
    const res = await c.client.chat.completions.create(
      {
        model,
        messages: [
          { role: 'system', content: prep.system },
          { role: 'user', content: prep.user },
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
    if (input.task)
      recordCall({
        task: input.task,
        target: 'cloud',
        model,
        fallback,
        redacted: prep.items.length,
        ms: Date.now() - t0,
        firstTokenMs: null,
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
        ok: true,
      });
    return restore(res.choices[0]?.message?.content?.trim() ?? '', prep.items);
  } catch (err) {
    return wrap(err);
  }
}

export async function* streamText(ctx: AppContext, input: CompleteInput): AsyncIterable<string> {
  const d = await route(ctx, input);
  if (d?.target === 'local') {
    let produced = false;
    try {
      input.onRoute?.({ target: 'local', fallback: false, redacted: 0 });
      for await (const piece of streamLocal(ctx, input)) {
        produced = true;
        yield piece;
      }
      return;
    } catch (err) {
      // 已经输出了一部分就不能再换云端重来
      if (produced || isAbort(err, input.signal) || d.route === 'local')
        throw err instanceof ApiError ? err : localError(err);
      markLocalDown((err as Error).message);
    }
    yield* streamCloud(ctx, input, true);
    return;
  }
  yield* streamCloud(ctx, input, d?.fallback ?? false);
}

async function* streamCloud(
  ctx: AppContext,
  input: CompleteInput,
  fallback: boolean,
): AsyncGenerator<string> {
  const c = client(ctx);
  const model = input.reasoning ? c.reasoningModel : c.model;
  if (input.billing) await assertCanSpend(ctx, envProvider(ctx), input.billing);
  const prep = await prepareCloud(ctx, input);
  input.onRoute?.({ target: 'cloud', fallback, redacted: prep.items.length });
  const t0 = Date.now();
  let stream;
  try {
    stream = await c.client.chat.completions.create(
      {
        model,
        messages: [
          { role: 'system', content: prep.system },
          { role: 'user', content: prep.user },
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
  const restorer = createRestorer(prep.items);
  let inputTokens = 0;
  let outputTokens = 0;
  let first: number | null = null;
  try {
    for await (const part of stream) {
      if (part.usage) {
        inputTokens = part.usage.prompt_tokens;
        outputTokens = part.usage.completion_tokens;
      }
      const delta = part.choices[0]?.delta?.content;
      if (!delta) continue;
      first ??= Date.now() - t0;
      const out = restorer.push(delta);
      if (out) yield out;
    }
    const rest = restorer.flush();
    if (rest) yield rest;
  } finally {
    // 中途取消也按已产生的用量记账（拿不到 usage 时 tokens 为 0，不扣）
    if (input.billing)
      await chargeUsage(ctx, input.billing, {
        provider: envProvider(ctx),
        model,
        inputTokens,
        outputTokens,
      });
    if (input.task)
      recordCall({
        task: input.task,
        target: 'cloud',
        model,
        fallback,
        redacted: prep.items.length,
        ms: Date.now() - t0,
        firstTokenMs: first,
        inputTokens,
        outputTokens,
        ok: first !== null,
      });
  }
}
