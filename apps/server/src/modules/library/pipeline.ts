import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { PaperChunk, PaperStructure } from '@srh/shared';
import type { AppContext } from '../../context';
import { paperChunks, papers } from '../../db/schema';
import { scopeOf, scopeWhere, type LibraryScopeInput } from './scope';
import { matchFormulas, parseLatexSource } from './latex-source';
import { PAPER_PDF_MAX_BYTES } from '@srh/shared';
import {
  arxivMeta,
  findPdfCandidates,
  resolveDoi,
  type PaperMeta,
  type PdfCandidates,
} from './metadata';
import { FetchError, fetchBytes, isPdf } from './net';
import { createParser, ParserUnavailable, type LayoutParser } from './parser';
import { pdfToText, textStructure } from './pdftext';
import { invalidateIndex } from './search';
import {
  citekeyFor,
  patchPaper,
  readPaperPdf,
  sha256,
  storePaperPdf,
  type PaperRow,
} from './service';
import type { TeiHeader } from './tei';

/**
 * 一篇论文的解析流水线（queue.ts 逐篇调用，并发 1）：
 *
 *   fetching   拉元数据（arXiv / Crossref / OpenAlex / S2）→ 定引用键 → 下载开放获取 PDF
 *              （没有 → needs_pdf，等成员上传）
 *   parsing    GROBID 版面解析（TEI + 坐标）；不可达 → 逐页纯文本降级
 *              arXiv 论文再下 LaTeX 源码，把公式换成真正的 LaTeX
 *   indexing   段落写入 paper_chunks，作废检索缓存
 *   ready
 *
 * 外部依赖都经 LibraryDeps，测试里换成假的（不连网、不需要 GROBID）。
 */
export interface LibraryDeps {
  parser: (ctx: AppContext) => LayoutParser;
  arxivMeta: (id: string, mailto: string) => Promise<PaperMeta | null>;
  resolveDoi: (doi: string, mailto: string) => Promise<PaperMeta | null>;
  fetchPdf: (url: string, mailto: string, guard: boolean) => Promise<Buffer>;
  /** arXiv LaTeX 源码（tar.gz / gz）；没有返回 null */
  fetchArxivSource: (id: string, mailto: string) => Promise<Buffer | null>;
  /** DOI 的全部开放获取 PDF 候选（OpenAlex / Unpaywall / S2 / 仓储） */
  findPdfs: (doi: string, mailto: string) => Promise<PdfCandidates>;
}

/** 文献库单个 PDF 上限（下载与上传共用；教材、学位论文、扫描版常超过 20 MB） */
export const MAX_PDF_BYTES = PAPER_PDF_MAX_BYTES;

/** 有的仓储（HAL、出版社 OA 页）只给浏览器样式的请求返回 PDF */
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 SRH-Library/0.1';

export const defaultDeps: LibraryDeps = {
  parser: (ctx) => createParser(ctx.config),
  arxivMeta,
  resolveDoi,
  findPdfs: findPdfCandidates,
  async fetchPdf(url, mailto, guard) {
    const { bytes, contentType } = await fetchBytes(url, {
      mailto,
      guard,
      timeoutMs: 120_000,
      maxBytes: MAX_PDF_BYTES,
      accept: 'application/pdf,*/*;q=0.5',
      userAgent: BROWSER_UA,
    });
    if (!isPdf(bytes)) {
      throw new FetchError(
        `链接返回的不是 PDF（${contentType || '未知类型'}），可能需要登录或是出版社的网页`,
        false,
      );
    }
    return bytes;
  },
  async fetchArxivSource(id, mailto) {
    try {
      const { bytes } = await fetchBytes(`https://arxiv.org/e-print/${id}`, {
        mailto,
        timeoutMs: 60_000,
        maxBytes: 40 * 1024 * 1024,
      });
      return bytes;
    } catch {
      return null;
    }
  },
};

const depsByCtx = new WeakMap<AppContext, LibraryDeps>();

export function libraryDeps(ctx: AppContext): LibraryDeps {
  return depsByCtx.get(ctx) ?? defaultDeps;
}

/** 测试注入 */
export function setLibraryDepsForTest(ctx: AppContext, deps: Partial<LibraryDeps>): void {
  depsByCtx.set(ctx, { ...defaultDeps, ...deps });
}

