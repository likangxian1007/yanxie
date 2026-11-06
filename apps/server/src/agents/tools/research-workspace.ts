import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  ApiError,
  ResearchLayoutUpdateInput,
  ResearchItemCreateInput,
  ResearchItemPositionInput,
  ResearchItemUpdateInput,
  ResearchRelationCreateInput,
  ResearchRelationUpdateInput,
  ResearchWorkspaceCreateInput,
  ResearchRecipeInstantiateInput,
  ResearchRecipePublishInput,
  ResearchRunCreateInput,
} from '@srh/shared';
import { agentSessions } from '../../db/schema';
import {
  cancelRun,
  instantiateRecipe,
  retryRun,
  runStaleness,
  startRun,
} from '../../modules/research/execution';
import { getRecipe, getRun, listRecipes, listRuns } from '../../modules/research/execution-store';
import { publishRecipe } from '../../modules/research/recipes';
import { getArtifact, listArtifacts, readArtifact } from '../../modules/research/artifacts';
import { readResearchTable } from '../../modules/research/tables';
import { updateResearchLayout } from '../../modules/research/layout';
import {
  archiveWorkspaceItem,
  createWorkspace,
  createWorkspaceItem,
  createWorkspaceRelation,
  getWorkspace,
  getWorkspaceItem,
  getWorkspaceItemContent,
  listWorkspaceRelations,
  updateWorkspaceItem,
  updateWorkspaceItemPosition,
  updateWorkspaceRelation,
} from '../../modules/research/workspace';
import { requireCoveringClaim } from './collab';
import { ALL_ROLES, WORKER_ROLES, defineTool, type ToolContext, type ToolDef } from './types';

const Scope = { record_id: z.string().min(1) };
const Page = { cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(50) };
const schema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('workspace_create'), input: ResearchWorkspaceCreateInput }),
  z.object({ op: z.literal('list'), ...Scope, ...Page }),
  z.object({
    op: z.literal('read'),
    ...Scope,
    item_id: z.string().min(1),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(50000).default(20000),
  }),
  z.object({
    op: z.literal('table'),
    ...Scope,
    item_id: z.string().min(1),
    sheet_id: z.string().optional(),
    ...Page,
  }),
  z.object({ op: z.literal('artifacts'), ...Scope, item_id: z.string().min(1), ...Page }),
  z.object({
    op: z.literal('artifact_read'),
    ...Scope,
    artifact_id: z.string().min(1),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(50000).default(20000),
  }),
  z.object({ op: z.literal('layout'), ...Scope, input: ResearchLayoutUpdateInput }),
  z.object({ op: z.literal('create'), ...Scope, input: ResearchItemCreateInput }),
  z.object({
    op: z.literal('update'),
    ...Scope,
    item_id: z.string().min(1),
    input: ResearchItemUpdateInput,
  }),
  z.object({
    op: z.literal('move'),
    ...Scope,
    item_id: z.string().min(1),
    input: ResearchItemPositionInput,
  }),
  z.object({
    op: z.literal('archive'),
    ...Scope,
    item_id: z.string().min(1),
    base_version: z.number().int().positive(),
  }),
  z.object({ op: z.literal('relations'), ...Scope, ...Page }),
  z.object({ op: z.literal('relation_create'), ...Scope, input: ResearchRelationCreateInput }),
  z.object({
    op: z.literal('relation_update'),
    ...Scope,
    relation_id: z.string().min(1),
    input: ResearchRelationUpdateInput,
  }),
  z.object({
    op: z.literal('relation_archive'),
    ...Scope,
    relation_id: z.string().min(1),
    base_version: z.number().int().positive(),
  }),
  z.object({ op: z.literal('start'), ...Scope, input: ResearchRunCreateInput }),
  z.object({ op: z.literal('runs'), ...Scope, ...Page }),
  z.object({ op: z.literal('run_read'), ...Scope, run_id: z.string().min(1) }),
  z.object({ op: z.literal('run_staleness'), ...Scope, run_id: z.string().min(1) }),
  z.object({ op: z.literal('stop'), ...Scope, run_id: z.string().min(1) }),
  z.object({ op: z.literal('retry'), ...Scope, run_id: z.string().min(1) }),
  z.object({ op: z.literal('recipe_save'), ...Scope, input: ResearchRecipePublishInput }),
  z.object({ op: z.literal('recipes'), ...Scope, ...Page }),
  z.object({
    op: z.literal('recipe_read'),
    ...Scope,
    recipe_id: z.string().min(1),
    version: z.number().int().positive(),
  }),
  z.object({
    op: z.literal('recipe_start'),
    ...Scope,
    recipe_id: z.string().min(1),
    input: ResearchRecipeInstantiateInput,
  }),
]);

async function claim(tc: ToolContext, recordId: string) {
  return requireCoveringClaim(
    tc,
    { resourceKind: 'research', resourceRef: recordId },
    { label: '研究空间', suggestMode: 'exclusive' },
  );
}
function requireWorker(tc: ToolContext) {
  if (!WORKER_ROLES.includes(tc.session.role as (typeof WORKER_ROLES)[number]))
    throw new Error('协调者不能直接修改研究空间，请交给线程');
}
async function sessionSettings(tc: ToolContext) {
  const [fresh] = await tc.ctx.db.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, tc.session.id));
  const session = fresh ?? tc.session;
  return { model: session.model, effort: session.effort, profile: session.profile };
}
function page<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
}

