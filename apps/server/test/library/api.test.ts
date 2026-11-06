import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LibraryHit, LibraryQaFrame, Paper, PaperDetail } from '@srh/shared';
import type { LlmClient } from '../../src/agents/llm/client';
import { setLibraryLlmForTest } from '../../src/modules/library/llm';
import { FetchError } from '../../src/modules/library/net';
import { ParserUnavailable, type LayoutParser } from '../../src/modules/library/parser';
import { setLibraryDepsForTest } from '../../src/modules/library/pipeline';
import { waitForQueueIdle } from '../../src/modules/library/queue';
import { parseTei } from '../../src/modules/library/tei';
import { makeApp, openWs, setupProject, signup, type Session, type TestApp } from '../helpers';
import { makeTar, tinyPdf } from './util';

const TEI = readFileSync(join(__dirname, '../fixtures/library/attention.tei.xml'), 'utf8');
const PDF = tinyPdf([[{ x: 72, y: 720, text: 'Attention Is All You Need', size: 14 }]]);
const SRC = gzipSync(
  makeTar({
    'ms.tex': String.raw`\documentclass{article}\begin{document}
\begin{equation}\mathrm{Attention}(Q, K, V) = \mathrm{softmax}(\frac{QK^T}{\sqrt{d_k}})V\end{equation}
\end{document}`,
  }),
);

// ---------------------------------------------------------------- 假的外部依赖

let grobid: 'ok' | 'down' | 'busy-once' = 'ok';
let parseCalls = 0;
let pdfFetches: string[] = [];

const fakeParser: LayoutParser = {
  name: 'grobid',
  url: 'http://grobid.test',
  probe: async () => ({ reachable: grobid !== 'down', version: '0.9.1' }),
  async parse() {
    parseCalls += 1;
    if (grobid === 'down') throw new ParserUnavailable('GROBID 不可达（http://grobid.test）');
    if (grobid === 'busy-once') {
      grobid = 'ok';
      throw new Error('GROBID 忙，稍后重试');
    }
    return parseTei(TEI);
  },
};

const META = {
  title: 'Attention Is All You Need',
  authors: [
    { name: 'Ashish Vaswani', given: 'Ashish', family: 'Vaswani' },
    { name: 'Noam Shazeer', given: 'Noam', family: 'Shazeer' },
  ],
  year: 2017,
  venue: null,
  abstract: 'The dominant sequence transduction models…',
  doi: null,
  arxivId: '1706.03762',
  url: 'https://arxiv.org/abs/1706.03762',
  pdfUrl: 'https://arxiv.org/pdf/1706.03762',
  bib: { entryType: 'misc', primaryClass: 'cs.CL', metaSource: 'arxiv' },
};

// ---------------------------------------------------------------- 假 LLM

let llmCalls: { messages: { role: string; content: string }[]; stream?: boolean }[] = [];
const fakeLlm: LlmClient = {
  model: 'chat',
  reasoningModel: 'reasoner',
  client: {
    chat: {
      completions: {
        async create(body: { messages: { role: string; content: string }[]; stream?: boolean }) {
          llmCalls.push(body);
          if (!body.stream) {
            return { choices: [{ message: { content: 'scaled dot-product attention, softmax' } }] };
          }
          const parts = ['缩放因子是 $1/\\sqrt{d_k}$ ', '[p.4 ¶2]', '。'];
          return (async function* () {
            for (const p of parts) yield { choices: [{ delta: { content: p } }] };
          })();
        },
      },
    },
  } as unknown as LlmClient['client'],
};

let t: TestApp;
let owner: Session;
let member: Session;
let advisor: Session;
let guest: Session;
let pid: string;

