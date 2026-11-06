/**
 * 文献库表：论文（元数据 + 解析出的结构）与段落索引。
 * 归属：文献库线程（apps/server/src/modules/library、agents/tools/library.ts）。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type {
  PaperAuthor,
  PaperChunk,
  PaperParserName,
  PaperSource,
  PaperStatus,
  PaperStructure,
  PdfBox,
  PaperQaSelection,
  PaperPublicationSummary,
  ResourceSpace,
} from '@srh/shared';
import { actor, createdAt, id, jsonObject, textArray, ts, updatedAt } from './_helpers';
import { files, projects, users } from './core';
import { bytea } from './collab';
import type {
  PaperNote,
  PaperAnnotation,
  PaperQaSource,
  PaperQaContext,
  PaperQaStatus,
} from '@srh/shared';

/** 结构里除段落以外的部分（段落单独存 paper_chunks，检索用） */
export type StoredStructure = Omit<PaperStructure, 'chunks'>;

/** BibTeX 需要、但列表不展示的元数据 */
export interface PaperBibMeta {
  /** article / inproceedings / misc / book / phdthesis … */
  entryType?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  primaryClass?: string;
  /** 元数据来源：arxiv / crossref / openalex / grobid */
  metaSource?: string;
  /** 引用键已按真实元数据确定，之后不再改（见 modules/library/bibtex.ts） */
  citekeyFixed?: boolean;
}

