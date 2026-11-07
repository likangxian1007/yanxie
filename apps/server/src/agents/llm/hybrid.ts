import OpenAI from 'openai';
import {
  ApiError,
  HybridRoute,
  HybridTask,
  type HybridCall,
  type HybridPrivacy,
  type HybridRedactPreview,
  type HybridStatus,
  type HybridTarget,
} from '@srh/shared';
import type { AppConfig } from '../../config';
import { estimateCostMicros } from '../../modules/billing/pricing';

/**
 * 本地 + 云端混合 AI（ARCHITECTURE.md §7.7）。
 *
 * - 本地端：本机的 OpenAI 兼容推理服务（推荐 OpenVINO Model Server 跑在 Intel 核显 / NPU 上，
 *   也兼容 Ollama、LM Studio），由 LOCAL_LLM_BASE_URL / LOCAL_LLM_MODEL 配置。不配置时整个模块不生效。
 * - 分流：按任务类型（HybridTask）查规则 local / cloud / auto；auto = 本地可用且输入不超长就走本地，
 *   否则回退云端。请求方可以要求 local_only（内容绝不出本机）。
 * - 隐私护栏：发往云端的文本先脱敏（规则识别 + 本地模型识别人名机构等），占位符形如〔数值1〕，
 *   云端结果回来后在本地还原。
 * - 统计：每次调用记一条（本地 / 云端、延迟、tokens/s、是否回退、脱敏数），供「混合 AI」看板展示。
 *   只存在进程内存里，重启清零。
 *
 * 本地模型不计费（不经过 billing），云端调用照旧按 provider 计费。
 */

/** 默认分流：改写、翻译、摘要、压缩这类高频小任务本地优先；生成长内容与组会汇报走云端 */
export const DEFAULT_ROUTES: Record<HybridTask, HybridRoute> = {
  'doc-rewrite': 'auto',
  'doc-translate': 'auto',
  'doc-summary': 'auto',
  'doc-generate': 'cloud',
  compact: 'auto',
  report: 'cloud',
  // 脱敏时的实体识别只会在本地做（它看的是原文）
  redact: 'local',
  // 整篇 PDF 翻译：本地优先，本地失败整篇改由云端重做
  'pdf-translate': 'auto',
};

export function hybridEnabled(config: AppConfig): boolean {
  return Boolean(config.LOCAL_LLM_BASE_URL.trim() && config.LOCAL_LLM_MODEL.trim());
}

let routesCache: { raw: string; routes: Record<HybridTask, HybridRoute> } | null = null;

export function hybridRoutes(config: AppConfig): Record<HybridTask, HybridRoute> {
  if (routesCache && routesCache.raw === config.HYBRID_ROUTES) return routesCache.routes;
  const routes = { ...DEFAULT_ROUTES };
  if (config.HYBRID_ROUTES.trim()) {
    try {
      const raw = JSON.parse(config.HYBRID_ROUTES) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) {
        const t = HybridTask.safeParse(k);
        const r = HybridRoute.safeParse(v);
        if (t.success && r.success) routes[t.data] = r.data;
        else console.error('[hybrid] HYBRID_ROUTES 有一项不认识，已忽略', k, v);
      }
    } catch (err) {
      console.error('[hybrid] HYBRID_ROUTES 不是合法 JSON，已忽略', (err as Error).message);
    }
  }
  routesCache = { raw: config.HYBRID_ROUTES, routes };
  return routes;
}

// ---------------------------------------------------------------- 本地服务

let local: { key: string; client: OpenAI } | null = null;

export function localClient(config: AppConfig): OpenAI {
  const key = `${config.LOCAL_LLM_BASE_URL}|${config.LOCAL_LLM_API_KEY}`;
  if (local?.key !== key) {
    local = {
      key,
      client: new OpenAI({
        apiKey: config.LOCAL_LLM_API_KEY || 'local',
        baseURL: config.LOCAL_LLM_BASE_URL,
        maxRetries: 0,
        timeout: 120_000,
      }),
    };
  }
  return local.client;
}

interface Health {
  up: boolean;
  checkedAt: number;
  latencyMs: number | null;
  error: string | null;
}
let health: Health | null = null;
let probing: Promise<Health> | null = null;
const HEALTH_TTL_UP = 30_000;
const HEALTH_TTL_DOWN = 10_000;

