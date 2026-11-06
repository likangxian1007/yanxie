import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type * as Y from 'yjs';
import {
  ApiError,
  type LatexCapability,
  type LatexCompileInput,
  type LatexCompileResult,
} from '@srh/shared';
import type { AppContext } from '../../../context';
import { diskPath, getFile, listFiles } from '../../files/service';
import { loadLatexOptions, type LatexOptions } from './config';
import {
  findMissingBibs,
  findUnsafePath,
  readLatexProject,
  type LatexProjectSnapshot,
} from './project';
import { latexmkRunner, tectonicRunner, type LatexRunner } from './runner';

/**
 * LaTeX 真编译：把服务端 Y.Doc 里的工程（main.tex + 辅助文本文件 + 图片）写进临时目录，
 * 调用编译器（tectonic / latexmk），产出 PDF 与日志。
 *
 * - 输入没变（内容哈希相同）直接复用上次结果，自动编译不会重复跑
 * - 同一篇文档同时只跑一个编译；全局并发 LATEX_MAX_CONCURRENCY，排队太长 → 429
 * - 每个项目每分钟最多 LATEX_RATE_PER_MIN 次真正的编译 → 超出 429
 * - PDF 放在内存 LRU 里（总量 pdfCacheBytes），按 pdfId 取；服务重启后需要重新编译
 */

interface CompileEntry {
  hash: string;
  result: LatexCompileResult;
  pdf: Buffer | null;
}

interface LatexState {
  options: LatexOptions;
  runner: LatexRunner | null | undefined;
  capability: { at: number; value: LatexCapability } | null;
  /** 探测后选中的编译器 */
  resolved: LatexRunner | null;
  /** 每篇文档最近一次编译（Map 的顺序即 LRU 顺序） */
  entries: Map<string, CompileEntry>;
  pdfBytes: number;
  inflight: Map<string, { hash: string; promise: Promise<CompileEntry> }>;
  running: number;
  waiters: (() => void)[];
  rate: Map<string, number[]>;
}

const states = new WeakMap<AppContext, LatexState>();
const MAX_WAITERS = 12;
const CAPABILITY_TTL = 60_000;

function state(ctx: AppContext): LatexState {
  let s = states.get(ctx);
  if (!s) {
    s = {
      options: loadLatexOptions(ctx.config.STORAGE_DIR),
      runner: undefined,
      capability: null,
      resolved: null,
      entries: new Map(),
      pdfBytes: 0,
      inflight: new Map(),
      running: 0,
      waiters: [],
      rate: new Map(),
    };
    states.set(ctx, s);
  }
  return s;
}

/** 测试 / 部署钩子：替换编译器（null = 关闭编译），可同时覆盖部分配置 */
export function setLatexRunner(
  ctx: AppContext,
  runner: LatexRunner | null,
  options: Partial<LatexOptions> = {},
): void {
  const s = state(ctx);
  s.runner = runner;
  s.options = { ...loadLatexOptions(ctx.config.STORAGE_DIR), ...options };
  s.capability = null;
  s.entries.clear();
  s.pdfBytes = 0;
  s.rate.clear();
}

async function resolveRunner(
  s: LatexState,
): Promise<{ runner: LatexRunner | null; version: string | null; reason: string | null }> {
  if (s.runner === null) return { runner: null, version: null, reason: '编译服务已关闭' };
  const candidates: LatexRunner[] = s.runner
    ? [s.runner]
    : s.options.compiler === 'none'
      ? []
      : s.options.compiler === 'tectonic'
        ? [tectonicRunner(s.options)]
        : s.options.compiler === 'latexmk'
          ? [latexmkRunner(s.options)]
          : [tectonicRunner(s.options), latexmkRunner(s.options)];
  if (candidates.length === 0) {
    return {
      runner: null,
      version: null,
      reason: '服务器没有开启 LaTeX 编译（LATEX_COMPILER=none）',
    };
  }
  let reason = '';
  for (const c of candidates) {
    const p = await c.probe();
    if (p.ok) return { runner: c, version: p.version, reason: null };
    reason = reason || p.reason;
  }
  return { runner: null, version: null, reason: `服务器上没有可用的 LaTeX 编译器：${reason}` };
}

