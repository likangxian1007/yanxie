import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  ApiError,
  type HybridTarget,
  type PdfTranslateInput,
  type PdfTranslateJob,
  type PdfTranslateKind,
} from '@srh/shared';
import type { AppConfig } from '../../config';
import { decide, markLocalDown, recordCall } from '../../agents/llm/hybrid';

/**
 * 整篇 PDF 保版式翻译（ARCHITECTURE.md §7.8）。
 *
 * 真正的翻译由独立进程 tools/pdf-translate（pdf2zh-next，AGPL-3.0）完成，这里只通过 HTTP 调它：
 * 上传 PDF → 轮询进度 → 下载 mono / dual 两份 PDF 存进磁盘缓存。
 *
 * - 分流走混合 AI 的 decide()（任务 'pdf-translate'，默认 auto）：本地模型可用就用本地；
 *   本地中途失败且不是「仅本地」，整篇改由云端 DeepSeek 重做（fallback = true）。
 * - 缓存键 = PDF 的 sha256 + 页码范围 + 输出模式；同一份 PDF 不重复翻译（不同论文记录共用）。
 * - 任务状态在进程内存；每篇论文最近一次任务的缓存键写在磁盘上，重启后已完成的结果还能取到。
 */

export const pdfTranslateTiming = { pollMs: 1500, timeoutMs: 3 * 60 * 60_000 };

interface Job extends PdfTranslateJob {
  key: string;
  dir: string;
  localOnly: boolean;
}

const jobs = new Map<string, Job>();

export function resetPdfTranslateForTest() {
  jobs.clear();
}

export function pdfTranslateEnabled(config: AppConfig): boolean {
  return Boolean(config.PDF_TRANSLATE_URL.trim());
}

function serviceUrl(config: AppConfig, path: string) {
  return `${config.PDF_TRANSLATE_URL.trim().replace(/\/+$/u, '')}${path}`;
}

function root(config: AppConfig) {
  return resolve(config.STORAGE_DIR, '.pdf-translate');
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

function view(job: Job): PdfTranslateJob {
  const { key: _key, dir: _dir, localOnly: _localOnly, ...rest } = job;
  return { ...rest };
}

function idle(): PdfTranslateJob {
  return {
    status: 'idle',
    progress: 0,
    stage: '',
    error: null,
    target: null,
    fallback: false,
    cached: false,
    pages: null,
    mode: 'both',
    files: [],
    startedAt: null,
    finishedAt: null,
  };
}

const exists = (p: string) =>
  stat(p).then(
    (s) => s.isFile() && s.size > 0,
    () => false,
  );

/** 论文 → 最近一次任务的缓存键（落盘，重启后仍能找到已完成的译文） */
function pointerPath(config: AppConfig, paperKey: string) {
  return join(root(config), 'papers', `${sha(paperKey)}.json`);
}

async function readPointer(config: AppConfig, paperKey: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(pointerPath(config, paperKey), 'utf8')) as {
      key?: unknown;
    };
    return typeof raw.key === 'string' && /^[0-9a-f]{64}$/u.test(raw.key) ? raw.key : null;
  } catch {
    return null;
  }
}

async function writePointer(config: AppConfig, paperKey: string, key: string) {
  await mkdir(join(root(config), 'papers'), { recursive: true });
  await writeFile(pointerPath(config, paperKey), JSON.stringify({ key }));
}

/** 从磁盘缓存恢复一个已完成的任务 */
async function loadCached(config: AppConfig, key: string): Promise<Job | null> {
  const dir = join(root(config), key);
  try {
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as Job;
    const files: PdfTranslateKind[] = [];
    for (const kind of ['mono', 'dual'] as const)
      if (await exists(join(dir, `${kind}.pdf`))) files.push(kind);
    if (!files.length) return null;
    return { ...meta, key, dir, status: 'done', progress: 100, files, error: null };
  } catch {
    return null;
  }
}

export async function getPdfTranslate(
  config: AppConfig,
  paperKey: string,
): Promise<PdfTranslateJob> {
  const key = await readPointer(config, paperKey);
  if (!key) return idle();
  const job = jobs.get(key) ?? (await loadCached(config, key));
  if (!job) return idle();
  jobs.set(key, job);
  return view(job);
}

export async function pdfTranslateFile(
  config: AppConfig,
  paperKey: string,
  kind: PdfTranslateKind,
): Promise<string> {
  const key = await readPointer(config, paperKey);
  const job = key ? (jobs.get(key) ?? (await loadCached(config, key))) : null;
  const path = job ? join(job.dir, `${kind}.pdf`) : '';
  if (!job || job.status !== 'done' || !job.files.includes(kind) || !(await exists(path)))
    throw new ApiError('not_found', '还没有可下载的译文');
  return path;
}

/**
 * 开始翻译（或复用正在进行 / 已缓存的结果）。立刻返回，后台跑完整个流程。
 */
export async function startPdfTranslate(
  config: AppConfig,
  paperKey: string,
  pdfPath: string,
  input: PdfTranslateInput,
): Promise<PdfTranslateJob> {
  if (!pdfTranslateEnabled(config)) throw new ApiError('not_found', 'PDF 翻译服务没有配置');
  const pdf = await readFile(pdfPath);
  const pages = input.pages?.replace(/\s+/gu, '') || null;
  const key = sha(`${sha(pdf)}|${pages ?? 'all'}|${input.mode}`);
  await writePointer(config, paperKey, key);

  const current = jobs.get(key) ?? (await loadCached(config, key));
  if (
    current &&
    (current.status === 'done' || current.status === 'queued' || current.status === 'running')
  ) {
    if (current.status === 'done') current.cached = true;
    jobs.set(key, current);
    return view(current);
  }

  const job: Job = {
    ...idle(),
    key,
    dir: join(root(config), key),
    localOnly: input.localOnly,
    status: 'queued',
    pages,
    mode: input.mode,
    startedAt: new Date().toISOString(),
  };
  jobs.set(key, job);
  void run(config, job, pdf).catch((err: unknown) => {
    job.status = 'failed';
    job.error = (err as Error).message || '翻译失败';
    job.finishedAt = new Date().toISOString();
  });
  return view(job);
}

