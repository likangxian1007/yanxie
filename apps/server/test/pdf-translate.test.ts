import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config';
import { hybridStatus, resetHybridForTest } from '../src/agents/llm/hybrid';
import {
  getPdfTranslate,
  pdfTranslateFile,
  pdfTranslateTiming,
  resetPdfTranslateForTest,
  startPdfTranslate,
} from '../src/modules/pdf-translate/service';

/**
 * 假的本机模型（只管 /models 探活）+ 假的 PDF 翻译服务（tools/pdf-translate 的 HTTP 协议）。
 * 翻译服务看请求里的 engine.base_url 判断是本地还是云端；localFails 时本地任务翻译失败。
 */
let llm: Server;
let svc: Server;
let llmBase = '';
let svcBase = '';
let llmUp = true;
let localFails = false;
let engines: string[] = [];
let dir = '';
let pdfPath = '';
const remoteJobs = new Map<string, { polls: number; ok: boolean }>();

beforeAll(async () => {
  llm = createServer((req, res) => {
    res.statusCode = llmUp ? 200 : 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ object: 'list', data: [] }));
  });
  svc = createServer((req, res) => {
    const url = req.url ?? '';
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && url === '/jobs') {
        const m = /"base_url":"([^"]+)"/u.exec(body);
        const engine = m?.[1] === llmBase ? 'local' : 'cloud';
        engines.push(engine);
        const id = `j${remoteJobs.size + 1}`;
        remoteJobs.set(id, { polls: 0, ok: !(engine === 'local' && localFails) });
        res.statusCode = 201;
        res.end(JSON.stringify({ id, status: 'queued', progress: 0, stage: '' }));
        return;
      }
      const file = /^\/jobs\/(\w+)\/(mono|dual)$/u.exec(url);
      if (file) {
        res.setHeader('content-type', 'application/pdf');
        res.end(`%PDF-1.7 ${file[2]}`);
        return;
      }
      const st = /^\/jobs\/(\w+)$/u.exec(url);
      const job = st ? remoteJobs.get(st[1]!) : undefined;
      if (!job) {
        res.statusCode = 404;
        res.end('{}');
        return;
      }
      job.polls++;
      const finished = job.polls >= 2;
      res.end(
        JSON.stringify({
          id: st![1],
          status: finished ? (job.ok ? 'done' : 'failed') : 'running',
          progress: finished ? 100 : 50,
          stage: 'Translate Paragraphs',
          error: finished && !job.ok ? 'APIConnectionError: local model crashed' : null,
          mono: true,
          dual: true,
        }),
      );
    });
  });
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => svc.listen(0, '127.0.0.1', r));
  llmBase = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v3`;
  svcBase = `http://127.0.0.1:${(svc.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), 'srh-pdft-'));
  pdfPath = join(dir, 'paper.pdf');
  await writeFile(pdfPath, '%PDF-1.7 fake paper');
  pdfTranslateTiming.pollMs = 5;
});

afterAll(async () => {
  llm.close();
  svc.close();
  await rm(dir, { recursive: true, force: true });
});

let n = 0;
beforeEach(() => {
  llmUp = true;
  localFails = false;
  engines = [];
  resetHybridForTest();
  resetPdfTranslateForTest();
  n++;
});

const cfg = (over: Partial<AppConfig> = {}) =>
  ({
    PDF_TRANSLATE_URL: svcBase,
    STORAGE_DIR: join(dir, `storage${n}`),
    LOCAL_LLM_BASE_URL: llmBase,
    LOCAL_LLM_API_KEY: '',
    LOCAL_LLM_MODEL: 'qwen3-4b',
    LOCAL_LLM_DEVICE: 'Intel Arc GPU',
    LOCAL_LLM_MAX_INPUT_CHARS: 1000,
    HYBRID_ROUTES: '',
    HYBRID_REDACT: true,
    LLM_BASE_URL: 'https://api.deepseek.com',
    LLM_API_KEY: 'sk-test',
    LLM_MODEL: 'deepseek-chat',
    llmConfigured: true,
    ...over,
  }) as AppConfig;

async function settle(config: AppConfig, paper = 'p1') {
  for (let i = 0; i < 400; i++) {
    const j = await getPdfTranslate(config, paper);
    if (j.status === 'done' || j.status === 'failed') return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not settle');
}

const input = { pages: '1-2', mode: 'both' as const, localOnly: false };

describe('pdf-translate', () => {
  it('本地可用时走本地，结果进缓存，可以下载两份 PDF', async () => {
    const config = cfg();
    const first = await startPdfTranslate(config, 'p1', pdfPath, input);
    expect(first.status).toBe('queued');
    const done = await settle(config);
    expect(done).toMatchObject({ status: 'done', target: 'local', fallback: false, progress: 100 });
    expect(done.files.sort()).toEqual(['dual', 'mono']);
    expect(engines).toEqual(['local']);
    expect(await pdfTranslateFile(config, 'p1', 'dual')).toMatch(/dual\.pdf$/u);

    // 同一份 PDF + 同样参数：直接命中缓存（重启后也一样）
    resetPdfTranslateForTest();
    const again = await startPdfTranslate(config, 'p2', pdfPath, input);
    expect(again).toMatchObject({ status: 'done', cached: true, target: 'local' });
    expect(engines).toEqual(['local']);
    const s = await hybridStatus(config);
    expect(s.pdfTranslate).toBe(true);
    expect(s.routes.find((r) => r.task === 'pdf-translate')).toMatchObject({
      route: 'auto',
      local: 1,
    });
  });

  it('本地中途失败：整篇改由云端重做，标记回退', async () => {
    localFails = true;
    const config = cfg();
    await startPdfTranslate(config, 'p1', pdfPath, input);
    const done = await settle(config);
    expect(done).toMatchObject({ status: 'done', target: 'cloud', fallback: true });
    expect(engines).toEqual(['local', 'cloud']);
  });

  it('本地不可用：直接走云端，标记回退', async () => {
    llmUp = false;
    const config = cfg();
    await startPdfTranslate(config, 'p1', pdfPath, input);
    const done = await settle(config);
    expect(done).toMatchObject({ status: 'done', target: 'cloud', fallback: true });
    expect(engines).toEqual(['cloud']);
  });

  it('仅本地 + 本地不可用：明确报错，不发往云端', async () => {
    llmUp = false;
    const config = cfg();
    await startPdfTranslate(config, 'p1', pdfPath, { ...input, localOnly: true });
    const done = await settle(config);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/本地模型现在不可用/u);
    expect(engines).toEqual([]);
  });

  it('仅本地 + 本地中途失败：不回退云端', async () => {
    localFails = true;
    const config = cfg();
    await startPdfTranslate(config, 'p1', pdfPath, { ...input, localOnly: true });
    const done = await settle(config);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/local model crashed/u);
    expect(engines).toEqual(['local']);
  });

  it('没有配置服务：报 not_found，看板标记关闭', async () => {
    const config = cfg({ PDF_TRANSLATE_URL: '' });
    await expect(startPdfTranslate(config, 'p1', pdfPath, input)).rejects.toThrow(/没有配置/u);
    expect((await hybridStatus(config)).pdfTranslate).toBe(false);
    expect((await getPdfTranslate(cfg(), 'never')).status).toBe('idle');
  });
});
