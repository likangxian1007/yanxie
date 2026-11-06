import { and, eq } from 'drizzle-orm';
import OpenAI from 'openai';
import { z } from 'zod';
import {
  ApiError,
  ReasoningEffort,
  ThinkingFormat,
  type LlmProvider,
  type ModelCatalog,
  type ModelInfo,
} from '@srh/shared';
import type { AppConfig } from '../../config';
import type { AppContext } from '../../context';
import { llmProviders, type ProviderModelRow } from '../../db/schema';

/**
 * 模型 provider 注册表（ARCHITECTURE.md §7.6）。
 *
 * 来源两类：
 * - env：主 provider（LLM_BASE_URL / LLM_API_KEY，id 固定为 `deepseek` 或 `default`）+ LLM_PROVIDERS JSON。
 *   自部署时在 .env 里加，全站所有项目可用，界面只读。
 * - project：项目管理者在「设置 → 模型」里加的 OpenAI 兼容 provider（存 llm_providers 表），只在该项目可用。
 *
 * 模型 id 统一写成 `<providerId>/<model>`；会话里存的旧值（如 `deepseek-chat`）按主 provider 的模型名兼容解析，
 * 找不到就回落到默认模型。
 */

/** DeepSeek 官方接口当前的模型（2026-10 实测 GET /models） */
const DEEPSEEK_MODELS: ProviderModelRow[] = [
  {
    model: 'deepseek-flash',
    name: 'DeepSeek V4.1 Flash',
    description: '响应快、成本低，适合日常对话与工具调用',
    efforts: ['off', 'low', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    model: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    description: '更强的推理与长程规划，适合复杂科研任务',
    efforts: ['off', 'low', 'high', 'max'],
    defaultEffort: 'high',
  },
];

/**
 * OpenRouter 内置模型（OPENROUTER_API_KEY 设置后启用，provider id 固定 `openrouter`）。
 * 推理档位 off/low/medium/high（6 个模型已实测接受 reasoning:{effort} + usage.include），默认 low 控制成本。
 */
const OPENROUTER_EFFORTS: ReasoningEffort[] = ['off', 'low', 'medium', 'high'];

export const OPENROUTER_MODELS: ProviderModelRow[] = [
  {
    model: 'qwen/qwen3.7-plus',
    name: '通义千问 3.7 Plus',
    description: '阿里通义千问，中文写作与通用任务',
    efforts: OPENROUTER_EFFORTS,
    defaultEffort: 'low',
    group: 'cn',
  },
  {
    model: 'z-ai/glm-5.3',
    name: '智谱 GLM-5.3',
    description: '智谱 GLM，性价比高',
    efforts: OPENROUTER_EFFORTS,
    defaultEffort: 'low',
    group: 'cn',
  },
  {
    model: 'moonshotai/kimi-k2.6',
    name: 'Kimi K2.6',
    description: '月之暗面 Kimi，长文本与工具调用',
    efforts: OPENROUTER_EFFORTS,
    defaultEffort: 'low',
    group: 'cn',
  },
  {
    model: 'anthropic/claude-sonnet-5.5',
    name: 'Claude Sonnet 5.5',
    description: 'Anthropic Claude，写作与代码',
    efforts: OPENROUTER_EFFORTS,
    defaultEffort: 'low',
    group: 'intl',
  },
  {
    model: 'openai/gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    description: 'OpenAI GPT，综合能力强',
    efforts: OPENROUTER_EFFORTS,
    defaultEffort: 'low',
    group: 'intl',
  },
  {
    model: 'google/gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    description: 'Google Gemini，速度快',
    efforts: OPENROUTER_EFFORTS,
    defaultEffort: 'low',
    group: 'intl',
  },
];

const OPENAI_EFFORTS: ReasoningEffort[] = ['off', 'low', 'medium', 'high'];

const EnvProviderModel = z.union([
  z.string(),
  z.object({
    model: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    efforts: z.array(ReasoningEffort).min(1).optional(),
    defaultEffort: ReasoningEffort.optional(),
  }),
]);
const EnvProvider = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/u),
  name: z.string().optional(),
  baseUrl: z.string().min(1),
  /** 直接写 key，或用 apiKeyEnv 指向另一个环境变量 */
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  thinkingFormat: ThinkingFormat.optional(),
  models: z.array(EnvProviderModel).min(1),
});