/** 探活：GET {base}/models，3 秒超时；结果缓存（可用 30 秒、不可用 10 秒） */
export async function localHealth(config: AppConfig, force = false): Promise<Health> {
  if (!hybridEnabled(config))
    return { up: false, checkedAt: Date.now(), latencyMs: null, error: null };
  const ttl = health?.up ? HEALTH_TTL_UP : HEALTH_TTL_DOWN;
  if (!force && health && Date.now() - health.checkedAt < ttl) return health;
  probing ??= (async () => {
    const t0 = Date.now();
    try {
      const res = await fetch(`${config.LOCAL_LLM_BASE_URL.replace(/\/+$/u, '')}/models`, {
        signal: AbortSignal.timeout(3000),
        headers: config.LOCAL_LLM_API_KEY
          ? { authorization: `Bearer ${config.LOCAL_LLM_API_KEY}` }
          : {},
      });
      health = {
        up: res.ok,
        checkedAt: Date.now(),
        latencyMs: Date.now() - t0,
        error: res.ok ? null : `HTTP ${res.status}`,
      };
    } catch (err) {
      health = { up: false, checkedAt: Date.now(), latencyMs: null, error: (err as Error).message };
    }
    return health;
  })().finally(() => {
    probing = null;
  });
  return probing;
}

/** 本地调用失败后立刻把状态标成不可用，后面的请求直接走云端，等下一次探活再恢复 */
export function markLocalDown(error: string) {
  health = { up: false, checkedAt: Date.now(), latencyMs: null, error };
}

/** 测试用：重置探活与统计 */
export function resetHybridForTest() {
  health = null;
  probing = null;
  calls.length = 0;
  since = new Date();
  routesCache = null;
}

export interface HybridDecision {
  target: HybridTarget;
  /** 规则希望走本地，但本地不可用 / 超长，改走云端 */
  fallback: boolean;
  route: HybridRoute;
}

/**
 * 决定一次调用走哪边。local_only 时本地不可用直接报错（绝不把内容发到云端）。
 */
export async function decide(
  config: AppConfig,
  task: HybridTask,
  inputChars: number,
  privacy: HybridPrivacy = 'auto',
): Promise<HybridDecision> {
  const route: HybridRoute = privacy === 'local_only' ? 'local' : hybridRoutes(config)[task];
  if (!hybridEnabled(config)) {
    if (route === 'local' && privacy === 'local_only')
      throw new ApiError('llm_unavailable', '这台服务器没有配置本地模型，不能使用「仅本地」');
    return { target: 'cloud', fallback: false, route };
  }
  if (route === 'cloud') return { target: 'cloud', fallback: false, route };
  const h = await localHealth(config);
  const fits = inputChars <= config.LOCAL_LLM_MAX_INPUT_CHARS;
  if (h.up && (fits || route === 'local')) return { target: 'local', fallback: false, route };
  if (route === 'local')
    throw new ApiError('llm_unavailable', '本地模型现在不可用，内容设为仅本地处理，没有发往云端');
  return { target: 'cloud', fallback: true, route };
}

/** Qwen3 等混合思考模型：本地小任务关掉思考，省时间 */
export function localSystemSuffix(): string {
  return '\n/no_think';
}

/** 去掉本地思考模型可能输出的 <think>…</think> 段 */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/gu, '');
}

/**
 * 非流式的「本地优先」调用：按规则该走本地且本地可用就在本地算完返回文本；
 * 返回 null 表示调用方照旧走云端（没启用、规则是 cloud、本地不可用或失败）。
 * 失败时记一条回退，云端那次由调用方自己完成。
 */
export async function tryLocal(
  config: AppConfig,
  task: HybridTask,
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
): Promise<string | null> {
  if (!hybridEnabled(config)) return null;
  let d: HybridDecision;
  try {
    d = await decide(config, task, system.length + user.length);
  } catch {
    return null;
  }
  if (d.target !== 'local') return null;
  const t0 = Date.now();
  try {
    const res = await localClient(config).chat.completions.create(
      {
        model: config.LOCAL_LLM_MODEL,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 2048,
        messages: [
          { role: 'system', content: system + localSystemSuffix() },
          { role: 'user', content: user },
        ],
      },
      opts.signal ? { signal: opts.signal } : {},
    );
    const text = stripThink(res.choices[0]?.message?.content ?? '').trim();
    if (!text) throw new Error('本地模型返回了空内容');
    recordCall({
      task,
      target: 'local',
      model: config.LOCAL_LLM_MODEL,
      fallback: false,
      redacted: 0,
      ms: Date.now() - t0,
      firstTokenMs: null,
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      ok: true,
    });
    return text;
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    console.error('[hybrid] 本地调用失败，回退云端', (err as Error).message);
    markLocalDown((err as Error).message);
    return null;
  }
}

