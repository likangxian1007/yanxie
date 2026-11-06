import { z } from 'zod';
import { ActorRef } from './entities';
import { AccessLevel, ResourceSpace } from './sharing';

/**
 * 文献库（论文导入、解析、索引、阅读、引用）的实体。
 * 归属：文献库线程（feat/paper-library）。只在本组文件（*-library.ts）里追加。
 *
 * 坐标约定：PDF 用户空间单位（pt），原点在页面左上角，y 向下（GROBID teiCoordinates 同一约定）；
 * 页码从 1 开始。前端按 scale 直接乘即可叠加到 PDF.js 渲染的页面上。
 */

/** ID 前缀（不进 ids.ts，避免与其他线程冲突；格式同 newId：`ppr_<ULID>`） */
export const LIBRARY_ID_PREFIX = { paper: 'ppr' } as const;

/** 独立笔记归属继承论文；团队副本不暴露私人原件 ID 或编辑历史。 */
export const PaperNote = z.object({
  id: z.string(),
  paperId: z.string(),
  title: z.string(),
  kind: z.enum(['note', 'brief']),
  body: z.string(),
  version: z.number().int(),
  createdBy: ActorRef,
  updatedBy: ActorRef,
  createdAt: z.string(),
  updatedAt: z.string(),
  publishedFrom: z
    .object({
      author: ActorRef,
      publishedBy: ActorRef,
      publishedAt: z.string(),
      sourceVersion: z.number().int(),
    })
    .nullable(),
});
export type PaperNote = z.infer<typeof PaperNote>;

/** 文献库单个 PDF 上限（自动下载与手动上传共用；学位论文、扫描版常超过 20 MB） */
export const PAPER_PDF_MAX_BYTES = 100 * 1024 * 1024;

/** 解析流水线状态 */
export const PAPER_STATUSES = [
  /** 排队等待解析 */
  'queued',
  /** 拉取元数据与 PDF */
  'fetching',
  /** 版面与结构解析（GROBID / MinerU / 纯文本） */
  'parsing',
  /** 建立段落索引 */
  'indexing',
  'ready',
  /** 没有开放获取的 PDF：已保存元数据，等成员上传 PDF */
  'needs_pdf',
  'failed',
] as const;
export const PaperStatus = z.enum(PAPER_STATUSES);
export type PaperStatus = z.infer<typeof PaperStatus>;

export const PAPER_SOURCES = ['upload', 'doi', 'arxiv', 'url'] as const;
export const PaperSource = z.enum(PAPER_SOURCES);
export type PaperSource = z.infer<typeof PaperSource>;

/** 实际用到的解析器：grobid（默认）/ mineru（可选 GPU 服务）/ pdf-text（降级：逐页纯文本） */
export const PAPER_PARSERS = ['grobid', 'mineru', 'pdf-text'] as const;
export const PaperParserName = z.enum(PAPER_PARSERS);
export type PaperParserName = z.infer<typeof PaperParserName>;

export const PaperAuthor = z.object({
  /** 展示名 “Ashish Vaswani” */
  name: z.string(),
  given: z.string().nullable(),
  family: z.string().nullable(),
});
export type PaperAuthor = z.infer<typeof PaperAuthor>;

