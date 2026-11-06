import { z } from 'zod';
import * as Y from 'yjs';
import { NOTEBOOK_METRICS_MIME, type NbOutput } from '@srh/shared';
import { withLiveDocument } from '../../realtime/collab';
import { executeCells, kernelManager } from '../../modules/notebooks';
import { cellsOf, findCell, makeCell } from '../../modules/notebooks/nbformat';
import { createNotebook, listNotebooks, readPlainNotebook } from '../../modules/notebooks/service';
import { proposeNotebookEditIfNeeded } from '../../modules/versioning/proposals';
import { ALL_ROLES, defineTool, ToolError, WORKER_ROLES, type ToolDef } from './types';

/**
 * Notebook 工具：list_notebooks、read_notebook、edit_notebook、run_notebook_cells。
 * 编辑走协同文档（在线的人实时看到 agent 插入 / 修改的单元格）；运行走同一个内核队列，
 * 单元格旁会显示「正在运行 · 研协」，输出流式出现在所有人的页面上。
 */

const MAX_TEXT = 4000;
const MAX_CELL_SOURCE = 100_000;

function clip(s: string, n = MAX_TEXT): string {
  return s.length > n ? `${s.slice(0, n)}\n…（截断，共 ${s.length} 字）` : s;
}

function text(v: unknown): string {
  return Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '';
}

// eslint-disable-next-line no-control-regex -- 去掉 traceback 里的 ANSI 颜色
const ANSI = /\x1b\[[\d;?]*[A-Za-z]/g;

/** 图像输出的引用：view_image 用它读图（cell 序号、output 序号都从 0 开始） */
export function notebookImageRef(notebookId: string, cell: number, output: number): string {
  return `notebook:${notebookId}#cell${cell}/out${output}`;
}

/**
 * 给模型看的输出摘要：文字照给，图片只说有图。
 * 给了 ref（notebook id + 单元格序号）时，图像带上 view_image 能读的引用。
 */
export function summarizeOutputs(
  outputs: NbOutput[],
  ref?: { notebookId: string; cell: number },
): string[] {
  const out: string[] = [];
  for (const [oi, o] of outputs.entries()) {
    if (o.output_type === 'stream') {
      out.push(`[${o.name}] ${clip(text(o.text))}`);
    } else if (o.output_type === 'error') {
      const tb = (o.traceback ?? []).join('\n').replace(ANSI, '');
      out.push(`[error] ${o.ename}: ${o.evalue}\n${clip(tb, 2500)}`);
    } else {
      const d = o.data;
      if (d[NOTEBOOK_METRICS_MIME]) {
        out.push(`[Notebook 运行值] ${JSON.stringify(d[NOTEBOOK_METRICS_MIME])}`);
      } else if (d['image/png'] || d['image/jpeg'] || d['image/svg+xml']) {
        const alt = d['text/plain'] ? `：${clip(text(d['text/plain']), 200)}` : '';
        const see =
          ref && (d['image/png'] || d['image/jpeg'])
            ? ` ref=${notebookImageRef(ref.notebookId, ref.cell, oi)}（用 view_image 查看）`
            : '';
        out.push(`[图像${alt}]${see}`);
      } else if (d['text/plain'] !== undefined) {
        out.push(
          `[${o.output_type === 'execute_result' ? 'result' : 'display'}] ${clip(text(d['text/plain']))}`,
        );
      } else if (d['text/html'] !== undefined) {
        out.push(
          `[html] ${clip(
            text(d['text/html'])
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' '),
            1500,
          )}`,
        );
      } else if (d['text/markdown'] !== undefined) {
        out.push(`[markdown] ${clip(text(d['text/markdown']))}`);
      } else {
        out.push(`[${Object.keys(d).join(', ')}]`);
      }
    }
  }
  return out;
}

/** 代码在画图但输出里没有图像（常见：matplotlib.use("Agg")、只 savefig） */
export function plotsWithoutImage(source: string, outputs: NbOutput[]): boolean {
  if (!/\bplt\.|\.savefig\(|\bsns\.|\.plot\(/u.test(source)) return false;
  if (outputs.some((o) => o.output_type === 'error')) return false;
  return !outputs.some(
    (o) =>
      (o.output_type === 'display_data' || o.output_type === 'execute_result') &&
      (o.data['image/png'] || o.data['image/jpeg'] || o.data['image/svg+xml']),
  );
}

async function notebookFor(
  _tc: Parameters<ToolDef['run']>[0],
  args: { notebook_id?: string | undefined },
) {
  if (args.notebook_id) return args.notebook_id;
  throw new ToolError('需要 notebook_id');
}
const Target = {
  notebook_id: z
    .string()
    .optional()
    .describe('Notebook id；edit_notebook 不提供时创建独立 Notebook'),
};

const EditOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('insert'),
    type: z.enum(['code', 'markdown']).default('code'),
    source: z.string().max(MAX_CELL_SOURCE),
    after_cell_id: z
      .string()
      .optional()
      .describe('插在这个单元格后面；不给就追加到末尾；给 "start" 插到最前'),
  }),
  z.object({
    op: z.literal('replace'),
    cell_id: z.string(),
    source: z.string().max(MAX_CELL_SOURCE),
  }),
  z.object({ op: z.literal('delete'), cell_id: z.string() }),
]);

