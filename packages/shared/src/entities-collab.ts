import { z } from 'zod';
import {
  ExperimentStatus,
  ReportStatus,
  ReviewStatus,
  ReviewTargetKind,
  ReviewVerdict,
  TodoPriority,
} from './enums';
import { ActorRef, OutputRef } from './entities';
import { AccessLevel, ResourceSpace } from './sharing';
import { tr } from './i18n';

/**
 * 协作功能的实体 DTO（文档、看板、待办、实验、审阅、汇报）。
 * 归属：协作功能线程。约定同 entities.ts。
 */
const Iso = z.string().describe(tr('ISO 8601 时间'));
const Id = z.string();

// ---------------------------------------------------------------- 指派对象

/**
 * 指派对象（卡片 assigneeIds、待办 assigneeId 的取值）：
 * - 成员：用户 id（`usr_…`）
 * - agent：`agent:coordinator`（协调者）或 `agent:<threadId>`（某个线程的 agent）
 */
export const AGENT_ASSIGNEE_PREFIX = 'agent:';
export const COORDINATOR_ASSIGNEE = 'agent:coordinator';

export function isAgentAssignee(value: string): boolean {
  return value.startsWith(AGENT_ASSIGNEE_PREFIX);
}

/** `agent:<threadId>` → threadId；协调者或成员返回 null。 */
export function assigneeThreadId(value: string): string | null {
  if (!isAgentAssignee(value) || value === COORDINATOR_ASSIGNEE) return null;
  return value.slice(AGENT_ASSIGNEE_PREFIX.length) || null;
}

// ---------------------------------------------------------------- 协同文档

/**
 * 文档类型：
 * - doc：富文本（飞书/腾讯文档式，Tiptap + Yjs XmlFragment `default`）
 * - sheet：表格（Y.Map `cells`，键 `r:c`，值为原始输入，`=` 开头为公式）
 * - slides：幻灯片（Y.Array `slides`，每页一个 Y.Map）
 * - latex：LaTeX 论文（Y.Text `source`，CodeMirror 协同 + 实时预览）
 */
export const DocumentKind = z.enum(['doc', 'sheet', 'slides', 'latex']);
export type DocumentKind = z.infer<typeof DocumentKind>;

export const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  doc: tr('文档'),
  sheet: tr('表格'),
  slides: tr('幻灯片'),
  latex: tr('LaTeX 论文'),
};

export const DocumentMeta = z.object({
  id: Id,
  projectId: Id,
  parentId: Id.nullable(),
  kind: DocumentKind,
  title: z.string(),
  icon: z.string().nullable(),
  /** 纯文本快照（搜索与 agent 读取用），协同内容本体在 Yjs 状态里 */
  excerpt: z.string(),
  createdBy: ActorRef,
  updatedBy: ActorRef.nullable(),
  createdAt: Iso,
  updatedAt: Iso,
  archivedAt: Iso.nullable(),
  /** 所在空间（旧数据与团队文档为 team）；见 sharing.ts */
  space: ResourceSpace.optional(),
  /** 个人空间的所有者；团队文档为 null */
  ownerUserId: Id.nullable().optional(),
  /** 当前用户对它的权限：只在 REST 响应里给，事件里不带 */
  access: AccessLevel.optional(),
  /** 个人文档已分享给别人（邀请了人或开了链接）；只在 REST 响应里给所有者 */
  shared: z.boolean().optional(),
});
export type DocumentMeta = z.infer<typeof DocumentMeta>;

export const DocumentVersion = z.object({
  id: Id,
  documentId: Id,
  label: z.string(),
  createdBy: ActorRef,
  createdAt: Iso,
});
export type DocumentVersion = z.infer<typeof DocumentVersion>;

/** 文档大纲项（doc 的标题、slides 的每页标题、latex 的 \section）。 */
export const DocumentOutlineItem = z.object({
  heading: z.string(),
  level: z.number().int().min(1).max(6),
});
export type DocumentOutlineItem = z.infer<typeof DocumentOutlineItem>;

/** LaTeX 工程里的一个文件（main.tex = Y.Text `source`；其余见 LATEX_YDOC）。 */
export const LatexProjectFile = z.object({
  /** 工程内路径，如 `main.tex`、`references.bib`、`figures/arch.png` */
  name: z.string(),
  kind: z.enum(['main', 'text', 'image']),
  /** 字节数（文本按 UTF-8） */
  size: z.number().int(),
});
export type LatexProjectFile = z.infer<typeof LatexProjectFile>;

