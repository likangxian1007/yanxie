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

// ---- 中文人名规则兜底：不让人名脱敏只靠 4B 小模型 ----
// 很少当普通词词头的常见姓：后面跟“在、和、提出、测得…”这类上下文就认作人名
const CLEAN_SURNAMES =
  '张王李刘陈杨赵吴孙徐朱胡郭罗梁宋郑谢韩唐冯董萧曹袁邓彭吕苏卢蒋蔡贾魏薛阎闫潘杜戴钟汪姜姚谭廖邹熊郝崔邱侯邵孟汤尹黎乔贺赖龚覃洪沈葛鲁韦俞陶殷庞樊兰翟倪柴聂祝庄詹欧邢骆岳裴鲍霍蒲';
// 也常是普通词词头的姓（高斯、方法、程序、温度、范围…）：只在称谓或“作者：”这类强上下文里认
const AMBIGUOUS_SURNAMES =
  '高方程温常范文任安金石白黄马周于许何施夏叶余田江林万段易武龙孔史向时原应全成包毛牛苗宁甘车云秦钱傅严曾丁';
const COMPOUND_SURNAMES =
  '欧阳|司马|诸葛|上官|东方|皇甫|尉迟|公孙|慕容|长孙|宇文|司徒|夏侯|令狐|端木|轩辕|南宫|西门|独孤|呼延|万俟|闻人|澹台|申屠';
/** 名字用字：汉字，但不含虚词，避免“张在”“李的”这种切法 */
const GIVEN = '(?:(?![的了是在和与及跟同让说对把将被也都还就又再才等们这那个])\\p{Script=Han})';
const TITLES = '老师|教授|同学|博士|研究员|主任|院士|师兄|师姐|师弟|师妹|医生|先生|女士|博导|导师';
/** 人名后面常跟的词（动词、介词、虚词、称谓、标点） */
const NAME_NEXT =
  `(?:${TITLES}|等人|负责|提出|提供|测得|测量|发现|完成|指出|认为|表示|建议|重跑|重做|重新|编写|整理|设计|分析|参与|报告|告诉|发来|发送|采集|处理|撰写|修改|审核|记录|` +
  '[在和与跟同及让叫请说讲问的对把将被给向已也都还又再就才是测做跑写等]|[，,、。；;：:！!？?）)\\s〔]|$)';
/** 人名前面允许的字：句首、非汉字、连词介词 */
const NAME_PREV = '(?<=^|[^\\p{Script=Han}]|[和与跟同及让叫请由被给向对把将问找据谢是])';
/** 强上下文：后面紧跟的就是人名 */
const NAME_PREFIX =
  '(?<=(?:联系人|通讯作者|第一作者|作者|同学|老师|导师|学生|负责人|研究员|教授|博士|组长|成员|实验员|记录人|操作人|审核人|申请人|主持人|执笔人|姓名)[:：\\s]?)';
