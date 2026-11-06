import { and, desc, eq, lt, sql } from 'drizzle-orm';
import {
  ApiError,
  ResearchRunNotice,
  ResearchRecipeNotice,
  ulid,
  type ActorRef,
  type ResearchRecipe,
  type ResearchRecord,
  type ResearchRun,
} from '@srh/shared';
import type { AppContext } from '../../context';
import {
  researchRecipeVersions,
  researchRunKeys,
  researchRuns,
} from '../../db/schema/research-execution';
import { getEntity } from './service';

const id = (prefix: string) => `${prefix}_${ulid()}`;
export const newRunId = () => id('rrun');
export const newRecipeId = () => id('rrcp');
const actorKey = (actor: ActorRef) => `${actor.kind}:${actor.id ?? ''}`;
const RUN_ACTOR: ActorRef = { kind: 'system', id: null, name: '研究运行' };

function withRunUrl(run: ResearchRun): ResearchRun {
  const pending = run.steps.find(
    (step) =>
      step.status === 'waiting' &&
      (step.definition.action.kind === 'human' || step.waitingFor?.kind === 'clarification'),
  );
  const base = `/p/${encodeURIComponent(run.projectId)}/research/${encodeURIComponent(run.recordId)}`;
  return {
    ...run,
    webUrl: pending ? `${base}?item=${encodeURIComponent(pending.definition.itemId)}` : base,
  };
}

export async function getRun(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  runId: string,
): Promise<ResearchRun> {
  const [row] = await ctx.db.db
    .select()
    .from(researchRuns)
    .where(
      and(
        eq(researchRuns.id, runId),
        eq(researchRuns.projectId, projectId),
        eq(researchRuns.recordId, recordId),
      ),
    );
  if (!row) throw new ApiError('not_found', '运行记录不存在');
  return withRunUrl(row.data);
}

export async function listRuns(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  query: { cursor?: string; limit?: number } = {},
): Promise<ResearchRun[]> {
  await getEntity<ResearchRecord>(ctx, projectId, 'record', recordId);
  const rows = await ctx.db.db
    .select()
    .from(researchRuns)
    .where(
      and(
        eq(researchRuns.projectId, projectId),
        eq(researchRuns.recordId, recordId),
        query.cursor ? lt(researchRuns.id, query.cursor) : undefined,
      ),
    )
    .orderBy(desc(researchRuns.id))
    .limit(Math.max(1, Math.min(100, query.limit ?? 50)) + 1);
  return rows.map((row) => withRunUrl(row.data));
}

/** 复用最近成功尝试的内部方案，具体适用性由处理运行器核验。 */
export async function previousProcessing(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  runId: string,
  stepId: string,
) {
  const rows = await ctx.db.db
    .select({ data: researchRuns.data })
    .from(researchRuns)
    .where(
      and(
        eq(researchRuns.projectId, projectId),
        eq(researchRuns.recordId, recordId),
        sql`${researchRuns.id} <> ${runId}`,
        sql`exists (select 1 from jsonb_array_elements(${researchRuns.data}->'steps') st,
      jsonb_array_elements(st->'attempts') att where st->'definition'->>'itemId' = ${stepId}
      and att->>'status' = 'succeeded' and att->'processing'->'plan' <> 'null'::jsonb)`,
      ),
    )
    .orderBy(desc(researchRuns.id))
    .limit(1);
  return rows[0]?.data.steps
    .find((step) => step.definition.itemId === stepId)
    ?.attempts.findLast((attempt) => attempt.status === 'succeeded' && attempt.processing?.plan)
    ?.processing;
}

export async function findRunByKey(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  key: string,
  requestHash: string,
): Promise<ResearchRun | null> {
  const [row] = await ctx.db.db
    .select()
    .from(researchRunKeys)
    .where(
      and(
        eq(researchRunKeys.projectId, projectId),
        eq(researchRunKeys.recordId, recordId),
        eq(researchRunKeys.actorId, actorKey(actor)),
        eq(researchRunKeys.key, key),
      ),
    );
  if (!row) return null;
  if (row.requestHash !== requestHash) throw new ApiError('conflict', '幂等键已用于其他运行请求');
  return getRun(ctx, projectId, recordId, row.runId);
}

export async function insertRun(
  ctx: AppContext,
  actor: ActorRef,
  run: ResearchRun,
  key: string,
  requestHash: string,
): Promise<{ run: ResearchRun; created: boolean }> {
  try {
    const event = await ctx.db.db.transaction(async (tx) => {
      await tx
        .insert(researchRuns)
        .values({ id: run.id, projectId: run.projectId, recordId: run.recordId, data: run });
      await tx.insert(researchRunKeys).values({
        id: id('rrkey'),
        projectId: run.projectId,
        recordId: run.recordId,
        actorId: actorKey(actor),
        key,
        requestHash,
        runId: run.id,
      });
      return ctx.bus.record(tx, {
        projectId: run.projectId,
        type: 'research.run.created',
        payload: ResearchRunNotice.parse(run),
        actor,
      });
    });
    ctx.bus.emit(event);
    return { run: withRunUrl(run), created: true };
  } catch (error) {
    const prior = await findRunByKey(ctx, actor, run.projectId, run.recordId, key, requestHash);
    if (prior) return { run: prior, created: false };
    throw error;
  }
}

