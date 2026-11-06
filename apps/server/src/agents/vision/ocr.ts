import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import type * as Tesseract from 'tesseract.js';
import type { AppConfig } from '../../config';

type TesseractModule = typeof Tesseract;

/**
 * OCR 兜底（没有配置视觉模型时）：
 * 1. 系统里装了 tesseract 可执行文件就用它（快、不占 Node 内存）；没有就静默跳过，不报错。
 * 2. 否则用 tesseract.js（WASM）。语言包 chi_sim + eng 第一次用时下载一次，
 *    缓存到可写的数据目录（OCR_LANG_DIR，默认 <STORAGE_DIR>/../ocr-lang），不放 node_modules。
 *    下载走 HTTPS_PROXY / HTTP_PROXY；离线时抛出说明清楚的错误，由调用方转成给模型的提示。
 */

export const OCR_LANGS = ['chi_sim', 'eng'] as const;
const DEFAULT_LANG_URL = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/{lang}/4.0.0_best_int';
const WORKER_IDLE_MS = 5 * 60_000;
const OCR_TIMEOUT_MS = 120_000;

export interface OcrResult {
  text: string;
  /** 0–100，tesseract 给的平均置信度；系统可执行文件路径拿不到时为 null */
  confidence: number | null;
  engine: 'tesseract-cli' | 'tesseract.js';
}

export type OcrEngine = (bytes: Buffer, config: AppConfig) => Promise<OcrResult>;

export class OcrUnavailableError extends Error {}

let override: OcrEngine | null = null;
/** 测试用：换掉 OCR 引擎（传 null 恢复） */
export function setOcrEngineForTests(fn: OcrEngine | null): void {
  override = fn;
}

export function ocrLangDir(config: Pick<AppConfig, 'OCR_LANG_DIR' | 'STORAGE_DIR'>): string {
  return resolve(config.OCR_LANG_DIR || join(dirname(resolve(config.STORAGE_DIR)), 'ocr-lang'));
}

export async function runOcr(bytes: Buffer, config: AppConfig): Promise<OcrResult> {
  if (override) return override(bytes, config);
  if (await hasTesseractCli()) {
    try {
      return await cliOcr(bytes);
    } catch (err) {
      console.warn('[vision] 系统 tesseract 识别失败，改用 tesseract.js：', (err as Error).message);
    }
  }
  return wasmOcr(bytes, config);
}

// ---------------------------------------------------------------- 系统可执行文件

let cliProbe: Promise<boolean> | null = null;
function hasTesseractCli(): Promise<boolean> {
  cliProbe ??= new Promise((res) => {
    try {
      execFile('tesseract', ['--list-langs'], { timeout: 5000 }, (err, stdout) => {
        if (err) return res(false);
        const langs = String(stdout);
        res(OCR_LANGS.every((l) => langs.includes(l)));
      });
    } catch {
      res(false);
    }
  });
  return cliProbe;
}

async function cliOcr(bytes: Buffer): Promise<OcrResult> {
  const tmp = join(tmpdir(), `srh-ocr-${randomUUID()}`);
  await writeFile(tmp, bytes);
  try {
    const text = await new Promise<string>((res, rej) =>
      execFile(
        'tesseract',
        [tmp, 'stdout', '-l', OCR_LANGS.join('+')],
        { timeout: OCR_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => (err ? rej(err) : res(String(stdout))),
      ),
    );
    return { text: text.trim(), confidence: null, engine: 'tesseract-cli' };
  } finally {
    await rm(tmp, { force: true });
  }
}

// ---------------------------------------------------------------- tesseract.js

/** 确保语言包在本地（没有就下载一次，原子写入）；返回目录 */
export async function ensureLangData(config: AppConfig): Promise<string> {
  const dir = ocrLangDir(config);
  await mkdir(dir, { recursive: true });
  for (const lang of OCR_LANGS) {
    const file = join(dir, `${lang}.traineddata`);
    const ok = await stat(file).then(
      (s) => s.size > 1000,
      () => false,
    );
    if (ok) continue;
    const base = (config.OCR_LANG_URL || DEFAULT_LANG_URL)
      .replace('{lang}', lang)
      .replace(/\/$/u, '');
    const url = `${base}/${lang}.traineddata.gz`;
    let data: Buffer;
    try {
      const resp = await undiciFetch(url, {
        dispatcher: new EnvHttpProxyAgent(),
        signal: AbortSignal.timeout(180_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = Buffer.from(await resp.arrayBuffer());
    } catch (err) {
      throw new OcrUnavailableError(
        `OCR 语言包 ${lang} 不在本地（${file}），下载 ${url} 失败：${(err as Error).message}。` +
          '服务器离线时请手动把 chi_sim.traineddata、eng.traineddata 放进该目录，或设置 OCR_LANG_URL 指向内网镜像。',
      );
    }
    if (data[0] === 0x1f && data[1] === 0x8b) data = gunzipSync(data);
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
    console.log(
      `[vision] 已下载 OCR 语言包 ${lang}（${Math.round(data.length / 1024)} KB）→ ${file}`,
    );
  }
  return dir;
}

interface TessWorker {
  recognize(image: Buffer): Promise<{ data: { text: string; confidence: number } }>;
  terminate(): Promise<unknown>;
}

let worker: Promise<TessWorker> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function getWorker(config: AppConfig): Promise<TessWorker> {
  worker ??= (async () => {
    const dir = await ensureLangData(config);
    const mod = (await import('tesseract.js')) as unknown as {
      default?: TesseractModule;
    } & TesseractModule;
    const T = mod.default ?? mod;
    const w = await T.createWorker([...OCR_LANGS], T.OEM.LSTM_ONLY, {
      langPath: dir,
      cachePath: dir,
      gzip: false,
      cacheMethod: 'readOnly',
      errorHandler: (e: unknown) => console.warn('[vision] tesseract.js worker 出错', e),
    });
    return w as unknown as TessWorker;
  })().catch((err: unknown) => {
    worker = null;
    throw err instanceof OcrUnavailableError
      ? err
      : new OcrUnavailableError(`OCR 引擎启动失败：${(err as Error)?.message ?? String(err)}`);
  });
  return worker;
}

function scheduleIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void shutdownOcr(), WORKER_IDLE_MS);
  idleTimer.unref();
}

/** 关掉 tesseract.js worker（空闲超时 / 进程退出时） */
export async function shutdownOcr(): Promise<void> {
  const w = worker;
  worker = null;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (w) await (await w.catch(() => null))?.terminate().catch(() => undefined);
}

async function wasmOcr(bytes: Buffer, config: AppConfig): Promise<OcrResult> {
  // 同一个 worker 串行识别，避免多张图同时占满内存
  const job = queue.then(async () => {
    const w = await getWorker(config);
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('OCR 超时')), OCR_TIMEOUT_MS).unref(),
    );
    const { data } = await Promise.race([w.recognize(bytes), timeout]);
    scheduleIdle();
    return {
      text: data.text.trim(),
      confidence: Math.round(data.confidence),
      engine: 'tesseract.js' as const,
    };
  });
  queue = job.catch(() => undefined);
  return job;
}

/** 测试 / 预热用：读语言包是否已就绪 */
export async function langDataReady(config: AppConfig): Promise<boolean> {
  const dir = ocrLangDir(config);
  for (const lang of OCR_LANGS) {
    const ok = await readFile(join(dir, `${lang}.traineddata`)).then(
      (b) => b.length > 1000,
      () => false,
    );
    if (!ok) return false;
  }
  return true;
}