export async function latexCapability(ctx: AppContext): Promise<LatexCapability> {
  const s = state(ctx);
  const now = Date.now();
  if (s.capability && now - s.capability.at < CAPABILITY_TTL) return s.capability.value;
  const r = await resolveRunner(s);
  s.resolved = r.runner;
  const value: LatexCapability = {
    available: !!r.runner,
    engine: r.runner?.engine ?? null,
    version: r.version,
    reason: r.reason,
    limits: {
      timeoutMs: s.options.timeoutMs,
      maxSourceBytes: s.options.maxSourceBytes,
      maxPdfBytes: s.options.maxPdfBytes,
    },
  };
  s.capability = { at: now, value };
  return value;
}

async function activeRunner(ctx: AppContext): Promise<LatexRunner> {
  const cap = await latexCapability(ctx);
  const runner = state(ctx).resolved;
  if (!cap.available || !runner) {
    throw new ApiError('not_implemented', cap.reason ?? '服务器上没有可用的 LaTeX 编译器');
  }
  return runner;
}

// ---------------------------------------------------------------- 输入

function projectHash(p: LatexProjectSnapshot, engine: string): string {
  const h = createHash('sha256');
  h.update(`engine:${engine}\n`);
  for (const t of p.texts) h.update(`T:${t.name}\n${t.content.length}\n${t.content}\n`);
  for (const a of p.assets) h.update(`A:${a.name}\n${a.fileId}:${a.size}:${a.mime}\n`);
  return h.digest('hex');
}

function rejected(engine: string, message: string): LatexCompileResult {
  return {
    status: 'rejected',
    pdfId: null,
    pdfBytes: 0,
    engine,
    durationMs: 0,
    log: message,
    logTruncated: false,
    cached: false,
    compiledAt: new Date().toISOString(),
  };
}

/** 工程检查：大小、路径；不合格返回原因 */
function validateProject(p: LatexProjectSnapshot, opts: LatexOptions): string | null {
  const textBytes = p.texts.reduce((n, t) => n + Buffer.byteLength(t.content, 'utf8'), 0);
  if (textBytes > opts.maxSourceBytes) {
    return `源码太大（${(textBytes / 1048576).toFixed(1)} MB），编译上限是 ${Math.round(opts.maxSourceBytes / 1048576)} MB。`;
  }
  const assetBytes = p.assets.reduce((n, a) => n + a.size, 0);
  if (assetBytes > opts.maxAssetBytes) {
    return `图片总大小 ${(assetBytes / 1048576).toFixed(1)} MB，超过上限 ${Math.round(opts.maxAssetBytes / 1048576)} MB。`;
  }
  const unsafe = findUnsafePath(p.texts);
  if (unsafe) {
    return `${unsafe.file}:${unsafe.line}: 不能引用工程以外的文件（绝对路径或 ..）：${unsafe.text}\n请把需要的文件加到工程里，用相对路径引用。`;
  }
  return null;
}

// ---------------------------------------------------------------- 限流与排队

function checkRate(s: LatexState, projectId: string): void {
  const now = Date.now();
  const list = (s.rate.get(projectId) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= s.options.ratePerMinute) {
    s.rate.set(projectId, list);
    throw new ApiError('rate_limited', '编译太频繁了，请稍等一分钟再试', {
      retryAfterMs: 60_000 - (now - list[0]!),
    });
  }
  list.push(now);
  s.rate.set(projectId, list);
}

async function acquire(s: LatexState): Promise<void> {
  if (s.running < s.options.maxConcurrency) {
    s.running += 1;
    return;
  }
  if (s.waiters.length >= MAX_WAITERS) {
    throw new ApiError('rate_limited', '编译服务正忙，请稍后再试');
  }
  await new Promise<void>((resolveWait) => s.waiters.push(resolveWait));
  s.running += 1;
}

function release(s: LatexState): void {
  s.running -= 1;
  const next = s.waiters.shift();
  if (next) next();
}

// ---------------------------------------------------------------- 结果缓存

function remember(s: LatexState, docId: string, entry: CompileEntry): void {
  const old = s.entries.get(docId);
  if (old) {
    s.pdfBytes -= old.pdf?.length ?? 0;
    s.entries.delete(docId);
  }
  s.entries.set(docId, entry);
  s.pdfBytes += entry.pdf?.length ?? 0;
  for (const [key, e] of s.entries) {
    if (s.pdfBytes <= s.options.pdfCacheBytes || key === docId) break;
    s.pdfBytes -= e.pdf?.length ?? 0;
    s.entries.delete(key);
  }
}

export function getCompiledPdf(ctx: AppContext, docId: string, pdfId: string): Buffer | null {
  const e = state(ctx).entries.get(docId);
  if (!e?.pdf || e.result.pdfId !== pdfId) return null;
  return e.pdf;
}

