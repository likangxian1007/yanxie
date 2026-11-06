import {
  ReportCreateInput,
  ReportRegenerateInput,
  ReportTodosInput,
  ReportUpdateInput,
} from '@srh/shared';
import type { ModuleDef } from '../types';
import { parse } from '../../lib/http';
import { registerCollabPort } from '../../agents/tools/collab-port';
import { requireProject, type Params } from '../collab-common';
import {
  createReport,
  createTodosFromReport,
  deleteReport,
  draft,
  getReport,
  listReports,
  regenerateReport,
  reportPlanItems,
  saveReportAsDocument,
  updateReport,
} from './service';

export { collectReportContext } from './context';
export { extractPlanItems } from './plan';
export { resolvePromptPath } from './prompt';
export { generateReport, waitForReportJobs } from './service';

/**
 * 组会汇报：从项目记录生成草稿、编辑定稿、另存为协同文档、把下期计划拆成待办。
 * 归属：协作功能线程。端点契约见 API.md §2.11，请求体 schema 见 @srh/shared api-collab.ts。
 *
 *   GET    P/reports                          Report[]（新到旧）
 *   POST   P/reports                          ReportCreateInput → 201 Report（generate=true 时 generating，后台生成）
 *   GET    P/reports/:reportId                Report
 *   PATCH  P/reports/:reportId                ReportUpdateInput → Report（生成中改正文 409）
 *   DELETE P/reports/:reportId                204
 *   POST   P/reports/:reportId/regenerate     ReportRegenerateInput → Report（generating）
 *   POST   P/reports/:reportId/document       → 201 { report, document }（已存过 409，details.documentId）
 *   POST   P/reports/:reportId/todos          ReportTodosInput → 201 Todo[]
 *   GET    P/reports/:reportId/plan-items     { items: string[] }（“下期计划”条目，供拆待办预填）
 */
type P = Params<'projectId'>;
type R = Params<'projectId' | 'reportId'>;

export const reportsModule: ModuleDef = {
  name: 'reports',
  owner: 'collab',
  register(app) {
    const { ctx } = app;
    registerCollabPort({ reports: { draft } });

    app.get<{ Params: P }>('/projects/:projectId/reports', async (req) => {
      const { projectId } = req.params;
      await requireProject(req, projectId, 'view');
      return listReports(ctx, projectId);
    });

    app.post<{ Params: P }>('/projects/:projectId/reports', async (req, reply) => {
      const { projectId } = req.params;
      const { actor } = await requireProject(req, projectId, 'write');
      const report = await createReport(
        ctx,
        actor,
        projectId,
        parse(ReportCreateInput, req.body ?? {}),
      );
      return reply.status(201).send(report);
    });

    app.get<{ Params: R }>('/projects/:projectId/reports/:reportId', async (req) => {
      const { projectId, reportId } = req.params;
      await requireProject(req, projectId, 'view');
      return getReport(ctx, projectId, reportId);
    });

    app.patch<{ Params: R }>('/projects/:projectId/reports/:reportId', async (req) => {
      const { projectId, reportId } = req.params;
      const { actor } = await requireProject(req, projectId, 'write');
      return updateReport(
        ctx,
        actor,
        projectId,
        reportId,
        parse(ReportUpdateInput, req.body ?? {}),
      );
    });

    app.delete<{ Params: R }>('/projects/:projectId/reports/:reportId', async (req, reply) => {
      const { projectId, reportId } = req.params;
      const { actor } = await requireProject(req, projectId, 'write');
      await deleteReport(ctx, actor, projectId, reportId);
      return reply.status(204).send();
    });

    app.post<{ Params: R }>('/projects/:projectId/reports/:reportId/regenerate', async (req) => {
      const { projectId, reportId } = req.params;
      const { actor } = await requireProject(req, projectId, 'write');
      return regenerateReport(
        ctx,
        actor,
        projectId,
        reportId,
        parse(ReportRegenerateInput, req.body ?? {}),
      );
    });

    app.post<{ Params: R }>(
      '/projects/:projectId/reports/:reportId/document',
      async (req, reply) => {
        const { projectId, reportId } = req.params;
        const { actor } = await requireProject(req, projectId, 'write');
        const result = await saveReportAsDocument(ctx, actor, projectId, reportId);
        return reply.status(201).send(result);
      },
    );

    app.post<{ Params: R }>('/projects/:projectId/reports/:reportId/todos', async (req, reply) => {
      const { projectId, reportId } = req.params;
      const { actor } = await requireProject(req, projectId, 'write');
      const todos = await createTodosFromReport(
        ctx,
        actor,
        projectId,
        reportId,
        parse(ReportTodosInput, req.body ?? {}),
      );
      return reply.status(201).send(todos);
    });

    app.get<{ Params: R }>('/projects/:projectId/reports/:reportId/plan-items', async (req) => {
      const { projectId, reportId } = req.params;
      await requireProject(req, projectId, 'view');
      return { items: await reportPlanItems(ctx, projectId, reportId) };
    });
  },
};
