import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  ApiError,
  ResearchRecipeInstantiateInput,
  ResearchRunConfirmInput,
  ResearchRunAnswerInput,
  ResearchRunCreateInput,
  ResearchStructuredTable,
  ResearchCellSource,
  ResearchTableSeed,
  type ActorRef,
  type ResearchExecutionDefinition,
  type ResearchArtifactRef,
  type ResearchItem,
  type ResearchRun,
  type ResearchProcessingExecution,
  type ResearchRunOutput,
  type ResearchRunStep,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { researchArtifactVersions, researchWorkspaceItems } from '../../db/schema';
import {
  createWorkspaceItem,
  getWorkspaceItem,
  updateWorkspaceItem,
  updateWorkspaceItemPosition,
} from './workspace';
import {
  itemBindingKey,
  snapshotInputs,
  snapshotItem,
  resolveSnapshot,
  snapshotIsCurrent,
} from './snapshots';
import {
  artifactWasPublished,
  getArtifact,
  listArtifacts,
  publishedArtifactCondition,
  saveArtifact,
  readArtifact,
} from './artifacts';
import { readResearchTable, stableResearchColumnId } from './tables';
import { chartPng, chartResearchTable, transformResearchTable } from './composable';
import { writeProjectFile } from '../files/service';
import {
  changeRun,
  findRunByKey,
  getRecipe,
  getRun,
  insertRun,
  newRunId,
  previousProcessing,
} from './execution-store';
import { executionRunners, type Draft } from './execution-runners';
import { executeProcessing } from './processing';
import { digest, freezeDefinitions, validateGraph } from './recipes';

const running = new WeakMap<AppContext, Map<string, AbortController>>();
const active = (ctx: AppContext) => {
  let map = running.get(ctx);
  if (!map) {
    map = new Map();
    running.set(ctx, map);
  }
  return map;
};
const invalid = (message: string): never => {
  throw new ApiError('validation_failed', message);
};

async function prepareRun(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  definitions: ResearchExecutionDefinition[],
  settings: {
    model: string | null;
    effort: string | null;
    profile: string | null;
    replan?: boolean;
  },
  recipe: { id: string; version: number } | null,
  profileUserId: string | null,
): Promise<ResearchRun> {
  validateGraph(definitions.map((d) => ({ itemId: d.itemId, dependsOn: d.dependsOn })));
  const runners = executionRunners(ctx);
  const selections = await Promise.all(
    definitions.map(async (d) => {
      if (d.action.kind === 'notebook') {
        await runners.checkNotebook(ctx);
        return null;
      }
      if (
        d.action.kind !== 'ai' ||
        (d.action.processing?.mode !== 'auto' &&
          ['transform_table', 'chart'].includes(d.action.operation ?? ''))
      )
        return null;
      return runners.selectModel(ctx, projectId, profileUserId, {
        model: d.action.model ?? settings.model,
        effort: d.action.effort ?? settings.effort,
        profile: d.action.profile ?? settings.profile,
      });
    }),
  );
  const runId = newRunId();
  const inputSnapshots = await snapshotInputs(ctx, actor, projectId, recordId, runId, definitions);
  const now = new Date().toISOString();
  return {
    id: runId,
    projectId,
    recordId,
    recipeId: recipe?.id ?? null,
    recipeVersion: recipe?.version ?? null,
    status: 'queued',
    cancelRequested: false,
    inputSnapshots,
    steps: definitions.map((definition, i) => ({
      definition,
      status: 'queued',
      attempts: [],
      selection: selections[i] ?? null,
      confirmedBy: null,
      confirmedAt: null,
    })),
    settings: {
      model: settings.model,
      effort: settings.effort,
      profile: settings.profile,
      ...(settings.replan ? { replan: true } : {}),
    },
    createdBy: actor,
    createdAt: now,
    updatedAt: now,
  };
}

export async function startRun(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  raw: unknown,
  profileUserId: string | null = actor.kind === 'user' ? actor.id : null,
): Promise<ResearchRun> {
  const input = ResearchRunCreateInput.parse(raw);
  const requestHash = digest({ operation: 'start', ...input });
  const prior = await findRunByKey(
    ctx,
    actor,
    projectId,
    recordId,
    input.idempotencyKey,
    requestHash,
  );
  if (prior) return prior;
  const definitions = await freezeDefinitions(ctx, projectId, recordId, input.steps);
  const run = await prepareRun(
    ctx,
    actor,
    projectId,
    recordId,
    definitions,
    input,
    null,
    profileUserId,
  );
  const inserted = await insertRun(ctx, actor, run, input.idempotencyKey, requestHash);
  if (inserted.created) launch(ctx, inserted.run);
  return inserted.run;
}

export async function instantiateRecipe(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  recipeId: string,
  raw: unknown,
  profileUserId: string | null = actor.kind === 'user' ? actor.id : null,
): Promise<ResearchRun> {
  const input = ResearchRecipeInstantiateInput.parse(raw);
  const requestHash = digest({ operation: 'instantiate', recipeId, ...input });
  const prior = await findRunByKey(
    ctx,
    actor,
    projectId,
    recordId,
    input.idempotencyKey,
    requestHash,
  );
  if (prior) return prior;
  const recipe = await getRecipe(ctx, projectId, recordId, recipeId, input.version);
  const available = new Set(
    recipe.definitions.flatMap((d) =>
      d.action.inputs !== undefined
        ? d.action.inputs.flatMap((binding) =>
            binding.source.kind === 'item' ? [binding.source.itemId] : [],
          )
        : d.action.inputItemIds,
    ),
  );
  if (Object.keys(input.bindings).some((id) => !available.has(id)))
    invalid('替换项不属于此方案的输入');
  const definitions = recipe.definitions.map((d) => ({
    ...d,
    action: {
      ...d.action,
      inputItemIds: d.action.inputItemIds.map((id) => input.bindings[id] ?? id),
      inputs: d.action.inputs?.map((binding) =>
        binding.source.kind === 'item'
          ? {
              ...binding,
              source: {
                ...binding.source,
                itemId: input.bindings[binding.source.itemId] ?? binding.source.itemId,
              },
            }
          : binding,
      ),
    },
  }));
  const run = await prepareRun(
    ctx,
    actor,
    projectId,
    recordId,
    definitions,
    input,
    recipe,
    profileUserId,
  );
  const inserted = await insertRun(ctx, actor, run, input.idempotencyKey, requestHash);
  if (inserted.created) launch(ctx, inserted.run);
  return inserted.run;
}

function stepById(run: ResearchRun, stepId: string): ResearchRunStep {
  const step = run.steps.find((s) => s.definition.itemId === stepId);
  if (!step) throw new ApiError('not_found', '运行步骤不存在');
  return step;
}
function successfulOutputs(step: ResearchRunStep): ResearchRunOutput[] {
  return step.attempts.findLast((a) => a.status === 'succeeded')?.outputs ?? [];
}
function finishCancelled(run: ResearchRun) {
  run.status = 'cancelled';
  for (const step of run.steps) {
    if (!['queued', 'waiting', 'running'].includes(step.status)) continue;
    step.status = 'cancelled';
    delete step.waitingFor;
    const last = step.attempts.at(-1);
    if (last?.status === 'running') {
      last.status = 'cancelled';
      last.endedAt = new Date().toISOString();
      last.error = '运行已停止';
    }
  }
}