/** 区分「翻译引擎（模型）失败」与「翻译服务本身出问题」：只有前者值得换云端重做 */
class RemoteFailure extends Error {
  constructor(
    message: string,
    readonly engine: boolean,
  ) {
    super(message);
  }
}

interface Engine {
  base_url: string;
  model: string;
  api_key: string;
  qps: number;
  no_think: boolean;
}

function engineFor(config: AppConfig, target: HybridTarget): Engine {
  if (target === 'local')
    return {
      base_url: config.LOCAL_LLM_BASE_URL,
      model: config.LOCAL_LLM_MODEL,
      api_key: config.LOCAL_LLM_API_KEY || 'none',
      qps: 4,
      // Qwen3 默认会先「思考」，整篇翻译时慢好几倍
      no_think: /qwen3/iu.test(config.LOCAL_LLM_MODEL),
    };
  return {
    base_url: config.LLM_BASE_URL,
    model: config.LLM_MODEL,
    api_key: config.LLM_API_KEY,
    qps: 8,
    no_think: false,
  };
}

async function run(config: AppConfig, job: Job, pdf: Buffer) {
  const t0 = Date.now();
  const decision = await decide(config, 'pdf-translate', 0, job.localOnly ? 'local_only' : 'auto');
  let target = decision.target;
  job.fallback = decision.fallback;
  if (target === 'cloud' && !config.llmConfigured)
    throw new Error('本地模型和云端模型都不可用，无法翻译 PDF');
  job.target = target;
  try {
    await translateOnce(config, job, pdf, engineFor(config, target));
  } catch (err) {
    const engineFailed = err instanceof RemoteFailure && err.engine;
    if (target !== 'local' || job.localOnly || !engineFailed || !config.llmConfigured) {
      recordCall(callOf(config, target, job.fallback, t0, false));
      throw err;
    }
    // 本地中途失败：整篇换云端重做
    markLocalDown((err as Error).message);
    recordCall(callOf(config, 'local', false, t0, false));
    target = 'cloud';
    job.target = 'cloud';
    job.fallback = true;
    job.progress = 0;
    job.stage = '';
    await translateOnce(config, job, pdf, engineFor(config, 'cloud'));
  }
  recordCall(callOf(config, target, job.fallback, t0, true));
  await writeFile(
    join(job.dir, 'meta.json'),
    JSON.stringify({ ...view(job), status: 'done', cached: false }),
  );
}

function callOf(
  config: AppConfig,
  target: HybridTarget,
  fallback: boolean,
  t0: number,
  ok: boolean,
) {
  return {
    task: 'pdf-translate' as const,
    target,
    model: target === 'local' ? config.LOCAL_LLM_MODEL : config.LLM_MODEL,
    fallback,
    redacted: 0,
    ms: Date.now() - t0,
    firstTokenMs: null,
    inputTokens: 0,
    outputTokens: 0,
    ok,
  };
}

async function remote(config: AppConfig, path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(serviceUrl(config, path), { ...init, signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    throw new RemoteFailure(`PDF 翻译服务连不上：${(err as Error).message}`, false);
  }
  if (res.status === 404 && path.startsWith('/jobs/'))
    throw new RemoteFailure('PDF 翻译服务丢失了这个任务', false);
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new RemoteFailure(`PDF 翻译服务出错：HTTP ${res.status} ${detail}`.trim(), false);
  }
  return res;
}

interface RemoteJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  stage: string;
  error: string | null;
  mono: boolean;
  dual: boolean;
}

async function translateOnce(config: AppConfig, job: Job, pdf: Buffer, engine: Engine) {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'input.pdf');
  form.set('opts', JSON.stringify({ pages: job.pages, mode: job.mode, engine }));
  const created = (await (
    await remote(config, '/jobs', { method: 'POST', body: form })
  ).json()) as RemoteJob;
  job.status = 'running';
  const deadline = Date.now() + pdfTranslateTiming.timeoutMs;
  let state = created;
  while (state.status === 'queued' || state.status === 'running') {
    if (Date.now() > deadline) throw new RemoteFailure('PDF 翻译超时', true);
    await new Promise((r) => setTimeout(r, pdfTranslateTiming.pollMs));
    state = (await (
      await remote(config, `/jobs/${encodeURIComponent(created.id)}`)
    ).json()) as RemoteJob;
    job.progress = Math.max(0, Math.min(100, Number(state.progress) || 0));
    job.stage = String(state.stage ?? '').slice(0, 200);
  }
  if (state.status !== 'done')
    throw new RemoteFailure(`翻译失败：${state.error ?? ''}`.trim(), true);

  await mkdir(job.dir, { recursive: true });
  const files: PdfTranslateKind[] = [];
  for (const kind of ['mono', 'dual'] as const) {
    if (!state[kind]) continue;
    const res = await remote(config, `/jobs/${encodeURIComponent(created.id)}/${kind}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = join(job.dir, `${kind}.pdf.tmp`);
    await writeFile(tmp, buf);
    await rename(tmp, join(job.dir, `${kind}.pdf`));
    files.push(kind);
  }
  if (!files.length) throw new RemoteFailure('翻译失败：没有生成 PDF', true);
  job.files = files;
  job.progress = 100;
  job.stage = '';
  job.status = 'done';
  job.finishedAt = new Date().toISOString();
}