/** 最近一次编译结果（没有则 null），打开文档时先显示它 */
export function lastCompile(ctx: AppContext, docId: string): LatexCompileResult | null {
  return state(ctx).entries.get(docId)?.result ?? null;
}

// ---------------------------------------------------------------- 编译

/** 统计 TeX 日志里的错误行（`! …` 或 `file:line: …`） */
export function countLogErrors(log: string): number {
  let n = 0;
  for (const line of log.split(/\r?\n/u)) {
    if (/^! /u.test(line) || /^(?:\.\/)?[^\s:]+\.(?:tex|sty|cls|bbl):\d+: /u.test(line)) n += 1;
  }
  return n;
}

function truncateLog(log: string, max: number): { log: string; truncated: boolean } {
  if (log.length <= max) return { log, truncated: false };
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  return {
    log: `${log.slice(0, head)}\n\n…（日志太长，中间省略了 ${log.length - max} 个字符）…\n\n${log.slice(-tail)}`,
    truncated: true,
  };
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

function cleanCompilerOutput(output: string): string {
  return (
    output
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/gu, '')
      .split(/\r?\n/u)
      .filter((l) => !/^Fontconfig error: Cannot load default config file/u.test(l))
      .join('\n')
      .trim()
  );
}

/** 研协提示里“缺参考文献库”那一行的固定开头（前端 texLog.ts 按它识别，改动时两边一起改） */
export const MISSING_BIB_NOTE = '研协：参考文献库缺失';

/**
 * \bibliography{…} 引用的 .bib 不在 LaTeX 工程里：一行说明（在哪一行、后果、怎么补）。
 * 项目文件夹里有同名文件时点出来——那不是工程的一部分，编译看不到它。
 */
export async function missingBibNotes(
  ctx: AppContext,
  projectId: string,
  project: LatexProjectSnapshot,
): Promise<string[]> {
  const missing = findMissingBibs(project.texts);
  if (missing.length === 0) return [];
  const bibsInProject = project.texts
    .map((t) => t.name)
    .filter((n) => n.toLowerCase().endsWith('.bib'));
  let projectFiles: string[] = [];
  try {
    projectFiles = (await listFiles(ctx, projectId)).map((f) => f.path);
  } catch {
    // 列不出项目文件不影响编译
  }
  return missing.map((m) => {
    const base = basename(m.name).toLowerCase();
    const outside = projectFiles.filter((p) => basename(p).toLowerCase() === base).slice(0, 3);
    const parts = [
      `${MISSING_BIB_NOTE}：${m.file} 第 ${m.line} 行 ${m.text} 要用 ${m.name}，但这个 LaTeX 工程里没有这个文件，`,
      'BibTeX 没有生成参考文献，正文里的 \\cite 都会显示成 [?]（PDF 其余部分照常生成）。',
    ];
    if (outside.length > 0) {
      parts.push(`项目文件夹里的 ${outside.join('、')} 不属于这个 LaTeX 工程，编译时看不到；`);
    }
    parts.push(
      `请在编辑器文件栏点「+」新建 ${m.name} 并贴入条目（或用文献库的「插入引用」写进工程）`,
    );
    if (bibsInProject.length > 0) {
      parts.push(`，或者把 ${m.text} 改成工程里已有的 ${bibsInProject.join('、')}`);
    }
    return `${parts.join('')}。`;
  });
}