async function stepInputs(ctx: AppContext, run: ResearchRun, step: ResearchRunStep) {
  const action = step.definition.action;
  const inputBindings =
    action.inputs === undefined
      ? action.inputItemIds.map((itemId) => ({ kind: 'item' as const, itemId }))
      : action.inputs.flatMap((binding) =>
          binding.source.kind === 'item' ? [binding.source] : [],
        );
  const inputs = await Promise.all(
    inputBindings.map((binding) =>
      resolveSnapshot(ctx, run.projectId, run.inputSnapshots, binding),
    ),
  );
  const upstream: ResearchRunOutput[] = [];
  if (action.inputs === undefined) {
    for (const id of step.definition.dependsOn)
      upstream.push(...successfulOutputs(stepById(run, id)));
  } else {
    for (const binding of action.inputs) {
      if (binding.source.kind !== 'output') continue;
      const source = binding.source;
      if (source.artifactVersionId) {
        const row = await getArtifact(ctx, run.projectId, source.artifactVersionId);
        if (
          row.recordId !== run.recordId ||
          row.data.stepId !== source.stepId ||
          row.data.outputKey !== source.outputKey ||
          !(await artifactWasPublished(ctx, run.projectId, row.data))
        )
          throw new Error('选择的产物版本不属于指定的上游输出');
        const bytes = (await readArtifact(ctx, run.projectId, row.id)).bytes;
        upstream.push({
          itemId: row.itemId,
          version: row.version,
          hash: row.data.hash,
          title: row.data.summary,
          origin: row.data.origin,
          content: bytes.toString('utf8'),
          artifact: row.data,
          outputKey: source.outputKey,
        });
      } else {
        const match = successfulOutputs(stepById(run, source.stepId)).find(
          (output) => output.outputKey === source.outputKey,
        );
        if (!match) throw new Error(`上游没有输出「${source.outputKey}」，请先运行上游`);
        upstream.push(match);
      }
    }
  }
  for (let i = 0; i < upstream.length; i++) {
    const output = upstream[i]!;
    if (output.artifact)
      upstream[i] = {
        ...output,
        content: (await readArtifact(ctx, run.projectId, output.artifact.id)).bytes.toString(
          'utf8',
        ),
      };
  }
  return { definition: step.definition, inputs, upstream };
}