beforeAll(async () => {
  t = await makeApp();
  const s = await setupProject(t.app);
  owner = s.owner;
  [member, advisor, guest] = s.others as [Session, Session, Session];
  pid = s.project.id;
  setLibraryDepsForTest(t.app.ctx, {
    parser: () => fakeParser,
    arxivMeta: async (id) =>
      id === '1706.03762'
        ? META
        : id === '9999.99999'
          ? null
          : { ...META, arxivId: id, title: `Paper ${id}`, pdfUrl: `https://arxiv.org/pdf/${id}` },
    resolveDoi: async (doi) =>
      doi === '10.1145/3065386'
        ? {
            ...META,
            title: 'ImageNet classification with deep convolutional neural networks',
            authors: [{ name: 'Alex Krizhevsky', given: 'Alex', family: 'Krizhevsky' }],
            doi,
            arxivId: null,
            pdfUrl: null,
            bib: { entryType: 'article', metaSource: 'crossref' },
          }
        : doi.startsWith('10.9999/')
          ? {
              ...META,
              title: `Paper ${doi}`,
              doi,
              arxivId: null,
              pdfUrl: 'https://paywalled.example/a.pdf',
              bib: { entryType: 'article', metaSource: 'crossref' },
            }
          : null,
    findPdfs: async (doi) =>
      doi === '10.9999/oa-repo'
        ? { urls: ['https://repo.example/big.pdf'], landing: null, isOa: true }
        : doi === '10.9999/blocked'
          ? {
              urls: ['https://paywalled.example/b.pdf'],
              landing: 'https://publisher.example/article',
              isOa: true,
            }
          : { urls: [], landing: null, isOa: doi === '10.1145/3065386' ? false : null },
    fetchPdf: async (url) => {
      pdfFetches.push(url);
      if (url.includes('paywalled')) throw new FetchError('返回 HTTP 403', false, 403);
      // 超过旧的 20 MB 上限
      if (url.includes('big')) return Buffer.concat([PDF, Buffer.alloc(21 * 1024 * 1024, 0x20)]);
      return PDF;
    },
    fetchArxivSource: async () => SRC,
  });
}, 60_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  grobid = 'ok';
  parseCalls = 0;
  pdfFetches = [];
  llmCalls = [];
  setLibraryLlmForTest(t.app.ctx, fakeLlm);
});

