import { z } from 'zod';
import { PaperStatus } from './entities-library';
import { ResourceSpace, SpaceFilter } from './sharing';
import { tr } from './i18n';

/**
 * 文献库 REST 请求体与查询参数（API.md §2.15）。
 */

/** arXiv 编号：新式 2101.00001(v2)、旧式 hep-th/9901001；也接受 arXiv: 前缀与 abs/pdf 链接 */
export function normalizeArxivId(raw: string): string | null {
  const s = raw
    .trim()
    .replace(/^arxiv:\s*/iu, '')
    .replace(/^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|e-print)\//iu, '')
    .replace(/\.pdf$/iu, '')
    .replace(/v\d+$/u, '');
  if (/^\d{4}\.\d{4,5}$/u.test(s)) return s;
  if (/^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}$/u.test(s)) return s;
  return null;
}

/** DOI：去掉 doi: 前缀与 https://doi.org/，转小写（DOI 不区分大小写） */
export function normalizeDoi(raw: string): string | null {
  const s = raw
    .trim()
    .replace(/^doi:\s*/iu, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '')
    .trim()
    .toLowerCase();
  return /^10\.\d{4,9}\/\S+$/u.test(s) ? s : null;
}

/** arXiv 的 DataCite DOI（10.48550/arXiv.1706.03762）→ arXiv 编号 */
export function arxivIdFromDoi(doi: string): string | null {
  const m = /^10\.48550\/arxiv\.(.+)$/iu.exec(doi);
  return m ? normalizeArxivId(m[1]!) : null;
}

/** POST P/library/papers（JSON）：三选一 */
export const PaperImportInput = z
  .object({
    doi: z.string().trim().min(1).max(300).optional(),
    arxiv: z.string().trim().min(1).max(300).optional(),
    /** 开放获取 PDF 的直链（http/https） */
    url: z.string().trim().url().max(2000).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    /** 导入到哪里：不传 = 团队文献库；personal = 我的文献 */
    space: ResourceSpace.optional(),
  })
  .refine((v) => [v.doi, v.arxiv, v.url].filter(Boolean).length === 1, {
    message: tr('请只填写 DOI、arXiv 编号或 PDF 链接中的一项'),
  });
export type PaperImportInput = z.infer<typeof PaperImportInput>;

export const PaperUpdateInput = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  note: z.string().max(20_000).optional(),
  /**
   * 改 note 时的乐观并发：带上编辑开始时的 Paper.noteVersion；与当前不一致 →
   * 409 version_conflict，details.current 为最新 Paper（含 note、noteVersion），前端据此合并。
   * 不带 = 直接覆盖（兼容旧调用）；不改 note 时忽略。
   */
  baseNoteVersion: z.number().int().min(0).optional(),
  archived: z.boolean().optional(),
});
export type PaperUpdateInput = z.infer<typeof PaperUpdateInput>;

export const PaperListQuery = z.object({
  q: z.string().max(200).optional(),
  tag: z.string().max(40).optional(),
  status: PaperStatus.optional(),
  archived: z.enum(['true', 'false', '1', '0']).optional(),
  /** team 团队文献库、personal 我的文献、shared 与我共享、all（默认）全部可见 */
  space: SpaceFilter.optional(),
});
export type PaperListQuery = z.infer<typeof PaperListQuery>;

export const LibrarySearchQuery = z.object({
  q: z.string().trim().min(1).max(500),
  paperId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type LibrarySearchQuery = z.infer<typeof LibrarySearchQuery>;

export const LibraryQaInput = z.object({
  question: z.string().trim().min(1).max(2000),
  /** 只在这篇论文里找；不传 = 全项目文献库 */
  paperId: z.string().optional(),
  /** 之前几轮（最多 6 轮），让追问能接上 */
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) }))
    .max(12)
    .default([]),
});
export type LibraryQaInput = z.infer<typeof LibraryQaInput>;

export const LibraryBibtexInput = z.object({
  /** 不传或为空 = 全部（未归档）论文 */
  paperIds: z.array(z.string()).max(500).optional(),
});
export type LibraryBibtexInput = z.infer<typeof LibraryBibtexInput>;

