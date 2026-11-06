import { createHash } from 'node:crypto';
import {
  ApiError,
  ResearchRecipePublishInput,
  type ActorRef,
  type ResearchExecutionDefinition,
  type ResearchExecutionStepInput,
  type ResearchRecipe,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { readPlainNotebook } from '../notebooks/service';
import { getWorkspaceItem } from './workspace';
import { getRecipe, insertRecipe, newRecipeId } from './execution-store';

export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** 只接受所选片段的有向无环执行连接，不解释普通语义关系。 */
export function validateGraph(steps: ResearchExecutionStepInput[]): void {
  const ids = new Set(steps.map((step) => step.itemId));
  if (ids.size !== steps.length)
    throw new ApiError('validation_failed', '同一个行动不能重复加入片段');
  for (const step of steps) {
    if (new Set(step.dependsOn).size !== step.dependsOn.length)
      throw new ApiError('validation_failed', '执行依赖不能重复');
    if (step.dependsOn.some((dep) => !ids.has(dep)))
      throw new ApiError('validation_failed', '执行依赖必须在选定片段中');
  }
  const map = new Map(steps.map((step) => [step.itemId, step.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new ApiError('validation_failed', '执行依赖包含循环');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of map.get(id) ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id);
}

export async function freezeDefinitions(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  steps: ResearchExecutionStepInput[],
): Promise<ResearchExecutionDefinition[]> {
  validateGraph(steps);
  const selected = new Set(steps.map((step) => step.itemId));
  const definitions = await Promise.all(
    steps.map(async ({ itemId, dependsOn, expectedItemVersion }) => {
      const item = await getWorkspaceItem(ctx, projectId, recordId, itemId);
      if (expectedItemVersion !== undefined && item.version !== expectedItemVersion)
        throw new ApiError('version_conflict', '行动配置已改变，请重新检查后启动', {
          current: item,
        });
      if (item.kind !== 'action' || !item.action)
        throw new ApiError('validation_failed', `「${item.title}」不是可执行行动`);
      const derived = [...dependsOn];
      for (const binding of item.action.inputs ?? []) {
        if (binding.source.kind !== 'output' || binding.source.artifactVersionId) continue;
        if (!selected.has(binding.source.stepId))
          throw new ApiError(
            'validation_failed',
            `「${item.title}」缺少上游产物，请先运行上游或选择固定版本`,
          );
        if (!derived.includes(binding.source.stepId)) derived.push(binding.source.stepId);
      }
      let notebook: ResearchExecutionDefinition['notebook'] = null;
      if (item.action.kind === 'notebook') {
        if (!item.action.notebookId)
          throw new ApiError('validation_failed', `「${item.title}」没有指定 Notebook`);
        const { nb } = await readPlainNotebook(ctx, projectId, item.action.notebookId);
        const code = nb.cells.filter((cell) => cell.type === 'code');
        const wanted = item.action.cellIds;
        if (new Set(wanted).size !== wanted.length)
          throw new ApiError('validation_failed', '单元格不能重复');
        const byId = new Map(code.map((cell) => [cell.id, cell]));
        if (wanted.some((id) => !byId.has(id)))
          throw new ApiError('validation_failed', `「${item.title}」的代码单元格不存在`);
        const cells = (wanted.length ? wanted.map((id) => byId.get(id)!) : code).map((cell) => ({
          id: cell.id,
          source: cell.source,
        }));
        if (!cells.length)
          throw new ApiError('validation_failed', `「${item.title}」没有可运行的代码单元格`);
        notebook = { notebookId: item.action.notebookId, cells, hash: digest(cells) };
      }
      return {
        itemId,
        itemVersion: item.version,
        title: item.title,
        action: item.action,
        dependsOn: derived,
        notebook,
      };
    }),
  );
  validateGraph(
    definitions.map((definition) => ({
      itemId: definition.itemId,
      dependsOn: definition.dependsOn,
    })),
  );
  return definitions;
}

export async function publishRecipe(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  raw: unknown,
): Promise<ResearchRecipe> {
  const input = ResearchRecipePublishInput.parse(raw);
  const definitions = await freezeDefinitions(ctx, projectId, recordId, input.steps);
  const previous = input.recipeId
    ? await getRecipe(ctx, projectId, recordId, input.recipeId)
    : null;
  return insertRecipe(ctx, {
    id: previous?.id ?? newRecipeId(),
    projectId,
    recordId,
    title: input.title,
    version: (previous?.version ?? 0) + 1,
    definitions,
    createdBy: actor,
    createdAt: new Date().toISOString(),
  });
}
