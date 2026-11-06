import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  ApiError,
  NotebookCreateInput,
  NotebookExecuteInput,
  NotebookExportFormat,
  NotebookImportInput,
  NotebookListQuery,
  NotebookRestartInput,
  NotebookUpdateInput,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { notebooks } from '../../db/schema';
import { parse } from '../../lib/http';
import { setCollabStorage } from '../../realtime/collab';
import { memberRole, requireProject, type Params } from '../collab-common';
import { onProjectArchived } from '../projects/archive-hooks';
import type { ModuleDef } from '../types';
import { exportNotebook, findChromium } from './export';
import { KernelCapacityError, KernelManager } from './kernel/manager';
import {
  createNotebook,
  deleteNotebook,
  findNotebookRow,
  getNotebook,
  importIpynb,
  listNotebooks,
  persistNotebook,
  readPlainNotebook,
  updateNotebook,
} from './service';

/**
 * Notebook（Jupyter 式实验笔记本）。归属：后端线程。端点见 API.md §2.13。
 * 单元格内容走 /collab/:notebookId（与协同文档同一个 Hocuspocus），这里只有元信息、执行与导入导出。
 *
 *   GET    /projects/:projectId/notebooks?experimentId=
 *   POST   /projects/:projectId/notebooks                       新建（可带 ipynb 导入）
 *   GET    /projects/:projectId/notebooks/:notebookId           元信息 + 内核状态
 *   PATCH  /projects/:projectId/notebooks/:notebookId
 *   DELETE /projects/:projectId/notebooks/:notebookId
 *   POST   /projects/:projectId/notebooks/:notebookId/import    用 .ipynb 整体替换
 *   GET    /projects/:projectId/notebooks/:notebookId/export?format=ipynb|py|html|pdf|md|zip
 *   POST   /projects/:projectId/notebooks/:notebookId/execute   { cellIds }（空 = 全部）
 *   POST   /projects/:projectId/notebooks/:notebookId/interrupt
 *   POST   /projects/:projectId/notebooks/:notebookId/restart   { runAll, clearOutputs }
 *   POST   /projects/:projectId/notebooks/:notebookId/shutdown
 *   GET    /projects/:projectId/notebooks/:notebookId/variables
 *   POST   /projects/:projectId/notebooks/:notebookId/complete  { code, cursorPos }
 *   POST   /projects/:projectId/notebooks/:notebookId/inspect   { code, cursorPos }
 */
type P = Params<'projectId'>;
type PN = Params<'projectId' | 'notebookId'>;

const managers = new WeakMap<AppContext, KernelManager>();

/** 本进程的内核调度器（agent 工具也用它） */
export function kernelManager(ctx: AppContext): KernelManager {
  let m = managers.get(ctx);
  if (!m) {
    m = new KernelManager(ctx);
    managers.set(ctx, m);
  }
  return m;
}

/** 测试用：替换内核调度器（例如注入一个指向本地网关的 host） */
export function setKernelManager(ctx: AppContext, m: KernelManager) {
  managers.set(ctx, m);
}

const CodeAt = z.object({
  code: z.string().max(200_000),
  cursorPos: z.number().int().nonnegative(),
});
const ExportQuery = z.object({ format: NotebookExportFormat.default('ipynb') });