/** 把论文的 BibTeX 合并进某篇 LaTeX 文档的 .bib 文件 */
export const LibraryCiteToDocInput = z.object({
  docId: z.string().min(1),
  paperIds: z.array(z.string()).min(1).max(100),
  /** 工程内的 .bib 路径，默认 references.bib */
  bibFile: z
    .string()
    .trim()
    .regex(/^[\w./-]{1,120}\.bib$/u, tr('必须是 .bib 文件'))
    .default('references.bib'),
});
export type LibraryCiteToDocInput = z.infer<typeof LibraryCiteToDocInput>;

export interface LibraryCiteToDocResult {
  docId: string;
  bibFile: string;
  /** 本次写入的引用键（按 paperIds 顺序） */
  keys: string[];
  /** 新加入 .bib 的条目数（已存在的键不重复写） */
  added: number;
  /** 可直接粘贴的 \cite{…} */
  cite: string;
}

export interface PaperImportResult<P = unknown> {
  paper: P;
  /** 项目里已有同一篇（同 DOI / arXiv 编号 / 同一个 PDF），没有重复导入 */
  duplicate: boolean;
}

/** R02：选区翻译不需要正文解析，也不接收整篇论文或问答历史。 */
export const LIBRARY_TRANSLATION_MAX_CHARS = 4000;
export const TRANSLATION_LANGUAGES = {
  'zh-CN': tr('简体中文'),
  en: tr('英语'),
  ja: tr('日语'),
  de: tr('德语'),
  fr: tr('法语'),
} as const;
export const TranslationLanguage = z.enum(['zh-CN', 'en', 'ja', 'de', 'fr']);
export type TranslationLanguage = z.infer<typeof TranslationLanguage>;
export const LibraryTranslationInput = z
  .object({
    text: z.string().trim().min(1).max(LIBRARY_TRANSLATION_MAX_CHARS),
    fileId: z.string().min(1).max(100),
    page: z.number().int().min(1).max(100_000),
    targetLanguage: TranslationLanguage.default('zh-CN'),
    modelId: z.string().min(1).max(300).optional(),
  })
  .strict();
export type LibraryTranslationInput = z.infer<typeof LibraryTranslationInput>;
export interface LibraryTranslationModels {
  defaultModel: string | null;
  models: { id: string; name: string; providerName: string }[];
}
export interface LibraryTranslationResult {
  translation: string;
  targetLanguage: TranslationLanguage;
  modelId: string;
  modelName: string;
}