/** GET P/docs/:docId/markdown 与 agent read 的结果。 */
export const DocumentContent = z.object({
  meta: DocumentMeta,
  markdown: z.string(),
  outline: z.array(DocumentOutlineItem),
  /** 仅 latex：工程文件列表（第一项是 main.tex）；没有辅助文件时省略 */
  files: z.array(LatexProjectFile).optional(),
});
export type DocumentContent = z.infer<typeof DocumentContent>;

export const DocumentSearchHit = z.object({
  id: Id,
  kind: DocumentKind,
  title: z.string(),
  snippet: z.string(),
});
export type DocumentSearchHit = z.infer<typeof DocumentSearchHit>;

/**
 * 富文本的行内评论锚点：选区两端的 Y.RelativePosition（`Y.relativePositionToJSON` 的结果）。
 * 锚点不写进文档内容；各端用 Yjs 结构把它换算回当前位置，所以并发编辑后仍指向同一段文字。
 */
export const DocCommentAnchor = z.object({
  start: z.record(z.string(), z.unknown()),
  end: z.record(z.string(), z.unknown()),
});
export type DocCommentAnchor = z.infer<typeof DocCommentAnchor>;

/**
 * 文档行内评论（飞书式批注）。parentId 为 null 的是评论串首条：anchor / quote / resolved 只看首条；
 * 回复的 parentId 指向首条。
 */