/** 检查声明与模型输出一一对应，全部通过才开始发布产物。 */
function validateDrafts(step: ResearchRunStep, drafts: Draft[]): Draft[] {
  const outputs = step.definition.action.outputs;
  if (!drafts.length || drafts.some((draft) => !draft.content.trim()))
    throw new Error('步骤没有产生可读取的产物');
  for (const draft of drafts) {
    if (!draft.title.trim() || draft.title.length > 200) throw new Error('产物标题无效');
    if (draft.kind === 'table') {
      const table = ResearchTableSeed.safeParse(draft.table);
      if (
        !table.success ||
        table.data.rows.length >= 100000 ||
        table.data.rows.some((row) => row.length > table.data.columns.length) ||
        new Set(table.data.columns.map((column) => column.id)).size !== table.data.columns.length
      )
        throw new Error('表格输出格式或行列范围无效');
    }
    if (
      draft.kind === 'figure' &&
      (!draft.figure ||
        !draft.figure.svg.startsWith('<svg ') ||
        !Buffer.isBuffer(draft.figure.png) ||
        !draft.figure.png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    )
      throw new Error('绘图输出格式无效');
  }
  if (!outputs?.length) {
    const required =
      step.definition.action.processing?.mode === 'auto'
        ? undefined
        : step.definition.action.operation === 'extract_table'
          ? 'table'
          : step.definition.action.operation === 'transform_table'
            ? 'table'
            : step.definition.action.operation === 'chart'
              ? 'figure'
              : undefined;
    if (required && (drafts.length !== 1 || drafts[0]!.kind !== required))
      throw new Error('产物类型与处理步骤不匹配');
    return drafts.map((draft, index) => ({
      ...draft,
      outputKey: draft.outputKey ?? (index ? `result_${index + 1}` : 'result'),
    }));
  }
  const auto = step.definition.action.processing?.mode === 'auto';
  if (!auto && drafts.length !== outputs.length) throw new Error('实际产物数量与声明不一致');
  const declared = outputs.map((declaration, index) => {
    const draft =
      drafts.find((entry) => entry.outputKey === declaration.key) ??
      (outputs.length === 1 && !drafts[0]!.outputKey ? drafts[0] : undefined);
    if (!draft || (draft.kind ?? 'note') !== declaration.kind)
      throw new Error(`输出「${declaration.key}」类型或名称不匹配`);
    if (draft.kind === 'table' && !draft.table)
      throw new Error(`输出「${declaration.key}」缺少表格数据`);
    if (draft.kind === 'figure' && !draft.figure)
      throw new Error(`输出「${declaration.key}」缺少实际图形`);
    if (
      drafts.findIndex((entry) => entry === draft) !== index &&
      drafts.some((entry) => entry.outputKey === undefined)
    )
      throw new Error('多个输出必须分别指定名称');
    return { ...draft, outputKey: declaration.key, title: declaration.title || draft.title };
  });
  if (!auto) return declared;
  const extras = drafts.filter(
    (draft) =>
      !outputs.some((output) => output.key === draft.outputKey) &&
      !(outputs.length === 1 && drafts.length === 1 && !draft.outputKey),
  );
  if (
    extras.some((draft) => !draft.outputKey) ||
    new Set(drafts.map((draft) => draft.outputKey)).size !== drafts.length
  )
    throw new Error('多个输出必须分别指定不同的名称');
  return [...declared, ...extras];
}

/** 没有精确匹配的 AI 单元格保留为待核对，绝不替模型虚构位置。 */
function verifyTableLineage(
  draft: Draft,
  inputs: Array<{ item: { id: string; kind: string }; content: string }>,
) {
  if (draft.kind !== 'table' || !draft.table || draft.origin !== 'ai_draft') return draft;
  const table = draft.table;
  const declared = table.lineage ?? [];
  const lineage = table.rows.flatMap((row, r) =>
    row.flatMap((value, c) => {
      if (value === null || value === '') return [];
      const rowId = `r${r + 1}`,
        columnId = table.columns[c]?.id;
      if (!columnId) throw new Error('表格数据行包含未声明的列');
      const candidate = declared.find(
        (source) => source.rowId === rowId && source.columnId === columnId,
      );
      const source = candidate?.itemId
        ? inputs.find((entry) => entry.item.id === candidate.itemId)
        : undefined;
      let text = source?.content ?? '';
      if (source?.item.kind === 'table' || source?.item.kind === 'figure') text = '';
      if (
        source?.item.kind === 'resource' &&
        text.startsWith('{"kind":"structured_table_resource"')
      )
        text = '';
      let excerptId: string | undefined;
      let blockId: string | undefined;
      if (source?.item.kind === 'draft') {
        try {
          const snapshot = JSON.parse(text) as {
            blocks?: Array<{
              id: string;
              kind: string;
              excerptId?: string;
              text?: string;
              content?: { text?: string };
            }>;
          };
          const block = snapshot.blocks?.find((entry) => entry.id === candidate?.blockId);
          text = block?.text ?? block?.content?.text ?? '';
          blockId = block?.id;
          if (block?.kind === 'excerpt') excerptId = block.excerptId;
        } catch {
          text = '';
        }
      }
      const position = candidate?.quote ? text.indexOf(candidate.quote) : -1;
      return [
        {
          rowId,
          columnId,
          ...(source ? { itemId: source.item.id } : {}),
          ...(blockId ? { blockId } : {}),
          ...(excerptId ? { excerptId } : {}),
          ...(position >= 0 && candidate?.quote ? { quote: candidate.quote } : {}),
          locator:
            position >= 0 && candidate?.quote
              ? {
                  kind: 'text',
                  start: position,
                  end: position + candidate.quote.length,
                  cellValue: value,
                }
              : { cellValue: value },
          verification: (position >= 0 ? 'matched' : 'unverified') as 'matched' | 'unverified',
        },
      ];
    }),
  );
  return { ...draft, table: { ...table, lineage } };
}

/** AI 临时生成的列 ID 不稳定，按唯一列名及类型建立可重复的显式身份。 */
function normalizeAiTable(draft: Draft): Draft {
  if (draft.kind !== 'table' || !draft.table || draft.origin !== 'ai_draft') return draft;
  const columns = draft.table.columns;
  const names = columns.map((column) => column.name.normalize('NFKC').trim());
  if (new Set(names).size !== names.length) throw new Error('AI 表格列名重复，请明确不同的列名');
  if (new Set(columns.map((column) => column.id)).size !== columns.length)
    throw new Error('AI 表格列标识重复');
  const replacements = new Map(
    columns.map((column, i) => [
      column.id,
      stableResearchColumnId({
        name: names[i],
        type: column.type ?? null,
        unit: column.unit?.trim() || null,
      }),
    ]),
  );
  return {
    ...draft,
    table: {
      ...draft.table,
      columns: columns.map((column, i) => ({
        ...column,
        name: names[i]!,
        unit: column.unit?.trim() || undefined,
        id: replacements.get(column.id)!,
      })),
      lineage: draft.table.lineage?.map((source) => ({
        ...source,
        columnId: replacements.get(source.columnId) ?? source.columnId,
      })),
    },
  };
}

async function validateAiTableSchema(
  ctx: AppContext,
  run: ResearchRun,
  step: ResearchRunStep,
  draft: Draft,
) {
  if (draft.origin !== 'ai_draft' || !draft.table || !draft.outputKey) return;
  const page = await listArtifacts(ctx, run.projectId, run.recordId, step.definition.itemId, {
    limit: 100,
  });
  const previous = page.items.find(
    (artifact) => artifact.outputKey === draft.outputKey && artifact.kind === 'table',
  );
  const metadata = previous?.metadata as
    { columnSchema?: Array<{ id: string }>; definitionVersion?: number } | undefined;
  if (!metadata?.columnSchema || metadata.definitionVersion !== step.definition.itemVersion) return;
  const old = metadata.columnSchema.map((column) => column.id).sort();
  const current = draft.table.columns.map((column) => column.id).sort();
  if (JSON.stringify(old) !== JSON.stringify(current))
    throw new Error('提取表格的列名、类型或单位已改变；请检查输出并重新配置下游列映射');
}

function tableInput(input: Awaited<ReturnType<typeof stepInputs>>) {
  const candidates = [
    ...input.inputs
      .filter((entry) => entry.item.kind === 'table')
      .map((entry) => ({ content: entry.content, artifact: entry.artifact })),
    ...input.upstream
      .filter((entry) => entry.artifact?.kind === 'table')
      .map((entry) => ({ content: entry.content, artifact: entry.artifact })),
  ];
  if (candidates.length !== 1 || !candidates[0]!.artifact)
    throw new Error('此步骤需要恰好一个已固定的表格输入');
  let raw: unknown;
  try {
    raw = JSON.parse(candidates[0]!.content);
  } catch {
    throw new Error('表格快照格式错误');
  }
  const parsed = ResearchStructuredTable.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.nextCursor !== null ||
    parsed.data.rows.length !== parsed.data.totalRows
  )
    throw new Error('表格快照不完整或格式错误');
  return {
    table: parsed.data,
    artifact: candidates[0]!.artifact,
    raw: raw as { lineage?: unknown[] },
  };
}

async function activeOutputParent(ctx: AppContext, run: ResearchRun, parentId: string) {
  try {
    const parent = await getWorkspaceItem(ctx, run.projectId, run.recordId, parentId);
    return parent.kind === 'group';
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'not_found') throw error;
    return false;
  }
}

/** 同一输出槽沿用最近成功产物的空间位置；内容和工作簿始终独立。 */
async function previousOutputLayout(
  ctx: AppContext,
  run: ResearchRun,
  stepId: string,
  outputKey: string,
) {
  const [previous] = await ctx.db.db
    .select({
      position: researchWorkspaceItems.position,
      parentId: researchWorkspaceItems.parentId,
    })
    .from(researchArtifactVersions)
    .innerJoin(
      researchWorkspaceItems,
      and(
        eq(researchWorkspaceItems.id, researchArtifactVersions.itemId),
        eq(researchWorkspaceItems.projectId, researchArtifactVersions.projectId),
        eq(researchWorkspaceItems.recordId, researchArtifactVersions.recordId),
        isNull(researchWorkspaceItems.archivedAt),
      ),
    )
    .where(
      and(
        eq(researchArtifactVersions.projectId, run.projectId),
        eq(researchArtifactVersions.recordId, run.recordId),
        sql`${researchArtifactVersions.data}->>'stepId' = ${stepId}`,
        sql`${researchArtifactVersions.data}->>'outputKey' = ${outputKey}`,
        publishedArtifactCondition,
      ),
    )
    .orderBy(desc(researchArtifactVersions.id))
    .limit(1);
  if (!previous) return null;
  const parentId =
    previous.parentId && (await activeOutputParent(ctx, run, previous.parentId))
      ? previous.parentId
      : null;
  return { position: previous.position, parentId };
}