/** 结果：done = 结束（ready / needs_pdf）；retry = 暂时性错误，稍后重试 */
export type StepResult = { kind: 'done' } | { kind: 'retry'; reason: string };

export class TransientError extends Error {}

function isTransient(err: unknown): boolean {
  return (
    err instanceof TransientError ||
    (err instanceof FetchError && err.transient) ||
    /GROBID 忙|超时/u.test((err as Error)?.message ?? '')
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 拿不到 PDF 时给成员看的原因与替代办法 */
export function explainNoPdf(tried: number, failures: string[], found: PdfCandidates): string {
  const upload = '可以在本地下载 PDF 后点「上传 PDF」，上传后会自动解析。';
  if (tried === 0) {
    if (found.isOa === false) {
      return `这篇论文不是开放获取，需要订阅才能下载全文，元数据已保存。${upload}通过学校图书馆或 VPN 登录出版社网站即可下载。`;
    }
    return `没有找到开放获取的 PDF，元数据已保存。${upload}`;
  }
  const detail = failures.slice(0, 3).join('；');
  if (found.landing) {
    return `这篇论文有开放获取版本，但出版社网站拦截了服务器下载（${detail}）。请在浏览器打开 ${found.landing} 下载 PDF，再上传。`;
  }
  if (found.isOa === false) {
    return `这篇论文需要订阅才能下载全文（${detail}）。${upload}`;
  }
  return `PDF 下载失败（${detail}）。${upload}`;
}

async function applyMeta(ctx: AppContext, row: PaperRow, meta: PaperMeta): Promise<PaperRow> {
  // DOI / arXiv 编号和项目里别的论文撞了：不写进这篇（唯一索引），保留原值
  const conflict = async (col: 'doi' | 'arxivId', v: string | null) => {
    if (!v || row[col] === v) return false;
    const [hit] = await ctx.db.db
      .select({ id: papers.id })
      .from(papers)
      .where(
        and(
          scopeWhere(papers, scopeOf(row)),
          row.ownerUserId ? eq(papers.ownerUserId, row.ownerUserId) : isNull(papers.ownerUserId),
          eq(col === 'doi' ? papers.doi : papers.arxivId, v),
          ne(papers.id, row.id),
        ),
      );
    return Boolean(hit);
  };
  const doi = meta.doi && !(await conflict('doi', meta.doi)) ? meta.doi : row.doi;
  const arxivId =
    meta.arxivId && !(await conflict('arxivId', meta.arxivId)) ? meta.arxivId : row.arxivId;
  const title = meta.title ?? row.title;
  const authors = meta.authors.length ? meta.authors : row.authors;
  const year = meta.year ?? row.year;
  const hasReal = Boolean(meta.title && meta.authors.length);
  const citekey = hasReal ? await citekeyFor(ctx, row, { authors, year, title }) : row.citekey;
  return patchPaper(ctx, row, {
    title,
    authors,
    year,
    venue: meta.venue ?? row.venue,
    abstract: meta.abstract ?? row.abstract,
    doi,
    arxivId,
    url: row.url ?? meta.url,
    pdfUrl: row.pdfUrl ?? meta.pdfUrl,
    citekey,
    meta: { ...row.meta, ...meta.bib, ...(hasReal ? { citekeyFixed: true } : {}) },
  });
}

function headerToMeta(h: TeiHeader): PaperMeta {
  return {
    title: h.title,
    authors: h.authors,
    year: h.year,
    venue: null,
    abstract: h.abstract,
    doi: h.doi,
    arxivId: h.arxivId,
    url: null,
    pdfUrl: null,
    bib: { metaSource: 'grobid' },
  };
}

const readPdf = readPaperPdf;

export async function processPaper(
  ctx: AppContext,
  projectId: LibraryScopeInput,
  paperId: string,
): Promise<StepResult> {
  const deps = libraryDeps(ctx);
  const mailto = ctx.config.CROSSREF_MAILTO || ctx.config.RESEARCH_CONTACT_EMAIL;
  let [row] = await ctx.db.db
    .select()
    .from(papers)
    .where(and(eq(papers.id, paperId), scopeWhere(papers, projectId)));
  if (!row || row.archivedAt) return { kind: 'done' };
  row = await patchPaper(ctx, row, {
    attempts: row.attempts + 1,
    status: 'fetching',
    progress: 8,
    stage: '正在获取论文信息',
    error: null,
  });

  try {
    // ------------------------------------------------ 元数据
    if (!row.meta.metaSource || row.meta.metaSource === 'grobid') {
      let meta: PaperMeta | null = null;
      if (row.arxivId) {
        meta = await deps.arxivMeta(row.arxivId, mailto);
        if (!meta && row.source === 'arxiv') {
          await patchPaper(ctx, row, {
            status: 'failed',
            progress: 0,
            stage: null,
            error: `arXiv 上找不到 ${row.arxivId}，请检查编号`,
          });
          return { kind: 'done' };
        }
      } else if (row.doi) {
        meta = await deps.resolveDoi(row.doi, mailto);
        if (!meta && row.source === 'doi') {
          await patchPaper(ctx, row, {
            status: 'failed',
            progress: 0,
            stage: null,
            error: `Crossref / OpenAlex 都查不到 DOI ${row.doi}，请检查 DOI`,
          });
          return { kind: 'done' };
        }
      }
      if (meta) row = await applyMeta(ctx, row, meta);
    }

    // ------------------------------------------------ PDF
    let pdf = await readPdf(ctx, row);
    if (!pdf) {
      row = await patchPaper(ctx, row, { progress: 15, stage: '正在查找可下载的 PDF' });
      const urls: string[] = [];
      const add = (u: string | null | undefined): void => {
        if (u && !urls.includes(u)) urls.push(u);
      };
      add(row.pdfUrl);
      if (row.arxivId) add(`https://arxiv.org/pdf/${row.arxivId}`);
      let found: PdfCandidates = { urls: [], landing: null, isOa: null };
      if (row.doi) {
        try {
          found = await deps.findPdfs(row.doi, mailto);
        } catch {
          // 候选查询只是补充，失败不影响已有链接
        }
        for (const u of found.urls) add(u);
      }
      const failures: string[] = [];
      let lastTransient: unknown = null;
      for (const [i, url] of urls.entries()) {
        row = await patchPaper(ctx, row, {
          progress: 15,
          stage: urls.length > 1 ? `正在下载 PDF（来源 ${i + 1}/${urls.length}）` : '正在下载 PDF',
        });
        try {
          // 只有用户直接粘贴的链接需要内网防护；元数据服务给出的链接同样走防护更稳妥
          pdf = await deps.fetchPdf(url, mailto, row.source === 'url' || i > 0);
          break;
        } catch (err) {
          if (isTransient(err)) lastTransient = err;
          failures.push(`${hostOf(url)}：${(err as Error).message}`);
        }
      }
      if (!pdf) {
        // 所有来源都是临时故障：交给重试；否则给出原因与替代办法
        if (lastTransient && failures.length === urls.length) throw lastTransient;
        await patchPaper(ctx, row, {
          status: 'needs_pdf',
          progress: 0,
          stage: null,
          error: explainNoPdf(urls.length, failures, found),
        });
        return { kind: 'done' };
      }
      // 个人文献的 PDF 存私有目录，团队文献库存共享文件夹
      const stored = await storePaperPdf(ctx, row.createdBy, row, `${row.citekey}.pdf`, pdf);
      row = await patchPaper(ctx, row, { ...stored, pdfSha256: sha256(pdf) });
    }

    // ------------------------------------------------ 版面解析
    const parser = deps.parser(ctx);
    row = await patchPaper(ctx, row, {
      status: 'parsing',
      progress: 30,
      stage: parser.name === 'grobid' ? '正在用 GROBID 解析版面' : '正在用 MinerU 解析版面',
    });
    let structure: PaperStructure;
    let header: TeiHeader | null = null;
    let parserName: PaperRow['parser'] = parser.name;
    let degradeNote: string | null = null;
    try {
      const tei = await parser.parse(pdf);
      structure = tei.structure;
      header = tei.header;
      if (structure.chunks.length === 0) throw new Error('GROBID 没有识别出正文');
    } catch (err) {
      const lastTry = row.attempts >= MAX_ATTEMPTS;
      if (!(err instanceof ParserUnavailable) && isTransient(err) && !lastTry) throw err;
      degradeNote =
        err instanceof ParserUnavailable
          ? `${(err as Error).message}，已降级为逐页纯文本（没有章节、公式、图表结构）。解析服务恢复后可点“重新解析”。`
          : `版面解析失败（${(err as Error).message}），已降级为逐页纯文本。`;
      row = await patchPaper(ctx, row, { progress: 40, stage: '正在逐页提取文字' });
      structure = textStructure(await pdfToText(pdf));
      parserName = 'pdf-text';
      if (structure.chunks.length === 0) {
        await patchPaper(ctx, row, {
          status: 'failed',
          progress: 0,
          stage: null,
          parser: parserName,
          error: '这个 PDF 里没有可提取的文字（可能是扫描件），暂时无法解析',
        });
        return { kind: 'done' };
      }
    }

    // 上传的论文：用 GROBID 读到的标题、作者、DOI / arXiv 补元数据
    if (header && (!row.meta.metaSource || row.meta.metaSource === 'grobid')) {
      let meta = headerToMeta(header);
      const arxivId = header.arxivId ?? row.arxivId;
      if (arxivId) meta = (await deps.arxivMeta(arxivId, mailto).catch(() => null)) ?? meta;
      else if (header.doi)
        meta = (await deps.resolveDoi(header.doi, mailto).catch(() => null)) ?? meta;
      row = await applyMeta(ctx, row, { ...meta, pdfUrl: null });
    }

    // ------------------------------------------------ arXiv LaTeX 源码 → 公式
    let hasLatex = false;
    const arxivForSource = row.arxivId;
    if (arxivForSource && structure.formulas.length > 0) {
      row = await patchPaper(ctx, row, { progress: 60, stage: '正在读取 arXiv LaTeX 源码' });
      const src = await deps.fetchArxivSource(arxivForSource, mailto);
      const parsed = src ? safe(() => parseLatexSource(src)) : null;
      if (parsed) {
        matchFormulas(structure.formulas, parsed);
        structure.macros = parsed.macros;
        hasLatex = true;
      }
    }

    // ------------------------------------------------ 索引
    row = await patchPaper(ctx, row, {
      status: 'indexing',
      progress: 85,
      stage: '正在建立段落索引',
    });
    await writeChunks(ctx, row, structure.chunks);
    const { chunks, ...rest } = structure;
    // 纯文本降级时元数据还是空的：用 PDF 第一段兜底标题
    const title =
      row.title.startsWith('paper') || row.title === ''
        ? (chunks[0]?.text.slice(0, 200) ?? row.title)
        : row.title;
    await patchPaper(ctx, row, {
      title,
      status: 'ready',
      progress: 100,
      stage: null,
      error: degradeNote,
      parser: parserName,
      structure: rest,
      pageCount: structure.pages.length || null,
      chunkCount: chunks.length,
      hasLatexSource: hasLatex ? 1 : 0,
      meta: { ...row.meta, citekeyFixed: true },
    });
    invalidateIndex(ctx, projectId);
    return { kind: 'done' };
  } catch (err) {
    if (isTransient(err) && row.attempts < MAX_ATTEMPTS) {
      await patchPaper(ctx, row, {
        status: 'queued',
        stage: `网络或解析服务暂时出错，稍后重试（第 ${row.attempts} 次）`,
        error: (err as Error).message,
      });
      return { kind: 'retry', reason: (err as Error).message };
    }
    await patchPaper(ctx, row, {
      status: 'failed',
      progress: 0,
      stage: null,
      error: `解析失败：${(err as Error).message}`,
    });
    return { kind: 'done' };
  }
}

export const MAX_ATTEMPTS = 3;

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

async function writeChunks(ctx: AppContext, row: PaperRow, chunks: PaperChunk[]) {
  await ctx.db.db.transaction(async (tx) => {
    await tx.delete(paperChunks).where(eq(paperChunks.paperId, row.id));
    for (let i = 0; i < chunks.length; i += 200) {
      await tx.insert(paperChunks).values(
        chunks.slice(i, i + 200).map((c) => ({
          id: `${row.id}:${c.seq}`,
          paperId: row.id,
          projectId: row.projectId,
          seq: c.seq,
          kind: c.kind,
          sectionIndex: c.sectionIndex,
          sectionPath: c.sectionPath.slice(0, 500),
          page: c.page,
          para: c.para,
          boxes: c.boxes,
          text: c.text,
        })),
      );
    }
  });
}

/** 启动时：上次进程退出时还没解析完的论文 */
export async function pendingPapers(ctx: AppContext) {
  return ctx.db.db
    .select({ id: papers.id, projectId: papers.projectId, ownerUserId: papers.ownerUserId })
    .from(papers)
    .where(inArray(papers.status, ['queued', 'fetching', 'parsing', 'indexing']));
}
