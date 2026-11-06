import { z } from 'zod';
import {
  PageQuery,
  ResearchRecipeInstantiateInput,
  ResearchRecipePublishInput,
  ResearchRunConfirmInput,
  ResearchRunAnswerInput,
  ResearchRunCreateInput,
} from '@srh/shared';
import type { FastifyInstance } from 'fastify';
import { parse } from '../../lib/http';
import { requireProject } from '../collab-common';
import {
  cancelRun,
  answerStep,
  confirmStep,
  instantiateRecipe,
  retryRun,
  runStaleness,
  startRun,
  stopExecutionWorkers,
} from './execution';
import {
  getRecipe,
  getRun,
  interruptUnfinishedRuns,
  listRecipes,
  listRuns,
} from './execution-store';
import { publishRecipe } from './recipes';

type Base = { projectId: string; recordId: string };
type Run = Base & { runId: string };
type Step = Run & { stepId: string };
type Recipe = Base & { recipeId: string };
const Version = z.object({ version: z.coerce.number().int().positive() });

/** 与研究空间注册在同一应用前缀；所有服务共用项目权限。 */
export function registerResearchExecutionRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  app.addHook('onReady', async () => {
    await interruptUnfinishedRuns(ctx);
  });
  app.addHook('onClose', async () => {
    stopExecutionWorkers(ctx);
  });
  const base = '/projects/:projectId/research/records/:recordId';
  app.get<{ Params: Base }>(`${base}/runs`, async (req) => {
    const { projectId, recordId } = req.params;
    await requireProject(req, projectId, 'view');
    const query = parse(PageQuery, req.query);
    const rows = await listRuns(ctx, projectId, recordId, query);
    const items = rows.slice(0, query.limit);
    return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.id : null };
  });
  app.get<{ Params: Run }>(`${base}/runs/:runId`, async (req) => {
    const { projectId, recordId, runId } = req.params;
    await requireProject(req, projectId, 'view');
    return getRun(ctx, projectId, recordId, runId);
  });
  app.post<{ Params: Base }>(`${base}/runs`, async (req, reply) => {
    const { projectId, recordId } = req.params;
    const { actor } = await requireProject(req, projectId, 'write');
    const run = await startRun(
      ctx,
      actor,
      projectId,
      recordId,
      parse(ResearchRunCreateInput, req.body),
    );
    return reply.status(201).send(run);
  });
  app.get<{ Params: Run }>(`${base}/runs/:runId/staleness`, async (req) => {
    const { projectId, recordId, runId } = req.params;
    await requireProject(req, projectId, 'view');
    return runStaleness(ctx, projectId, recordId, runId);
  });
  app.post<{ Params: Run }>(`${base}/runs/:runId/cancel`, async (req) => {
    const { projectId, recordId, runId } = req.params;
    const { actor } = await requireProject(req, projectId, 'write');
    return cancelRun(ctx, projectId, recordId, runId, actor);
  });
  app.post<{ Params: Step }>(`${base}/runs/:runId/steps/:stepId/confirm`, async (req) => {
    const { projectId, recordId, runId, stepId } = req.params;
    const { actor } = await requireProject(req, projectId, 'write');
    return confirmStep(
      ctx,
      actor,
      projectId,
      recordId,
      runId,
      stepId,
      parse(ResearchRunConfirmInput, req.body),
    );
  });
  app.post<{ Params: Step }>(`${base}/runs/:runId/steps/:stepId/answer`, async (req) => {
    const { projectId, recordId, runId, stepId } = req.params;
    const { actor } = await requireProject(req, projectId, 'write');
    return answerStep(
      ctx,
      actor,
      projectId,
      recordId,
      runId,
      stepId,
      parse(ResearchRunAnswerInput, req.body),
    );
  });
  app.post<{ Params: Run }>(`${base}/runs/:runId/retry`, async (req) => {
    const { projectId, recordId, runId } = req.params;
    const { actor } = await requireProject(req, projectId, 'write');
    return retryRun(ctx, projectId, recordId, runId, actor);
  });
  app.get<{ Params: Base }>(`${base}/recipes`, async (req) => {
    const { projectId, recordId } = req.params;
    await requireProject(req, projectId, 'view');
    const query = parse(PageQuery, req.query);
    const rows = (await listRecipes(ctx, projectId, recordId)).sort((a, b) =>
      b.id.localeCompare(a.id),
    );
    const remaining = query.cursor ? rows.filter((row) => row.id < query.cursor!) : rows;
    const items = remaining.slice(0, query.limit);
    return { items, nextCursor: remaining.length > query.limit ? items.at(-1)!.id : null };
  });
  app.post<{ Params: Base }>(`${base}/recipes`, async (req, reply) => {
    const { projectId, recordId } = req.params;
    const { actor } = await requireProject(req, projectId, 'write');
    const recipe = await publishRecipe(
      ctx,
      actor,
      projectId,
      recordId,
      parse(ResearchRecipePublishInput, req.body),
    );
    return reply.status(201).send(recipe);
  });
  app.get<{ Params: Recipe & { version: string } }>(
    `${base}/recipes/:recipeId/versions/:version`,
    async (req) => {
      const { projectId, recordId, recipeId } = req.params;
      await requireProject(req, projectId, 'view');
      return getRecipe(ctx, projectId, recordId, recipeId, parse(Version, req.params).version);
    },
  );
  app.post<{ Params: Recipe }>(`${base}/recipes/:recipeId/instantiate`, async (req, reply) => {
    const { projectId, recordId, recipeId } = req.params;
    const { actor } = await requireProject(req, projectId, 'write');
    const run = await instantiateRecipe(
      ctx,
      actor,
      projectId,
      recordId,
      recipeId,
      parse(ResearchRecipeInstantiateInput, req.body),
    );
    return reply.status(201).send(run);
  });
}