async function outputItem(
  ctx: AppContext,
  run: ResearchRun,
  step: ResearchRunStep,
  attemptNo: number,
  index: number,
  draft: Draft,
  actor: ActorRef,
  inputs: string[],
  intermediate = false,
): Promise<ResearchRunOutput> {
  const key = `rout_${digest([run.id, step.definition.itemId, attemptNo, index]).slice(0, 48)}`;
  const label = {
    ai_draft: 'AI 草稿（待人工确认）',
    computation: '实际计算输出',
    member_report: '成员人工检查报告',
  }[draft.origin];
  const content = `来源：${label}；运行 ${run.id}，步骤「${step.definition.title}」，第 ${attemptNo} 次尝试。\n\n${draft.content}`;
  if (content.length > 200000) throw new Error('产物超过研究条目可保存的大小');
  const layout = await previousOutputLayout(
    ctx,
    run,
    step.definition.itemId,
    draft.outputKey ?? 'result',
  );
  let payload: Extract<NonNullable<ResearchItem['payload']>, { kind: 'figure' }> | undefined;
  let pngBytes: Buffer | undefined;
  if (draft.kind === 'figure') {
    if (!draft.figure) throw new Error('图表没有生成图形');
    const path = `research-charts/${run.id}/${step.definition.itemId}/${attemptNo}-${index}`;
    const svg = await writeProjectFile(
      ctx,
      actor,
      run.projectId,
      `${path}.svg`,
      draft.figure.svg,
      'image/svg+xml',
    );
    const png = await writeProjectFile(
      ctx,
      actor,
      run.projectId,
      `${path}.png`,
      draft.figure.png,
      'image/png',
    );
    pngBytes = draft.figure.png;
    payload = {
      kind: 'figure' as const,
      svgFileId: svg.file.id,
      pngFileId: png.file.id,
      chart: draft.figure.chart ?? step.definition.action.chart,
      dataArtifactId: draft.figure.dataArtifactId,
      caption: draft.content,
    };
  }
  const createOutputItem = (parentId: string | null | undefined) =>
    createWorkspaceItem(
      ctx,
      actor,
      run.projectId,
      run.recordId,
      {
        kind: draft.kind ?? 'note',
        title: draft.title.slice(0, 200),
        body: content,
        ...(payload ? { payload } : {}),
        ...(draft.table ? { table: draft.table } : {}),
        ...(layout ? { position: layout.position, parentId: parentId ?? null } : {}),
        idempotencyKey: key,
      },
      { trustedLineage: true },
    );
  let item: ResearchItem;
  try {
    item = await createOutputItem(layout?.parentId);
  } catch (error) {
    if (
      !layout?.parentId ||
      !(error instanceof ApiError) ||
      !['not_found', 'validation_failed'].includes(error.code) ||
      (await activeOutputParent(ctx, run, layout.parentId))
    )
      throw error;
    // 父分组在读取布局后失效时，保留位置并回退到画布根级。
    item = await createOutputItem(null);
  }
  // 创建接口将 (0,0) 作为自动布局哨兵，旧条目可以确实被移动到原点。
  if (layout && layout.position.x === 0 && layout.position.y === 0) {
    item = await getWorkspaceItem(ctx, run.projectId, run.recordId, item.id);
    if (item.position.x !== 0 || item.position.y !== 0)
      item = await updateWorkspaceItemPosition(ctx, actor, run.projectId, run.recordId, item.id, {
        basePositionVersion: item.positionVersion,
        position: layout.position,
      });
  }
  let bytes: string | Buffer = content;
  let mime = 'text/markdown; charset=utf-8';
  if (item.kind === 'table') {
    const table = await readResearchTable(ctx, run.projectId, item);
    bytes = JSON.stringify({
      ...table,
      lineage: item.payload?.kind === 'table' ? (item.payload.lineage ?? []) : [],
      processing: draft.metadata ?? null,
    });
    mime = 'application/json';
  } else if (draft.figure) {
    bytes = draft.figure.svg;
    mime = 'image/svg+xml';
  }
  let pngArtifactId: string | undefined;
  if (pngBytes) {
    const pngArtifact = await saveArtifact(ctx, actor, run.projectId, run.recordId, {
      itemId: item.id,
      runId: run.id,
      kind: 'figure',
      mime: 'image/png',
      bytes: pngBytes,
      summary: `${item.title} · PNG`,
      origin: draft.origin,
      inputs,
      requestKey: `${key}:png`,
    });
    pngArtifactId = pngArtifact.id;
  }
  const artifact = await saveArtifact(ctx, actor, run.projectId, run.recordId, {
    itemId: item.id,
    runId: run.id,
    stepId: intermediate ? null : step.definition.itemId,
    outputKey: intermediate ? undefined : draft.outputKey,
    kind: item.kind === 'table' ? 'table' : item.kind === 'figure' ? 'figure' : 'note',
    mime,
    bytes,
    summary: item.title,
    origin: draft.origin,
    inputs,
    metadata: {
      operation: step.definition.action.operation,
      action: step.definition.action,
      selection: step.selection,
      attemptNo,
      pngArtifactId,
      itemVersion: item.version,
      definitionVersion: step.definition.itemVersion,
      columnSchema: draft.table?.columns,
      ...(draft.figure
        ? {
            chart: draft.figure.chart ?? step.definition.action.chart,
            rendering: draft.figure.metadata,
          }
        : {}),
      ...(intermediate ? { purpose: 'processing_intermediate' } : {}),
    },
    requestKey: `${key}:artifact`,
  });
  return {
    itemId: item.id,
    version: item.version,
    hash: artifact.hash,
    title: item.title,
    origin: draft.origin,
    content,
    artifact,
    outputKey: draft.outputKey,
  };
}

