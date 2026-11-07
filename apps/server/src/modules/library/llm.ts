import { ApiError } from '@srh/shared';
import type { AppContext } from '../../context';
import type { LlmClient } from '../../agents/llm/client';
import { clientFor, fitEffort, thinkingParams } from '../../agents/llm/registry';
import type { CompleteInput } from '../collab-common/llm';
import { assertCanSpend, chargeUsage, type BillingContext } from '../billing/service';
import { libraryScope, type LibraryScopeInput } from './scope';
import { libraryDefaultModel, libraryProviders } from './models';

const overrides = new WeakMap<AppContext, LlmClient | null>();
export type LibraryTextInput = CompleteInput & { modelId?: string };
export function setLibraryLlmForTest(ctx: AppContext, client: LlmClient | null) {
  overrides.set(ctx, client);
}

export async function libraryLlmAvailable(ctx: AppContext, scope: LibraryScopeInput) {
  if (overrides.has(ctx)) return overrides.get(ctx) !== null;
  return (await libraryProviders(ctx, scope)).length > 0;
}

async function resolveModel(ctx: AppContext, scope: LibraryScopeInput, modelId?: string) {
  if (!modelId) return libraryDefaultModel(ctx, scope);
  const providers = await libraryProviders(ctx, scope);
  for (const provider of providers) {
    const info = provider.models.find((m) => `${provider.id}/${m.model}` === modelId);
    if (info) return { id: modelId, provider, info };
  }
  throw new ApiError('validation_failed', '所选模型在当前文献库不可用，请重新选择');
}
export async function libraryTextModel(
  ctx: AppContext,
  scope: LibraryScopeInput,
  modelId?: string,
) {
  if (overrides.has(ctx)) {
    const injected = overrides.get(ctx);
    if (!injected) throw new ApiError('llm_unavailable', '尚无可用模型');
    return { id: modelId ?? `test/${injected.model}`, name: injected.model };
  }
  const resolved = await resolveModel(ctx, scope, modelId);
  return { id: resolved.id, name: `${resolved.provider.name} · ${resolved.info.model}` };
}
async function request(ctx: AppContext, scope: LibraryScopeInput, input: LibraryTextInput) {
  const injected = overrides.get(ctx);
  if (overrides.has(ctx) && !injected) throw new ApiError('llm_unavailable', '尚无可用模型');
  const resolved = injected ? null : await resolveModel(ctx, scope, input.modelId);
  return {
    client: injected?.client ?? clientFor(resolved!.provider),
    provider: resolved ? { id: resolved.provider.id, source: resolved.provider.source } : null,
    model: injected?.model ?? resolved!.info.model,
    body: {
      ...(resolved
        ? thinkingParams(resolved.provider.thinkingFormat, fitEffort(resolved.info, 'off'))
        : {}),
      model: injected?.model ?? resolved!.info.model,
      messages: [
        { role: 'system' as const, content: input.system },
        { role: 'user' as const, content: input.user },
      ],
      max_tokens: input.maxTokens ?? 2000,
    },
  };
}

function wrap(err: unknown): never {
  if (err instanceof ApiError || (err instanceof Error && err.name === 'AbortError')) throw err;
  const status = (err as { status?: number } | null)?.status;
  if (status === 429) throw new ApiError('rate_limited', '模型繁忙，请稍后重试');
  if (status === 401 || status === 403)
    throw new ApiError('llm_unavailable', '模型鉴权失败，请在对应项目的“设置 → 模型”中检查配置');
  throw new ApiError('llm_unavailable', '模型服务暂不可用，请稍后重试');
}

export async function completeLibraryText(
  ctx: AppContext,
  scope: LibraryScopeInput,
  input: LibraryTextInput,
) {
  const { client, body, provider, model } = await request(ctx, scope, input).catch(wrap);
  const billing = billingFor(scope, input);
  await assertCanSpend(ctx, provider, billing);
  try {
    const response = await client.chat.completions.create(body, { signal: input.signal });
    await chargeUsage(ctx, billing, {
      provider,
      model,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      costUsd: (response.usage as { cost?: number } | undefined)?.cost ?? null,
    });
    return response.choices[0]?.message.content?.trim() ?? '';
  } catch (err) {
    return wrap(err);
  }
}

/** 付款人：调用方明确给的；否则个人库归本人，项目库归项目创建者 */
function billingFor(scope: LibraryScopeInput, input: LibraryTextInput): BillingContext {
  const s = libraryScope(scope);
  // 个人库永远只扣个人积分（即使调用方带了 projectId）
  if (input.billing)
    return s.kind === 'personal'
      ? { ...input.billing, scope: 'personal' }
      : { projectId: s.projectId, ...input.billing };
  return s.kind === 'personal'
    ? { payerUserId: s.ownerUserId, note: 'library', scope: 'personal' }
    : { projectId: s.projectId, note: 'library' };
}

export async function* streamLibraryText(
  ctx: AppContext,
  scope: LibraryScopeInput,
  input: LibraryTextInput,
) {
  const { client, body, provider, model } = await request(ctx, scope, input).catch(wrap);
  const billing = billingFor(scope, input);
  await assertCanSpend(ctx, provider, billing);
  const usage = { input: 0, output: 0, cost: null as number | null };
  try {
    const stream = await client.chat.completions.create(
      { ...body, stream: true, stream_options: { include_usage: true } },
      { signal: input.signal },
    );
    for await (const part of stream) {
      if (part.usage) {
        usage.input = part.usage.prompt_tokens;
        usage.output = part.usage.completion_tokens;
        usage.cost = (part.usage as { cost?: number }).cost ?? null;
      }
      const text = part.choices[0]?.delta.content;
      if (text) yield text;
    }
  } catch (err) {
    wrap(err);
  } finally {
    await chargeUsage(ctx, billing, {
      provider,
      model,
      inputTokens: usage.input,
      outputTokens: usage.output,
      costUsd: usage.cost,
    });
  }
}
