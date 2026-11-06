import { z } from 'zod';
import {
  ExperimentStatus,
  ReportStatus,
  ReviewTargetKind,
  ReviewVerdict,
  TodoPriority,
} from './enums';
import { DocCommentAnchor, DocumentKind, ExperimentLink, MetricValue } from './entities-collab';
import { ResourceSpace } from './sharing';
import { tr } from './i18n';

/**
 * 协作功能的 REST 请求体（文档、看板、待办、实验、审阅、汇报）。
 * 归属：协作功能线程。约定同 api.ts。
 */

// ---------------------------------------------------------------- 文档

export const DocumentCreateInput = z.object({
  title: z.string().trim().max(120).default(tr('未命名文档')),
  kind: DocumentKind.default('doc'),
  parentId: z.string().nullable().default(null),
  icon: z.string().max(8).nullable().default(null),
  /**
   * 可选的初始内容：doc = markdown；latex = LaTeX 源码；
   * sheet = markdown 表格或 CSV；slides = 以 `## 标题` 分页的 markdown。
   */
  markdown: z.string().max(500_000).optional(),
  /** 建在哪个空间：不传 = 团队空间（旧行为）；personal = 自己的个人空间 */
  space: ResourceSpace.optional(),
});
export type DocumentCreateInput = z.input<typeof DocumentCreateInput>;

/**
 * 从文件导入新建文档（POST P/docs/import）的查询参数；请求体是 application/octet-stream 的
 * Yjs 更新（前端导入器在空 Y.Doc 里生成的完整状态），服务端校验后和文档一起原子写入。
 */
export const DocumentImportQuery = z.object({
  title: z.string().trim().max(120).default(tr('未命名文档')),
  kind: DocumentKind,
  parentId: z.string().min(1).optional(),
  /**
   * 客户端生成的幂等键：网络中断后重试同一次导入时带上同一个值，服务端（15 分钟内）
   * 返回第一次建好的文档而不是再建一份。
   */
  importId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/u)
    .optional(),
  /** 建在哪个空间（同 DocumentCreateInput.space） */
  space: ResourceSpace.optional(),
});
export type DocumentImportQuery = z.input<typeof DocumentImportQuery>;

export const DocumentUpdateInput = z.object({
  title: z.string().trim().max(120).optional(),
  parentId: z.string().nullable().optional(),
  icon: z.string().max(8).nullable().optional(),
  archived: z.boolean().optional(),
});
export const DocumentVersionCreateInput = z.object({ label: z.string().trim().min(1).max(80) });

export const SlideInput = z.object({
  title: z.string().max(200),
  /** markdown 正文（列表、段落） */
  body: z.string().max(20_000).default(''),
  layout: z.enum(['title', 'content', 'two-column', 'section']).default('content'),
  notes: z.string().max(5000).default(''),
});
export type SlideInput = z.input<typeof SlideInput>;

/**
 * 对文档的结构化编辑（agent 工具与 POST P/docs/:docId/edit 共用），作为 Yjs 事务应用到在线文档。
 * heading 按大纲里的标题原文精确匹配。
 */
export const DocumentEdit = z.discriminatedUnion('op', [
  /** doc / latex：在末尾追加 */
  z.object({ op: z.literal('append'), markdown: z.string().max(200_000) }),
  /** doc：插到某个标题所在小节的末尾（下一个同级或更高级标题之前） */
  z.object({
    op: z.literal('insert_after_heading'),
    heading: z.string(),
    markdown: z.string().max(200_000),
  }),
  /** doc：替换某个标题下的正文（保留标题行） */
  z.object({
    op: z.literal('replace_section'),
    heading: z.string(),
    markdown: z.string().max(200_000),
  }),
  /**
   * doc / latex：替换第一处精确匹配的文本。
   * doc 里 find 可以是读出来的 markdown（含 `## 标题` 行、跨段落）：按块重建命中的那几段；
   * replace 里有空行时拆成新段落。occurrence（doc，1 起）指定替换第几处。
   */
  z.object({
    op: z.literal('replace_text'),
    find: z.string().min(1),
    replace: z.string(),
    all: z.boolean().default(false),
    occurrence: z.number().int().min(1).max(1000).optional(),
  }),
  /** doc / latex：整体替换 */
  z.object({ op: z.literal('replace_all'), markdown: z.string().max(500_000) }),
  /** sheet：写单元格（A1 记法），value 以 = 开头为公式 */
  z.object({
    op: z.literal('set_cells'),
    /** 工作表名（多表时），默认第一张；不存在则新建 */
    sheet: z.string().trim().min(1).max(100).optional(),
    cells: z
      .array(z.object({ ref: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,5}$/u), value: z.string() }))
      .max(5000),
  }),
  /** slides：在末尾追加若干页 */
  z.object({ op: z.literal('append_slides'), slides: z.array(SlideInput).max(60) }),
  /** slides：整体替换 */
  z.object({ op: z.literal('replace_slides'), slides: z.array(SlideInput).max(60) }),
]);
export type DocumentEdit = z.input<typeof DocumentEdit>;