/** 云端调用方记一条统计（tryLocal 返回 null 后走云端的那次） */
export function recordCloud(
  task: HybridTask,
  model: string,
  t0: number,
  usage: { input: number; output: number },
  fallback: boolean,
) {
  recordCall({
    task,
    target: 'cloud',
    model,
    fallback,
    redacted: 0,
    ms: Date.now() - t0,
    firstTokenMs: null,
    inputTokens: usage.input,
    outputTokens: usage.output,
    ok: true,
  });
}

// ---------------------------------------------------------------- 统计

const MAX_CALLS = 300;
const calls: HybridCall[] = [];
let since = new Date();

export function recordCall(call: Omit<HybridCall, 'at' | 'tps'> & { tps?: number | null }) {
  const genMs = call.firstTokenMs !== null ? call.ms - call.firstTokenMs : call.ms;
  const tps =
    call.tps ??
    (call.outputTokens > 0 && genMs > 0
      ? Math.round((call.outputTokens * 10_000) / genMs) / 10
      : null);
  calls.push({ ...call, tps, at: new Date().toISOString() });
  if (calls.length > MAX_CALLS) calls.splice(0, calls.length - MAX_CALLS);
}

function avg(xs: number[]): number | null {
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;
}

export async function hybridStatus(config: AppConfig): Promise<HybridStatus> {
  const h = await localHealth(config);
  const routes = hybridRoutes(config);
  const ok = calls.filter((c) => c.ok);
  const localCalls = ok.filter((c) => c.target === 'local');
  const cloudCalls = ok.filter((c) => c.target === 'cloud');
  const localIn = localCalls.reduce((a, c) => a + c.inputTokens, 0);
  const localOut = localCalls.reduce((a, c) => a + c.outputTokens, 0);
  return {
    enabled: hybridEnabled(config),
    local: {
      baseUrl: config.LOCAL_LLM_BASE_URL,
      model: config.LOCAL_LLM_MODEL,
      device: config.LOCAL_LLM_DEVICE,
      up: h.up,
      checkedAt: hybridEnabled(config) ? new Date(h.checkedAt).toISOString() : null,
      latencyMs: h.latencyMs,
      error: h.error,
    },
    cloud: { model: config.LLM_MODEL, configured: config.llmConfigured },
    redact: config.HYBRID_REDACT,
    routes: HybridTask.options.map((task) => ({
      task,
      route: routes[task],
      local: localCalls.filter((c) => c.task === task).length,
      cloud: cloudCalls.filter((c) => c.task === task).length,
    })),
    totals: {
      calls: ok.length,
      localCalls: localCalls.length,
      cloudCalls: cloudCalls.length,
      fallbacks: ok.filter((c) => c.fallback).length,
      redacted: ok.reduce((a, c) => a + c.redacted, 0),
      localTokens: localIn + localOut,
      savedUsd: estimateCostMicros(config.LLM_MODEL, localIn, localOut) / 1_000_000,
      avgLocalTps: avg(localCalls.map((c) => c.tps).filter((x): x is number => x !== null)),
      avgLocalMs: avg(localCalls.map((c) => c.ms)),
      avgCloudMs: avg(cloudCalls.map((c) => c.ms)),
    },
    since: since.toISOString(),
    recent: calls.slice(-50).reverse(),
    pdfTranslate: Boolean(config.PDF_TRANSLATE_URL?.trim()),
  };
}

// ---------------------------------------------------------------- 隐私护栏

export interface Redaction {
  text: string;
  items: { placeholder: string; original: string; kind: string }[];
  usedLocalModel: boolean;
}