export const researchWorkspaceTools: ToolDef[] = [
  defineTool({
    name: 'research_workspace',
    description:
      '查看或组织研究空间的混合草稿、笔记、协作表格、图表和具名数据流，分页读取结构化表格及固定产物，显式启动选定步骤、查询运行或保存/实例化方案。写入、启动和重试前需认领；只有成员能确认人工检查。',
    roles: ALL_ROLES,
    schema,
    async run(tc, args) {
      const projectId = tc.project.id;
      if (args.op === 'workspace_create') {
        requireWorker(tc);
        await claim(tc, 'new');
        return createWorkspace(tc.ctx, tc.actor, projectId, args.input);
      }
      const recordId = args.record_id;
      switch (args.op) {
        case 'list':
          return getWorkspace(tc.ctx, projectId, recordId, {
            cursor: args.cursor,
            limit: args.limit,
          });
        case 'read':
          return {
            item: await getWorkspaceItem(tc.ctx, projectId, recordId, args.item_id),
            content: await getWorkspaceItemContent(tc.ctx, projectId, recordId, args.item_id, {
              offset: args.offset,
              limit: args.limit,
            }),
          };
        case 'table': {
          const item = await getWorkspaceItem(tc.ctx, projectId, recordId, args.item_id);
          return readResearchTable(tc.ctx, projectId, item, {
            sheetId: args.sheet_id,
            cursor: args.cursor,
            limit: args.limit,
          });
        }
        case 'artifacts':
          return listArtifacts(tc.ctx, projectId, recordId, args.item_id, args);
        case 'artifact_read': {
          const row = await getArtifact(tc.ctx, projectId, args.artifact_id);
          if (row.recordId !== recordId) throw new ApiError('not_found', '产物版本不存在');
          const { artifact, bytes } = await readArtifact(tc.ctx, projectId, args.artifact_id);
          if (!artifact.mime.startsWith('text/') && artifact.mime !== 'application/json')
            return { artifact, notice: '二进制产物请通过 downloadUrl 查看，未转换为文本。' };
          const content = bytes.toString('utf8');
          const end = Math.min(content.length, args.offset + args.limit);
          return {
            artifact,
            content: content.slice(args.offset, end),
            offset: args.offset,
            totalLength: content.length,
            nextOffset: end < content.length ? end : null,
          };
        }
        case 'relations':
          return listWorkspaceRelations(tc.ctx, projectId, recordId, args);
        case 'runs':
          return page(await listRuns(tc.ctx, projectId, recordId, args), args.limit);
        case 'run_read':
          return getRun(tc.ctx, projectId, recordId, args.run_id);
        case 'run_staleness':
          return runStaleness(tc.ctx, projectId, recordId, args.run_id);
        case 'recipes': {
          const rows = (await listRecipes(tc.ctx, projectId, recordId)).sort((a, b) =>
            b.id.localeCompare(a.id),
          );
          return page(args.cursor ? rows.filter((row) => row.id < args.cursor!) : rows, args.limit);
        }
        case 'recipe_read':
          return getRecipe(tc.ctx, projectId, recordId, args.recipe_id, args.version);
        default: {
          requireWorker(tc);
          await claim(tc, recordId);
          if (args.op === 'layout')
            return updateResearchLayout(tc.ctx, tc.actor, projectId, recordId, args.input);
          if (args.op === 'create')
            return createWorkspaceItem(tc.ctx, tc.actor, projectId, recordId, args.input);
          if (args.op === 'update')
            return updateWorkspaceItem(
              tc.ctx,
              tc.actor,
              projectId,
              recordId,
              args.item_id,
              args.input,
            );
          if (args.op === 'move')
            return updateWorkspaceItemPosition(
              tc.ctx,
              tc.actor,
              projectId,
              recordId,
              args.item_id,
              args.input,
            );
          if (args.op === 'archive')
            return archiveWorkspaceItem(
              tc.ctx,
              tc.actor,
              projectId,
              recordId,
              args.item_id,
              args.base_version,
            );
          if (args.op === 'relation_create')
            return createWorkspaceRelation(tc.ctx, tc.actor, projectId, recordId, args.input);
          if (args.op === 'relation_update')
            return updateWorkspaceRelation(
              tc.ctx,
              tc.actor,
              projectId,
              recordId,
              args.relation_id,
              args.input,
            );
          if (args.op === 'relation_archive')
            return updateWorkspaceRelation(
              tc.ctx,
              tc.actor,
              projectId,
              recordId,
              args.relation_id,
              { baseVersion: args.base_version, label: '' },
              true,
            );
          if (args.op === 'stop')
            return cancelRun(tc.ctx, projectId, recordId, args.run_id, tc.actor);
          if (args.op === 'retry')
            return retryRun(tc.ctx, projectId, recordId, args.run_id, tc.actor);
          if (args.op === 'recipe_save')
            return publishRecipe(tc.ctx, tc.actor, projectId, recordId, args.input);
          const settings = await sessionSettings(tc);
          const userId =
            tc.thread?.kind === 'personal' ? tc.thread.ownerUserId : tc.requesterUserId;
          if (args.op === 'start')
            return startRun(
              tc.ctx,
              tc.actor,
              projectId,
              recordId,
              {
                ...args.input,
                model: args.input.model ?? settings.model,
                effort: args.input.effort ?? settings.effort,
                profile: args.input.profile ?? settings.profile,
              },
              userId,
            );
          return instantiateRecipe(
            tc.ctx,
            tc.actor,
            projectId,
            recordId,
            args.recipe_id,
            {
              ...args.input,
              model: args.input.model ?? settings.model,
              effort: args.input.effort ?? settings.effort,
              profile: args.input.profile ?? settings.profile,
            },
            userId,
          );
        }
      }
    },
  }),
];
