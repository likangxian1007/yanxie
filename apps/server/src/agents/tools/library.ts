import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { paperChunks, papers } from '../../db/schema';
import { enqueuePaper } from '../../modules/library/queue';
import { englishKeywords } from '../../modules/library/qa';
import { searchLibrary } from '../../modules/library/search';
import {
  bibOf,
  findPaper,
  importByRef,
  listByIds,
  visiblePaperIds,
} from '../../modules/library/service';
import { agentViewer } from './viewer';
import { ToolError, WORKER_ROLES, ALL_ROLES, defineTool } from './types';

/**
 * 文献库工具（归属：文献库线程）。结果里统一带 citekey、页码、段号，并提醒模型按
 * (citekey, p.N ¶M) 引用——前端会把 [citekey, p.N ¶M] 渲染成能跳到 PDF 原文的引用。
 *
 * web_search 找到论文后：library_import(arxiv/doi) 等解析完成 → library_search / library_read 精读。
 */
const CITE_HINT =
  '引用时写 [citekey, p.页 ¶段]（如 [vaswani2017attention, p.4 ¶2]），只引用这里真实出现的页码段号。';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

const librarySearch = defineTool({
  name: 'library_search',
  description:
    '在项目文献库（已导入并解析的论文全文）里检索段落，返回论文标题、citekey、页码、段号和原文片段。' +
    '论文是英文时请用英文关键词检索（中文问题会自动补英文关键词）。回答论文相关的问题前先用它找证据。',
  roles: ALL_ROLES,
  schema: z.object({
    query: z.string().min(1).max(500).describe('检索词或问题'),
    paper: z.string().optional().describe('只在这篇里找：论文 id 或 citekey'),
    limit: z.number().int().min(1).max(20).optional().describe('返回段落数，默认 8'),
  }),
  async run(tc, args) {
    const viewer = await agentViewer(tc);
    let paperId: string | undefined;
    if (args.paper) {
      const row = await findPaper(tc.ctx, tc.project.id, args.paper, viewer);
      if (!row) throw new ToolError(`文献库里没有 ${args.paper}`);
      paperId = row.id;
    }
    // 只在 agent 能看到的论文里找：协调者 / 团队线程 = 团队文献库，个人工作区 = 加上主人的个人文献
    const visible = await visiblePaperIds(tc.ctx, tc.project.id, viewer);
    const kw = await englishKeywords(tc.ctx, tc.project.id, args.query);
    const hits = await searchLibrary(
      tc.ctx,
      tc.project.id,
      [args.query, ...(kw.length ? [kw.join(' ')] : [])],
      { paperId, paperIds: [...visible], limit: args.limit ?? 8 },
    );
    await tc.setActivity(`在文献库里检索：${clip(args.query, 30)}`);
    if (hits.length === 0) {
      const [any] = await tc.ctx.db.db
        .select({ id: papers.id })
        .from(papers)
        .where(eq(papers.projectId, tc.project.id))
        .limit(1);
      return {
        results: [],
        note: any
          ? '没有匹配的段落，换个说法（英文术语）再试，或用 library_import 导入相关论文'
          : '文献库还是空的，先用 library_import 导入论文（arXiv 编号 / DOI）',
      };
    }
    return {
      keywords: kw,
      results: hits.map((h) => ({
        paper_id: h.paperId,
        citekey: h.citekey,
        title: h.paperTitle,
        section: h.sectionPath,
        page: h.page,
        paragraph: h.para,
        cite: `[${h.citekey}, p.${h.page} ¶${h.para}]`,
        text: clip(h.text, 900),
      })),
      how_to_cite: CITE_HINT,
    };
  },
});