/** 规则可识别的敏感片段。顺序有意义：先长后短，避免数值规则吃掉手机号、身份证号 */
const RULES: { kind: string; label: string; re: RegExp }[] = [
  { kind: 'email', label: '邮箱', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu },
  { kind: 'id', label: '证件号', re: /(?<!\d)\d{17}[\dXx](?!\d)/gu },
  { kind: 'phone', label: '电话', re: /(?<![\d.])(?:\+?86[- ]?)?1[3-9]\d{9}(?![\d.])/gu },
  // 样本 / 批次 / 患者编号：大写字母开头带数字，如 S-2031、BATCH07、P0012
  { kind: 'code', label: '编号', re: /(?<![\w-])[A-Z]{1,6}-?\d{2,}(?:-\d+)*(?![\w-])/gu },
  // 实验数值：小数、百分数、带单位或显著性的数（整数年份、序号不动）
  {
    kind: 'number',
    label: '数值',
    re: /(?<![\w.〔])(?:[<>≤≥=±]\s*)?\d+\.\d+(?:\s*(?:%|‰|mg|g|kg|ml|mL|μL|uL|L|mM|μM|nM|mol|°C|K|Hz|kHz|MHz|GHz|nm|μm|mm|cm|m|s|ms|h|min|dB|eV|V|mV|A|mA|W|kW|Pa|kPa|MPa)(?![A-Za-z]))?|(?<![\w.〔])\d+(?:\.\d+)?\s*%/gu,
  },
];

const LABELS: Record<string, string> = {
  email: '邮箱',
  id: '证件号',
  phone: '电话',
  code: '编号',
  number: '数值',
  person: '人名',
  org: '机构',
  term: '保密术语',
};

function placeholderFor(kind: string, n: number) {
  return `〔${LABELS[kind] ?? '敏感'}${n}〕`;
}

/**
 * 让本地模型找出规则抓不到的敏感实体（人名、机构、未公开的项目代号）。
 * 失败或本地不可用就只用规则，绝不因此阻塞调用。
 */
async function localEntities(
  config: AppConfig,
  text: string,
  signal?: AbortSignal,
): Promise<{ kind: string; text: string }[]> {
  if (!hybridEnabled(config) || text.length > config.LOCAL_LLM_MAX_INPUT_CHARS) return [];
  const h = await localHealth(config);
  if (!h.up) return [];
  const t0 = Date.now();
  try {
    const res = await localClient(config).chat.completions.create(
      {
        model: config.LOCAL_LLM_MODEL,
        temperature: 0,
        max_tokens: 400,
        messages: [
          {
            role: 'system',
            content:
              '你是隐私审查器。从用户给的科研文本里找出需要保密的实体：具体人名（person）、具体单位或机构名（org）、未公开的项目或样品代号（term）。' +
              '只输出 JSON 数组，例如 [{"kind":"person","text":"张三"}]；文本里逐字出现的才算；通用学科词、公开的方法名、知名模型名都不算；没有就输出 []。' +
              localSystemSuffix(),
          },
          { role: 'user', content: text },
        ],
      },
      { signal: signal ?? AbortSignal.timeout(30_000) },
    );
    const raw = stripThink(res.choices[0]?.message?.content ?? '');
    recordCall({
      task: 'redact',
      target: 'local',
      model: config.LOCAL_LLM_MODEL,
      fallback: false,
      redacted: 0,
      ms: Date.now() - t0,
      firstTokenMs: null,
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      ok: true,
    });
    const m = /\[[\s\S]*\]/u.exec(raw);
    if (!m) return [];
    const list = JSON.parse(m[0]) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (x): x is { kind: string; text: string } =>
          typeof x === 'object' &&
          x !== null &&
          typeof (x as { text?: unknown }).text === 'string' &&
          typeof (x as { kind?: unknown }).kind === 'string',
      )
      .map((x) => ({
        kind: ['person', 'org', 'term'].includes(x.kind) ? x.kind : 'term',
        text: x.text.trim(),
      }))
      .filter((x) => x.text.length >= 2 && x.text.length <= 40 && text.includes(x.text));
  } catch (err) {
    console.error('[hybrid] 本地实体识别失败，只用规则脱敏', (err as Error).message);
    return [];
  }
}

/**
 * 脱敏：同一原文在多段文本里用同一个占位符（system 与 user 一起处理）。
 */