async function performStep(
  ctx: AppContext,
  run: ResearchRun,
  stepId: string,
  controller: AbortController,
): Promise<void> {
  const started = await changeRun(ctx, run.projectId, run.recordId, run.id, (current) => {
    const step = stepById(current, stepId);
    if (step.status !== 'queued' || current.cancelRequested) return current;
    step.status = step.definition.action.kind === 'human' ? 'waiting' : 'running';
    const resume = step.attempts.at(-1);
    if (resume?.status === 'running' && resume.processing?.phase === 'planning') return current;
    step.attempts.push({
      number: step.attempts.length + 1,
      status: 'running',
      startedAt: new Date().toISOString(),
      endedAt: null,
      logs: [],
      notebookId: null,
      error: null,
      outputs: [],
    });
    return current;
  });
  const step = stepById(started, stepId);
  if (step.status !== 'running') return;
  const attemptNo = step.attempts.at(-1)!.number;
  try {
    const input = await stepInputs(ctx, started, step);
    const runners = executionRunners(ctx);
    const operation = step.definition.action.operation;
    const auto =
      step.definition.action.kind === 'ai' && step.definition.action.processing?.mode === 'auto';
    const connected = started.steps.some((candidate) =>
      candidate.definition.action.inputs?.some(
        (binding) =>
          binding.source.kind === 'output' &&
          binding.source.stepId === stepId &&
          !binding.source.artifactVersionId,
      ),
    );
    const inferredKind =
      operation === 'extract_table' || operation === 'transform_table'
        ? ('table' as const)
        : operation === 'chart'
          ? ('figure' as const)
          : ('note' as const);
    const runnerInput =
      auto && connected && !step.definition.action.outputs?.length
        ? {
            ...input,
            definition: {
              ...input.definition,
              action: {
                ...input.definition.action,
                outputs: [{ key: 'result', kind: inferredKind }],
              },
            },
          }
        : input;
    const prior = auto
      ? await previousProcessing(ctx, started.projectId, started.recordId, started.id, stepId)
      : undefined;
    const result: { outputs: Draft[]; logs: string[]; processing?: ResearchProcessingExecution } =
      auto
        ? await executeProcessing(
            ctx,
            started.projectId,
            step.selection!,
            runnerInput,
            controller.signal,
            {
              previous: prior,
              state: step.attempts.at(-1)?.processing,
              replan: started.settings.replan,
              onState: async (state) => {
                await changeRun(ctx, started.projectId, started.recordId, started.id, (current) => {
                  const latest = stepById(current, stepId);
                  const attempt = latest.attempts.at(-1);
                  if (
                    !attempt ||
                    attempt.number !== attemptNo ||
                    latest.status !== 'running' ||
                    current.cancelRequested
                  )
                    throw new Error('运行状态已变化');
                  attempt.processing = {
                    ...state,
                    version: (attempt.processing?.version ?? 0) + 1,
                    answers: attempt.processing?.answers ?? state.answers,
                    intermediates: attempt.processing?.intermediates ?? state.intermediates,
                  };
                  return current;
                });
              },
              publishIntermediate: async (internalId, draft, ids) => {
                const lineageInputs = [
                  ...input.inputs,
                  ...input.upstream.map((output) => ({
                    item: { id: output.itemId, kind: output.artifact?.kind ?? 'note' },
                    content: output.content,
                  })),
                ];
                const validated = validateDrafts(
                  {
                    ...step,
                    definition: {
                      ...step.definition,
                      action: { ...step.definition.action, outputs: undefined, operation: 'free' },
                    },
                  },
                  [normalizeAiTable(verifyTableLineage(draft, lineageInputs))],
                )[0]!;
                const index =
                  1000000 +
                  parseInt(
                    digest([internalId, step.attempts.at(-1)?.processing?.version ?? 0]).slice(
                      0,
                      10,
                    ),
                    16,
                  );
                const output = await outputItem(
                  ctx,
                  started,
                  step,
                  attemptNo,
                  index,
                  validated,
                  started.createdBy.kind === 'user'
                    ? { kind: 'agent', id: started.id, name: '研协' }
                    : started.createdBy,
                  ids,
                  true,
                );
                const artifact = output.artifact!;
                await changeRun(ctx, started.projectId, started.recordId, started.id, (current) => {
                  const latest = stepById(current, stepId);
                  const attempt = latest.attempts.at(-1);
                  if (
                    !attempt ||
                    attempt.number !== attemptNo ||
                    latest.status !== 'running' ||
                    current.cancelRequested
                  )
                    throw new Error('运行状态已变化');
                  if (
                    attempt.processing &&
                    !attempt.processing.intermediates.some((ref) => ref.id === artifact.id)
                  )
                    attempt.processing.intermediates.push(artifact);
                  return current;
                });
                return {
                  ...output,
                  content: (await readArtifact(ctx, started.projectId, artifact.id)).bytes.toString(
                    'utf8',
                  ),
                };
              },
            },
          )
        : operation === 'transform_table'
          ? (() => {
              if (!step.definition.action.transform) throw new Error('未指定表格处理配置');
              const source = tableInput(input);
              const transformed = transformResearchTable(
                source.table,
                step.definition.action.transform,
              );
              const lineage = (source.raw.lineage ?? []).flatMap((entry) => {
                const parsed = ResearchCellSource.safeParse(entry);
                return parsed.success ? [parsed.data] : [];
              });
              transformed.seed.lineage = transformed.audit.sourceRows.flatMap(
                (sourceRows, index) => {
                  if (sourceRows.length !== 1) return [];
                  return lineage
                    .filter(
                      (entry) =>
                        entry.rowId === sourceRows[0] &&
                        transformed.seed.columns.some((column) => column.id === entry.columnId),
                    )
                    .map((entry) => ({ ...entry, rowId: `r${index + 1}` }));
                },
              );
              return {
                outputs: [
                  {
                    kind: 'table' as const,
                    title: `${step.definition.title} · 处理表`,
                    content: `实际处理 ${transformed.audit.inputRows} 行，得到 ${transformed.audit.outputRows} 行。`,
                    table: transformed.seed,
                    origin: 'computation' as const,
                    metadata: { ...transformed.audit, inputArtifactId: source.artifact.id },
                  },
                ],
                logs: ['按指定规则处理表格，未补零或转换单位'],
              };
            })()
          : operation === 'chart'
            ? await (async () => {
                if (!step.definition.action.chart) throw new Error('未指定绘图配置');
                const source = tableInput(input);
                const chart = chartResearchTable(source.table, step.definition.action.chart);
                const png = await chartPng(ctx, chart.svg);
                return {
                  outputs: [
                    {
                      kind: 'figure' as const,
                      title: `${step.definition.title} · 图表`,
                      content: `基于 ${chart.plottedRows.length} 行实际数据，按配置忽略 ${chart.omittedRows} 行缺失值。`,
                      origin: 'computation' as const,
                      figure: {
                        svg: chart.svg,
                        png,
                        dataArtifactId: source.artifact.id,
                        metadata: {
                          plottedRows: chart.plottedRows,
                          omittedRows: chart.omittedRows,
                          xLabel: chart.xLabel,
                          yLabel: chart.yLabel,
                        },
                      },
                    },
                  ],
                  logs: ['图表绑定固定数据版本'],
                };
              })()
            : step.definition.action.kind === 'ai'
              ? await runners.ai(ctx, started.projectId, step.selection!, input, controller.signal)
              : await runners.notebook(
                  ctx,
                  started.createdBy,
                  started.projectId,
                  input,
                  controller.signal,
                  async (id) => {
                    await changeRun(
                      ctx,
                      started.projectId,
                      started.recordId,
                      started.id,
                      (current) => {
                        const last = stepById(current, stepId).attempts.at(-1);
                        if (last?.number === attemptNo) last.notebookId = id;
                        return current;
                      },
                    );
                  },
                );
    if (auto && result.processing?.phase === 'waiting') {
      await changeRun(ctx, started.projectId, started.recordId, started.id, (current) => {
        const latest = stepById(current, stepId);
        const attempt = latest.attempts.at(-1);
        if (
          !attempt ||
          attempt.number !== attemptNo ||
          latest.status !== 'running' ||
          current.cancelRequested
        )
          return current;
        const processing = attempt.processing;
        if (!processing?.question) throw new Error('缺少澄清问题');
        latest.waitingFor = { kind: 'clarification', ...processing.question };
        latest.status = 'waiting';
        return current;
      });
      return;
    }
    const lineageInputs = [
      ...input.inputs,
      ...input.upstream.map((output) => ({
        item: { id: output.itemId, kind: output.artifact?.kind ?? 'note' },
        content: output.content,
      })),
    ];
    const drafts = validateDrafts(
      step,
      result.outputs.map((draft) => normalizeAiTable(verifyTableLineage(draft, lineageInputs))),
    );
    for (const draft of drafts) await validateAiTableSchema(ctx, started, step, draft);
    if (controller.signal.aborted) throw new Error('运行已停止');
    const author: ActorRef =
      step.definition.action.kind === 'ai' &&
      (auto || !['transform_table', 'chart'].includes(operation ?? '')) &&
      started.createdBy.kind === 'user'
        ? { kind: 'agent', id: started.id, name: '研协' }
        : started.createdBy;
    const outputs: ResearchRunOutput[] = [];
    const provenance = [
      ...input.inputs.flatMap((entry) => (entry.artifact ? [entry.artifact.id] : [])),
      ...input.upstream.flatMap((entry) => (entry.artifact ? [entry.artifact.id] : [])),
    ];
    for (const [index, draft] of drafts.entries())
      outputs.push(
        await outputItem(ctx, started, step, attemptNo, index, draft, author, [
          ...new Set([
            ...provenance,
            ...((draft.metadata as { inputArtifactIds?: string[] } | undefined)?.inputArtifactIds ??
              []),
          ]),
        ]),
      );
    const completed = await changeRun(
      ctx,
      started.projectId,
      started.recordId,
      started.id,
      (current) => {
        const latest = stepById(current, stepId);
        const attempt = latest.attempts.at(-1);
        if (!attempt || attempt.number !== attemptNo || latest.status !== 'running') return current;
        attempt.outputs = outputs;
        attempt.logs = result.logs;
        attempt.endedAt = new Date().toISOString();
        if (current.cancelRequested) {
          attempt.status = 'cancelled';
          latest.status = 'cancelled';
        } else {
          attempt.status = 'succeeded';
          latest.status = 'succeeded';
        }
        return current;
      },
    );
    // 自动规划新增的输出槽成为可连线的稳定契约；并发编辑始终优先。
    const existingKeys = new Set(
      (step.definition.action.outputs ?? []).map((output) => output.key),
    );
    const additions = drafts.filter((draft) => !existingKeys.has(draft.outputKey!));
    if (
      auto &&
      additions.length &&
      stepById(completed, stepId).attempts.at(-1)?.status === 'succeeded'
    ) {
      try {
        const current = await getWorkspaceItem(ctx, started.projectId, started.recordId, stepId);
        if (current.version === step.definition.itemVersion && current.action) {
          await updateWorkspaceItem(ctx, author, started.projectId, started.recordId, stepId, {
            baseVersion: step.definition.itemVersion,
            action: {
              ...current.action,
              outputs: [
                ...(current.action.outputs ?? []),
                ...additions.map((draft) => ({
                  key: draft.outputKey!,
                  kind: draft.kind ?? 'note',
                })),
              ],
            },
          });
        }
      } catch (error) {
        if (!(error instanceof ApiError) || !['version_conflict', 'not_found'].includes(error.code))
          throw error;
      }
    }
  } catch (error) {
    await changeRun(ctx, started.projectId, started.recordId, started.id, (current) => {
      const latest = stepById(current, stepId);
      const attempt = latest.attempts.at(-1);
      if (!attempt || attempt.number !== attemptNo || latest.status !== 'running') return current;
      const cancelled = current.cancelRequested || controller.signal.aborted;
      latest.status = cancelled ? 'cancelled' : 'failed';
      attempt.status = cancelled ? 'cancelled' : 'failed';
      if (attempt.processing) attempt.processing.phase = 'failed';
      attempt.error = error instanceof Error ? error.message : '运行失败';
      attempt.endedAt = new Date().toISOString();
      return current;
    });
  }
}