/** 运行时用的 provider（带 key，不出服务端） */
export interface ResolvedProvider {
  id: string;
  projectId: string | null;
  source: 'env' | 'project';
  name: string;
  baseUrl: string;
  apiKey: string;
  thinkingFormat: ThinkingFormat;
  models: ProviderModelRow[];
  enabled: boolean;
  createdAt: Date | null;
}

export interface ResolvedModel {
  /** `<providerId>/<model>` */
  id: string;
  provider: ResolvedProvider;
  info: ProviderModelRow;
  effort: ReasoningEffort;
}

export function isDeepSeekUrl(url: string) {
  return /api\.deepseek\.com/iu.test(url);
}

function normalizeModel(
  m: z.infer<typeof EnvProviderModel> | ProviderModelRow,
  format: ThinkingFormat,
): ProviderModelRow {
  const base = typeof m === 'string' ? { model: m } : m;
  const known = DEEPSEEK_MODELS.find((d) => d.model === base.model);
  const efforts = base.efforts?.length
    ? base.efforts
    : (known?.efforts ??
      (format === 'none'
        ? (['off'] as ReasoningEffort[])
        : format === 'deepseek'
          ? DEEPSEEK_MODELS[0]!.efforts
          : OPENAI_EFFORTS));
  const defaultEffort =
    base.defaultEffort && efforts.includes(base.defaultEffort)
      ? base.defaultEffort
      : efforts.includes('high')
        ? 'high'
        : efforts[efforts.length - 1]!;
  return {
    model: base.model,
    name: base.name || known?.name || base.model,
    description: base.description ?? known?.description ?? null,
    efforts,
    defaultEffort,
  };
}

let envCache: { key: string; list: ResolvedProvider[] } | null = null;