export const papers = pgTable(
  'papers',
  {
    id: id(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    authors: jsonb('authors')
      .$type<PaperAuthor[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    year: integer('year'),
    venue: text('venue'),
    abstract: text('abstract'),
    /** 小写 */
    doi: text('doi'),
    /** 不带版本号 */
    arxivId: text('arxiv_id'),
    url: text('url'),
    /** 拉取 PDF 用的地址（OA 直链 / arXiv PDF） */
    pdfUrl: text('pdf_url'),
    pdfSha256: text('pdf_sha256'),
    citekey: text('citekey').notNull(),
    tags: textArray('tags'),
    note: text('note').notNull().default(''),
    /** 笔记的乐观并发版本：每次改 note +1（解析进度等不动它） */
    noteVersion: integer('note_version').notNull().default(1),
    titleVersion: integer('title_version').notNull().default(1),
    tagsVersion: integer('tags_version').notNull().default(1),
    source: text('source').$type<PaperSource>().notNull(),
    status: text('status').$type<PaperStatus>().notNull().default('queued'),
    progress: integer('progress').notNull().default(0),
    stage: text('stage'),
    error: text('error'),
    parser: text('parser').$type<PaperParserName>(),
    fileId: text('file_id').references(() => files.id, { onDelete: 'set null' }),
    pageCount: integer('page_count'),
    chunkCount: integer('chunk_count').notNull().default(0),
    hasLatexSource: integer('has_latex_source').notNull().default(0),
    structure: jsonb('structure').$type<StoredStructure>(),
    meta: jsonObject<PaperBibMeta>('meta'),
    attempts: integer('attempts').notNull().default(0),
    createdBy: actor('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: ts('archived_at'),
    /** team：团队文献库（旧数据都是 team）；personal：owner_user_id 的个人文献 */
    space: text('space').$type<ResourceSpace>().notNull().default('team'),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    /**
     * 个人文献的 PDF 不进项目共享文件夹（否则全组都能在文件里看到），存在
     * STORAGE_DIR/_private/<projectId>/ 下；这里记相对路径。移入团队库时再写进共享文件夹。
     */
    privatePdfPath: text('private_pdf_path'),
  },
  (t) => [
    check(
      'papers_owner_scope',
      sql`(${t.projectId} is not null and ((${t.space} = 'team' and ${t.ownerUserId} is null) or (${t.space} = 'personal' and ${t.ownerUserId} is not null))) or (${t.projectId} is null and ${t.ownerUserId} is not null)`,
    ),
    index('papers_owner_idx').on(t.ownerUserId, t.createdAt),
    uniqueIndex('papers_owner_citekey_uq')
      .on(t.ownerUserId, t.citekey)
      .where(sql`${t.projectId} is null`),
    uniqueIndex('papers_owner_doi_uq')
      .on(t.ownerUserId, t.doi)
      .where(sql`${t.projectId} is null`),
    uniqueIndex('papers_owner_arxiv_uq')
      .on(t.ownerUserId, t.arxivId)
      .where(sql`${t.projectId} is null`),
    index('papers_project_idx').on(t.projectId, t.createdAt),
    // 去重与引用键唯一都按“库”算：团队库一套，每个人的个人文献各一套
    uniqueIndex('papers_lib_citekey_uq').on(
      t.projectId,
      sql`coalesce(${t.ownerUserId}, '')`,
      t.citekey,
    ),
    uniqueIndex('papers_lib_doi_uq')
      .on(t.projectId, sql`coalesce(${t.ownerUserId}, '')`, t.doi)
      .where(sql`${t.doi} is not null`),
    uniqueIndex('papers_lib_arxiv_uq')
      .on(t.projectId, sql`coalesce(${t.ownerUserId}, '')`, t.arxivId)
      .where(sql`${t.arxivId} is not null`),
  ],
);

export const paperChunks = pgTable(
  'paper_chunks',
  {
    /** `<paperId>:<seq>` */
    id: text('id').primaryKey(),
    paperId: text('paper_id')
      .notNull()
      .references(() => papers.id, { onDelete: 'cascade' }),
    /** 兼容旧项目索引；访问归属始终从所属论文继承，不由调用者指定。 */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind').$type<PaperChunk['kind']>().notNull(),
    sectionIndex: integer('section_index'),
    sectionPath: text('section_path').notNull().default(''),
    page: integer('page').notNull(),
    para: integer('para').notNull(),
    boxes: jsonb('boxes')
      .$type<PdfBox[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    text: text('text').notNull(),
  },
  (t) => [
    index('paper_chunks_paper_idx').on(t.paperId, t.seq),
    index('paper_chunks_project_idx').on(t.projectId),
  ],
);

/** 发布凭据仅供服务端核对来源与重试；不能通过项目接口暴露私人论文 ID。 */
export const paperPublications = pgTable(
  'paper_publications',
  {
    id: id(),
    publisherUserId: text('publisher_user_id').references(() => users.id, { onDelete: 'set null' }),
    requestId: text('request_id').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    paperId: text('paper_id').references(() => papers.id, { onDelete: 'set null' }),
    // 不级联删除：个人原件删除后仍保留已发布记录，但 ID 不授予原件访问权。
    sourcePaperId: text('source_paper_id').notNull(),
    sourceFileId: text('source_file_id'),
    sourceUpdatedAt: ts('source_updated_at').notNull(),
    publishedBy: actor('published_by'),
    noteSelection: text('note_selection').notNull().default('[]'),
    requestOptions: text('request_options').notNull().default('{}'),
    summary: jsonb('summary').$type<PaperPublicationSummary>(),
    annotationSelection: text('annotation_selection').notNull().default('[]'),
    qaSelection: text('qa_selection').notNull().default('[]'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('paper_publications_request_uq').on(t.publisherUserId, t.requestId),
    index('paper_publications_source_idx').on(t.projectId, t.sourcePaperId),
  ],
);

export const paperNotes = pgTable(
  'paper_notes',
  {
    id: id(),
    paperId: text('paper_id')
      .notNull()
      .references(() => papers.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    kind: text('kind').$type<'note' | 'brief'>().notNull().default('note'),
    body: text('body').notNull().default(''),
    ydocState: bytea('ydoc_state').notNull(),
    version: integer('version').notNull().default(1),
    createdBy: actor('created_by'),
    updatedBy: actor('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
    publishedFrom: jsonb('published_from').$type<PaperNote['publishedFrom']>(),
  },
  (t) => [index('paper_notes_paper_idx').on(t.paperId, t.createdAt)],
);

/** 高亮和批注各有独立 ID；文件身份为定位快照，不随文件删除而清空。 */
export const paperAnnotations = pgTable(
  'paper_annotations',
  {
    id: id(),
    paperId: text('paper_id')
      .notNull()
      .references(() => papers.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<PaperAnnotation['kind']>().notNull(),
    color: text('color').$type<PaperAnnotation['color']>().notNull().default('yellow'),
    label: text('label').notNull().default(''),
    fileId: text('file_id').notNull(),
    pdfSha256: text('pdf_sha256'),
    page: integer('page').notNull(),
    quote: text('quote').notNull(),
    boxes: jsonb('boxes').$type<PdfBox[]>().notNull(),
    body: text('body').notNull().default(''),
    ydocState: bytea('ydoc_state').notNull(),
    version: integer('version').notNull().default(1),
    metadataVersion: integer('metadata_version').notNull().default(1),
    createdBy: actor('created_by'),
    updatedBy: actor('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
    restoredToId: text('restored_to_id'),
    publishedFrom: jsonb('published_from').$type<PaperAnnotation['publishedFrom']>(),
  },
  (t) => [index('paper_annotations_paper_idx').on(t.paperId, t.page)],
);

export const paperQaSessions = pgTable(
  'paper_qa_sessions',
  {
    id: id(),
    paperId: text('paper_id')
      .notNull()
      .references(() => papers.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    version: integer('version').notNull().default(1),
    createdBy: actor('created_by'),
    updatedBy: actor('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('paper_qa_sessions_paper_idx').on(t.paperId, t.createdAt)],
);

export const paperQaTurns = pgTable(
  'paper_qa_turns',
  {
    id: id(),
    sessionId: text('session_id')
      .notNull()
      .references(() => paperQaSessions.id, { onDelete: 'cascade' }),
    paperId: text('paper_id')
      .notNull()
      .references(() => papers.id, { onDelete: 'cascade' }),
    generationId: text('generation_id').notNull(),
    requestId: text('request_id').notNull(),
    requestSignature: text('request_signature').notNull(),
    requestedByUserId: text('requested_by_user_id').notNull(),
    question: text('question').notNull(),
    answer: text('answer').notNull().default(''),
    originalQuestion: text('original_question').notNull(),
    originalAnswer: text('original_answer').notNull().default(''),
    origin: text('origin').$type<'model' | 'published'>().notNull().default('model'),
    status: text('status').$type<PaperQaStatus>().notNull().default('queued'),
    error: text('error'),
    modelId: text('model_id'),
    modelName: text('model_name').notNull(),
    searchScope: text('search_scope').$type<'paper' | 'all'>().notNull().default('paper'),
    sources: jsonb('sources').$type<PaperQaSource[]>().notNull().default([]),
    context: jsonb('context').$type<PaperQaContext[]>().notNull().default([]),
    contextOmitted: boolean('context_omitted').notNull().default(false),
    selection: jsonb('selection').$type<PaperQaSelection>(),
    keywords: textArray('keywords'),
    ydocState: bytea('ydoc_state'),
    version: integer('version').notNull().default(1),
    createdBy: actor('created_by'),
    updatedBy: actor('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: ts('completed_at'),
    publishedFrom: jsonb('published_from').$type<PaperNote['publishedFrom']>(),
  },
  (t) => [
    index('paper_qa_turns_session_idx').on(t.sessionId, t.createdAt),
    uniqueIndex('paper_qa_turns_request_uq').on(t.sessionId, t.requestedByUserId, t.requestId),
  ],
);

export const paperQaRevisions = pgTable(
  'paper_qa_revisions',
  {
    id: id(),
    turnId: text('turn_id')
      .notNull()
      .references(() => paperQaTurns.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    kind: text('kind').$type<'generated' | 'edited' | 'published'>().notNull(),
    actor: actor('actor'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('paper_qa_revisions_version_uq').on(t.turnId, t.version)],
);