async function drive(ctx: AppContext, initial: ResearchRun, controller: AbortController) {
  let run = await changeRun(ctx, initial.projectId, initial.recordId, initial.id, (current) => {
    if (current.status !== 'queued') throw new ApiError('conflict', '运行已经开始');
    current.status = 'running';
    return current;
  });
  for (;;) {
    run = await getRun(ctx, run.projectId, run.recordId, run.id);
    if (run.cancelRequested) {
      await changeRun(ctx, run.projectId, run.recordId, run.id, (current) => {
        finishCancelled(current);
        return current;
      });
      return;
    }
    const ready = run.steps.filter(
      (step) =>
        step.status === 'queued' &&
        step.definition.dependsOn.every((id) => stepById(run, id).status === 'succeeded'),
    );
    if (ready.length) {
      await Promise.all(
        ready.map((step) => performStep(ctx, run, step.definition.itemId, controller)),
      );
      continue;
    }
    await changeRun(ctx, run.projectId, run.recordId, run.id, (current) => {
      if (current.cancelRequested) finishCancelled(current);
      else if (current.steps.some((s) => s.status === 'failed')) current.status = 'failed';
      else if (current.steps.some((s) => s.status === 'waiting')) current.status = 'waiting';
      else if (current.steps.every((s) => s.status === 'succeeded')) current.status = 'succeeded';
      else current.status = 'interrupted';
      return current;
    });
    return;
  }
}

function launch(ctx: AppContext, run: ResearchRun) {
  const map = active(ctx);
  if (map.has(run.id)) return;
  const controller = new AbortController();
  map.set(run.id, controller);
  // 取消请求可能由另一应用进程接收；后台运行器仍要观察持久化状态。
  let checking = false;
  const cancelWatcher = setInterval(() => {
    if (checking) return;
    checking = true;
    void getRun(ctx, run.projectId, run.recordId, run.id)
      .then((latest) => {
        if (latest.cancelRequested) controller.abort();
      })
      .catch(() => undefined)
      .finally(() => {
        checking = false;
      });
  }, 1000);
  cancelWatcher.unref();
  void drive(ctx, run, controller)
    .catch(async (error: unknown) => {
      if (error instanceof ApiError && error.code === 'conflict') return;
      await changeRun(ctx, run.projectId, run.recordId, run.id, (current) => {
        if (current.status === 'running' || current.status === 'queued') {
          current.status = 'interrupted';
          for (const step of current.steps)
            if (step.status === 'running') {
              step.status = 'interrupted';
              const attempt = step.attempts.at(-1);
              if (attempt) {
                attempt.status = 'interrupted';
                attempt.endedAt = new Date().toISOString();
                attempt.error = error instanceof Error ? error.message : '运行中断';
              }
            }
        }
        return current;
      }).catch(() => undefined);
    })
    .finally(() => {
      clearInterval(cancelWatcher);
      map.delete(run.id);
      // 人工确认或重试可能恰好发生在旧调度器退出之前。
      void getRun(ctx, run.projectId, run.recordId, run.id)
        .then(async (latest) => {
          if (latest.cancelRequested && ['queued', 'running', 'waiting'].includes(latest.status)) {
            await changeRun(ctx, run.projectId, run.recordId, run.id, (current) => {
              if (current.cancelRequested) finishCancelled(current);
              return current;
            });
          } else if (latest.status === 'queued') launch(ctx, latest);
        })
        .catch(() => undefined);
    });
}