/** 变换函数必须无副作用，竞争失败后会用最新版本重算。 */
export async function changeRun(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  runId: string,
  change: (run: ResearchRun) => ResearchRun,
  actor: ActorRef = RUN_ACTOR,
): Promise<ResearchRun> {
  for (let retry = 0; retry < 100; retry += 1) {
    const [row] = await ctx.db.db
      .select()
      .from(researchRuns)
      .where(
        and(
          eq(researchRuns.id, runId),
          eq(researchRuns.projectId, projectId),
          eq(researchRuns.recordId, recordId),
        ),
      );
    if (!row) throw new ApiError('not_found', '运行记录不存在');
    const next = { ...change(structuredClone(row.data)), updatedAt: new Date().toISOString() };
    const event = await ctx.db.db.transaction(async (tx) => {
      const updated = await tx
        .update(researchRuns)
        .set({ data: next, revision: row.revision + 1, updatedAt: new Date() })
        .where(
          and(
            eq(researchRuns.id, runId),
            eq(researchRuns.projectId, projectId),
            eq(researchRuns.recordId, recordId),
            eq(researchRuns.revision, row.revision),
          ),
        )
        .returning({ id: researchRuns.id });
      if (!updated.length) return null;
      return ctx.bus.record(tx, {
        projectId,
        type: 'research.run.updated',
        payload: ResearchRunNotice.parse(next),
        actor,
      });
    });
    if (event) {
      ctx.bus.emit(event);
      return withRunUrl(next);
    }
  }
  throw new ApiError('conflict', '运行状态正被更新，请重试');
}

export async function insertRecipe(
  ctx: AppContext,
  recipe: ResearchRecipe,
): Promise<ResearchRecipe> {
  try {
    const event = await ctx.db.db.transaction(async (tx) => {
      await tx.insert(researchRecipeVersions).values({
        id: recipe.id,
        version: recipe.version,
        projectId: recipe.projectId,
        recordId: recipe.recordId,
        data: recipe,
      });
      return ctx.bus.record(tx, {
        projectId: recipe.projectId,
        type: 'research.recipe.published',
        payload: ResearchRecipeNotice.parse(recipe),
        actor: recipe.createdBy,
      });
    });
    ctx.bus.emit(event);
  } catch (error) {
    const [existing] = await ctx.db.db
      .select()
      .from(researchRecipeVersions)
      .where(
        and(
          eq(researchRecipeVersions.id, recipe.id),
          eq(researchRecipeVersions.version, recipe.version),
        ),
      );
    if (existing) throw new ApiError('conflict', '方案版本已被更新，请重新发布');
    throw error;
  }
  return recipe;
}

export async function getRecipe(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  recipeId: string,
  version?: number,
): Promise<ResearchRecipe> {
  const conditions = [
    eq(researchRecipeVersions.id, recipeId),
    eq(researchRecipeVersions.projectId, projectId),
    eq(researchRecipeVersions.recordId, recordId),
  ];
  if (version !== undefined) conditions.push(eq(researchRecipeVersions.version, version));
  const [row] = await ctx.db.db
    .select()
    .from(researchRecipeVersions)
    .where(and(...conditions))
    .orderBy(desc(researchRecipeVersions.version))
    .limit(1);
  if (!row) throw new ApiError('not_found', '方案或版本不存在');
  return row.data;
}

export async function listRecipes(
  ctx: AppContext,
  projectId: string,
  recordId: string,
): Promise<ResearchRecipe[]> {
  await getEntity<ResearchRecord>(ctx, projectId, 'record', recordId);
  const rows = await ctx.db.db
    .select()
    .from(researchRecipeVersions)
    .where(
      and(
        eq(researchRecipeVersions.projectId, projectId),
        eq(researchRecipeVersions.recordId, recordId),
      ),
    )
    .orderBy(desc(researchRecipeVersions.version));
  const latest = new Map<string, ResearchRecipe>();
  for (const row of rows) if (!latest.has(row.id)) latest.set(row.id, row.data);
  return [...latest.values()];
}

/** 服务重启仅标记不明状态，不自动重做可能已有副作用的操作。 */
export async function interruptUnfinishedRuns(ctx: AppContext): Promise<void> {
  const rows = await ctx.db.db.select().from(researchRuns);
  for (const row of rows) {
    if (!['queued', 'running'].includes(row.data.status)) continue;
    await changeRun(ctx, row.projectId, row.recordId, row.id, (run) => {
      if (!['queued', 'running'].includes(run.status)) return run;
      run.status = 'interrupted';
      for (const step of run.steps) {
        if (step.status !== 'running' && step.status !== 'queued') continue;
        step.status = 'interrupted';
        const attempt = step.attempts.at(-1);
        if (attempt?.status === 'running') {
          attempt.status = 'interrupted';
          attempt.endedAt = new Date().toISOString();
          attempt.error = '服务重启，执行结果未确定；请核对副作用后再重试';
        }
      }
      return run;
    });
  }
}
