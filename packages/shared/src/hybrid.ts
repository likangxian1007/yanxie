import { z } from 'zod';

/**
 * 本地 + 云端混合 AI（ARCHITECTURE.md §7.7）。
 * 本机推理服务（OpenVINO Model Server / Ollama 等 OpenAI 兼容接口）处理隐私敏感与高频小任务，
 * 复杂推理交给云端；发往云端的文本先在本地脱敏，结果回来后在本地还原。
 */

/** 可分流的任务类型 */
export const HybridTask = z.enum([
  'doc-rewrite', // 文档内嵌 AI：润色、精简、扩写、学术语气
  'doc-translate', // 文档内嵌 AI：中英互译
  'doc-summary', // 文档内嵌 AI：总结、大纲
  'doc-generate', // 文档内嵌 AI：续写、按指令、表格、幻灯片、LaTeX
  'compact', // agent 上下文压缩摘要
  'report', // 组会汇报
  'redact', // 隐私护栏：本地识别敏感实体（只在本地）
  'pdf-translate', // 整篇论文保版式翻译（外部 pdf2zh-next 服务，见 tools/pdf-translate）
]);
export type HybridTask = z.infer<typeof HybridTask>;

/** 分流策略：local 只走本地（本地不可用就报错），cloud 只走云端，auto 本地优先、不行回退云端 */
export const HybridRoute = z.enum(['local', 'cloud', 'auto']);
export type HybridRoute = z.infer<typeof HybridRoute>;

/** 每次调用请求方附带的隐私级别：local_only = 内容绝不出本机 */
export const HybridPrivacy = z.enum(['auto', 'local_only']);
export type HybridPrivacy = z.infer<typeof HybridPrivacy>;

export type HybridTarget = 'local' | 'cloud';

export interface HybridCall {
  at: string;
  task: HybridTask;
  target: HybridTarget;
  model: string;
  /** 本地优先但不可用 / 失败，改走了云端 */
  fallback: boolean;
  /** 上云前被替换成占位符的敏感片段数 */
  redacted: number;
  ms: number;
  /** 首个 token 延迟（流式才有） */
  firstTokenMs: number | null;
  inputTokens: number;
  outputTokens: number;
  /** 输出速度 tokens/s */
  tps: number | null;
  ok: boolean;
}

export interface HybridTaskStats {
  task: HybridTask;
  route: HybridRoute;
  local: number;
  cloud: number;
}

export interface HybridStatus {
  enabled: boolean;
  local: {
    baseUrl: string;
    model: string;
    device: string;
    up: boolean;
    checkedAt: string | null;
    /** 探活延迟 ms */
    latencyMs: number | null;
    error: string | null;
  };
  cloud: { model: string; configured: boolean };
  redact: boolean;
  routes: HybridTaskStats[];
  totals: {
    calls: number;
    localCalls: number;
    cloudCalls: number;
    fallbacks: number;
    redacted: number;
    localTokens: number;
    /** 本地处理的 token 若走云端大约要花的钱（美元） */
    savedUsd: number;
    avgLocalTps: number | null;
    avgLocalMs: number | null;
    avgCloudMs: number | null;
  };
  since: string;
  recent: HybridCall[];
  /** 整篇 PDF 保版式翻译服务是否已配置（PDF_TRANSLATE_URL） */
  pdfTranslate: boolean;
}

/**
 * 整篇 PDF 保版式翻译（ARCHITECTURE.md §7.8）。
 * mode：both = 同时出译文和双语对照，mono = 仅译文，dual = 仅双语对照。
 */
export const PdfTranslateInput = z.object({
  pages: z
    .string()
    .trim()
    .max(200)
    .regex(/^\d+(-\d+)?(,\d+(-\d+)?)*$/u)
    .optional(),
  mode: z.enum(['both', 'mono', 'dual']).default('both'),
  localOnly: z.boolean().default(false),
});
export type PdfTranslateInput = z.infer<typeof PdfTranslateInput>;

export type PdfTranslateKind = 'mono' | 'dual';

export interface PdfTranslateJob {
  status: 'idle' | 'queued' | 'running' | 'done' | 'failed';
  /** 0–100 */
  progress: number;
  stage: string;
  error: string | null;
  /** 实际在哪边翻译 */
  target: HybridTarget | null;
  /** 本地失败后整篇改由云端重做 */
  fallback: boolean;
  /** 命中磁盘缓存，没有重新翻译 */
  cached: boolean;
  pages: string | null;
  mode: 'both' | 'mono' | 'dual';
  files: PdfTranslateKind[];
  startedAt: string | null;
  finishedAt: string | null;
}

/** 隐私护栏试运行（设置页演示脱敏效果） */
export const HybridRedactPreviewInput = z.object({ text: z.string().min(1).max(20_000) });
export interface HybridRedactPreview {
  redacted: string;
  items: { placeholder: string; original: string; kind: string }[];
  usedLocalModel: boolean;
}