function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_') || 'notebook';
  const encoded = encodeURIComponent(name).replace(
    /['()*]/gu,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** 需要执行的单元格：给定 id（保持顺序、去掉不存在的 / 非代码的），或全部代码单元格 */
async function resolveCellIds(
  ctx: AppContext,
  projectId: string,
  notebookId: string,
  wanted: string[],
) {
  const { nb } = await readPlainNotebook(ctx, projectId, notebookId);
  const code = nb.cells.filter((c) => c.type === 'code');
  if (!wanted.length) return code.map((c) => c.id);
  const ids = new Set(code.map((c) => c.id));
  const missing = wanted.filter((id) => !nb.cells.some((c) => c.id === id));
  if (missing.length === wanted.length)
    throw new ApiError('not_found', '要运行的单元格不存在，可能已被删除');
  return wanted.filter((id) => ids.has(id));
}

export async function executeCells(
  ctx: AppContext,
  actor: Parameters<KernelManager['enqueue']>[3],
  projectId: string,
  notebookId: string,
  cellIds: string[],
) {
  const mgr = kernelManager(ctx);
  if (!mgr.available) {
    throw new ApiError('not_implemented', '服务器还没有配置 Python 内核，暂时只能编辑不能运行');
  }
  const ids = await resolveCellIds(ctx, projectId, notebookId, cellIds);
  return mgr.enqueue(notebookId, projectId, ids, actor);
}

export const notebooksModule: ModuleDef = {
  name: 'notebooks',
  owner: 'backend',
  register(app) {
    const ctx = app.ctx;

    setCollabStorage(
      ctx,
      {
        async load(id) {
          const [row] = await ctx.db.db
            .select({
              projectId: notebooks.projectId,
              state: notebooks.ydocState,
              deletedAt: notebooks.deletedAt,
            })
            .from(notebooks)
            .where(eq(notebooks.id, id));
          if (!row || row.deletedAt) return null;
          return { projectId: row.projectId, state: row.state ?? null, archived: false };
        },
        role: (projectId, userId) => memberRole(ctx, projectId, userId),
        persist: (id, doc, actor) => persistNotebook(ctx, id, doc, actor),
      },
      'nb',
    );

    app.addHook('onClose', async () => {
      await managers.get(ctx)?.close();
    });

    // 项目删除（归档）后：关掉它的内核并删除内核容器（终验 R2 #15：删项目 1 小时后容器还是 Up）
    onProjectArchived('notebooks-kernel', (hookCtx, projectId) =>
      kernelManager(hookCtx).reclaimProject(projectId),
    );
    // 兜底：定期删掉已归档 / 已不存在项目的内核容器（钩子失败、服务重启错过钩子时）
    app.addHook('onReady', async () => {
      kernelManager(ctx).startSweeper();
    });

    app.get<{ Params: P }>('/projects/:projectId/notebooks', async (req) => {
      const { projectId } = req.params;
      await requireProject(req, projectId, 'view');
      const q = parse(NotebookListQuery, req.query);
      return listNotebooks(ctx, projectId, q);
    });

    app.post<{ Params: P }>('/projects/:projectId/notebooks', async (req, reply) => {
      const { projectId } = req.params;
      const access = await requireProject(req, projectId, 'write');
      const nb = await createNotebook(
        ctx,
        access.actor,
        projectId,
        parse(NotebookCreateInput, req.body ?? {}),
      );
      return reply.status(201).send(nb);
    });

    app.get<{ Params: PN }>('/projects/:projectId/notebooks/:notebookId', async (req) => {
      const { projectId, notebookId } = req.params;
      await requireProject(req, projectId, 'view');
      const nb = await getNotebook(ctx, projectId, notebookId);
      return { ...nb, kernel: { status: kernelManager(ctx).kernelStatus(notebookId) } };
    });

    app.patch<{ Params: PN }>('/projects/:projectId/notebooks/:notebookId', async (req) => {
      const { projectId, notebookId } = req.params;
      const access = await requireProject(req, projectId, 'write');
      return updateNotebook(
        ctx,
        access.actor,
        projectId,
        notebookId,
        parse(NotebookUpdateInput, req.body ?? {}),
      );
    });

    app.delete<{ Params: PN }>('/projects/:projectId/notebooks/:notebookId', async (req, reply) => {
      const { projectId, notebookId } = req.params;
      const access = await requireProject(req, projectId, 'write');
      await kernelManager(ctx)
        .shutdown(notebookId)
        .catch(() => undefined);
      await deleteNotebook(ctx, access.actor, projectId, notebookId);
      return reply.status(204).send();
    });

    app.post<{ Params: PN }>(
      '/projects/:projectId/notebooks/:notebookId/import',
      { bodyLimit: 64 * 1024 * 1024 },
      async (req) => {
        const { projectId, notebookId } = req.params;
        const access = await requireProject(req, projectId, 'write');
        const input = parse(NotebookImportInput, req.body ?? {});
        return importIpynb(ctx, access.actor, projectId, notebookId, input.ipynb);
      },
    );

    app.get<{ Params: PN }>(
      '/projects/:projectId/notebooks/:notebookId/export',
      async (req, reply) => {
        const { projectId, notebookId } = req.params;
        const access = await requireProject(req, projectId, 'view');
        const { format } = parse(ExportQuery, req.query);
        const { meta, nb } = await readPlainNotebook(ctx, projectId, notebookId);
        const file = await exportNotebook(nb, meta.title, format, {
          chromiumPath:
            format === 'pdf' || format === 'zip'
              ? findChromium(ctx.config.PDF_CHROMIUM_PATH)
              : null,
          author: access.user.name,
        });
        return reply
          .header('Content-Type', file.contentType)
          .header('Content-Disposition', contentDisposition(file.filename))
          .header('Cache-Control', 'no-store')
          .send(file.body);
      },
    );

    app.post<{ Params: PN }>('/projects/:projectId/notebooks/:notebookId/execute', async (req) => {
      const { projectId, notebookId } = req.params;
      const access = await requireProject(req, projectId, 'write');
      await findNotebookRow(ctx, projectId, notebookId);
      const input = parse(NotebookExecuteInput, req.body ?? {});
      const runs = await executeCells(ctx, access.actor, projectId, notebookId, input.cellIds);
      return { runs };
    });

    app.post<{ Params: PN }>(
      '/projects/:projectId/notebooks/:notebookId/interrupt',
      async (req) => {
        const { projectId, notebookId } = req.params;
        await requireProject(req, projectId, 'write');
        await findNotebookRow(ctx, projectId, notebookId);
        await kernelManager(ctx).interrupt(notebookId);
        return { ok: true };
      },
    );

    app.post<{ Params: PN }>('/projects/:projectId/notebooks/:notebookId/restart', async (req) => {
      const { projectId, notebookId } = req.params;
      const access = await requireProject(req, projectId, 'write');
      await findNotebookRow(ctx, projectId, notebookId);
      const input = parse(NotebookRestartInput, req.body ?? {});
      const mgr = kernelManager(ctx);
      if (!mgr.available) throw new ApiError('not_implemented', '服务器还没有配置 Python 内核');
      try {
        await mgr.restart(notebookId, projectId, { clearOutputs: input.clearOutputs });
      } catch (err) {
        if (err instanceof KernelCapacityError) throw new ApiError('rate_limited', err.message);
        throw err;
      }
      const runs = input.runAll
        ? await executeCells(ctx, access.actor, projectId, notebookId, [])
        : [];
      return { ok: true, runs };
    });

    app.post<{ Params: PN }>('/projects/:projectId/notebooks/:notebookId/shutdown', async (req) => {
      const { projectId, notebookId } = req.params;
      await requireProject(req, projectId, 'write');
      await findNotebookRow(ctx, projectId, notebookId);
      await kernelManager(ctx).shutdown(notebookId);
      return { ok: true };
    });

    app.get<{ Params: PN }>('/projects/:projectId/notebooks/:notebookId/variables', async (req) => {
      const { projectId, notebookId } = req.params;
      await requireProject(req, projectId, 'view');
      await findNotebookRow(ctx, projectId, notebookId);
      return { variables: await kernelManager(ctx).variables(notebookId) };
    });

    app.post<{ Params: PN }>('/projects/:projectId/notebooks/:notebookId/complete', async (req) => {
      const { projectId, notebookId } = req.params;
      await requireProject(req, projectId, 'write');
      const { code, cursorPos } = parse(CodeAt, req.body ?? {});
      return kernelManager(ctx).complete(notebookId, code, cursorPos);
    });

    app.post<{ Params: PN }>('/projects/:projectId/notebooks/:notebookId/inspect', async (req) => {
      const { projectId, notebookId } = req.params;
      await requireProject(req, projectId, 'view');
      const { code, cursorPos } = parse(CodeAt, req.body ?? {});
      return kernelManager(ctx).inspect(notebookId, code, cursorPos);
    });
  },
};