const libraryRead = defineTool({
  name: 'library_read',
  description:
    '精读文献库里的一篇论文：按小节（section 写编号或标题，如 "3.2" 或 "Attention"）或页码范围读原文，' +
    '每段带页码和段号。不给 section / 页码时返回元数据、摘要和目录。',
  roles: ALL_ROLES,
  schema: z.object({
    paper: z.string().min(1).describe('论文 id 或 citekey'),
    section: z.string().max(200).optional().describe('小节编号或标题'),
    page_from: z.number().int().min(1).optional(),
    page_to: z.number().int().min(1).optional(),
  }),
  async run(tc, args) {
    const row = await findPaper(tc.ctx, tc.project.id, args.paper, await agentViewer(tc));
    if (!row) throw new ToolError(`文献库里没有 ${args.paper}`);
    const base = {
      paper_id: row.id,
      citekey: row.citekey,
      title: row.title,
      authors: row.authors.map((a) => a.name).slice(0, 12),
      year: row.year,
      status: row.status,
    };
    if (row.status !== 'ready' || !row.structure) {
      return {
        ...base,
        note:
          row.status === 'needs_pdf'
            ? '没有可下载的 PDF，需要成员在文献库里上传 PDF 后才能精读'
            : row.status === 'failed'
              ? `解析失败：${row.error ?? '未知原因'}`
              : `还在解析（${row.stage ?? row.status}），稍后再读`,
      };
    }
    await tc.setActivity(`在读《${clip(row.title, 24)}》`);
    const sections = row.structure.sections;
    const toc = sections.map(
      (s) => `${'  '.repeat(s.level - 1)}${s.n ? `${s.n} ` : ''}${s.title} (p.${s.page ?? '?'})`,
    );
    if (!args.section && !args.page_from && !args.page_to) {
      return {
        ...base,
        venue: row.venue,
        doi: row.doi,
        arxiv: row.arxivId,
        abstract: row.abstract ? clip(row.abstract, 2500) : null,
        pages: row.pageCount,
        toc,
        figures: row.structure.figures.map(
          (f) =>
            `${f.label ?? f.kind} (p.${f.page}): ${clip(f.caption, 160)} ref=paper:${row.id}#p${f.page}`,
        ),
        hint:
          '用 section 或 page_from/page_to 读原文。图表可用 view_image(path_or_id="paper:<id>#p<页>") 查看该页的图（没有内嵌位图的矢量图会自动渲染整页）；看整页用 #p<页>/page，只看某块用 #p<页>/region:x0,y0,x1,y1（0~1 的页面比例，左上角到右下角）。' +
          CITE_HINT,
      };
    }
    const chunks = await tc.ctx.db.db
      .select()
      .from(paperChunks)
      .where(eq(paperChunks.paperId, row.id))
      .orderBy(asc(paperChunks.seq));
    let picked = chunks;
    if (args.section) {
      const want = args.section.trim().toLowerCase();
      const idx = sections.findIndex(
        (s) => s.n === args.section!.trim() || s.title.toLowerCase().includes(want),
      );
      if (idx < 0) {
        return { ...base, error: `找不到小节「${args.section}」`, toc };
      }
      // 包括子小节：直到下一个同级或更高级的小节
      const level = sections[idx]!.level;
      let end = sections.length;
      for (let i = idx + 1; i < sections.length; i += 1) {
        if (sections[i]!.level <= level) {
          end = i;
          break;
        }
      }
      const allowed = new Set(Array.from({ length: end - idx }, (_, k) => idx + k));
      picked = chunks.filter((c) => c.sectionIndex !== null && allowed.has(c.sectionIndex));
    }
    if (args.page_from || args.page_to) {
      const from = args.page_from ?? 1;
      const to = args.page_to ?? from + 1;
      picked = picked.filter((c) => c.page >= from && c.page <= to);
    }
    const formulas = new Map(
      row.structure.formulas.filter((f) => f.chunkSeq !== null).map((f) => [f.chunkSeq!, f]),
    );
    let budget = 24_000;
    const out: string[] = [];
    for (const c of picked) {
      const f = formulas.get(c.seq);
      const body = f?.latex ? `$$${f.latex}$$ ${f.label ?? ''}` : c.text;
      const line = `[p.${c.page} ¶${c.para}] ${body}`;
      if (budget - line.length < 0) {
        out.push(`…（后面还有，缩小 section 或页码范围继续读）`);
        break;
      }
      budget -= line.length;
      out.push(line);
    }
    return {
      ...base,
      section: args.section ?? null,
      text: out.join('\n\n') || '（这一部分没有正文段落）',
      how_to_cite: CITE_HINT,
    };
  },
});