export const DocComment = z.object({
  id: Id,
  documentId: Id,
  projectId: Id,
  parentId: Id.nullable(),
  author: ActorRef,
  body: z.string(),
  /** 正文里 @ 到的成员 id */
  mentions: z.array(Id),
  anchor: DocCommentAnchor.nullable(),
  /** 评论时选中的原文（锚点失效时用来提示） */
  quote: z.string(),
  resolved: z.boolean(),
  resolvedBy: ActorRef.nullable(),
  resolvedAt: Iso.nullable(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type DocComment = z.infer<typeof DocComment>;

/**
 * 富文本里的特殊块在 markdown 里的写法（服务端转换器、agent 读写共用）：
 * - 图片：独占一段的 `![说明](地址 "图注")`
 * - 附件：独占一段的 `[📎 文件名](地址)`
 * - 内嵌文档：独占一段的 `[嵌入表格：标题](doc:<docId>)`（表格 / 幻灯片 / 文档 / LaTeX 论文）
 * - @提及：行内 `[@名字](mention:<userId>)`
 */
export const DOC_EMBED_SCHEME = 'doc:';
export const DOC_MENTION_SCHEME = 'mention:';
export const DOC_ATTACHMENT_PREFIX = '📎 ';

export function docEmbedLabel(kind: DocumentKind, title: string): string {
  return tr('嵌入{value}：{title}', { value: DOCUMENT_KIND_LABEL[kind], title });
}

/** `嵌入表格：标题` → { kind, title }；不是内嵌写法返回 null。 */
export function parseDocEmbedLabel(text: string): { kind: DocumentKind; title: string } | null {
  const m = /^嵌入(表格|幻灯片|文档|LaTeX 论文|LaTeX)[：:]\s*(.*)$/u.exec(text.trim());
  if (!m) return null;
  const kind: DocumentKind =
    m[1] === '表格' ? 'sheet' : m[1] === '幻灯片' ? 'slides' : m[1] === '文档' ? 'doc' : 'latex';
  return { kind, title: (m[2] ?? '').trim() };
}

// ---------------------------------------------------------------- 看板与待办

export const BoardColumn = z.object({
  id: Id,
  boardId: Id,
  name: z.string(),
  /** 排序用分数位置（fractional index 字符串） */
  position: z.string(),
  color: z.number().int().min(0).max(7).nullable(),
});
export type BoardColumn = z.infer<typeof BoardColumn>;

export const Card = z.object({
  id: Id,
  boardId: Id,
  columnId: Id,
  title: z.string(),
  description: z.string(),
  position: z.string(),
  /** 成员 id 或 agent 指派（见 AGENT_ASSIGNEE_PREFIX） */
  assigneeIds: z.array(Id),
  labels: z.array(z.string()),
  dueAt: Iso.nullable(),
  threadId: Id.nullable(),
  experimentId: Id.nullable(),
  version: z.number().int(),
  createdBy: ActorRef,
  createdAt: Iso,
  updatedAt: Iso,
});
export type Card = z.infer<typeof Card>;

export const Board = z.object({
  id: Id,
  projectId: Id,
  name: z.string(),
  columns: z.array(BoardColumn),
  createdAt: Iso,
});
export type Board = z.infer<typeof Board>;

export const Todo = z.object({
  id: Id,
  projectId: Id,
  /** null = 项目共享待办；否则为某人的个人待办 */
  ownerUserId: Id.nullable(),
  /** 成员 id 或 agent 指派（见 AGENT_ASSIGNEE_PREFIX） */
  assigneeId: Id.nullable(),
  title: z.string(),
  notes: z.string(),
  done: z.boolean(),
  priority: TodoPriority,
  dueAt: Iso.nullable(),
  position: z.string(),
  /** 来源（例如从组会汇报里拆出来的） */
  source: z.object({ kind: z.string(), id: Id }).nullable(),
  createdBy: ActorRef,
  createdAt: Iso,
  completedAt: Iso.nullable(),
});
export type Todo = z.infer<typeof Todo>;

// ---------------------------------------------------------------- 实验记录

/** 参数与指标的取值：数字或短文本 */
export const MetricValue = z.union([z.number(), z.string()]);
export type MetricValue = z.infer<typeof MetricValue>;

/** 实验关联的对象：线程、消息（agent 的改动）、文档、文件、产出、审阅 */
export const ExperimentLink = z.object({
  kind: z.enum(['thread', 'message', 'document', 'file', 'output', 'review', 'url']),
  ref: z.string(),
  title: z.string(),
});
export type ExperimentLink = z.infer<typeof ExperimentLink>;

export const Experiment = z.object({
  id: Id,
  projectId: Id,
  title: z.string(),
  hypothesis: z.string(),
  /** 实验设置（markdown） */
  setup: z.string(),
  status: ExperimentStatus,
  /** 超参数 / 配置，如 { "lr": 0.001, "seed": 42 } */
  params: z.record(z.string(), MetricValue),
  /** 关键指标（结论用），如 { "acc": 0.913, "loss": 0.21 } */
  metrics: z.record(z.string(), MetricValue),
  conclusion: z.string(),
  tags: z.array(z.string()),
  links: z.array(ExperimentLink),
  ownerUserId: Id.nullable(),
  threadId: Id.nullable(),
  createdBy: ActorRef,
  startedAt: Iso.nullable(),
  endedAt: Iso.nullable(),
  version: z.number().int(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Experiment = z.infer<typeof Experiment>;

export const ExperimentLog = z.object({
  id: Id,
  experimentId: Id,
  author: ActorRef,
  body: z.string(),
  /** 本次运行记录的原始数字 */
  metrics: z.record(z.string(), MetricValue),
  attachments: z.array(OutputRef),
  createdAt: Iso,
});
export type ExperimentLog = z.infer<typeof ExperimentLog>;

// ---------------------------------------------------------------- 审阅

export const ReviewParticipant = z.object({
  userId: Id,
  verdict: ReviewVerdict,
  updatedAt: Iso,
});
export type ReviewParticipant = z.infer<typeof ReviewParticipant>;

export const Review = z.object({
  id: Id,
  projectId: Id,
  targetKind: ReviewTargetKind,
  targetId: Id,
  title: z.string(),
  summary: z.string(),
  requestedBy: ActorRef,
  /** 发起审阅的线程（agent 请求审阅时），结论会唤醒该线程 */
  threadId: Id.nullable(),
  status: ReviewStatus,
  reviewers: z.array(ReviewParticipant),
  /** 发起时目标内容的 markdown 快照（像 PR 的 diff 基线）；无法快照的目标为 null */
  snapshot: z.string().nullable(),
  /** 被同一目标的新一轮审阅取代时指向新审阅（本审阅已随之关闭）；未被取代为 null */
  supersededById: Id.nullable().optional(),
  commentCount: z.number().int(),
  createdAt: Iso,
  updatedAt: Iso,
  closedAt: Iso.nullable(),
});
export type Review = z.infer<typeof Review>;

export const ReviewComment = z.object({
  id: Id,
  reviewId: Id,
  author: ActorRef,
  body: z.string(),
  /** 结论评论（LGTM / 要求修改）带上 verdict，普通评论为 null */
  verdict: ReviewVerdict.nullable(),
  /** 锚点：{ quote } 引用的原文片段、消息 id、实验字段等 */
  anchor: z.record(z.string(), z.unknown()).nullable(),
  resolved: z.boolean(),
  createdAt: Iso,
});
export type ReviewComment = z.infer<typeof ReviewComment>;

// ---------------------------------------------------------------- 组会汇报

export const ReportStats = z.object({
  threads: z.number().int(),
  messages: z.number().int(),
  experiments: z.number().int(),
  researchRecords: z.number().int().optional(),
  reviews: z.number().int(),
  todos: z.number().int(),
  documents: z.number().int(),
});
export type ReportStats = z.infer<typeof ReportStats>;

export const Report = z.object({
  id: Id,
  projectId: Id,
  title: z.string(),
  periodStart: Iso,
  periodEnd: Iso,
  status: ReportStatus,
  /** markdown 正文；定稿后可另存为协同文档 */
  content: z.string(),
  documentId: Id.nullable(),
  /** 生成时收集到的上下文规模 */
  stats: ReportStats.nullable(),
  /** 生成失败的原因（中文），成功为 null */
  error: z.string().nullable(),
  /** 乐观并发版本：PATCH 带 baseVersion 时比对，每次写入 +1 */
  version: z.number().int(),
  /**
   * 只在 GET 单个汇报时给出：汇报最后一次写入之后，项目里又被改过 / 新建的文档和实验记录（最多 8 条）。
   * 非空说明汇报里的数字和结论可能已经过期，前端提示并提供「重新生成」。
   */
  outdatedBy: z
    .array(
      z.object({
        kind: z.enum(['document', 'experiment', 'research']),
        id: Id,
        title: z.string(),
        updatedAt: Iso,
      }),
    )
    .optional(),
  createdBy: ActorRef,
  createdAt: Iso,
  updatedAt: Iso,
});
export type Report = z.infer<typeof Report>;

/**
 * 四类文档在 Y.Doc 里的结构（服务端转换器与前端编辑器共用，改动需两边同步）：
 * - doc：Y.XmlFragment `default`（Tiptap Collaboration 的默认字段）
 * - sheet：Y.Map `cells`（键 `r:c`，0 起；值为原始输入字符串）+ Y.Map `sheet`
 *   （`rows`、`cols` 数字，`colWidths` Y.Map<colIndex, px>）
 * - slides：Y.Array `slides`，每项 Y.Map 一页：v2 为 `{ id, order（fractional 键，页顺序）, v: 2, layout,
 *   elements: Y.Map<id, 元素 Y.Map>, bg?, notes: Y.Text }`，页面尺寸 / 主题在 Y.Map `slidesMeta`；
 *   旧版 v1 为 `id`、`layout`、`title`/`body`/`notes` 为 Y.Text（详见 API.md §2.7.1）
 * - latex：Y.Text `source`
 */
export const YDOC_FIELD = {
  doc: 'default',
  sheetCells: 'cells',
  sheetMeta: 'sheet',
  slides: 'slides',
  latex: 'source',
} as const;

export const SHEET_DEFAULT_SIZE = { rows: 50, cols: 12 } as const;

/**
 * 从文件导入（POST P/docs/import）：请求体是前端导入器生成的 Yjs 更新（`Y.encodeStateAsUpdate`），
 * 上限 DOC_IMPORT_MAX_BYTES；上传的原始文件本身由前端检查 DOC_IMPORT_FILE_MAX_BYTES。
 */
export const DOC_IMPORT_MAX_BYTES = 16 * 1024 * 1024;
export const DOC_IMPORT_FILE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * 表格 v2（多工作表，API.md §2.7.1）。上面的 `cells` / `sheet` 是 v1 单表结构，打开时惰性迁移到这里。
 * 全部用根级共享类型（并发创建同名根类型会合并而不是互相覆盖）：
 * - `sheetOrder`：Y.Array<工作表 id>（读时去重）
 * - `sheetInfo`：Y.Map<工作表 id, { name, hidden?, color? }>
 * - `cellStyles`：Y.Map<样式 id, 样式对象>（按内容哈希得到 id，单元格只引用 id）
 * - 每张表 `sheet:<id>:<part>`，part 见 SHEET_PARTS：rows / cols 为 Y.Array<行/列 id>（读时去重），
 *   cells Y.Map<"行id:列id", 原始输入>，fmt Y.Map<"行id:列id", 样式 id>，rowp / colp 行高列宽与隐藏，
 *   merges 合并区域，view 冻结与筛选，cache 导入时 Excel 的公式缓存值。
 */
export const SHEET_YDOC = {
  order: 'sheetOrder',
  info: 'sheetInfo',
  styles: 'cellStyles',
} as const;
export const SHEET_PARTS = [
  'rows',
  'cols',
  'cells',
  'fmt',
  'rowp',
  'colp',
  'merges',
  'view',
  'cache',
] as const;
export type SheetPart = (typeof SHEET_PARTS)[number];
export function sheetTypeName(sheetId: string, part: SheetPart): string {
  return `sheet:${sheetId}:${part}`;
}
/** 第一张表、迁移出来的表与默认表都用确定的 id（行列 id 为 r0… / c0…），并发创建时自然合并 */
export const SHEET_FIRST_ID = 's1';
export const SHEET_LIMITS = {
  rows: 100_000,
  cols: 1000,
  defaultRows: 100,
  defaultCols: 26,
} as const;

// ---------------------------------------------------------------- LaTeX 工程（多文件、编译）

/**
 * LaTeX 文档除了 Y.Text `source`（= main.tex）之外的工程文件，存在同一个 Y.Doc 里：
 * - `files`：Y.Map<路径, Y.Text>，文本文件（references.bib、sections/intro.tex、自定义 .sty…）
 * - `assets`：Y.Map<路径, LatexAsset>，图片等二进制文件；本体在项目文件夹（files 模块），这里只存引用
 */
export const LATEX_YDOC = { files: 'files', assets: 'assets' } as const;
export const LATEX_MAIN_FILE = 'main.tex';
export const LATEX_TEXT_EXTS = ['tex', 'bib', 'sty', 'cls', 'bst', 'txt', 'csv', 'dat'] as const;
export const LATEX_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'pdf'] as const;
/** 工程文件数、单个文本文件长度上限（前后端一致） */
export const LATEX_LIMITS = {
  files: 60,
  textChars: 500_000,
  assetBytes: 20 * 1024 * 1024,
} as const;

export const LatexAsset = z.object({
  /** 项目文件 id（`fil_…`） */
  fileId: Id,
  mime: z.string(),
  size: z.number().int(),
});
export type LatexAsset = z.infer<typeof LatexAsset>;

/**
 * 工程内路径：最多三级目录，每段以字母、数字、`_` 或 `-` 开头，只含字母数字和 `._-`；
 * 扩展名必须是 LATEX_TEXT_EXTS / LATEX_IMAGE_EXTS 之一；`main.tex` 保留给主文件。
 */
export function latexFileKind(name: string): 'main' | 'text' | 'image' | null {
  if (name === LATEX_MAIN_FILE) return 'main';
  if (name.length > 120) return null;
  if (
    !/^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}\/){0,3}[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/u.test(name)
  )
    return null;
  if (name.split('/').some((seg) => seg.includes('..'))) return null;
  const ext = /\.([A-Za-z0-9]+)$/u.exec(name)?.[1]?.toLowerCase();
  if (!ext) return null;
  if ((LATEX_TEXT_EXTS as readonly string[]).includes(ext)) return 'text';
  if ((LATEX_IMAGE_EXTS as readonly string[]).includes(ext)) return 'image';
  return null;
}

/** 编译能力探测（GET P/docs/latex/capability） */
export const LatexCapability = z.object({
  available: z.boolean(),
  /** 实际使用的编译器 */
  engine: z.enum(['tectonic', 'latexmk']).nullable(),
  version: z.string().nullable(),
  /** 不可用时的原因（中文，可直接展示） */
  reason: z.string().nullable(),
  limits: z.object({ timeoutMs: z.number(), maxSourceBytes: z.number(), maxPdfBytes: z.number() }),
});
export type LatexCapability = z.infer<typeof LatexCapability>;

/**
 * 一次编译的结果（POST P/docs/:docId/latex/compile）：
 * - success：生成了 PDF，日志里没有错误
 * - error：TeX 报了错误；尽量继续排版，pdfId 不为空时仍有（可能不完整的）PDF
 * - timeout：超时被终止
 * - rejected：工程不合法（文件太大、引用了工程外的路径…），没有运行编译器，原因在 log
 */
export const LatexCompileResult = z.object({
  status: z.enum(['success', 'error', 'timeout', 'rejected']),
  /** 取 PDF：GET P/docs/:docId/latex/pdf/:pdfId */
  pdfId: z.string().nullable(),
  pdfBytes: z.number().int(),
  engine: z.string(),
  durationMs: z.number().int(),
  /** TeX 日志（main.log，前面附编译器的标准错误输出）；超长时截断 */
  log: z.string(),
  logTruncated: z.boolean(),
  /** 输入与上次相同，直接复用了上次的结果 */
  cached: z.boolean(),
  compiledAt: Iso,
});
export type LatexCompileResult = z.infer<typeof LatexCompileResult>;