async function runCompile(
  ctx: AppContext,
  projectId: string,
  docId: string,
  project: LatexProjectSnapshot,
  hash: string,
  runner: LatexRunner,
): Promise<CompileEntry> {
  const s = state(ctx);
  const opts = s.options;
  const started = Date.now();
  await acquire(s);
  const dir = await mkdtemp(join(tmpdir(), 'srh-latex-'));
  try {
    const notes: string[] = [];
    for (const t of project.texts) {
      const abs = join(dir, ...t.name.split('/'));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, t.content, 'utf8');
    }
    for (const a of project.assets) {
      const row = await getFile(ctx, projectId, a.fileId);
      if (!row) {
        notes.push(`研协：图片 ${a.name} 对应的项目文件已被删除，编译时缺少这个文件。`);
        continue;
      }
      const abs = join(dir, ...a.name.split('/'));
      await mkdir(dirname(abs), { recursive: true });
      try {
        await copyFile(diskPath(ctx, projectId, row.path), abs);
      } catch {
        notes.push(`研协：图片 ${a.name} 的文件内容已丢失。`);
      }
    }

    notes.push(...(await missingBibNotes(ctx, projectId, project)));

    const out = await runner.run({ dir, timeoutMs: opts.timeoutMs });
    const pdfPath = join(dir, 'main.pdf');
    let pdf = await readOptional(pdfPath);
    if (pdf && pdf.length > opts.maxPdfBytes) {
      notes.push(`研协：生成的 PDF 有 ${(pdf.length / 1048576).toFixed(1)} MB，超过上限，已丢弃。`);
      pdf = null;
    }
    if (pdf && pdf.subarray(0, 5).toString('latin1') !== '%PDF-') pdf = null;
    const texLog = (await readOptional(join(dir, 'main.log')))?.toString('utf8') ?? '';
    const blg = (await readOptional(join(dir, 'main.blg')))?.toString('utf8') ?? '';
    const compilerOut = cleanCompilerOutput(out.output);
    const parts = [texLog.trim()];
    if (blg.trim()) parts.push(`---- BibTeX（main.blg）----\n${blg.trim()}`);
    if (compilerOut) parts.push(`---- 编译器输出（${runner.engine}）----\n${compilerOut}`);
    if (out.timedOut) {
      parts.push(
        `研协：编译超过 ${Math.round(opts.timeoutMs / 1000)} 秒被终止。第一次用到某些宏包时需要下载，可以稍后再试一次。`,
      );
    }
    if (notes.length) parts.push(notes.join('\n'));
    const { log, truncated } = truncateLog(parts.filter(Boolean).join('\n\n'), opts.maxLogChars);
    const errors = countLogErrors(texLog) + (pdf ? 0 : 1);
    const status: LatexCompileResult['status'] = out.timedOut
      ? 'timeout'
      : errors > 0 || out.exitCode !== 0
        ? 'error'
        : 'success';
    const pdfId = pdf ? createHash('sha1').update(pdf).digest('hex').slice(0, 20) : null;
    const result: LatexCompileResult = {
      status,
      pdfId,
      pdfBytes: pdf?.length ?? 0,
      engine: runner.engine,
      durationMs: Date.now() - started,
      log,
      logTruncated: truncated,
      cached: false,
      compiledAt: new Date().toISOString(),
    };
    return { hash, result, pdf };
  } finally {
    release(s);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 编译文档当前的工程。doc 由调用方取（在线文档或库里的状态）。
 */
export async function compileLatex(
  ctx: AppContext,
  projectId: string,
  docId: string,
  doc: Y.Doc,
  input: LatexCompileInput = {},
): Promise<LatexCompileResult> {
  const s = state(ctx);
  const runner = await activeRunner(ctx);
  const project = readLatexProject(doc);
  const hash = projectHash(project, runner.engine);

  const last = s.entries.get(docId);
  if (!input.force && last && last.hash === hash && last.result.status !== 'timeout') {
    // LRU：刷新位置
    s.entries.delete(docId);
    s.entries.set(docId, last);
    return { ...last.result, cached: true };
  }

  const invalid = validateProject(project, s.options);
  if (invalid) {
    const result = rejected(runner.engine, invalid);
    remember(s, docId, { hash, result, pdf: null });
    return result;
  }

  // 同一篇文档：相同输入合并成一次；不同输入等前一次结束后再跑
  const running = s.inflight.get(docId);
  if (running) {
    if (running.hash === hash && !input.force) {
      const e = await running.promise;
      return { ...e.result, cached: true };
    }
    await running.promise.catch(() => undefined);
  }

  checkRate(s, projectId);
  const promise = runCompile(ctx, projectId, docId, project, hash, runner);
  s.inflight.set(docId, { hash, promise });
  try {
    const entry = await promise;
    remember(s, docId, entry);
    return entry.result;
  } finally {
    if (s.inflight.get(docId)?.promise === promise) s.inflight.delete(docId);
  }
}

/** 文档删除时丢掉它的 PDF */
export function forgetCompiled(ctx: AppContext, docId: string): void {
  const s = state(ctx);
  const e = s.entries.get(docId);
  if (e) {
    s.pdfBytes -= e.pdf?.length ?? 0;
    s.entries.delete(docId);
  }
}

/** 仅测试用：重置能力缓存（例如切换 runner 后） */
export function resetLatexCapability(ctx: AppContext): void {
  state(ctx).capability = null;
}