/** .env 里的 provider（主 provider + LLM_PROVIDERS）；格式错误的条目跳过并打日志 */
export function envProviders(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProvider[] {
  const key = [
    config.LLM_BASE_URL,
    config.LLM_API_KEY,
    config.LLM_MODELS,
    config.LLM_MODEL,
    config.LLM_PROVIDERS,
    config.OPENROUTER_API_KEY,
    config.OPENROUTER_BASE_URL,
  ].join('|');
  if (envCache?.key === key) return envCache.list;
  const list: ResolvedProvider[] = [];
  if (config.llmConfigured) {
    const deepseek = isDeepSeekUrl(config.LLM_BASE_URL);
    const format: ThinkingFormat = deepseek ? 'deepseek' : 'openai';
    const names = config.LLM_MODELS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const models = names.length
      ? names.map((n) => normalizeModel(n, format))
      : deepseek
        ? DEEPSEEK_MODELS
        : [...new Set([config.LLM_MODEL, config.LLM_MODEL_REASONING])].map((n) =>
            normalizeModel(n, format),
          );
    list.push({
      id: deepseek ? 'deepseek' : 'default',
      projectId: null,
      source: 'env',
      name: deepseek ? 'DeepSeek' : '默认',
      baseUrl: config.LLM_BASE_URL,
      apiKey: config.LLM_API_KEY,
      thinkingFormat: format,
      models: deepseek ? models.map((m) => ({ ...m, group: 'cn' as const })) : models,
      enabled: true,
      createdAt: null,
    });
  }
  if (config.OPENROUTER_API_KEY && !list.some((x) => x.id === 'openrouter')) {
    list.push({
      id: 'openrouter',
      projectId: null,
      source: 'env',
      name: 'OpenRouter',
      baseUrl: config.OPENROUTER_BASE_URL,
      apiKey: config.OPENROUTER_API_KEY,
      thinkingFormat: 'openrouter',
      models: OPENROUTER_MODELS,
      enabled: true,
      createdAt: null,
    });
  }
  if (config.LLM_PROVIDERS.trim()) {
    let raw: unknown;
    try {
      raw = JSON.parse(config.LLM_PROVIDERS);
    } catch (err) {
      console.error('[llm] LLM_PROVIDERS 不是合法 JSON，已忽略', (err as Error).message);
      raw = [];
    }
    for (const item of Array.isArray(raw) ? raw : []) {
      const parsed = EnvProvider.safeParse(item);
      if (!parsed.success) {
        console.error(
          '[llm] LLM_PROVIDERS 有一项格式不对，已跳过',
          parsed.error.issues[0]?.message,
        );
        continue;
      }
      const p = parsed.data;
      if (list.some((x) => x.id === p.id)) continue;
      const format = p.thinkingFormat ?? (isDeepSeekUrl(p.baseUrl) ? 'deepseek' : 'openai');
      list.push({
        id: p.id,
        projectId: null,
        source: 'env',
        name: p.name ?? p.id,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey ?? (p.apiKeyEnv ? (env[p.apiKeyEnv] ?? '') : ''),
        thinkingFormat: format,
        models: p.models.map((m) => normalizeModel(m, format)),
        enabled: true,
        createdAt: null,
      });
    }
  }
  envCache = { key, list };
  return list;
}

export function rowToProvider(row: typeof llmProviders.$inferSelect): ResolvedProvider {
  return {
    id: row.id,
    projectId: row.projectId,
    source: 'project',
    name: row.name,
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    thinkingFormat: row.thinkingFormat,
    models: row.models.map((m) => normalizeModel(m, row.thinkingFormat)),
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

/** 本项目可用的全部 provider（env 在前） */
export async function projectProviders(
  ctx: AppContext,
  projectId: string,
): Promise<ResolvedProvider[]> {
  const rows = await ctx.db.db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.projectId, projectId));
  return [...envProviders(ctx.config), ...rows.map(rowToProvider)];
}

export function toModelInfo(p: ResolvedProvider, m: ProviderModelRow): ModelInfo {
  return {
    id: `${p.id}/${m.model}`,
    providerId: p.id,
    model: m.model,
    name: m.name,
    description: m.description,
    efforts: m.efforts,
    defaultEffort: m.defaultEffort,
    ...(m.group ? { group: m.group } : {}),
  };
}

export function toProviderDto(p: ResolvedProvider): LlmProvider {
  return {
    id: p.id,
    projectId: p.projectId,
    source: p.source,
    name: p.name,
    baseUrl: p.baseUrl,
    thinkingFormat: p.thinkingFormat,
    hasApiKey: p.apiKey.length > 0,
    models: p.models.map((m) => toModelInfo(p, m)),
    enabled: p.enabled,
    createdAt: p.createdAt?.toISOString() ?? null,
  };
}

function pickDefault(config: AppConfig, providers: ResolvedProvider[]): string {
  const usable = providers.filter((p) => p.enabled && p.models.length);
  const all = usable.flatMap((p) => p.models.map((m) => `${p.id}/${m.model}`));
  if (config.LLM_DEFAULT_MODEL && all.includes(config.LLM_DEFAULT_MODEL))
    return config.LLM_DEFAULT_MODEL;
  return all[0] ?? '';
}

/** 新会话的默认模型 id（只看 env provider，创建会话时不查库） */
export function defaultModelId(config: AppConfig): string {
  return pickDefault(config, envProviders(config)) || config.LLM_MODEL;
}

export async function modelCatalog(ctx: AppContext, projectId: string): Promise<ModelCatalog> {
  const providers = await projectProviders(ctx, projectId);
  return {
    defaultModel: pickDefault(ctx.config, providers),
    defaultEffort: ctx.config.LLM_DEFAULT_EFFORT,
    providers: providers.map(toProviderDto),
  };
}

/**
 * 解析会话的模型与强度：
 * - modelId 形如 `<provider>/<model>`；裸模型名在全部 provider 里按 model 找；
 *   旧值 deepseek-chat / deepseek-reasoner 视为默认模型（DeepSeek 已把它们并到 deepseek-flash）
 * - effort 不在模型支持的档位里时：medium→high，max→high，其他取模型默认
 */
export async function resolveModel(
  ctx: AppContext,
  projectId: string,
  modelId: string | null | undefined,
  effort: ReasoningEffort | string | null | undefined,
): Promise<ResolvedModel> {
  const providers = (await projectProviders(ctx, projectId)).filter((p) => p.enabled);
  const find = (id: string) => {
    const slash = id.indexOf('/');
    if (slash > 0) {
      const p = providers.find((x) => x.id === id.slice(0, slash));
      const m = p?.models.find((x) => x.model === id.slice(slash + 1));
      if (p && m) return { p, m };
    }
    for (const p of providers) {
      const m = p.models.find((x) => x.model === id);
      if (m) return { p, m };
    }
    return null;
  };
  const hit = (modelId ? find(modelId) : null) ?? find(pickDefault(ctx.config, providers));
  if (!hit)
    throw new ApiError(
      'llm_unavailable',
      '还没有可用的模型：请在 .env 配置 LLM_API_KEY，或在设置里添加模型',
    );
  const { p, m } = hit;
  return {
    id: `${p.id}/${m.model}`,
    provider: p,
    info: m,
    effort: fitEffort(m, effort ?? ctx.config.LLM_DEFAULT_EFFORT),
  };
}

export function fitEffort(m: ProviderModelRow, wanted: string): ReasoningEffort {
  const e = ReasoningEffort.safeParse(wanted);
  if (e.success && m.efforts.includes(e.data)) return e.data;
  if (e.success && e.data !== 'off') {
    const fallback = (['high', 'medium', 'low'] as const).find((x) => m.efforts.includes(x));
    if (fallback) return fallback;
  }
  return m.defaultEffort;
}

const clients = new Map<string, OpenAI>();
/** OpenRouter 要求的来源标识（展示在它的排行榜 / 账单里） */
const OPENROUTER_HEADERS = {
  'HTTP-Referer': 'https://co.thinkloft.io', // i18n-ignore
  'X-Title': '研协', // i18n-ignore
};

export function isOpenRouterUrl(url: string) {
  return /openrouter\.ai/iu.test(url);
}

export function clientFor(p: { baseUrl: string; apiKey: string }): OpenAI {
  const key = `${p.baseUrl}|${p.apiKey}`;
  let c = clients.get(key);
  if (!c) {
    c = new OpenAI({
      apiKey: p.apiKey || 'none',
      baseURL: p.baseUrl,
      maxRetries: 2,
      ...(isOpenRouterUrl(p.baseUrl) ? { defaultHeaders: OPENROUTER_HEADERS } : {}),
    });
    if (clients.size > 50) clients.clear();
    clients.set(key, c);
  }
  return c;
}

/**
 * 按 provider 的格式生成推理参数（实测 DeepSeek：thinking.type + reasoning_effort low/high/max）。
 */
export function thinkingParams(
  format: ThinkingFormat,
  effort: ReasoningEffort,
): Record<string, unknown> {
  if (format === 'none') return {};
  if (format === 'openrouter') {
    // usage.include：让 OpenRouter 在 usage 里带上真实成本 usage.cost（美元），计费以它为准
    const usage = { usage: { include: true } };
    if (effort === 'off') return usage;
    return { ...usage, reasoning: { effort: effort === 'max' ? 'high' : effort } };
  }
  if (format === 'deepseek') {
    if (effort === 'off') return { thinking: { type: 'disabled' } };
    return {
      thinking: { type: 'enabled' },
      reasoning_effort: effort === 'medium' ? 'high' : effort,
    };
  }
  if (effort === 'off') return {};
  return { reasoning_effort: effort === 'max' ? 'high' : effort };
}

/** 项目 provider 行（管理接口用） */
export async function getProviderRow(ctx: AppContext, projectId: string, id: string) {
  const [row] = await ctx.db.db
    .select()
    .from(llmProviders)
    .where(and(eq(llmProviders.id, id), eq(llmProviders.projectId, projectId)));
  return row ?? null;
}