/** 一块区域：页码 + 左上角坐标 + 宽高（pt） */
export const PdfBox = z.object({
  page: z.number().int().min(1),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type PdfBox = z.infer<typeof PdfBox>;

/** 论文（列表与事件的形状，不含结构化正文） */
export const Paper = z.object({
  id: z.string(),
  /** 个人论文为 null；已有项目响应继续返回项目 ID。 */
  projectId: z.string().nullable(),
  /** 个人归属；可选以兼容旧客户端和旧缓存。 */
  ownerUserId: z.string().nullable().optional(),
  title: z.string(),
  authors: z.array(PaperAuthor),
  year: z.number().int().nullable(),
  venue: z.string().nullable(),
  abstract: z.string().nullable(),
  doi: z.string().nullable(),
  arxivId: z.string().nullable(),
  url: z.string().nullable(),
  /** 稳定的 BibTeX 引用键，如 vaswani2017attention（项目内唯一） */
  citekey: z.string(),
  tags: z.array(z.string()),
  note: z.string(),
  /** 笔记版本（每次改 note +1）；PATCH 带 baseNoteVersion 做乐观并发 */
  noteVersion: z.number().int().optional(),
  source: PaperSource,
  status: PaperStatus,
  /** 0–100 */
  progress: z.number().int(),
  /** 当前阶段的中文说明（“正在用 GROBID 解析版面”） */
  stage: z.string().nullable(),
  /** 失败原因或降级提示（中文） */
  error: z.string().nullable(),
  parser: PaperParserName.nullable(),
  /** PDF 文件 ID；下载必须通过当前库的鉴权入口。 */
  fileId: z.string().nullable(),
  pageCount: z.number().int().nullable(),
  /** 索引里的段落数 */
  chunkCount: z.number().int(),
  /** 有 arXiv LaTeX 源码、公式已换成 LaTeX */
  hasLatexSource: z.boolean(),
  createdBy: ActorRef,
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  /** 元数据按字段计数；旧缓存可以不带，服务端新响应始终返回。 */
  titleVersion: z.number().int().min(1).optional(),
  tagsVersion: z.number().int().min(1).optional(),
  /** 团队文献库（team）还是某人的个人文献（personal）；旧数据为 team */
  space: ResourceSpace.optional(),
  /** 当前用户对它的权限：只在 REST 响应里给 */
  access: AccessLevel.optional(),
  /** 个人文献已分享给别人；只在 REST 响应里给所有者 */
  shared: z.boolean().optional(),
});
export type Paper = z.infer<typeof Paper>;

/** 正文段落（也是检索与引用的最小单位） */
export const PaperChunk = z.object({
  /** `<paperId>:<seq>` */
  id: z.string(),
  /** 全文顺序号（0 起） */
  seq: z.number().int(),
  kind: z.enum(['abstract', 'paragraph', 'formula', 'caption', 'table', 'note']),
  /** 所在小节序号（PaperStructure.sections 的下标），摘要与无标题为 null */
  sectionIndex: z.number().int().nullable(),
  /** 小节路径 “3 Model Architecture › 3.2 Attention” */
  sectionPath: z.string(),
  /** 起始页（1 起） */
  page: z.number().int(),
  /** 该页内的段落序号（1 起，按版面阅读顺序）——引用写作 p.<page> ¶<para> */
  para: z.number().int(),
  boxes: z.array(PdfBox),
  text: z.string(),
});
export type PaperChunk = z.infer<typeof PaperChunk>;

export const PaperSection = z.object({
  /** 小节编号（“3.2”），没有编号为 null */
  n: z.string().nullable(),
  title: z.string(),
  /** 1 = 一级标题 */
  level: z.number().int().min(1).max(6),
  page: z.number().int().nullable(),
  boxes: z.array(PdfBox),
  /** 本节第一个段落的 seq */
  firstChunk: z.number().int().nullable(),
});
export type PaperSection = z.infer<typeof PaperSection>;

export const PaperFormula = z.object({
  id: z.string(),
  /** 编号 “(1)” */
  label: z.string().nullable(),
  /** GROBID 抽出的公式文字（近似，非 LaTeX） */
  text: z.string(),
  /** LaTeX 源码（来自 arXiv 源码匹配；没有则为 null，前端显示原图区域） */
  latex: z.string().nullable(),
  page: z.number().int().nullable(),
  boxes: z.array(PdfBox),
  chunkSeq: z.number().int().nullable(),
});
export type PaperFormula = z.infer<typeof PaperFormula>;

export const PaperFigure = z.object({
  id: z.string(),
  kind: z.enum(['figure', 'table']),
  /** “Figure 1” / “Table 2” */
  label: z.string().nullable(),
  caption: z.string(),
  page: z.number().int().nullable(),
  /** 整个图（含图注）的区域 */
  boxes: z.array(PdfBox),
  /** 图片本体的区域（裁图用；没有时用 boxes） */
  graphic: PdfBox.nullable(),
  /** 表格的单元格（GROBID 能识别时） */
  rows: z.array(z.array(z.string())).nullable(),
  chunkSeq: z.number().int().nullable(),
});
export type PaperFigure = z.infer<typeof PaperFigure>;

export const PaperReference = z.object({
  id: z.string(),
  /** 文中编号（按出现顺序 1 起） */
  index: z.number().int(),
  title: z.string().nullable(),
  authors: z.array(z.string()),
  year: z.number().int().nullable(),
  venue: z.string().nullable(),
  doi: z.string().nullable(),
  arxivId: z.string().nullable(),
  /** 原始引文串 */
  raw: z.string().nullable(),
  page: z.number().int().nullable(),
  boxes: z.array(PdfBox),
});
export type PaperReference = z.infer<typeof PaperReference>;

/** 解析出的结构（GET 论文详情时返回） */
export const PaperStructure = z.object({
  /** 每页尺寸（pt），下标 0 = 第 1 页 */
  pages: z.array(z.object({ width: z.number(), height: z.number() })),
  sections: z.array(PaperSection),
  chunks: z.array(PaperChunk),
  formulas: z.array(PaperFormula),
  figures: z.array(PaperFigure),
  references: z.array(PaperReference),
  /** LaTeX 源码里的自定义宏（KaTeX macros），如 { "\\dmodel": "d_{\\text{model}}" } */
  macros: z.record(z.string(), z.string()),
});
export type PaperStructure = z.infer<typeof PaperStructure>;

export const PaperDetail = Paper.extend({
  structure: PaperStructure.nullable(),
});
export type PaperDetail = z.infer<typeof PaperDetail>;

/** 检索命中（REST 与 agent 工具同一形状） */
export const LibraryHit = z.object({
  paperId: z.string(),
  paperTitle: z.string(),
  citekey: z.string(),
  chunkId: z.string(),
  seq: z.number().int(),
  kind: PaperChunk.shape.kind,
  sectionPath: z.string(),
  page: z.number().int(),
  para: z.number().int(),
  boxes: z.array(PdfBox),
  text: z.string(),
  score: z.number(),
});
export type LibraryHit = z.infer<typeof LibraryHit>;

/** 解析服务状态（列表页顶部的状态提示） */
export const LibraryStatus = z.object({
  parser: z.enum(['grobid', 'mineru']),
  /** 解析服务是否可达；不可达时降级为逐页纯文本 */
  reachable: z.boolean(),
  version: z.string().nullable(),
  url: z.string(),
  queue: z.object({ running: z.number().int(), waiting: z.number().int() }),
  llm: z.boolean(),
});
export type LibraryStatus = z.infer<typeof LibraryStatus>;

/** 问答流（application/x-ndjson，每行一个对象） */
export type LibraryQaFrame =
  | { type: 'sources'; keywords: string[]; sources: LibraryHit[] }
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** L04/L13：高亮与批注是独立记录，共享原文位置不代表共享评论。 */
export const AnnotationColor = z.enum(['yellow', 'green', 'blue', 'pink']);
export type AnnotationColor = z.infer<typeof AnnotationColor>;
export const PaperAnnotation = z.object({
  id: z.string(),
  paperId: z.string(),
  kind: z.enum(['highlight', 'comment']),
  color: AnnotationColor,
  label: z.string(),
  fileId: z.string(),
  pdfSha256: z.string().nullable(),
  page: z.number().int(),
  quote: z.string(),
  boxes: z.array(PdfBox),
  /** 不匹配时只保留记录，不向当前 PDF 绘制旧坐标。 */
  anchorStatus: z.enum(['current', 'mismatch']),
  body: z.string(),
  version: z.number().int(),
  metadataVersion: z.number().int(),
  createdBy: ActorRef,
  updatedBy: ActorRef,
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  restoredToId: z.string().nullable(),
  publishedFrom: PaperNote.shape.publishedFrom,
});
export type PaperAnnotation = z.infer<typeof PaperAnnotation>;

/** L05/L09/L14：已保存的问答与生成时的来源、前文快照。 */
export const PaperQaStatus = z.enum([
  'queued',
  'retrieving',
  'generating',
  'done',
  'failed',
  'cancelled',
  'interrupted',
]);
export type PaperQaStatus = z.infer<typeof PaperQaStatus>;
export const PaperQaSource = z.object({
  id: z.string(),
  paperId: z.string().nullable(),
  fileId: z.string().nullable(),
  pdfSha256: z.string().nullable(),
  chunkId: z.string().nullable(),
  paperTitle: z.string(),
  citekey: z.string(),
  seq: z.number().int(),
  page: z.number().int(),
  para: z.number().int(),
  boxes: z.array(PdfBox),
  quote: z.string(),
  status: z.enum(['available', 'unshared', 'missing', 'changed']),
});
export type PaperQaSource = z.infer<typeof PaperQaSource>;
export const PaperQaContext = z.object({
  turnId: z.string(),
  version: z.number().int(),
  question: z.string(),
  answer: z.string(),
});
export type PaperQaContext = z.infer<typeof PaperQaContext>;
export const PaperQaSession = z.object({
  id: z.string(),
  paperId: z.string(),
  title: z.string(),
  version: z.number().int(),
  createdBy: ActorRef,
  updatedBy: ActorRef,
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
export type PaperQaSession = z.infer<typeof PaperQaSession>;
/** 用户主动选取的片段；原文快照不等于经过解析器核验的段落。 */
export const PaperQaSelection = z.object({
  fileId: z.string().nullable(),
  pdfSha256: z.string().nullable(),
  page: z.number().int(),
  text: z.string(),
  status: z.enum(['available', 'unshared', 'changed', 'missing']),
});
export type PaperQaSelection = z.infer<typeof PaperQaSelection>;
export const PaperQaTurn = z.object({
  id: z.string(),
  sessionId: z.string(),
  paperId: z.string(),
  generationId: z.string(),
  question: z.string(),
  answer: z.string(),
  originalQuestion: z.string(),
  originalAnswer: z.string(),
  origin: z.enum(['model', 'published']),
  status: PaperQaStatus,
  error: z.string().nullable(),
  modelId: z.string().nullable(),
  modelName: z.string(),
  searchScope: z.enum(['paper', 'all']),
  sources: z.array(PaperQaSource),
  context: z.array(PaperQaContext),
  contextOmitted: z.boolean(),
  selection: PaperQaSelection.nullable().optional(),
  keywords: z.array(z.string()),
  version: z.number().int(),
  createdBy: ActorRef,
  updatedBy: ActorRef,
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  publishedFrom: PaperNote.shape.publishedFrom,
});
export type PaperQaTurn = z.infer<typeof PaperQaTurn>;
export const PaperQaRevision = z.object({
  id: z.string(),
  turnId: z.string(),
  version: z.number().int(),
  question: z.string(),
  answer: z.string(),
  kind: z.enum(['generated', 'edited', 'published']),
  actor: ActorRef,
  createdAt: z.string(),
});
export type PaperQaRevision = z.infer<typeof PaperQaRevision>;

export interface PaperQaPublishPreview {
  turns: {
    id: string;
    version: number;
    sessionTitle: string;
    question: string;
    answer: string;
    sources: PaperQaSource[];
    author: z.infer<typeof ActorRef>;
    missingContext: { id: string; version: number; question: string }[];
    unsharedSources: { id: string; title: string }[];
    privateLinksRemoved: boolean;
    previewHash: string;
    selection?: PaperQaSelection | null;
  }[];
}