export const notebookTools: ToolDef[] = [
  defineTool({
    name: 'list_notebooks',
    description: '列出项目里的 Jupyter Notebook。',
    roles: ALL_ROLES,
    schema: z.object({}),
    async run(tc) {
      const list = await listNotebooks(tc.ctx, tc.project.id);
      return {
        notebooks: list.map((n) => ({
          id: n.id,
          title: n.title,
          cells: n.cellCount,
          updated_at: n.updatedAt,
        })),
      };
    },
  }),

  defineTool({
    name: 'read_notebook',
    description:
      '读 notebook 的全部单元格：id、类型、代码 / Markdown 源码、执行序号，以及输出摘要（文字、报错、是否有图）。改之前先读。',
    roles: ALL_ROLES,
    schema: z.object({
      ...Target,
      include_outputs: z.boolean().default(true),
    }),
    async run(tc, args) {
      const id = await notebookFor(tc, args);
      const { meta, nb } = await readPlainNotebook(tc.ctx, tc.project.id, id);
      return {
        notebook_id: meta.id,
        title: meta.title,
        kernel: kernelManager(tc.ctx).kernelStatus(meta.id),
        cells: nb.cells.map((c, i) => ({
          index: i,
          id: c.id,
          type: c.type,
          source: clip(c.source, 8000),
          ...(c.type === 'code' ? { execution_count: c.executionCount } : {}),
          ...(args.include_outputs && c.outputs.length
            ? { outputs: summarizeOutputs(c.outputs, { notebookId: meta.id, cell: i }) }
            : {}),
        })),
      };
    },
  }),

  defineTool({
    name: 'edit_notebook',
    description:
      '修改 notebook：插入、替换或删除单元格（按顺序执行一组操作）。打开着的人会实时看到。' +
      '不提供 notebook_id 时先创建独立 Notebook。改完要跑就再调 run_notebook_cells。',
    roles: WORKER_ROLES,
    schema: z.object({
      ...Target,
      ops: z.array(EditOp).min(1).max(50),
      reason: z
        .string()
        .max(1000)
        .optional()
        .describe('为什么这样改，一两句话；改动需要审阅时作为提案说明给审阅人看'),
    }),
    async run(tc, args) {
      let id: string;
      let created = false;
      try {
        id = await notebookFor(tc, args);
      } catch (err) {
        if (args.notebook_id) throw err;
        const nb = await createNotebook(tc.ctx, tc.actor, tc.project.id, {
          title: '研究 Notebook',
        });
        id = nb.id;
        created = true;
      }
      // 确认 notebook 属于本项目
      await readPlainNotebook(tc.ctx, tc.project.id, id);
      const edit = (doc: Y.Doc) => {
        const res: { op: string; cell_id: string }[] = [];
        const cells = cellsOf(doc);
        // 新建的 notebook 里只有一个空单元格：第一次插入直接替换它
        const onlyEmpty =
          cells.length === 1 && String(cells.get(0).get('source') ?? '').trim() === '';
        doc.transact(() => {
          if (onlyEmpty && args.ops[0]?.op === 'insert') cells.delete(0, 1);
          for (const op of args.ops) {
            if (op.op === 'insert') {
              let at = cells.length;
              if (op.after_cell_id === 'start') at = 0;
              else if (op.after_cell_id) {
                const f = findCell(doc, op.after_cell_id);
                if (!f) throw new ToolError(`找不到单元格 ${op.after_cell_id}`);
                at = f.index + 1;
              }
              const m = makeCell({ type: op.type, source: op.source });
              cells.insert(at, [m]);
              res.push({ op: 'insert', cell_id: String(m.get('id')) });
            } else if (op.op === 'replace') {
              const f = findCell(doc, op.cell_id);
              if (!f) throw new ToolError(`找不到单元格 ${op.cell_id}`);
              const src = f.cell.get('source');
              if (src instanceof Y.Text) {
                src.delete(0, src.length);
                src.insert(0, op.source);
              } else f.cell.set('source', new Y.Text(op.source));
              res.push({ op: 'replace', cell_id: op.cell_id });
            } else {
              const f = findCell(doc, op.cell_id);
              if (!f) throw new ToolError(`找不到单元格 ${op.cell_id}`);
              cells.delete(f.index, 1);
              res.push({ op: 'delete', cell_id: op.cell_id });
            }
          }
          if (cells.length === 0) cells.insert(0, [makeCell({ type: 'code' })]);
        });
        return res;
      };
      // 版本管理：默认不直接写正文，而是存成改动提案等成员审阅（项目设置可改为直接写入）
      let proposed: {
        results: ReturnType<typeof edit>;
        proposalId: string;
        notice: string;
      } | null = null;
      if (!created) {
        let res: ReturnType<typeof edit> = [];
        const p = await proposeNotebookEditIfNeeded(
          tc.ctx,
          tc.actor,
          tc.project.id,
          id,
          (doc) => {
            res = edit(doc);
          },
          args.reason,
        );
        if (p) proposed = { results: res, ...p };
      }
      if (proposed) {
        await tc.setActivity('在起草 notebook 改动提案');
        return {
          ok: true,
          notebook_id: id,
          created,
          results: proposed.results,
          proposal_id: proposed.proposalId,
          notice: proposed.notice,
        };
      }
      const results = await withLiveDocument(tc.ctx, id, tc.actor, edit);
      await tc.setActivity('在改 Notebook');
      return { ok: true, notebook_id: id, created, results };
    },
  }),

  defineTool({
    name: 'run_notebook_cells',
    description:
      '在项目的 Python 内核里运行 notebook 单元格（不给 cell_ids 就从头运行全部代码单元格），等跑完返回每个单元格的输出摘要。' +
      '内核在隔离容器里，变量在单元格之间保留；srh.log_metric("acc", 0.9) 在单元格输出中显示指标。出错后排在后面的单元格会被取消。',
    roles: WORKER_ROLES,
    enabled: (ctx) => kernelManager(ctx).available,
    schema: z.object({
      ...Target,
      cell_ids: z.array(z.string()).max(100).optional(),
      timeout_seconds: z.number().int().min(5).max(600).default(180),
    }),
    async run(tc, args) {
      const id = await notebookFor(tc, args);
      await tc.setActivity('在运行 notebook');
      const runs = await executeCells(tc.ctx, tc.actor, tc.project.id, id, args.cell_ids ?? []);
      const done = await kernelManager(tc.ctx).waitIdle(id, args.timeout_seconds * 1000);
      const { nb } = await readPlainNotebook(tc.ctx, tc.project.id, id);
      const wanted = args.cell_ids?.length
        ? new Set(args.cell_ids)
        : new Set(nb.cells.filter((c) => c.type === 'code').map((c) => c.id));
      const cells = nb.cells
        .map((c, index) => ({ c, index }))
        .filter(({ c }) => wanted.has(c.id))
        .map(({ c, index }) => ({
          id: c.id,
          execution_count: c.executionCount,
          outputs: summarizeOutputs(c.outputs, { notebookId: id, cell: index }),
          failed: c.outputs.some((o) => o.output_type === 'error'),
          ...(plotsWithoutImage(c.source, c.outputs)
            ? {
                warning:
                  '这个单元格在画图（plt / savefig），但输出里没有图像：图没有显示出来。' +
                  '不要用 matplotlib.use("Agg")，画完调用 plt.show()（或让 figure 作为最后一个表达式），' +
                  '确认输出里出现 [图像] 后才能说「出图」。savefig 存的文件只在内核里，项目文件里看不到。',
              }
            : {}),
        }));
      return {
        notebook_id: id,
        queued: runs.length,
        finished: done,
        ...(done
          ? {}
          : {
              note: `超过 ${args.timeout_seconds} 秒还没跑完，仍在后台运行；稍后用 read_notebook 看结果`,
            }),
        cells,
      };
    },
  }),
];