export async function redact(
  config: AppConfig,
  texts: string[],
  opts: { useLocalModel?: boolean; signal?: AbortSignal } = {},
): Promise<{ texts: string[]; items: Redaction['items']; usedLocalModel: boolean }> {
  const items: Redaction['items'] = [];
  const byOriginal = new Map<string, string>();
  const counters: Record<string, number> = {};
  const take = (kind: string, original: string) => {
    let ph = byOriginal.get(original);
    if (!ph) {
      counters[kind] = (counters[kind] ?? 0) + 1;
      ph = placeholderFor(kind, counters[kind]!);
      byOriginal.set(original, ph);
      items.push({ placeholder: ph, original, kind });
    }
    return ph;
  };
  const useLocal = opts.useLocalModel ?? true;
  const ruleHit = (text: string) =>
    RULES.some((r) => {
      r.re.lastIndex = 0;
      const m = text.match(r.re);
      return !!m && m.join('').length >= text.length * 0.6;
    });
  // 规则能认出的（邮箱、数值、编号）交给规则，标签更准；模型只补人名、机构、术语
  const entities = (
    useLocal ? await localEntities(config, texts.join('\n\n'), opts.signal) : []
  ).filter((e) => e.kind === 'person' || e.kind === 'org' || !ruleHit(e.text));
  // 实体按长度降序替换，避免短名字先替掉长名字的一部分
  entities.sort((a, b) => b.text.length - a.text.length);
  const out = texts.map((t) => {
    // 先跑规则（确定性），命中的区间受保护；模型实体只能落在剩下的空隙里。
    // 否则模型把邮箱域名 lab.cn 认成机构先替掉，邮箱规则就认不出整个地址，用户名会泄露。
    const spans: { start: number; end: number; ph: string }[] = [];
    const free = (start: number, end: number) =>
      spans.every((x) => end <= x.start || start >= x.end);
    for (const r of RULES) {
      r.re.lastIndex = 0;
      for (const m of t.matchAll(r.re)) {
        const start = m.index;
        const end = start + m[0].length;
        if (m[0] && free(start, end)) spans.push({ start, end, ph: take(r.kind, m[0]) });
      }
    }
    for (const e of entities) {
      for (let i = t.indexOf(e.text); i >= 0; i = t.indexOf(e.text, i + 1)) {
        const end = i + e.text.length;
        if (free(i, end)) spans.push({ start: i, end, ph: take(e.kind, e.text) });
      }
    }
    spans.sort((a, b) => a.start - b.start);
    let s = '';
    let pos = 0;
    for (const x of spans) {
      s += t.slice(pos, x.start) + x.ph;
      pos = x.end;
    }
    return s + t.slice(pos);
  });
  return {
    texts: out,
    items,
    usedLocalModel: entities.length > 0 || (useLocal && hybridEnabled(config)),
  };
}

/** 给云端模型的说明：占位符原样保留 */
export const REDACT_NOTE =
  '\n\n注意：文本里形如〔数值1〕〔人名2〕〔编号3〕的是隐私占位符，代表被隐藏的原始内容。请把它们当作普通词语使用，输出时逐字原样保留，不要改写、翻译、合并或编造其中的内容。';

export function restore(text: string, items: Redaction['items']): string {
  let s = text;
  for (const it of items) s = s.split(it.placeholder).join(it.original);
  return s;
}

/**
 * 流式还原：占位符可能被切在两个分块之间，末尾未闭合的〔…先留着，等下一块。
 */
export function createRestorer(items: Redaction['items']) {
  let pending = '';
  return {
    push(chunk: string): string {
      if (!items.length) return chunk;
      pending += chunk;
      const open = pending.lastIndexOf('〔');
      const close = pending.lastIndexOf('〕');
      let ready = pending;
      if (open > close && pending.length - open <= 12) {
        ready = pending.slice(0, open);
        pending = pending.slice(open);
      } else pending = '';
      return restore(ready, items);
    },
    flush(): string {
      const rest = restore(pending, items);
      pending = '';
      return rest;
    },
  };
}

export async function redactPreview(config: AppConfig, text: string): Promise<HybridRedactPreview> {
  const r = await redact(config, [text]);
  return { redacted: r.texts[0]!, items: r.items, usedLocalModel: r.usedLocalModel };
}