export async function cancelRun(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  runId: string,
  actor?: ActorRef,
): Promise<ResearchRun> {
  const current = await changeRun(
    ctx,
    projectId,
    recordId,
    runId,
    (run) => {
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status))
        throw new ApiError('conflict', '这次运行已经结束');
      run.cancelRequested = true;
      // 本进程看不到正在执行的远程工作者时不能假装已经停止。
      if (!active(ctx).has(run.id) && run.status !== 'running') finishCancelled(run);
      return run;
    },
    actor,
  );
  active(ctx).get(runId)?.abort();
  return current;
}

export async function confirmStep(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  runId: string,
  stepId: string,
  raw: unknown,
): Promise<ResearchRun> {
  if (actor.kind !== 'user' || !actor.id)
    throw new ApiError('forbidden', '只有成员本人可以确认人工检查');
  const input = ResearchRunConfirmInput.parse(raw);
  const run = await getRun(ctx, projectId, recordId, runId);
  const step = stepById(run, stepId);
  if (step.definition.action.kind !== 'human' || step.status !== 'waiting' || run.cancelRequested)
    throw new ApiError('conflict', '步骤不在等待人工确认');
  const attemptNo = step.attempts.at(-1)!.number;
  const declarations = step.definition.action.outputs ?? [];
  const outputs: ResearchRunOutput[] = [];
  if (declarations.length) {
    const itemIds = input.itemIds ?? [];
    if (itemIds.length !== declarations.length || new Set(itemIds).size !== itemIds.length)
      invalid('请为每个声明的输出选择一个不同的上游候选产物');
    // 使用步骤实际绑定的固定输入，兼容独立运行时选择的历史上游版本。
    // stepInputs 同时验证历史产物属于本研究空间、对应输出且已成功发布。
    const resolved = await stepInputs(ctx, run, step);
    const allowed = new Set([
      ...resolved.inputs
        .filter((snapshot) => snapshot.artifact && ['note', 'table'].includes(snapshot.item.kind))
        .map((snapshot) => snapshot.item.id),
      ...resolved.upstream
        .filter((output) => output.artifact && ['note', 'table'].includes(output.artifact.kind))
        .map((output) => output.itemId),
    ]);
    if (itemIds.some((id) => !allowed.has(id))) invalid('只能确认本步骤绑定的笔记或表格候选');
    const candidates = await Promise.all(
      itemIds.map((id) => getWorkspaceItem(ctx, projectId, recordId, id)),
    );
    candidates.forEach((candidate, index) => {
      const declaration = declarations[index]!;
      if (candidate.kind !== declaration.kind || !['note', 'table'].includes(candidate.kind))
        invalid(`候选产物与输出「${declaration.key}」类型不一致`);
    });
    const report = await saveArtifact(ctx, actor, projectId, recordId, {
      itemId: itemIds[0]!,
      runId,
      kind: 'note',
      mime: 'text/plain; charset=utf-8',
      bytes: input.note,
      summary: `${step.definition.title} · 确认说明`,
      origin: 'member_report',
      requestKey: `confirm-report:${runId}:${stepId}:${attemptNo}`,
    });
    for (const [index, declaration] of declarations.entries()) {
      const itemId = itemIds[index]!;
      const current = candidates[index]!;
      const frozen = await snapshotItem(
        ctx,
        actor,
        projectId,
        recordId,
        runId,
        itemId,
        undefined,
        `confirm:${stepId}:${attemptNo}`,
      );
      const source = await readArtifact(ctx, projectId, frozen.artifact!.id);
      const artifact = await saveArtifact(ctx, actor, projectId, recordId, {
        itemId,
        runId,
        stepId,
        outputKey: declaration.key,
        kind: current.kind === 'table' ? 'table' : 'note',
        mime: source.artifact.mime,
        bytes: source.bytes,
        summary: declaration.title || current.title,
        origin: 'member_report',
        inputs: [source.artifact.id],
        metadata: { itemVersion: frozen.item.version, reportArtifactId: report.id, attemptNo },
        requestKey: `confirm-output:${runId}:${stepId}:${attemptNo}:${index}`,
      });
      outputs.push({
        itemId,
        version: frozen.item.version,
        hash: artifact.hash,
        title: frozen.item.title,
        origin: 'member_report',
        content: frozen.content,
        artifact,
        outputKey: declaration.key,
      });
    }
  } else {
    if (input.itemIds?.length) invalid('人工步骤需要先声明要确认的输出类型');
    outputs.push(
      await outputItem(
        ctx,
        run,
        step,
        attemptNo,
        0,
        {
          title: `${step.definition.title} · 成员报告`,
          content: input.note,
          origin: 'member_report',
          outputKey: 'result',
        },
        actor,
        [],
      ),
    );
  }
  const result = await changeRun(
    ctx,
    projectId,
    recordId,
    runId,
    (current) => {
      const latest = stepById(current, stepId);
      if (latest.status !== 'waiting' || current.cancelRequested)
        throw new ApiError('conflict', '步骤状态已变化');
      const attempt = latest.attempts.at(-1)!;
      attempt.status = 'succeeded';
      attempt.endedAt = new Date().toISOString();
      attempt.outputs = outputs;
      latest.status = 'succeeded';
      latest.confirmedBy = actor;
      latest.confirmedAt = attempt.endedAt;
      if (current.status === 'waiting') current.status = 'queued';
      return current;
    },
    actor,
  );
  if (result.status === 'queued') launch(ctx, result);
  return result;
}

/** 在同一尝试中记录成员回答；CAS 重算时同时检查版本及幂等键。 */
export async function answerStep(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  runId: string,
  stepId: string,
  raw: unknown,
): Promise<ResearchRun> {
  if (actor.kind !== 'user' || !actor.id)
    throw new ApiError('forbidden', '只有成员本人可以回答澄清问题');
  const input = ResearchRunAnswerInput.parse(raw);
  const result = await changeRun(
    ctx,
    projectId,
    recordId,
    runId,
    (run) => {
      const step = stepById(run, stepId);
      const processing = step.attempts.at(-1)?.processing;
      const previous = processing?.answers.find(
        (entry) => entry.idempotencyKey === input.idempotencyKey,
      );
      if (previous) {
        if (
          previous.questionId !== input.questionId ||
          previous.answer !== input.answer ||
          previous.actor.kind !== actor.kind ||
          previous.actor.id !== actor.id
        )
          throw new ApiError('conflict', '回答幂等键已用于不同内容');
        return run;
      }
      if (
        !processing ||
        step.status !== 'waiting' ||
        run.cancelRequested ||
        step.waitingFor?.questionId !== input.questionId ||
        processing.question?.questionId !== input.questionId
      )
        throw new ApiError('conflict', '步骤不在等待该问题的回答');
      if (processing.version !== input.baseVersion)
        throw new ApiError('version_conflict', '澄清问题已更新，请重新查看', { current: run });
      processing.answers.push({
        questionId: input.questionId,
        question: processing.question.question,
        answer: input.answer,
        actor,
        answeredAt: new Date().toISOString(),
        idempotencyKey: input.idempotencyKey,
      });
      processing.version += 1;
      processing.phase = 'planning';
      delete processing.question;
      delete step.waitingFor;
      step.status = 'queued';
      if (run.status === 'waiting') run.status = 'queued';
      return run;
    },
    actor,
  );
  if (result.status === 'queued') launch(ctx, result);
  return result;
}