const ANY_SURNAME = `(?:${COMPOUND_SURNAMES}|[${CLEAN_SURNAMES}${AMBIGUOUS_SURNAMES}])`;
const NAME_RULES: RegExp[] = [
  // 张伟在… / 和李娜在… / 让张伟重跑…（名字取最短，免得把“说”“测”吞进名字）
  new RegExp(
    `${NAME_PREV}(?:${COMPOUND_SURNAMES}|[${CLEAN_SURNAMES}])${GIVEN}{1,2}?(?=${NAME_NEXT})`,
    'gu',
  ),
  // 王老师、李教授、欧阳同学：姓 + 称谓，整个当人名
  new RegExp(`${NAME_PREV}${ANY_SURNAME}(?:${TITLES})`, 'gu'),
  // 作者：王小明 / 联系人张伟
  new RegExp(`${NAME_PREFIX}${ANY_SURNAME}${GIVEN}{1,2}(?=${NAME_NEXT}|[^\\p{Script=Han}])`, 'gu'),
];
/** 姓开头的普通词：规则命中这些（或以它们开头）不算人名 */
const NAME_STOPLIST = new Set(
  (
    '张量 张力 张开 张贴 张拉 张角 王国 王朝 王者 李子 刘海 陈述 陈列 陈旧 杨树 杨氏 杨柳 孙子 徐徐 朱红 胡乱 胡同 ' +
    '罗列 罗盘 宋体 宋代 郑重 谢谢 谢绝 唐朝 唐代 董事 苏醒 苏联 杜绝 钟表 钟头 汪洋 汤匙 黎明 乔木 贺信 鲁棒 庞大 ' +
    '洪水 熊猫 殷切 祝贺 庄稼 庄重 陶瓷 柴油 欧洲 欧氏 欧式 欧拉 欧姆 霍尔 霍夫 姜黄 戴着 曹操 潘多 葛根 兰花 ' +
    '高斯 方法 方向 方面 方案 方程 程序 程度 温度 常数 范围 文献 任务 安全 金属 石头 白色 黄色 马上 周期 于是 ' +
    '许多 何种 施加 夏天 叶片 余下 田间 江河 林业 万一 段落 易于 武器 龙头 孔径 史料 向量 时间 原理 应用 全部 ' +
    '成本 包括 毛细 牛顿 苗木 宁可 甘油 车辆 云端 秦朝 钱财 严格 严重 曾经 丁烷 丁酸 高度 高温 高压 高效'
  ).split(' '),
);

function isStopName(name: string): boolean {
  return NAME_STOPLIST.has(name) || NAME_STOPLIST.has(name.slice(0, 2));
}

/** 规则找出的中文人名（去重）。宁可多遮一点，也不能漏掉人名 */
export function ruleNames(text: string): string[] {
  const found = new Set<string>();
  for (const re of NAME_RULES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const name = m[0];
      if (name.length >= 2 && !isStopName(name)) found.add(name);
    }
  }
  return [...found];
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
              // 旧提示词把三类实体写在一句里、只给一个人名例子，qwen3-4b 遇到带样本编号的句子
              // 会只输出编号（[{"kind":"term","text":"S-2031"}]），句首和并列的人名整个漏掉。
              // 人名单独成条、点明句首/并列/带称谓几种形式后，同样的句子能稳定找全。
              '你是隐私审查器。逐字检查用户给的科研文本，找出所有需要保密的实体：' +
              '1) 人名（person）：每一个具体的人名都要列出，包括句首的人名、并列的多个人名、带称谓的（如“王老师”）；' +
              '2) 具体单位或机构名（org）；3) 未公开的项目或样品代号（term）。' +
              '只输出 JSON 数组，例如 [{"kind":"person","text":"刘洋"},{"kind":"org","text":"某某大学"}]；text 必须是文本里逐字出现的片段；通用学科词、公开的方法名、知名模型名都不算；没有就输出 []。' +
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
  const entities = (useLocal ? await localEntities(config, texts.join('\n\n'), opts.signal) : [])
    .filter((e) => e.kind === 'person' || e.kind === 'org' || !ruleHit(e.text))
    // 小模型偶尔把“张量分解”“高斯分布”当人名；姓开头的普通词一律不算人名
    // （只丢整词命中或 ≥4 字以普通词开头的，“王国维”“方向东”这类三字真名照样遮）
    .filter(
      (e) =>
        e.kind !== 'person' ||
        !(NAME_STOPLIST.has(e.text) || (e.text.length >= 4 && isStopName(e.text))),
    );
  // 人名规则兜底：不管模型有没有找到、本地模型开没开都跑。
  // 规则和模型找到的人名合在一起，在所有文本里的每一处出现都遮掉
  const modelFound = entities.length > 0;
  const known = new Set(entities.map((e) => e.text));
  for (const name of ruleNames(texts.join('\n\n'))) {
    if (!known.has(name)) {
      known.add(name);
      entities.push({ kind: 'person', text: name });
    }
  }
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
    usedLocalModel: modelFound || (useLocal && hybridEnabled(config)),
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