/** 文档内嵌 AI（流式返回纯文本，POST P/docs/:docId/ai）。 */
export const DocumentAiAction = z.enum([
  'continue', // 续写
  'polish', // 润色
  'shorten', // 精简
  'expand', // 扩写
  'translate_en', // 译成英文
  'translate_zh', // 译成中文
  'summarize', // 总结
  'academic', // 改成学术语气
  'custom', // 按指令
  'outline', // 生成大纲
  'table', // 生成表格（sheet：返回 CSV）
  'slides', // 生成幻灯片（返回以 ## 分页的 markdown）
  'latex_fix', // 修复 LaTeX 编译问题
  'latex_section', // 写一个 LaTeX 小节
]);
export type DocumentAiAction = z.infer<typeof DocumentAiAction>;

export const DocumentAiInput = z.object({
  action: DocumentAiAction,
  /** 选中的文本（改写类动作必填） */
  selection: z.string().max(50_000).default(''),
  /** 自定义指令 / 主题 */
  prompt: z.string().max(4000).default(''),
});
export type DocumentAiInput = z.input<typeof DocumentAiInput>;

/** 新建行内评论（parentId 为空 = 新开一串，可带锚点与引用原文；否则是回复） */
export const DocCommentCreateInput = z.object({
  body: z.string().trim().min(1).max(10_000),
  parentId: z.string().nullable().default(null),
  anchor: DocCommentAnchor.nullable().default(null),
  quote: z.string().max(2000).default(''),
  /** @ 到的成员 id（会收到“待我处理”的 mention 提醒） */
  mentions: z.array(z.string()).max(20).default([]),
});
export type DocCommentCreateInput = z.input<typeof DocCommentCreateInput>;

/** 改正文（只限作者）或解决 / 重新打开（只对首条） */
export const DocCommentUpdateInput = z.object({
  body: z.string().trim().min(1).max(10_000).optional(),
  mentions: z.array(z.string()).max(20).optional(),
  resolved: z.boolean().optional(),
});
export type DocCommentUpdateInput = z.input<typeof DocCommentUpdateInput>;

/** 正文里 @ 了成员：给他们发提醒 */
export const DocMentionInput = z.object({
  userIds: z.array(z.string()).min(1).max(20),
  /** @ 所在的上下文（一小段原文），放进提醒标题 */
  context: z.string().max(200).default(''),
});
export type DocMentionInput = z.input<typeof DocMentionInput>;

// ---------------------------------------------------------------- 看板与待办

export const BoardCreateInput = z.object({
  name: z.string().trim().min(1).max(60),
  /** 不传则使用默认列：想法 / 进行中 / 待审阅 / 完成 */
  columns: z.array(z.string().max(30)).max(12).optional(),
});
export const BoardUpdateInput = z.object({ name: z.string().trim().min(1).max(60) });
export const ColumnUpsertInput = z.object({
  name: z.string().trim().min(1).max(30),
  position: z.string().optional(),
  color: z.number().int().min(0).max(7).nullable().optional(),
});
export const CardCreateInput = z.object({
  columnId: z.string(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).default(''),
  assigneeIds: z.array(z.string()).max(20).default([]),
  labels: z.array(z.string().max(20)).max(10).default([]),
  dueAt: z.string().nullable().default(null),
  threadId: z.string().nullable().default(null),
  experimentId: z.string().nullable().default(null),
  /** 插在哪张卡之后（null = 列首；不传 = 列尾） */
  afterCardId: z.string().nullable().optional(),
});
export type CardCreateInput = z.input<typeof CardCreateInput>;
export const CardUpdateInput = z.object({
  columnId: z.string().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(20_000).optional(),
  assigneeIds: z.array(z.string()).max(20).optional(),
  labels: z.array(z.string().max(20)).max(10).optional(),
  dueAt: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
  experimentId: z.string().nullable().optional(),
  /** 移动：插在哪张卡之后（null = 列首） */
  afterCardId: z.string().nullable().optional(),
  baseVersion: z.number().int(),
});
export type CardUpdateInput = z.input<typeof CardUpdateInput>;