async function upload(
  s: Session,
  data: Buffer,
  name = 'paper.pdf',
  url = `/projects/${pid}/library/papers`,
) {
  const boundary = '----srhtest';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="tags"\r\n\r\n精读,基线\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers: { cookie: s.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  return { statusCode: res.statusCode, json: <T>() => res.json<T>(), body: res.body };
}

async function detail(id: string) {
  return (await owner.req('GET', `/projects/${pid}/library/papers/${id}`)).json<PaperDetail>();
}

describe('导入 arXiv：元数据 → PDF → GROBID → LaTeX 源码 → 索引', () => {
  let paper: Paper;

  it('导入后按阶段推送进度，最后 ready', async () => {
    const ws = await openWs(t.app, member.cookie);
    await ws.waitFor((f) => f.op === 'ready');
    ws.ws.send(JSON.stringify({ op: 'subscribe', projectId: pid, afterSeq: 0 }));
    await ws.waitFor((f) => f.op === 'subscribed');
    const res = await member.req('POST', `/projects/${pid}/library/papers`, {
      arxiv: 'arXiv:1706.03762v7',
    });
    expect(res.statusCode).toBe(201);
    paper = res.json<{ paper: Paper; duplicate: boolean }>().paper;
    expect(paper).toMatchObject({ arxivId: '1706.03762', source: 'arxiv', status: 'queued' });
    await waitForQueueIdle(t.app.ctx);
    const d = await detail(paper.id);
    expect(d).toMatchObject({
      status: 'ready',
      progress: 100,
      title: 'Attention Is All You Need',
      citekey: 'vaswani2017attention',
      parser: 'grobid',
      hasLatexSource: true,
      pageCount: 15,
      error: null,
    });
    expect(d.fileId).toBeTruthy();
    expect(pdfFetches).toEqual(['https://arxiv.org/pdf/1706.03762']);
    expect(d.structure!.chunks.length).toBe(d.chunkCount);
    expect(d.structure!.chunks[0]!.id).toBe(`${paper.id}:0`);
    const eq1 = d.structure!.formulas.find((f) => f.label === '(1)')!;
    expect(eq1.latex).toContain('\\frac{QK^T}{\\sqrt{d_k}}');
    // 进度事件
    const frames = await ws.waitFor(
      (f) =>
        f.op === 'event' &&
        f.event.type === 'paper.updated' &&
        (f.event.payload as Paper).status === 'ready',
    );
    expect(frames).toBeTruthy();
    const stages = ws.frames.flatMap((f) =>
      f.op === 'event' && f.event.type === 'paper.updated'
        ? [(f.event.payload as Paper).status]
        : [],
    );
    expect(stages).toEqual(expect.arrayContaining(['fetching', 'parsing', 'indexing', 'ready']));
    ws.ws.terminate();
  });

  it('同一篇（arXiv 编号 / DOI 10.48550 / abs 链接）不重复导入', async () => {
    for (const body of [
      { arxiv: '1706.03762' },
      { doi: '10.48550/arXiv.1706.03762' },
      { url: 'https://arxiv.org/abs/1706.03762v3' },
    ]) {
      const res = await owner.req('POST', `/projects/${pid}/library/papers`, body);
      expect(res.statusCode).toBe(200);
      expect(res.json<{ paper: Paper; duplicate: boolean }>()).toMatchObject({
        duplicate: true,
        paper: { id: paper.id },
      });
    }
    const list = (await owner.req('GET', `/projects/${pid}/library/papers`)).json<Paper[]>();
    expect(list.filter((p) => p.arxivId === '1706.03762')).toHaveLength(1);
  });

  it('PDF 流需要成员身份；BibTeX 单篇', async () => {
    const pdf = await guest.req('GET', `/projects/${pid}/library/papers/${paper.id}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.body.startsWith('%PDF-')).toBe(true);
    const stranger = await signup(t.app, '路人');
    expect(
      (await stranger.req('GET', `/projects/${pid}/library/papers/${paper.id}/pdf`)).statusCode,
    ).toBe(404);
    expect((await stranger.req('GET', `/projects/${pid}/library/papers`)).statusCode).toBe(404);
    const bib = await guest.req('GET', `/projects/${pid}/library/papers/${paper.id}/bibtex`);
    expect(bib.body).toContain('@misc{vaswani2017attention,');
    expect(bib.body).toContain('eprint        = {1706.03762}');
  });

  it('检索：段落带 citekey / 页码 / 段号 / 坐标，中文问题也能找到英文段落（经 LLM 关键词）', async () => {
    const res = await guest.req(
      'GET',
      `/projects/${pid}/library/search?q=scaled%20dot-product%20attention%20softmax`,
    );
    const hits = res.json<LibraryHit[]>();
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ paperId: paper.id, citekey: 'vaswani2017attention' });
    expect(hits[0]!.boxes.length).toBeGreaterThan(0);
    expect(hits.some((h) => /Scaled Dot-Product/u.test(h.sectionPath))).toBe(true);
  });

  it('问答会消耗模型额度：访客 403，且不调用模型', async () => {
    const res = await guest.req('POST', `/projects/${pid}/library/qa`, {
      question: '为什么要除以 根号 d_k？',
      paperId: paper.id,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('forbidden');
    expect(llmCalls).toHaveLength(0);
  });

  it('问答：NDJSON 流，先给来源再流式输出，带 [p.N ¶M] 引用', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${pid}/library/qa`,
      headers: { cookie: member.cookie },
      payload: { question: '为什么要除以 根号 d_k？', paperId: paper.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const frames = res.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as LibraryQaFrame);
    const src = frames[0] as Extract<LibraryQaFrame, { type: 'sources' }>;
    expect(src.type).toBe('sources');
    expect(src.keywords).toEqual(['scaled dot-product attention', 'softmax']);
    expect(src.sources.length).toBeGreaterThan(0);
    expect(src.sources.every((s) => s.paperId === paper.id)).toBe(true);
    const text = frames
      .filter((f): f is Extract<LibraryQaFrame, { type: 'delta' }> => f.type === 'delta')
      .map((f) => f.text)
      .join('');
    expect(text).toContain('[p.4 ¶2]');
    expect(frames.at(-1)).toEqual({ type: 'done' });
    // 第一次调用 = 英文关键词；第二次 = 带段落的流式回答，段落标记写好了页码段号
    const prompt = llmCalls[1]!.messages[1]!.content;
    expect(prompt).toMatch(/\[S1\] \[p\.\d+ ¶\d+\]/u);
    expect(llmCalls[1]!.messages[0]!.content).toContain('[p.5 ¶3]');
  });

  it('没配 LLM 时问答返回 503 中文错误', async () => {
    setLibraryLlmForTest(t.app.ctx, null);
    const res = await owner.req('POST', `/projects/${pid}/library/qa`, { question: 'attention?' });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('llm_unavailable');
  });

  it('插入引用：写进 LaTeX 工程的 references.bib，已有键不重复', async () => {
    const doc = await member.req('POST', `/projects/${pid}/docs`, {
      kind: 'latex',
      title: '论文初稿',
      markdown: '\\documentclass{article}\\begin{document}Hi\\end{document}',
    });
    expect(doc.statusCode).toBe(201);
    const docId = doc.json<{ id: string }>().id;
    for (const expectAdded of [1, 0]) {
      const res = await member.req('POST', `/projects/${pid}/library/cite`, {
        docId,
        paperIds: [paper.id],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        bibFile: 'references.bib',
        keys: ['vaswani2017attention'],
        added: expectAdded,
        cite: '\\cite{vaswani2017attention}',
      });
    }
    const md = await member.req('GET', `/projects/${pid}/docs/${docId}/markdown`);
    expect(md.body).toContain('references.bib');
    expect(md.body).toContain('vaswani2017attention');
    // 访客不能写
    const g = await guest.req('POST', `/projects/${pid}/library/cite`, {
      docId,
      paperIds: [paper.id],
    });
    expect(g.statusCode).toBe(403);
  });
});

describe('其他导入路径', () => {
  it('DOI 没有开放获取 PDF → needs_pdf；补传 PDF 后解析', async () => {
    const res = await member.req('POST', `/projects/${pid}/library/papers`, {
      doi: 'https://doi.org/10.1145/3065386',
    });
    expect(res.statusCode).toBe(201);
    const p = res.json<{ paper: Paper }>().paper;
    expect(p.doi).toBe('10.1145/3065386');
    await waitForQueueIdle(t.app.ctx);
    let d = await detail(p.id);
    expect(d).toMatchObject({ status: 'needs_pdf', citekey: 'krizhevsky2017imagenet' });
    expect(d.error).toContain('上传 PDF');
    expect(d.error).toContain('开放获取');
    const up = await upload(
      member,
      tinyPdf([[{ x: 72, y: 700, text: 'ImageNet', size: 12 }]]),
      'alexnet.pdf',
      `/projects/${pid}/library/papers/${p.id}/pdf`,
    );
    expect(up.statusCode).toBe(200);
    await waitForQueueIdle(t.app.ctx);
    d = await detail(p.id);
    expect(d.status).toBe('ready');
    // 元数据来自 Crossref，不被 GROBID 头部覆盖
    expect(d.title).toBe('ImageNet classification with deep convolutional neural networks');
    expect(d.citekey).toBe('krizhevsky2017imagenet');
  });

  it('出版商链接被拦 → 换开放获取仓库下载；超过 20 MB 的 PDF 也能导入', async () => {
    const res = await member.req('POST', `/projects/${pid}/library/papers`, {
      doi: '10.9999/oa-repo',
    });
    const p = res.json<{ paper: Paper }>().paper;
    await waitForQueueIdle(t.app.ctx);
    const d = await detail(p.id);
    expect(pdfFetches).toEqual(['https://paywalled.example/a.pdf', 'https://repo.example/big.pdf']);
    expect(d.status).toBe('ready');
  });

  it('所有来源都拿不到 → needs_pdf，说明原因并给出原文链接', async () => {
    const res = await member.req('POST', `/projects/${pid}/library/papers`, {
      doi: '10.9999/blocked',
    });
    const p = res.json<{ paper: Paper }>().paper;
    await waitForQueueIdle(t.app.ctx);
    const d = await detail(p.id);
    expect(d.status).toBe('needs_pdf');
    expect(d.error).toContain('HTTP 403');
    expect(d.error).toContain('https://publisher.example/article');
  });

  it('手动上传超过 20 MB 的 PDF', async () => {
    const big = Buffer.concat([
      tinyPdf([[{ x: 72, y: 700, text: 'Big upload', size: 12 }]]),
      Buffer.alloc(21 * 1024 * 1024, 0x20),
    ]);
    const res = await upload(member, big, 'big.pdf');
    expect(res.statusCode).toBe(201);
    await waitForQueueIdle(t.app.ctx);
    expect((await detail(res.json<{ paper: Paper }>().paper.id)).status).toBe('ready');
  });

  it('上传 PDF：同一个文件只导入一次；不是 PDF 拒绝', async () => {
    const pdf = tinyPdf([[{ x: 72, y: 700, text: 'Unique upload', size: 12 }]]);
    const a = await upload(member, pdf, '我的论文.pdf');
    expect(a.statusCode).toBe(201);
    const pa = a.json<{ paper: Paper }>().paper;
    expect(pa.tags).toEqual(['精读', '基线']);
    const b = await upload(owner, pdf, 'copy.pdf');
    expect(b.statusCode).toBe(200);
    expect(b.json<{ duplicate: boolean; paper: Paper }>()).toMatchObject({
      duplicate: true,
      paper: { id: pa.id },
    });
    const bad = await upload(member, Buffer.from('hello'), 'x.pdf');
    expect(bad.statusCode).toBe(422);
    await waitForQueueIdle(t.app.ctx);
    // GROBID 解析出的头部是 Attention：arXiv 编号已被前一篇占用，不写进这篇（唯一约束）
    const d = await detail(pa.id);
    expect(d.status).toBe('ready');
    expect(d.arxivId).toBeNull();
  });

  it('GROBID 不可达 → 降级为逐页纯文本，并说明原因', async () => {
    grobid = 'down';
    const res = await member.req('POST', `/projects/${pid}/library/papers`, {
      arxiv: '2101.00001',
    });
    const p = res.json<{ paper: Paper }>().paper;
    await waitForQueueIdle(t.app.ctx);
    const d = await detail(p.id);
    expect(d).toMatchObject({ status: 'ready', parser: 'pdf-text', hasLatexSource: false });
    expect(d.error).toContain('降级为逐页纯文本');
    expect(d.structure!.chunks[0]!.text).toBe('Attention Is All You Need');
    const st = (await guest.req('GET', `/projects/${pid}/library/status`)).json();
    expect(st).toMatchObject({ parser: 'grobid', reachable: false });
  });

  it('GROBID 忙（暂时性错误）→ 自动重试后成功', async () => {
    grobid = 'busy-once';
    const res = await member.req('POST', `/projects/${pid}/library/papers`, {
      arxiv: '2101.00002',
    });
    const p = res.json<{ paper: Paper }>().paper;
    await waitForQueueIdle(t.app.ctx);
    const d = await detail(p.id);
    expect(parseCalls).toBe(2);
    expect(d).toMatchObject({ status: 'ready', parser: 'grobid' });
  });

  it('arXiv 编号不存在 → failed；格式不对 → 422', async () => {
    const res = await member.req('POST', `/projects/${pid}/library/papers`, {
      arxiv: '9999.99999',
    });
    const p = res.json<{ paper: Paper }>().paper;
    await waitForQueueIdle(t.app.ctx);
    expect((await detail(p.id)).status).toBe('failed');
    expect(
      (await member.req('POST', `/projects/${pid}/library/papers`, { arxiv: 'abc' })).statusCode,
    ).toBe(422);
    expect(
      (
        await member.req('POST', `/projects/${pid}/library/papers`, {
          arxiv: '1706.03762',
          doi: '10.1/x',
        })
      ).statusCode,
    ).toBe(422);
  });

  it('同一作者同年同词：引用键自动加后缀', async () => {
    const res = await member.req('POST', `/projects/${pid}/library/papers`, {
      arxiv: '2101.00003',
    });
    const p = res.json<{ paper: Paper }>().paper;
    await waitForQueueIdle(t.app.ctx);
    const keys = (await owner.req('GET', `/projects/${pid}/library/papers`))
      .json<Paper[]>()
      .map((x) => x.citekey);
    expect(new Set(keys).size).toBe(keys.length);
    expect((await detail(p.id)).citekey).toMatch(/^vaswani2017paper[b-z]?$/u);
  });
});

describe('权限、标签、归档、删除、全部导出', () => {
  it('所有项目成员可编辑文献信息；访客仍不能导入删除；归档后不在列表和检索里', async () => {
    const list = (await owner.req('GET', `/projects/${pid}/library/papers`)).json<Paper[]>();
    const p = list.find((x) => x.citekey === 'vaswani2017attention')!;
    expect(
      (await guest.req('POST', `/projects/${pid}/library/papers`, { arxiv: '2101.00009' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await guest.req('PATCH', `/projects/${pid}/library/papers/${p.id}`, { note: 'x' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await guest.req('PATCH', `/projects/${pid}/library/papers/${p.id}`, { archived: true }))
        .statusCode,
    ).toBe(403);
    expect((await guest.req('DELETE', `/projects/${pid}/library/papers/${p.id}`)).statusCode).toBe(
      403,
    );

    const patched = await advisor.req('PATCH', `/projects/${pid}/library/papers/${p.id}`, {
      tags: ['Transformer', 'Transformer', '必读'],
      note: '第 3.2 节是重点',
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<Paper>()).toMatchObject({
      tags: ['Transformer', '必读'],
      note: '第 3.2 节是重点',
    });
    const byTag = (await guest.req('GET', `/projects/${pid}/library/papers?tag=必读`)).json<
      Paper[]
    >();
    expect(byTag.map((x) => x.id)).toEqual([p.id]);
    const byQ = (await guest.req('GET', `/projects/${pid}/library/papers?q=vaswani`)).json<
      Paper[]
    >();
    expect(byQ.some((x) => x.id === p.id)).toBe(true);

    await member.req('PATCH', `/projects/${pid}/library/papers/${p.id}`, { archived: true });
    const after = (await guest.req('GET', `/projects/${pid}/library/papers`)).json<Paper[]>();
    expect(after.some((x) => x.id === p.id)).toBe(false);
    const hits = (
      await guest.req('GET', `/projects/${pid}/library/search?q=attention&paperId=${p.id}`)
    ).json<LibraryHit[]>();
    expect(hits).toEqual([]);
    // 再次导入同一篇 = 恢复归档
    const again = await member.req('POST', `/projects/${pid}/library/papers`, {
      arxiv: '1706.03762',
    });
    expect(again.json<{ paper: Paper; duplicate: boolean }>()).toMatchObject({
      duplicate: true,
      paper: { id: p.id, archivedAt: null },
    });
  });

  it('笔记乐观并发：带 baseNoteVersion 过期 → 409 带最新笔记与版本；不带照旧覆盖', async () => {
    const list = (await owner.req('GET', `/projects/${pid}/library/papers`)).json<Paper[]>();
    const p = list.find((x) => x.citekey === 'vaswani2017attention')!;
    const v0 = p.noteVersion!;
    expect(typeof v0).toBe('number');

    // 成员 A 基于 v0 保存成功，版本 +1
    const a = await member.req('PATCH', `/projects/${pid}/library/papers/${p.id}`, {
      note: 'A 的笔记',
      baseNoteVersion: v0,
    });
    expect(a.statusCode).toBe(200);
    expect(a.json<Paper>()).toMatchObject({ note: 'A 的笔记', noteVersion: v0 + 1 });

    // 成员 B 也基于 v0 保存：过期 → 409，不覆盖，details 带最新笔记与版本
    const b = await advisor.req('PATCH', `/projects/${pid}/library/papers/${p.id}`, {
      note: 'B 的笔记',
      tags: ['不该生效'],
      baseNoteVersion: v0,
    });
    expect(b.statusCode).toBe(409);
    expect(b.json()).toMatchObject({
      error: {
        code: 'version_conflict',
        details: {
          note: 'A 的笔记',
          noteVersion: v0 + 1,
          current: { id: p.id, note: 'A 的笔记', noteVersion: v0 + 1 },
        },
      },
    });
    let d = await detail(p.id);
    expect(d.note).toBe('A 的笔记');
    expect(d.tags).not.toContain('不该生效');

    // 只改标签时 baseNoteVersion 不约束；不改笔记版本不变
    const t1 = await advisor.req('PATCH', `/projects/${pid}/library/papers/${p.id}`, {
      tags: ['Transformer', '必读'],
      baseNoteVersion: v0,
    });
    expect(t1.statusCode).toBe(200);
    expect(t1.json<Paper>().noteVersion).toBe(v0 + 1);

    // 不带 baseNoteVersion = 旧行为，直接覆盖，版本照样 +1
    const c = await advisor.req('PATCH', `/projects/${pid}/library/papers/${p.id}`, {
      note: 'B 合并后的笔记',
    });
    expect(c.statusCode).toBe(200);
    expect(c.json<Paper>()).toMatchObject({ note: 'B 合并后的笔记', noteVersion: v0 + 2 });

    // 并发两次同版本保存：只有一次成功
    const [r1, r2] = await Promise.all(
      ['并发一', '并发二'].map((note) =>
        member.req('PATCH', `/projects/${pid}/library/papers/${p.id}`, {
          note,
          baseNoteVersion: v0 + 2,
        }),
      ),
    );
    expect([r1!.statusCode, r2!.statusCode].sort()).toEqual([200, 409]);
    d = await detail(p.id);
    expect(d.noteVersion).toBe(v0 + 3);
  });

  it('全部 / 选中导出 BibTeX；删除后 PDF 一起删', async () => {
    const all = await guest.req('POST', `/projects/${pid}/library/bibtex`, {});
    expect(all.body.match(/^@/gmu)!.length).toBeGreaterThanOrEqual(4);
    const list = (await owner.req('GET', `/projects/${pid}/library/papers`)).json<Paper[]>();
    const p = list.find((x) => x.citekey === 'krizhevsky2017imagenet')!;
    const one = await guest.req('POST', `/projects/${pid}/library/bibtex`, { paperIds: [p.id] });
    expect(one.body).toContain('@article{krizhevsky2017imagenet,');
    expect(one.body.match(/^@/gmu)).toHaveLength(1);

    expect((await member.req('DELETE', `/projects/${pid}/library/papers/${p.id}`)).statusCode).toBe(
      204,
    );
    expect((await owner.req('GET', `/projects/${pid}/library/papers/${p.id}`)).statusCode).toBe(
      404,
    );
    expect((await owner.req('GET', `/projects/${pid}/files/${p.fileId}`)).statusCode).toBe(404);
  });
});
