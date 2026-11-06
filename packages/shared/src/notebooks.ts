import { z } from 'zod';
import { ActorRef } from './entities';
import { tr } from './i18n';

const Id = z.string();

/**
 * Notebook（Jupyter 式实验笔记本）。归属：后端线程（modules/notebooks）。
 *
 * 内容不走 REST，走 /collab/:notebookId（Hocuspocus，与协同文档同一协议）。Y.Doc 布局：
 *
 *   doc.getArray('cells')  Y.Array<Y.Map>，每个单元格：
 *     id               string（稳定 id，nbformat 4.5 的 cell.id）
 *     type             'code' | 'markdown' | 'raw'
 *     source           Y.Text（多人光标绑定在这里）
 *     outputs          Y.Array<NbOutput>（只有服务端执行时写；客户端只能整体清空）
 *     execution_count  number | null
 *     metadata         Y.Map（collapsed: 输出折叠, source_hidden: 代码折叠, scrolled, tags…）
 *   doc.getMap('runs')    cellId → NotebookRun（排队 / 正在运行；结束即删除）。服务端写。
 *   doc.getMap('kernel')  KernelState 的字段（status、execution_count、language、startedAt、error）。服务端写。
 *   doc.getMap('meta')    title、language、kernelspec 等 notebook 级 metadata。
 *
 * awareness 与协同文档相同（API.md §3.2），另加 `cell: <cellId>` 表示正在编辑哪个单元格、
 * `mode: 'command' | 'edit'`。
 */
export const NotebookCellType = z.enum(['code', 'markdown', 'raw']);
export type NotebookCellType = z.infer<typeof NotebookCellType>;

/** nbformat v4 的输出（原样存，导出 .ipynb 时直接写出） */
export type NbMimeBundle = Record<string, unknown>;
export type NbOutput =
  | { output_type: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | {
      output_type: 'display_data';
      data: NbMimeBundle;
      metadata: Record<string, unknown>;
      /** display_id（update_display_data 用），不进 .ipynb */
      transient?: { display_id?: string };
    }
  | {
      output_type: 'execute_result';
      execution_count: number | null;
      data: NbMimeBundle;
      metadata: Record<string, unknown>;
    }
  | { output_type: 'error'; ename: string; evalue: string; traceback: string[] };

export const KernelStatus = z.enum([
  /** 还没启动（第一次运行时自动启动） */
  'none',
  'starting',
  'idle',
  'busy',
  'restarting',
  /** 内核崩溃或被杀；下次运行时重启 */
  'dead',
  /** 服务器没配内核服务（KERNEL_GATEWAY_URL） */
  'unavailable',
]);
export type KernelStatus = z.infer<typeof KernelStatus>;

export const KernelState = z.object({
  status: KernelStatus,
  language: z.string(),
  /** 最后一次执行计数 */
  executionCount: z.number().int(),
  startedAt: z.string().nullable(),
  /** 最近一次出错原因（启动失败、内核崩溃） */
  error: z.string().nullable(),
});
export type KernelState = z.infer<typeof KernelState>;

export const NotebookRun = z.object({
  runId: z.string(),
  state: z.enum(['queued', 'running']),
  by: ActorRef,
  at: z.string(),
});
export type NotebookRun = z.infer<typeof NotebookRun>;

export const Notebook = z.object({
  id: Id,
  projectId: Id,
  /** 挂在哪个实验记录上；独立 notebook 为 null */
  /** @deprecated 实验功能已移除，响应始终为 null。 */
  experimentId: Id.nullable(),
  title: z.string(),
  language: z.string(),
  cellCount: z.number().int(),
  createdBy: ActorRef,
  updatedBy: ActorRef.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Notebook = z.infer<typeof Notebook>;

export const NotebookVariable = z.object({
  name: z.string(),
  type: z.string(),
  /** repr 摘要，≤200 字 */
  summary: z.string(),
  /** 数组 / DataFrame 的形状，如 "(100, 3)" */
  shape: z.string().nullable(),
  /** 字节数估计 */
  size: z.number().nullable(),
});
export type NotebookVariable = z.infer<typeof NotebookVariable>;

export const NOTEBOOK_EXPORT_FORMATS = ['ipynb', 'py', 'html', 'pdf', 'md', 'zip'] as const;
export const NotebookExportFormat = z.enum(NOTEBOOK_EXPORT_FORMATS);
export type NotebookExportFormat = z.infer<typeof NotebookExportFormat>;

// ---------------------------------------------------------------- 请求体

export const NotebookCreateInput = z.object({
  title: z.string().trim().min(1).max(200).default(tr('未命名 Notebook')),
  /** @deprecated 实验功能已移除，响应始终为 null。 */
  experimentId: Id.nullable().default(null),
  /** 从 .ipynb 导入：nbformat v4 JSON（对象或字符串） */
  ipynb: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
});
export type NotebookCreateInput = z.input<typeof NotebookCreateInput>;

export const NotebookUpdateInput = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});
export type NotebookUpdateInput = z.input<typeof NotebookUpdateInput>;

/** 用 .ipynb 整体替换内容（导入到已有 notebook） */
export const NotebookImportInput = z.object({
  ipynb: z.union([z.string(), z.record(z.string(), z.unknown())]),
});
export type NotebookImportInput = z.input<typeof NotebookImportInput>;

export const NotebookExecuteInput = z.object({
  /** 按给定顺序排队执行；空数组 = 全部代码单元格 */
  cellIds: z.array(z.string()).max(500).default([]),
});
export type NotebookExecuteInput = z.input<typeof NotebookExecuteInput>;

export const NotebookRestartInput = z.object({
  /** 重启后从头运行全部单元格（Restart & Run All） */
  runAll: z.boolean().default(false),
  /** 重启时清空全部输出（Restart & Clear Output） */
  clearOutputs: z.boolean().default(false),
});
export type NotebookRestartInput = z.input<typeof NotebookRestartInput>;

export const NotebookListQuery = z.object({
  /** @deprecated 实验功能已移除，响应始终为 null。 */
  experimentId: z.string().optional(),
});
export type NotebookListQuery = z.input<typeof NotebookListQuery>;

/**
 * 运行结果里的实验参数 / 指标：内核里预置了 `srh` 模块，
 *   srh.log_param("lr", 3e-4)   srh.log_metric("acc", 0.91)   srh.log({"loss": 0.3})
 * 它输出一个 display_data，MIME 为 NOTEBOOK_METRICS_MIME；服务端看到后写进实验记录的 params / metrics。
 */
export const NOTEBOOK_METRICS_MIME = 'application/vnd.srh.metrics+json';