export const TodoCreateInput = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(5000).default(''),
  personal: z.boolean().default(false),
  assigneeId: z.string().nullable().default(null),
  priority: TodoPriority.default('normal'),
  dueAt: z.string().nullable().default(null),
  source: z
    .object({ kind: z.string().max(30), id: z.string() })
    .nullable()
    .default(null),
});
export type TodoCreateInput = z.input<typeof TodoCreateInput>;
export const TodoUpdateInput = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  notes: z.string().max(5000).optional(),
  personal: z.boolean().optional(),
  assigneeId: z.string().nullable().optional(),
  priority: TodoPriority.optional(),
  dueAt: z.string().nullable().optional(),
  done: z.boolean().optional(),
  /** 拖动排序：插在哪条之后（null = 最前） */
  afterTodoId: z.string().nullable().optional(),
});
export type TodoUpdateInput = z.input<typeof TodoUpdateInput>;

// ---------------------------------------------------------------- 实验

export const ExperimentCreateInput = z.object({
  title: z.string().trim().min(1).max(120),
  hypothesis: z.string().max(5000).default(''),
  setup: z.string().max(50_000).default(''),
  status: ExperimentStatus.default('planned'),
  params: z.record(z.string().max(60), MetricValue).default({}),
  tags: z.array(z.string().max(20)).max(10).default([]),
  links: z.array(ExperimentLink).max(50).default([]),
  threadId: z.string().nullable().default(null),
});
export type ExperimentCreateInput = z.input<typeof ExperimentCreateInput>;
export const ExperimentUpdateInput = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  hypothesis: z.string().max(5000).optional(),
  setup: z.string().max(50_000).optional(),
  status: ExperimentStatus.optional(),
  params: z.record(z.string().max(60), MetricValue).optional(),
  metrics: z.record(z.string().max(60), MetricValue).optional(),
  conclusion: z.string().max(20_000).optional(),
  tags: z.array(z.string().max(20)).max(10).optional(),
  links: z.array(ExperimentLink).max(50).optional(),
  threadId: z.string().nullable().optional(),
  baseVersion: z.number().int(),
});
export type ExperimentUpdateInput = z.input<typeof ExperimentUpdateInput>;
export const ExperimentLogCreateInput = z.object({
  body: z.string().trim().min(1).max(50_000),
  metrics: z.record(z.string().max(60), MetricValue).default({}),
  fileIds: z.array(z.string()).max(20).default([]),
});
export type ExperimentLogCreateInput = z.input<typeof ExperimentLogCreateInput>;

// ---------------------------------------------------------------- 审阅

export const ReviewCreateInput = z.object({
  targetKind: ReviewTargetKind,
  targetId: z.string(),
  title: z.string().trim().min(1).max(120),
  summary: z.string().max(10_000).default(''),
  reviewerIds: z.array(z.string()).min(1).max(10),
  /** 发起审阅的线程；结论会唤醒它 */
  threadId: z.string().nullable().default(null),
});
export type ReviewCreateInput = z.input<typeof ReviewCreateInput>;
export const ReviewVerdictInput = z.object({
  verdict: ReviewVerdict.exclude(['pending']),
  comment: z.string().max(10_000).optional(),
});
export const ReviewCommentCreateInput = z.object({
  body: z.string().trim().min(1).max(10_000),
  anchor: z.record(z.string(), z.unknown()).nullable().default(null),
});
export const ReviewCommentUpdateInput = z.object({ resolved: z.boolean() });

// ---------------------------------------------------------------- 组会汇报

export const ReportCreateInput = z.object({
  title: z.string().trim().max(120).optional(),
  periodStart: z.string(),
  periodEnd: z.string(),
  /** true = 从项目上下文自动生成草稿 */
  generate: z.boolean().default(true),
  /** 额外要求，如“重点讲消融实验” */
  instructions: z.string().max(2000).default(''),
});
export type ReportCreateInput = z.input<typeof ReportCreateInput>;
export const ReportUpdateInput = z.object({
  title: z.string().trim().max(120).optional(),
  content: z.string().max(200_000).optional(),
  status: ReportStatus.exclude(['generating']).optional(),
  /** 带上时做乐观并发：与当前版本不一致 → 409 version_conflict + details.current；不带 = 直接写（兼容旧调用） */
  baseVersion: z.number().int().optional(),
});
export const ReportRegenerateInput = z.object({
  instructions: z.string().max(2000).default(''),
});
/** 把汇报里的“下期计划”拆成待办 */
export const ReportTodosInput = z.object({
  items: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        assigneeId: z.string().nullable().default(null),
      }),
    )
    .min(1)
    .max(50),
});

// ---------------------------------------------------------------- LaTeX 编译

/** POST P/docs/:docId/latex/compile：编译服务端 Y.Doc 里的当前工程（main.tex + 辅助文件） */
export const LatexCompileInput = z.object({
  /** true = 忽略“输入没变就复用上次结果”的缓存，强制重新编译 */
  force: z.boolean().default(false),
});
export type LatexCompileInput = z.input<typeof LatexCompileInput>;