const libraryImport = defineTool({
  name: 'library_import',
  description:
    '把论文导入项目文献库并解析全文（arXiv 编号、DOI 或开放获取 PDF 链接三选一）。' +
    'web_search 找到值得精读的论文时用它；默认等解析完成（最多约 2 分钟）再返回目录，之后用 library_read / library_search 精读。',
  roles: WORKER_ROLES,
  schema: z.object({
    arxiv: z.string().optional().describe('arXiv 编号，如 1706.03762'),
    doi: z.string().optional(),
    url: z.string().url().optional().describe('开放获取 PDF 直链'),
    wait: z.boolean().optional().describe('是否等解析完成，默认 true'),
    space: z
      .enum(['team', 'personal'])
      .optional()
      .describe('导入到哪：team 团队文献库（默认）；personal 主人的个人文献（只在个人工作区可用）'),
  }),
  visible: false,
  async run(tc, args) {
    const n = [args.arxiv, args.doi, args.url].filter(Boolean).length;
    if (n !== 1) throw new ToolError('arxiv、doi、url 只能填一个');
    const viewer = await agentViewer(tc);
    if (args.space === 'personal' && !viewer.userId) {
      throw new ToolError('协调者和团队线程只能导入到团队文献库');
    }
    const out = await importByRef(
      tc.ctx,
      tc.actor,
      tc.project.id,
      { arxiv: args.arxiv, doi: args.doi, url: args.url },
      args.space === 'personal' ? viewer.userId : null,
    );
    if (out.enqueue) enqueuePaper(tc.ctx, tc.project.id, out.row.id);
    await tc.setActivity(`在导入论文 ${args.arxiv ?? args.doi ?? '（PDF）'}`);
    let row = out.row;
    if (args.wait !== false) {
      const deadline = Date.now() + 150_000;
      while (
        Date.now() < deadline &&
        ['queued', 'fetching', 'parsing', 'indexing'].includes(row.status)
      ) {
        await new Promise((r) => setTimeout(r, 1500));
        const [next] = await tc.ctx.db.db.select().from(papers).where(eq(papers.id, row.id));
        if (!next) throw new ToolError('论文在解析过程中被删除了');
        row = next;
      }
    }
    return {
      paper_id: row.id,
      citekey: row.citekey,
      title: row.title,
      duplicate: out.duplicate,
      status: row.status,
      sections: row.structure?.sections.map((s) => `${s.n ? `${s.n} ` : ''}${s.title}`) ?? [],
      note:
        row.status === 'ready'
          ? `已解析（${row.chunkCount} 段）。用 library_read(paper="${row.citekey}") 精读。${row.error ? `注意：${row.error}` : ''}`
          : row.status === 'needs_pdf'
            ? (row.error ?? '没有开放获取 PDF，请成员上传')
            : row.status === 'failed'
              ? `失败：${row.error ?? ''}`
              : '还在解析，稍后用 library_read 查看',
    };
  },
});

const libraryCite = defineTool({
  name: 'library_cite',
  description: '取文献库论文的 BibTeX 条目和 \\cite{key}（写 LaTeX 时用）。',
  roles: ALL_ROLES,
  schema: z.object({
    papers: z.array(z.string()).min(1).max(30).describe('论文 id 或 citekey 列表'),
  }),
  async run(tc, args) {
    const rows = await listByIds(tc.ctx, tc.project.id, args.papers, await agentViewer(tc)).catch(
      () => [],
    );
    if (rows.length === 0) throw new ToolError('文献库里没有这些论文');
    return {
      cite: `\\cite{${rows.map((r) => r.citekey).join(',')}}`,
      bibtex: rows.map(bibOf).join('\n'),
    };
  },
});

export const libraryTools = [librarySearch, libraryRead, libraryImport, libraryCite];