export async function retryRun(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  runId: string,
  actor?: ActorRef,
): Promise<ResearchRun> {
  const original = await getRun(ctx, projectId, recordId, runId);
  if (!['failed', 'interrupted'].includes(original.status))
    throw new ApiError('conflict', '只有失败或中断的运行可以重试');
  const runners = executionRunners(ctx);
  for (const step of original.steps) {
    if (!['failed', 'interrupted'].includes(step.status)) continue;
    if (step.definition.action.kind === 'notebook') await runners.checkNotebook(ctx);
    if (step.selection)
      await runners.selectModel(ctx, projectId, null, {
        model: step.selection.model,
        effort: step.selection.effort,
        profile: null,
      });
  }
  for (const snapshot of original.inputSnapshots) {
    if (!(await snapshotIsCurrent(ctx, projectId, recordId, snapshot)))
      throw new ApiError('conflict', '输入内容已改变，请新建运行');
  }
  const result = await changeRun(
    ctx,
    projectId,
    recordId,
    runId,
    (run) => {
      if (!['failed', 'interrupted'].includes(run.status))
        throw new ApiError('conflict', '运行状态已变化');
      run.status = 'queued';
      run.cancelRequested = false;
      for (const step of run.steps)
        if (['failed', 'interrupted'].includes(step.status)) step.status = 'queued';
      return run;
    },
    actor,
  );
  launch(ctx, result);
  return result;
}

export function stopExecutionWorkers(ctx: AppContext) {
  for (const controller of active(ctx).values()) controller.abort();
}

/** 比较原件当前内容而不改写历史快照。 */
export async function runStaleness(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  runId: string,
) {
  const run = await getRun(ctx, projectId, recordId, runId);
  type InputState = {
    itemId: string;
    state: 'current' | 'changed' | 'unavailable';
    reason: string | null;
  };
  const checks: Promise<InputState | null>[] = [];
  const directChecks = new Map<string, Promise<InputState>>();
  const artifactChecks = new Map<string, Promise<InputState>>();
  const checkDirect = (binding: Parameters<typeof resolveSnapshot>[3]) => {
    const key = itemBindingKey(binding.itemId, binding.blockIds);
    let check = directChecks.get(key);
    if (!check) {
      check = (async (): Promise<InputState> => {
        try {
          const original = await resolveSnapshot(ctx, projectId, run.inputSnapshots, binding);
          const same = await snapshotIsCurrent(ctx, projectId, recordId, original);
          return {
            itemId: original.item.id,
            state: same ? 'current' : 'changed',
            reason: same ? null : '材料或原件已更新，产物待复核',
          };
        } catch (error) {
          return {
            itemId: binding.itemId,
            state: 'unavailable',
            reason: error instanceof Error ? error.message : '材料当前不可读取',
          };
        }
      })();
      directChecks.set(key, check);
    }
    return check;
  };
  const checkArtifact = (ref: ResearchArtifactRef) => {
    let check = artifactChecks.get(ref.id);
    if (!check) {
      check = (async (): Promise<InputState> => {
        try {
          const artifact = (await getArtifact(ctx, projectId, ref.id)).data;
          const item = await getWorkspaceItem(ctx, projectId, recordId, artifact.itemId);
          const snapshot = await readArtifact(ctx, projectId, artifact.id);
          const metadata = artifact.metadata as { itemVersion?: number } | undefined;
          let same = metadata?.itemVersion === undefined || item.version === metadata.itemVersion;
          if (artifact.kind === 'table' && item.kind === 'table') {
            const fixed = ResearchStructuredTable.parse(
              JSON.parse(snapshot.bytes.toString('utf8')),
            );
            const current = await readResearchTable(ctx, projectId, item);
            same &&= fixed.hash === current.hash;
          } else if (artifact.kind === 'note' && item.kind === 'note') {
            same &&= snapshot.bytes.toString('utf8') === item.body;
          }
          return {
            itemId: item.id,
            state: same ? 'current' : 'changed',
            reason: same ? null : '上游产物已修改，后续结果待复核',
          };
        } catch (error) {
          return {
            itemId: ref.itemId,
            state: 'unavailable',
            reason: error instanceof Error ? error.message : '上游产物当前不可读取',
          };
        }
      })();
      artifactChecks.set(ref.id, check);
    }
    return check;
  };
  for (const step of run.steps) {
    // 确认只替换该人工步骤实际确认的输入，其他分支仍检查各自消费的版本。
    const confirmed = new Map<string, ResearchArtifactRef>();
    if (
      step.definition.action.kind === 'human' &&
      step.status === 'succeeded' &&
      step.confirmedBy?.kind === 'user'
    ) {
      for (const output of successfulOutputs(step))
        if (output.origin === 'member_report' && output.artifact)
          confirmed.set(output.itemId, output.artifact);
    }
    const action = step.definition.action;
    const bindings =
      action.inputs === undefined
        ? action.inputItemIds.map((itemId) => ({ kind: 'item' as const, itemId }))
        : action.inputs.flatMap((binding) =>
            binding.source.kind === 'item' ? [binding.source] : [],
          );
    for (const binding of bindings) {
      const fixed = confirmed.get(binding.itemId);
      checks.push(fixed ? checkArtifact(fixed) : checkDirect(binding));
    }
    if (action.inputs === undefined) {
      for (const dependency of step.definition.dependsOn) {
        for (const output of successfulOutputs(stepById(run, dependency))) {
          if (!output.artifact) continue;
          const fixed = confirmed.get(output.itemId);
          const check = checkArtifact(fixed ?? output.artifact);
          // 旧 dependsOn 不曾列出未变化的中间结果；只追加有问题的旧分支。
          checks.push(
            fixed ? check : check.then((entry) => (entry.state === 'current' ? null : entry)),
          );
        }
      }
      continue;
    }
    for (const binding of action.inputs) {
      const source = binding.source;
      if (source.kind !== 'output') continue;
      const artifact = source.artifactVersionId
        ? (await getArtifact(ctx, projectId, source.artifactVersionId)).data
        : successfulOutputs(stepById(run, source.stepId)).find(
            (output) => output.outputKey === source.outputKey,
          )?.artifact;
      if (artifact) checks.push(checkArtifact(confirmed.get(artifact.itemId) ?? artifact));
    }
  }
  const byItem = new Map<string, InputState>();
  const rank = { current: 0, changed: 1, unavailable: 2 };
  for (const input of await Promise.all(checks)) {
    if (!input) continue;
    const existing = byItem.get(input.itemId);
    if (!existing || rank[input.state] > rank[existing.state]) byItem.set(input.itemId, input);
  }
  const inputs = [...byItem.values()];
  return { stale: inputs.some((input) => input.state !== 'current'), inputs };
}