/** L07/L08：发布论文、PDF 与解析结果；仅明确选中的独立笔记会随副本发布。 */
export const PaperQaPublishSelection = z
  .object({
    id: z.string().min(1).max(100),
    version: z.number().int().min(1),
    unsharedSources: z.enum(['mark', 'remove']).default('mark'),
    allowMissingContext: z.boolean().default(false),
    previewHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict();
export type PaperQaPublishSelection = z.infer<typeof PaperQaPublishSelection>;
export const PaperPublishInput = z
  .object({
    projectId: z.string().min(1).max(100),
    requestId: z.uuid(),
    sourceUpdatedAt: z.iso.datetime(),
    notes: z
      .array(
        z.object({ id: z.string().min(1).max(100), version: z.number().int().min(1) }).strict(),
      )
      .max(50)
      .optional(),
    annotations: z
      .array(
        z.object({ id: z.string().min(1).max(100), version: z.number().int().min(1) }).strict(),
      )
      .max(200)
      .optional(),
    qa: z.array(PaperQaPublishSelection).max(50).optional(),
    targetPaperId: z.string().min(1).max(100).optional(),
    targetUpdatedAt: z.iso.datetime().optional(),
  })
  .strict();
export type PaperPublishInput = z.infer<typeof PaperPublishInput>;
export interface PaperPublishResult<P = unknown> {
  paper: P;
  /** 相同请求的重试返回已提交副本，不再复制。 */
  replayed: boolean;
  summary?: PaperPublicationSummary;
}

export interface PaperPublicationSummary {
  mode: 'created' | 'appended';
  added: { notes: number; annotations: number; qa: number };
  skipped: { notes: number; annotations: number; qa: number };
}
export interface PaperPublicationTarget<P = unknown> {
  paper: P;
  reasons: string[];
  samePdf: boolean;
  published: Record<'notes' | 'annotations' | 'qa', { id: string; version: number }[]>;
}

/** L11：只检查实际修改字段的版本，不把另一个字段的更新当作冲突。 */
export const PaperUpdateWithVersionsInput = PaperUpdateInput.extend({
  baseTitleVersion: z.number().int().min(1).optional(),
  baseTagsVersion: z.number().int().min(1).optional(),
});
export type PaperUpdateWithVersionsInput = z.infer<typeof PaperUpdateWithVersionsInput>;

export const PaperNoteCreateInput = z
  .object({
    title: z.string().trim().min(1).max(160),
    kind: z.enum(['note', 'brief']).default('note'),
    body: z.string().max(100_000).default(''),
  })
  .strict();
export type PaperNoteCreateInput = z.infer<typeof PaperNoteCreateInput>;
export const PaperNoteRenameInput = z
  .object({ title: z.string().trim().min(1).max(160), baseVersion: z.number().int().min(1) })
  .strict();
export const PaperNoteCopyInput = z
  .object({ title: z.string().trim().min(1).max(160), sourceVersion: z.number().int().min(1) })
  .strict();

/** L04/L13：坐标取自 PDF 原始用户空间，服务端从论文核对文件身份。 */
export const PaperAnnotationCreateInput = z
  .object({
    kind: z.enum(['highlight', 'comment']),
    color: z.enum(['yellow', 'green', 'blue', 'pink']).default('yellow'),
    label: z.string().trim().max(160).default(''),
    fileId: z.string().min(1).max(100),
    page: z.number().int().min(1).max(100_000),
    quote: z.string().trim().min(1).max(12_000),
    boxes: z
      .array(
        z
          .object({
            page: z.number().int().min(1).max(100_000),
            x: z.number().min(0).max(1_000_000),
            y: z.number().min(0).max(1_000_000),
            w: z.number().positive().max(1_000_000),
            h: z.number().positive().max(1_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(300),
    body: z.string().max(100_000).default(''),
  })
  .strict()
  .refine((v) => v.boxes.every((b) => b.page === v.page), tr('选区必须位于同一页'))
  .refine((v) => v.kind === 'comment' || v.body === '', tr('高亮不包含批注正文，请独立创建批注'));
export type PaperAnnotationCreateInput = z.infer<typeof PaperAnnotationCreateInput>;
export const PaperAnnotationUpdateInput = z
  .object({
    color: z.enum(['yellow', 'green', 'blue', 'pink']),
    label: z.string().trim().max(160),
    baseMetadataVersion: z.number().int().min(1),
  })
  .strict();
export type PaperAnnotationUpdateInput = z.infer<typeof PaperAnnotationUpdateInput>;
export const PaperAnnotationVersionInput = z
  .object({ baseVersion: z.number().int().min(1) })
  .strict();

export const PaperQaSessionCreateInput = z
  .object({ title: z.string().trim().min(1).max(160) })
  .strict();
export const PaperQaSessionUpdateInput = PaperQaSessionCreateInput.extend({
  baseVersion: z.number().int().min(1),
});
export const PaperQaAskInput = z
  .object({
    requestId: z.uuid(),
    question: z.string().trim().min(1).max(2000),
    modelId: z.string().min(1).max(300).optional(),
    searchScope: z.enum(['paper', 'all']).default('paper'),
    contextTurnIds: z.array(z.string().min(1).max(100)).max(3).default([]),
    selection: z
      .object({
        fileId: z.string().min(1).max(100),
        page: z.number().int().min(1).max(100_000),
        text: z.string().trim().min(1).max(4000),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PaperQaAskInput = z.infer<typeof PaperQaAskInput>;
export const PaperQaPublishPreviewInput = z
  .object({
    projectId: z.string().min(1).max(100),
    targetPaperId: z.string().min(1).max(100).optional(),
    selections: z.array(PaperQaPublishSelection).min(1).max(50),
  })
  .strict();
export type PaperQaPublishPreviewInput = z.infer<typeof PaperQaPublishPreviewInput>;
export const PaperQaBriefInput = z
  .object({
    title: z.string().trim().min(1).max(160),
    sourceVersion: z.number().int().min(1),
  })
  .strict();

export const PaperAnnotationBriefInput = PaperQaBriefInput;
