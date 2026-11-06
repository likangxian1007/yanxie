import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { and, desc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  ApiError,
  ResearchItemCreateInput,
  ResearchItemUpdateInput,
  ResearchRelationCreateInput,
  ResearchWorkspaceCreateInput,
  ulid,
  newId,
  type ActorRef,
  type Page,
  type ResearchItem,
  type ResearchItemSummary,
  type ResearchRelation,
  type ResearchRecord,
  type ResearchEvidenceRef,
  type ResearchSource,
  type EvidenceExcerpt,
  type ResearchFinding,
  type ResearchItemContent,
  type ResearchItemPositionInput,
  type ResearchRelationUpdateInput,
} from '@srh/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/client';
import {
  researchWorkspaceItems,
  researchWorkspaceRelations,
  researchIdempotency,
  researchEntities,
  researchRevisions,
  researchArtifactVersions,
  researchRuns,
  files,
  papers,
  paperChunks,
} from '../../db/schema';
import { notFound } from '../collab-common';
import { diskPath, isTextMime } from '../files/service';
import { getRow as getDocumentRow, readDocument } from '../documents/service';
import { readPlainNotebook } from '../notebooks/service';
import { createResearchTable, researchSeedCellValue } from './tables';
import {
  artifactWasPublished,
  publishedArtifactCondition,
  visibleWorkspaceItemCondition,
} from './artifacts';
import {
  checkResource,
  createRecord,
  createSource,
  createSnapshot,
  createExcerpt,
  getEntity,
} from './service';

const digest = (v: unknown) =>
  createHash('sha256')
    .update(typeof v === 'string' ? v : JSON.stringify(v))
    .digest('hex');
const preview = (body: string) => body.replace(/\s+/gu, ' ').trim().slice(0, 300);
const invalid = (message: string): never => {
  throw new ApiError('validation_failed', message);
};
const itemDto = (r: typeof researchWorkspaceItems.$inferSelect): ResearchItem => ({
  ...r,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  archivedAt: r.archivedAt?.toISOString() ?? null,
});
const relationDto = (r: typeof researchWorkspaceRelations.$inferSelect): ResearchRelation => ({
  ...r,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  archivedAt: r.archivedAt?.toISOString() ?? null,
});
const pageSize = (n?: number) => Math.max(1, Math.min(100, n ?? 50));
type Query = { cursor?: string; limit?: number };

export async function createWorkspace(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  raw: ResearchWorkspaceCreateInput,
): Promise<ResearchRecord> {
  const input = ResearchWorkspaceCreateInput.parse(raw);
  return createRecord(ctx, actor, projectId, {
    templateId: 'rtpl_preset_general',
    title: input.title,
    question: input.question,
    idempotencyKey: input.idempotencyKey,
  });
}

export async function getWorkspaceItem(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  itemId: string,
): Promise<ResearchItem> {
  const [row] = await ctx.db.db
    .select()
    .from(researchWorkspaceItems)
    .where(
      and(
        eq(researchWorkspaceItems.projectId, projectId),
        eq(researchWorkspaceItems.recordId, recordId),
        eq(researchWorkspaceItems.id, itemId),
        isNull(researchWorkspaceItems.archivedAt),
      ),
    );
  if (!row) notFound('研究条目');
  return itemDto(row);
}

export async function findWorkspaceItem(
  ctx: AppContext,
  projectId: string,
  itemId: string,
): Promise<ResearchItem> {
  const [row] = await ctx.db.db
    .select()
    .from(researchWorkspaceItems)
    .where(
      and(
        eq(researchWorkspaceItems.projectId, projectId),
        eq(researchWorkspaceItems.id, itemId),
        isNull(researchWorkspaceItems.archivedAt),
      ),
    );
  if (!row) notFound('研究条目');
  return itemDto(row);
}

export async function listWorkspaceItems(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  query: Query = {},
): Promise<Page<ResearchItemSummary>> {
  await getEntity<ResearchRecord>(ctx, projectId, 'record', recordId);
  const t = researchWorkspaceItems;
  const rows = await ctx.db.db
    .select({
      id: t.id,
      projectId: t.projectId,
      recordId: t.recordId,
      kind: t.kind,
      title: t.title,
      resource: t.resource,
      evidenceRef: t.evidenceRef,
      originItemId: sql<string | null>`${t.origin}->>'itemId'`,
      parentId: t.parentId,
      position: t.position,
      version: t.version,
      positionVersion: t.positionVersion,
      preview: t.preview,
      actionKind: sql<ResearchItemSummary['actionKind']>`${t.action}->>'kind'`,
      actionInputs: sql<ResearchItemSummary['actionInputs']>`case when ${t.action} ? 'inputs'
        then coalesce(${t.action}->'inputs', '[]'::jsonb)
        else coalesce((select jsonb_agg(jsonb_build_object('name', '输入' || ord::text, 'source', jsonb_build_object('kind', 'item', 'itemId', value))) from jsonb_array_elements_text(coalesce(${t.action}->'inputItemIds', '[]'::jsonb)) with ordinality as legacy(value, ord)), '[]'::jsonb) end`,
      actionOutputs: sql<
        ResearchItemSummary['actionOutputs']
      >`coalesce(${t.action}->'outputs', '[]'::jsonb)`,
      producerStepId: sql<
        string | null
      >`(select ${researchArtifactVersions.data}->>'stepId' from ${researchArtifactVersions} where ${researchArtifactVersions}.${sql.identifier('item_id')} = ${t}.${sql.identifier('id')} and ${publishedArtifactCondition} order by ${researchArtifactVersions.version} asc limit 1)`,
      producerOutputKey: sql<
        string | null
      >`(select ${researchArtifactVersions.data}->>'outputKey' from ${researchArtifactVersions} where ${researchArtifactVersions}.${sql.identifier('item_id')} = ${t}.${sql.identifier('id')} and ${publishedArtifactCondition} order by ${researchArtifactVersions.version} asc limit 1)`,
      previewImageFileId: sql<
        string | null
      >`case when ${t.kind} = 'figure' then coalesce(${t.payload}->>'pngFileId', ${t.payload}->>'svgFileId', case when ${t.resource}->>'kind' = 'file' then ${t.resource}->>'id' end) else null end`,
      runStatus: sql<
        string | null
      >`(select step->>'status' from ${researchRuns} run, jsonb_array_elements(run.data->'steps') step where run.project_id = ${t}.${sql.identifier('project_id')} and run.record_id = ${t}.${sql.identifier('record_id')} and step->'definition'->>'itemId' = ${t}.${sql.identifier('id')} order by run.updated_at desc limit 1)`,
      createdBy: t.createdBy,
      updatedBy: t.updatedBy,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      archivedAt: t.archivedAt,
    })
    .from(t)
    .where(
      and(
        eq(t.projectId, projectId),
        eq(t.recordId, recordId),
        isNull(t.archivedAt),
        visibleWorkspaceItemCondition,
        query.cursor ? lt(t.id, query.cursor) : undefined,
      ),
    )
    .orderBy(desc(t.id))
    .limit(pageSize(query.limit) + 1);
  const limit = pageSize(query.limit);
  return {
    items: rows.slice(0, limit).map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      archivedAt: r.archivedAt?.toISOString() ?? null,
    })),
    nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
  };
}

export async function listWorkspaceRelations(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  query: Query = {},
): Promise<Page<ResearchRelation>> {
  await getEntity<ResearchRecord>(ctx, projectId, 'record', recordId);
  const t = researchWorkspaceRelations;
  const i = researchWorkspaceItems;
  const rows = await ctx.db.db
    .select()
    .from(t)
    .where(
      and(
        eq(t.projectId, projectId),
        eq(t.recordId, recordId),
        isNull(t.archivedAt),
        query.cursor ? lt(t.id, query.cursor) : undefined,
        sql`exists (select 1 from ${i} where ${i.id} = ${t.fromItemId} and ${i.archivedAt} is null)`,
        sql`exists (select 1 from ${i} where ${i.id} = ${t.toItemId} and ${i.archivedAt} is null)`,
      ),
    )
    .orderBy(desc(t.id))
    .limit(pageSize(query.limit) + 1);
  const limit = pageSize(query.limit);
  return {
    items: rows.slice(0, limit).map(relationDto),
    nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
  };
}

export async function getWorkspace(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  query: Query = {},
) {
  const record = await getEntity<ResearchRecord>(ctx, projectId, 'record', recordId);
  const items = await listWorkspaceItems(ctx, projectId, recordId, query);
  const relations = await listWorkspaceRelations(ctx, projectId, recordId, { limit: query.limit });
  return { record, items, relations };
}

async function checkEvidence(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  ref: ResearchEvidenceRef,
) {
  const obj = await getEntity<ResearchSource | EvidenceExcerpt | ResearchFinding>(
    ctx,
    projectId,
    ref.kind,
    ref.id,
  );
  // 来源是项目共享对象，创建条目本身即建立引用；摘录和发现属于各自的研究空间。
  if (ref.kind !== 'source' && obj.recordId !== recordId) invalid('证据不属于此研究');
}

async function checkItemLinks(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  item: Pick<ResearchItem, 'kind' | 'resource' | 'evidenceRef' | 'action' | 'parentId' | 'payload'>,
  selfId?: string,
  changed: { resource: boolean; evidence: boolean; action: boolean; parent: boolean } = {
    resource: true,
    evidence: true,
    action: true,
    parent: true,
  },
) {
  if (item.resource && item.evidenceRef) invalid('条目只能引用一个原件或证据');
  if (item.kind === 'table' && item.resource && item.resource.kind !== 'document')
    invalid('表格必须引用工作簿');
  if (changed.resource && item.resource) await checkResource(ctx, projectId, item.resource);
  if (item.kind === 'table' && item.resource?.kind === 'document') {
    const document = await getDocumentRow(ctx, projectId, item.resource.id);
    if (document.kind !== 'sheet') invalid('表格引用的文档必须是工作簿');
  }
  if (changed.evidence && item.evidenceRef)
    await checkEvidence(ctx, projectId, recordId, item.evidenceRef);
  if (item.action && item.kind !== 'action') invalid('只有行动条目可以配置行动');
  if (item.payload && item.payload.kind !== item.kind) invalid('内容类型与条目类型不一致');
  if (item.payload?.kind === 'draft') {
    const blocks = item.payload.blocks;
    if (new Set(blocks.map((block) => block.id)).size !== blocks.length)
      invalid('草稿素材标识不能重复');
    for (const block of blocks) {
      if (block.kind === 'resource') await checkResource(ctx, projectId, block.resource);
      if (block.kind === 'excerpt')
        await checkEvidence(ctx, projectId, recordId, { kind: 'excerpt', id: block.excerptId });
    }
  }
  if (item.payload?.kind === 'figure') {
    for (const fileId of [item.payload.svgFileId, item.payload.pngFileId])
      if (fileId) await checkResource(ctx, projectId, { kind: 'file', id: fileId });
    if (item.payload.dataArtifactId) {
      const [artifact] = await ctx.db.db
        .select()
        .from(researchArtifactVersions)
        .where(
          and(
            eq(researchArtifactVersions.id, item.payload.dataArtifactId),
            eq(researchArtifactVersions.projectId, projectId),
            eq(researchArtifactVersions.recordId, recordId),
          ),
        );
      if (!artifact || artifact.data.kind !== 'table') invalid('图表数据版本不属于此研究');
    }
  }
  if (item.payload?.kind === 'table') {
    const columns = item.payload.columns ?? [];
    if (new Set(columns.map((column) => column.id)).size !== columns.length)
      invalid('表格列标识不能重复');
    for (const source of item.payload.lineage ?? []) {
      const sourceItem = source.itemId
        ? await getWorkspaceItem(ctx, projectId, recordId, source.itemId)
        : null;
      if (
        source.blockId &&
        (!sourceItem ||
          sourceItem.payload?.kind !== 'draft' ||
          !sourceItem.payload.blocks.some((block) => block.id === source.blockId))
      )
        invalid('单元格来源中的草稿块不存在');
      if (source.excerptId)
        await checkEvidence(ctx, projectId, recordId, { kind: 'excerpt', id: source.excerptId });
      if (
        source.excerptId &&
        source.blockId &&
        sourceItem?.payload?.kind === 'draft' &&
        !sourceItem.payload.blocks.some(
          (block) =>
            block.id === source.blockId &&
            block.kind === 'excerpt' &&
            block.excerptId === source.excerptId,
        )
      )
        invalid('单元格来源中的摘录与草稿块不一致');
    }
  }
  if (changed.action && item.action?.notebookId)
    await checkResource(ctx, projectId, { kind: 'notebook', id: item.action.notebookId });
  if (changed.action && item.action?.inputs === undefined)
    for (const id of item.action?.inputItemIds ?? []) {
      if (id === selfId) invalid('行动不能以自身为输入');
      const source = await getWorkspaceItem(ctx, projectId, recordId, id);
      if (source.kind === 'action' || source.kind === 'group') invalid('输入必须是内容条目');
    }
  if (changed.action && item.action) {
    const inputs = item.action.inputs ?? [];
    const outputs = item.action.outputs ?? [];
    const operation = item.action.operation;
    if (item.action.processing?.mode === 'auto' && item.action.kind !== 'ai')
      invalid('自动规划仅适用于 AI 处理步骤');
    if (operation && operation !== 'free' && item.action.kind !== 'ai')
      invalid('该处理动作需要自动处理步骤');
    if (item.action.kind === 'human' && outputs.some((output) => output.kind === 'figure'))
      invalid('人工检查首轮仅支持确认笔记或表格');
    if (item.action.kind === 'notebook' && outputs.some((output) => output.kind !== 'note'))
      invalid('Notebook 首轮输出为可阅读笔记');
    if (
      operation !== 'chart' &&
      item.action.processing?.mode !== 'auto' &&
      outputs.some((output) => output.kind === 'figure')
    )
      invalid('图表输出请使用绘图动作');
    if (
      item.action.processing?.mode !== 'auto' &&
      outputs.length &&
      ['extract_table', 'transform_table'].includes(operation ?? '') &&
      (outputs.length !== 1 || outputs[0]!.kind !== 'table')
    )
      invalid('表格处理需要一个表格输出');
    if (
      item.action.processing?.mode !== 'auto' &&
      outputs.length &&
      operation === 'chart' &&
      (outputs.length !== 1 || outputs[0]!.kind !== 'figure')
    )
      invalid('绘图需要一个图表输出');
    if (
      item.action.processing?.mode !== 'auto' &&
      ['transform_table', 'chart'].includes(operation ?? '') &&
      inputs.length > 1
    )
      invalid('基础表格处理或绘图需要一个表格输入');
    if (new Set(inputs.map((input) => input.name)).size !== inputs.length)
      invalid('输入名称不能重复');
    if (new Set(outputs.map((output) => output.key)).size !== outputs.length)
      invalid('输出名称不能重复');
    for (const input of inputs) {
      const source = input.source;
      const sourceId = source.kind === 'item' ? source.itemId : source.stepId;
      if (sourceId === selfId) invalid('行动不能以自身为输入');
      const upstream = await getWorkspaceItem(ctx, projectId, recordId, sourceId);
      if (source.kind === 'item') {
        if (upstream.kind === 'action' || upstream.kind === 'group') invalid('输入必须是内容条目');
        if (source.blockIds) {
          if (!source.blockIds.length) return invalid('请至少选择一个草稿素材块');
          const payload = upstream.payload;
          if (!payload || payload.kind !== 'draft') return invalid('只能选择草稿中的素材块');
          const blockIds = new Set(payload.blocks.map((block) => block.id));
          if (
            new Set(source.blockIds).size !== source.blockIds.length ||
            source.blockIds.some((id) => !blockIds.has(id))
          )
            invalid('所选草稿素材不存在或重复');
        }
        if (
          item.action.processing?.mode !== 'auto' &&
          ['transform_table', 'chart'].includes(item.action.operation ?? '') &&
          upstream.kind !== 'table'
        )
          invalid('表格处理和绘图的输入必须是表格');
      } else {
        const upstreamAction = upstream.action;
        if (upstream.kind !== 'action' || !upstreamAction)
          return invalid('上游输出必须来自处理步骤');
        const declared = upstreamAction.outputs ?? [];
        const inferredKind =
          upstreamAction.operation === 'extract_table' ||
          upstreamAction.operation === 'transform_table'
            ? 'table'
            : upstreamAction.operation === 'chart'
              ? 'figure'
              : 'note';
        const declaration =
          declared.find((output) => output.key === source.outputKey) ??
          (!declared.length && source.outputKey === 'result'
            ? { key: 'result', kind: inferredKind }
            : undefined) ??
          invalid('上游步骤没有声明所选输出');
        if (
          item.action.processing?.mode !== 'auto' &&
          ['transform_table', 'chart'].includes(item.action.operation ?? '') &&
          declaration.kind !== 'table'
        )
          invalid('表格处理和绘图只能连接表格输出');
        if (source.artifactVersionId) {
          const [artifact] = await ctx.db.db
            .select()
            .from(researchArtifactVersions)
            .where(
              and(
                eq(researchArtifactVersions.id, source.artifactVersionId),
                eq(researchArtifactVersions.projectId, projectId),
                eq(researchArtifactVersions.recordId, recordId),
              ),
            );
          if (
            !artifact ||
            artifact.data.stepId !== source.stepId ||
            artifact.data.outputKey !== source.outputKey ||
            artifact.data.kind !== declaration.kind ||
            !(await artifactWasPublished(ctx, projectId, artifact.data))
          )
            invalid('选定的产物版本不属于此上游输出');
        }
      }
    }
  }
  if (changed.parent) await checkParent(ctx.db.db, projectId, recordId, item.parentId, selfId);
}

async function checkParent(
  exec: Pick<Db, 'select'>,
  projectId: string,
  recordId: string,
  initial: string | null,
  selfId?: string,
) {
  let parentId = initial;
  const seen = new Set<string>();
  while (parentId) {
    if (parentId === selfId || seen.has(parentId) || seen.size >= 100) invalid('分组不能形成循环');
    seen.add(parentId);
    const [parent] = await exec
      .select()
      .from(researchWorkspaceItems)
      .where(
        and(
          eq(researchWorkspaceItems.id, parentId),
          eq(researchWorkspaceItems.projectId, projectId),
          eq(researchWorkspaceItems.recordId, recordId),
          isNull(researchWorkspaceItems.archivedAt),
        ),
      );
    if (!parent) notFound('研究分组');
    if (parent.kind !== 'group') invalid('上级条目必须是分组');
    parentId = parent.parentId;
  }
}

async function prior<T>(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  action: string,
  key: string | undefined,
  input: unknown,
): Promise<T | null> {
  if (!key) return null;
  const [row] = await ctx.db.db
    .select()
    .from(researchIdempotency)
    .where(
      and(
        eq(researchIdempotency.projectId, projectId),
        eq(researchIdempotency.actorId, actor.id ?? actor.kind),
        eq(researchIdempotency.action, action),
        eq(researchIdempotency.key, key),
      ),
    );
  if (!row) return null;
  if (row.requestHash !== digest(input)) throw new ApiError('conflict', '幂等键已用于其他请求');
  return row.response as T;
}

/** 将项目来源加入旧记录的关联列表，保留字段并在同一事务写入修订和事件。 */
async function linkSource(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  sourceId: string,
) {
  const event = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(researchEntities)
      .where(
        and(
          eq(researchEntities.id, recordId),
          eq(researchEntities.projectId, projectId),
          eq(researchEntities.kind, 'record'),
        ),
      )
      .for('update');
    if (!row) notFound('研究空间');
    const current = row.data as unknown as ResearchRecord;
    if (current.sourceIds.includes(sourceId)) return null;
    if (current.sourceIds.length >= 200) invalid('研究关联来源已达到上限');
    const now = new Date();
    const next: ResearchRecord = {
      ...current,
      sourceIds: [...current.sourceIds, sourceId],
      version: current.version + 1,
      updatedAt: now.toISOString(),
      updatedBy: actor,
    };
    await tx
      .update(researchEntities)
      .set({ data: next, version: next.version, updatedAt: now })
      .where(eq(researchEntities.id, recordId));
    await tx.insert(researchRevisions).values({
      id: newId('researchRevision'),
      projectId,
      recordId,
      version: next.version,
      data: next,
      createdBy: actor,
    });
    return ctx.bus.record(tx, { projectId, type: 'research.record.updated', payload: next, actor });
  });
  if (event) ctx.bus.emit(event);
}

/** 在首个副作用前保留请求哈希；中断后同键可续接，异内容不可复用。 */
async function reserveOriginRequest(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  key: string | undefined,
  input: unknown,
) {
  if (!key) return;
  const action = `research.item.request:${recordId}`;
  const existing = await prior<{ pending: boolean }>(ctx, actor, projectId, action, key, input);
  if (existing) return;
  await ctx.db.db
    .insert(researchIdempotency)
    .values({
      id: newId('researchRevision'),
      projectId,
      actorId: actor.id ?? actor.kind,
      action,
      key,
      requestHash: digest(input),
      response: { pending: true },
    })
    .onConflictDoNothing();
  await prior(ctx, actor, projectId, action, key, input);
}

async function originExcerpt(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  origin: NonNullable<ResearchItem['origin']>,
  baseKey: string,
): Promise<EvidenceExcerpt> {
  const derived = (step: string) => `ws_${digest(`${recordId}:${baseKey}:${step}`).slice(0, 48)}`;
  const citation = JSON.stringify({
    itemId: origin.itemId,
    resource: origin.resource,
    evidenceRef: origin.evidenceRef,
    sourceVersion: origin.sourceVersion,
    locator: origin.locator,
    verification: 'unverified',
  });
  let source: ResearchSource;
  let fixedSnapshotId: string | null = null;
  const originItem = await getWorkspaceItem(ctx, projectId, recordId, origin.itemId);
  if (originItem.kind === 'note') {
    let originalSourceId: string | null = null;
    if (origin.evidenceRef?.kind === 'source') originalSourceId = origin.evidenceRef.id;
    if (origin.evidenceRef?.kind === 'excerpt') {
      const previous = await getEntity<EvidenceExcerpt>(
        ctx,
        projectId,
        'excerpt',
        origin.evidenceRef.id,
      );
      originalSourceId = previous.sourceId;
    }
    // 笔记可编辑，因此截取的是笔记当前版本，不冒充旧固定快照中的原文。
    source = await createSource(ctx, actor, projectId, {
      recordId,
      kind: 'bibliography',
      resourceId: null,
      title: `摘录来源 · ${origin.itemId}`.slice(0, 500),
      citation,
      url: null,
      originalSourceId,
      idempotencyKey: derived('source'),
    });
  } else if (origin.evidenceRef?.kind === 'excerpt') {
    const existing = await getEntity<EvidenceExcerpt>(
      ctx,
      projectId,
      'excerpt',
      origin.evidenceRef.id,
    );
    source = await getEntity<ResearchSource>(ctx, projectId, 'source', existing.sourceId);
    fixedSnapshotId = existing.snapshotId;
  } else if (origin.evidenceRef?.kind === 'source') {
    source = await getEntity<ResearchSource>(ctx, projectId, 'source', origin.evidenceRef.id);
  } else {
    const ref = origin.resource;
    let sourceKind: ResearchSource['kind'] = 'bibliography';
    let resourceId: string | null = null;
    if (
      ref &&
      (ref.kind === 'file' ||
        ref.kind === 'document' ||
        ref.kind === 'paper' ||
        ref.kind === 'notebook')
    ) {
      sourceKind = ref.kind;
      resourceId = ref.id;
    }
    source = await createSource(ctx, actor, projectId, {
      recordId,
      kind: sourceKind,
      resourceId,
      title: `摘录来源 · ${origin.itemId}`.slice(0, 500),
      citation,
      url: null,
      originalSourceId: null,
      idempotencyKey: derived('source'),
    });
  }
  await linkSource(ctx, actor, projectId, recordId, source.id);
  const snapshotId =
    fixedSnapshotId ??
    (
      await createSnapshot(ctx, actor, projectId, source.id, {
        coverage: 'excerpt',
        text: origin.quote,
        idempotencyKey: derived('snapshot'),
      })
    ).id;
  return createExcerpt(ctx, actor, projectId, recordId, {
    sourceId: source.id,
    snapshotId,
    quote: origin.quote,
    locator: { kind: 'manual', note: citation },
    origin: actor.kind === 'user' ? 'member_report' : 'tool_result',
    idempotencyKey: derived('excerpt'),
  });
}

export async function createWorkspaceItem(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  raw: ResearchItemCreateInput,
  options: { trustedLineage?: boolean } = {},
): Promise<ResearchItem> {
  const input = ResearchItemCreateInput.parse(raw);
  const autoPosition = input.position.x === 0 && input.position.y === 0;
  await getEntity<ResearchRecord>(ctx, projectId, 'record', recordId);
  const actionKey = `research.item.created:${recordId}`;
  const existing = await prior<ResearchItem>(
    ctx,
    actor,
    projectId,
    actionKey,
    input.idempotencyKey,
    input,
  );
  if (existing) return existing;
  await checkItemLinks(ctx, projectId, recordId, input);
  if (input.table && input.kind !== 'table') invalid('只有表格条目可以提供初始表格数据');
  if (input.table && input.resource) invalid('初始数据只能用于新建工作簿');
  for (const source of input.table?.lineage ?? []) {
    if (!options.trustedLineage) {
      const sourceItem = source.itemId
        ? await getWorkspaceItem(ctx, projectId, recordId, source.itemId)
        : null;
      if (
        source.blockId &&
        (!sourceItem ||
          sourceItem.payload?.kind !== 'draft' ||
          !sourceItem.payload.blocks.some((block) => block.id === source.blockId))
      )
        invalid('单元格来源中的草稿块不存在');
      if (source.excerptId)
        await checkEvidence(ctx, projectId, recordId, { kind: 'excerpt', id: source.excerptId });
      if (
        source.excerptId &&
        source.blockId &&
        sourceItem?.payload?.kind === 'draft' &&
        !sourceItem.payload.blocks.some(
          (block) =>
            block.id === source.blockId &&
            block.kind === 'excerpt' &&
            block.excerptId === source.excerptId,
        )
      )
        invalid('单元格来源中的摘录与草稿块不一致');
    }
    if (
      !/^r[1-9]\d*$/u.test(source.rowId) ||
      Number(source.rowId.slice(1)) > input.table!.rows.length ||
      !input.table!.columns.some((column) => column.id === source.columnId)
    )
      invalid('单元格来源定位不属于初始表格');
  }
  let resource = input.resource;
  let payload = input.payload ?? null;
  if (input.kind === 'draft' && !payload) payload = { kind: 'draft', blocks: [] };
  if (input.kind === 'figure' && !payload) payload = { kind: 'figure' };
  if (input.kind === 'table') {
    if (resource && resource.kind !== 'document') invalid('表格必须引用工作簿');
    if (!resource) {
      const created = await createResearchTable(ctx, actor, projectId, input.title, input.table);
      resource = { kind: 'document', id: created.documentId };
      const columnMap = new Map(
        input.table?.columns.map((column, i) => [column.id, created.columns[i]!.id]),
      );
      payload = {
        kind: 'table',
        sheetId: created.sheetId,
        columns: created.columns,
        lineage: input.table?.lineage?.map((source) => {
          const rowIndex = Number(source.rowId.slice(1)) - 1;
          const columnIndex = input.table!.columns.findIndex(
            (column) => column.id === source.columnId,
          );
          const originalLocator =
            source.locator && typeof source.locator === 'object' && !Array.isArray(source.locator)
              ? source.locator
              : {};
          return {
            ...source,
            rowId: created.rowIds[rowIndex]!,
            columnId: columnMap.get(source.columnId) ?? source.columnId,
            locator: {
              ...originalLocator,
              cellValue: researchSeedCellValue(
                input.table!.rows[rowIndex]![columnIndex] ?? null,
                input.table!.columns[columnIndex]!,
              ),
            },
            verification: options.trustedLineage ? source.verification : 'unverified',
          };
        }),
      };
    } else if (!payload) payload = { kind: 'table' };
  }
  let origin: ResearchItem['origin'] = null;
  let evidenceRef = input.evidenceRef;
  if (input.origin) {
    if (input.kind !== 'note' || input.resource || input.evidenceRef)
      invalid('摘录必须保存为新的笔记条目');
    const source = await getWorkspaceItem(ctx, projectId, recordId, input.origin.itemId);
    if (!source.resource && !source.evidenceRef) invalid('摘录来源必须引用原件或证据');
    if (input.origin.locator.end <= input.origin.locator.start) invalid('摘录定位范围无效');
    origin = {
      ...input.origin,
      resource: source.resource,
      evidenceRef: source.evidenceRef,
      verification: 'unverified',
    };
    await reserveOriginRequest(ctx, actor, projectId, recordId, input.idempotencyKey, input);
    const excerpt = await originExcerpt(
      ctx,
      actor,
      projectId,
      recordId,
      origin,
      input.idempotencyKey ?? ulid(),
    );
    evidenceRef = { kind: 'excerpt', id: excerpt.id };
  }
  const stamp = new Date();
  const row = {
    id: `rwi_${ulid()}`,
    projectId,
    recordId,
    kind: input.kind,
    title: input.title,
    body: input.body,
    preview: preview(
      input.table
        ? `创建时 · 列：${input.table.columns
            .slice(0, 6)
            .map((column) => `${column.name}${column.unit ? ` (${column.unit})` : ''}`)
            .join('、')}${
            input.table.rows.length
              ? `；首行：${input.table.rows[0]!.slice(0, 6)
                  .map((value) => (value === null ? '—' : String(value)))
                  .join('、')}`
              : '；无数据行'
          }`
        : input.body ||
            (payload?.kind === 'draft'
              ? payload.blocks
                  .map((block) =>
                    block.kind === 'text'
                      ? block.text
                      : block.kind === 'resource'
                        ? (block.title ?? block.resource.id)
                        : block.excerptId,
                  )
                  .join(' ')
              : ''),
    ),
    resource,
    payload,
    evidenceRef,
    action: input.action,
    origin,
    parentId: input.parentId,
    position: input.position,
    version: 1,
    positionVersion: 1,
    createdBy: actor,
    updatedBy: actor,
    createdAt: stamp,
    updatedAt: stamp,
    archivedAt: null,
  };
  let dto = itemDto(row);
  let event;
  try {
    event = await ctx.db.db.transaction(async (tx) => {
      if (row.parentId || autoPosition) {
        await tx.execute(
          sql`select id from ${researchEntities} where ${researchEntities.id} = ${recordId} and ${researchEntities.projectId} = ${projectId} for update`,
        );
        if (row.parentId) await checkParent(tx, projectId, recordId, row.parentId, row.id);
      }
      if (autoPosition) {
        const occupied = await tx
          .select({ position: researchWorkspaceItems.position })
          .from(researchWorkspaceItems)
          .where(
            and(
              eq(researchWorkspaceItems.projectId, projectId),
              eq(researchWorkspaceItems.recordId, recordId),
              isNull(researchWorkspaceItems.archivedAt),
            ),
          );
        for (let slot = 0; ; slot++) {
          const next = { x: 80 + (slot % 3) * 270, y: 80 + Math.floor(slot / 3) * 240 };
          if (
            occupied.every(
              ({ position }) =>
                Math.abs(position.x - next.x) >= 250 || Math.abs(position.y - next.y) >= 220,
            )
          ) {
            row.position = next;
            break;
          }
        }
        dto = itemDto(row);
      }
      await tx.insert(researchWorkspaceItems).values(row);
      if (input.idempotencyKey)
        await tx.insert(researchIdempotency).values({
          id: newId('researchRevision'),
          projectId,
          actorId: actor.id ?? actor.kind,
          action: actionKey,
          key: input.idempotencyKey,
          requestHash: digest(input),
          response: dto,
        });
      return ctx.bus.record(tx, { projectId, type: 'research.item.created', payload: dto, actor });
    });
  } catch (e) {
    const winner = await prior<ResearchItem>(
      ctx,
      actor,
      projectId,
      actionKey,
      input.idempotencyKey,
      input,
    );
    if (winner) return winner;
    throw e;
  }
  ctx.bus.emit(event);
  return dto;
}

export async function updateWorkspaceItem(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  itemId: string,
  raw: ResearchItemUpdateInput,
): Promise<ResearchItem> {
  const input = ResearchItemUpdateInput.parse(raw);
  const current = await getWorkspaceItem(ctx, projectId, recordId, itemId);
  await checkItemLinks(ctx, projectId, recordId, { ...current, ...input }, itemId, {
    resource: input.resource !== undefined,
    evidence: input.evidenceRef !== undefined,
    action: input.action !== undefined,
    parent: input.parentId !== undefined,
  });
  const { baseVersion, ...rawPatch } = input;
  const oldLineage = current.payload?.kind === 'table' ? (current.payload.lineage ?? []) : [];
  const patch =
    rawPatch.payload?.kind === 'table'
      ? {
          ...rawPatch,
          payload: {
            ...rawPatch.payload,
            lineage: rawPatch.payload.lineage?.map((source) => {
              const old = oldLineage.find(
                (entry) => entry.rowId === source.rowId && entry.columnId === source.columnId,
              );
              const same =
                old &&
                JSON.stringify({ ...old, verification: undefined }) ===
                  JSON.stringify({ ...source, verification: undefined });
              return {
                ...source,
                verification: old && same ? old.verification : ('unverified' as const),
              };
            }),
          },
        }
      : rawPatch;
  const nextPayload = patch.payload === undefined ? current.payload : patch.payload;
  const stamp = new Date();
  const event = await ctx.db.db.transaction(async (tx) => {
    if (input.parentId !== undefined) {
      await tx.execute(
        sql`select id from ${researchEntities} where ${researchEntities.id} = ${recordId} and ${researchEntities.projectId} = ${projectId} for update`,
      );
      await checkParent(tx, projectId, recordId, input.parentId, itemId);
    }
    const [row] = await tx
      .update(researchWorkspaceItems)
      .set({
        ...patch,
        ...(patch.body !== undefined || patch.payload !== undefined
          ? {
              preview: preview(
                nextPayload?.kind === 'draft'
                  ? nextPayload.blocks
                      .map((block) =>
                        block.kind === 'text'
                          ? block.text
                          : block.kind === 'resource'
                            ? (block.title ?? block.resource.id)
                            : block.excerptId,
                      )
                      .join(' ') ||
                      (patch.body ?? current.body)
                  : (patch.body ?? current.body),
              ),
            }
          : {}),
        version: sql`${researchWorkspaceItems.version} + 1`,
        updatedBy: actor,
        updatedAt: stamp,
      })
      .where(
        and(
          eq(researchWorkspaceItems.id, itemId),
          eq(researchWorkspaceItems.projectId, projectId),
          eq(researchWorkspaceItems.recordId, recordId),
          eq(researchWorkspaceItems.version, baseVersion),
          isNull(researchWorkspaceItems.archivedAt),
        ),
      )
      .returning();
    if (!row) {
      const [latest] = await tx
        .select()
        .from(researchWorkspaceItems)
        .where(
          and(
            eq(researchWorkspaceItems.id, itemId),
            eq(researchWorkspaceItems.projectId, projectId),
            eq(researchWorkspaceItems.recordId, recordId),
            isNull(researchWorkspaceItems.archivedAt),
          ),
        );
      if (!latest) notFound('研究条目');
      throw new ApiError('version_conflict', '内容已被他人修改，已为你载入最新版本', {
        current: itemDto(latest),
      });
    }
    return ctx.bus.record(tx, {
      projectId,
      type: 'research.item.updated',
      payload: itemDto(row),
      actor,
    });
  });
  ctx.bus.emit(event);
  return event.payload;
}

export async function updateWorkspaceItemPosition(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  itemId: string,
  input: ResearchItemPositionInput,
): Promise<ResearchItem> {
  await getWorkspaceItem(ctx, projectId, recordId, itemId);
  const event = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx
      .update(researchWorkspaceItems)
      .set({
        position: input.position,
        positionVersion: sql`${researchWorkspaceItems.positionVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(researchWorkspaceItems.id, itemId),
          eq(researchWorkspaceItems.projectId, projectId),
          eq(researchWorkspaceItems.recordId, recordId),
          eq(researchWorkspaceItems.positionVersion, input.basePositionVersion),
          isNull(researchWorkspaceItems.archivedAt),
        ),
      )
      .returning();
    if (!row) {
      const [latest] = await tx
        .select()
        .from(researchWorkspaceItems)
        .where(
          and(
            eq(researchWorkspaceItems.id, itemId),
            eq(researchWorkspaceItems.projectId, projectId),
            eq(researchWorkspaceItems.recordId, recordId),
            isNull(researchWorkspaceItems.archivedAt),
          ),
        );
      if (!latest) notFound('研究条目');
      throw new ApiError('version_conflict', '位置已被他人修改', { current: itemDto(latest) });
    }
    return ctx.bus.record(tx, {
      projectId,
      type: 'research.item.updated',
      payload: itemDto(row),
      actor,
    });
  });
  ctx.bus.emit(event);
  return event.payload;
}

export async function archiveWorkspaceItem(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  itemId: string,
  baseVersion: number,
): Promise<void> {
  await getWorkspaceItem(ctx, projectId, recordId, itemId);
  const now = new Date();
  const event = await ctx.db.db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from ${researchEntities} where ${researchEntities.id} = ${recordId} and ${researchEntities.projectId} = ${projectId} for update`,
    );
    const [child] = await tx
      .select({ id: researchWorkspaceItems.id })
      .from(researchWorkspaceItems)
      .where(
        and(
          eq(researchWorkspaceItems.projectId, projectId),
          eq(researchWorkspaceItems.recordId, recordId),
          eq(researchWorkspaceItems.parentId, itemId),
          isNull(researchWorkspaceItems.archivedAt),
        ),
      )
      .limit(1);
    if (child) throw new ApiError('conflict', '请先移出或归档分组内的条目');
    const [row] = await tx
      .update(researchWorkspaceItems)
      .set({
        archivedAt: now,
        updatedAt: now,
        updatedBy: actor,
        version: sql`${researchWorkspaceItems.version}+1`,
      })
      .where(
        and(
          eq(researchWorkspaceItems.id, itemId),
          eq(researchWorkspaceItems.projectId, projectId),
          eq(researchWorkspaceItems.recordId, recordId),
          eq(researchWorkspaceItems.version, baseVersion),
          isNull(researchWorkspaceItems.archivedAt),
        ),
      )
      .returning();
    if (!row) {
      const [latest] = await tx
        .select()
        .from(researchWorkspaceItems)
        .where(
          and(
            eq(researchWorkspaceItems.id, itemId),
            eq(researchWorkspaceItems.projectId, projectId),
            eq(researchWorkspaceItems.recordId, recordId),
            isNull(researchWorkspaceItems.archivedAt),
          ),
        );
      if (!latest) notFound('研究条目');
      throw new ApiError('version_conflict', '内容已被他人修改', { current: itemDto(latest) });
    }
    return ctx.bus.record(tx, {
      projectId,
      type: 'research.item.archived',
      payload: itemDto(row),
      actor,
    });
  });
  ctx.bus.emit(event);
}

export async function createWorkspaceRelation(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  raw: ResearchRelationCreateInput,
): Promise<ResearchRelation> {
  const input = ResearchRelationCreateInput.parse(raw);
  await getEntity<ResearchRecord>(ctx, projectId, 'record', recordId);
  const actionKey = `research.relation.created:${recordId}`;
  const existing = await prior<ResearchRelation>(
    ctx,
    actor,
    projectId,
    actionKey,
    input.idempotencyKey,
    input,
  );
  if (existing) return existing;
  if (input.fromItemId === input.toItemId) invalid('关系不能连接同一条目');
  await getWorkspaceItem(ctx, projectId, recordId, input.fromItemId);
  await getWorkspaceItem(ctx, projectId, recordId, input.toItemId);
  const stamp = new Date();
  const row = {
    id: `rwr_${ulid()}`,
    projectId,
    recordId,
    fromItemId: input.fromItemId,
    toItemId: input.toItemId,
    label: input.label,
    version: 1,
    createdBy: actor,
    updatedBy: actor,
    createdAt: stamp,
    updatedAt: stamp,
    archivedAt: null,
  };
  const dto = relationDto(row);
  let event;
  try {
    event = await ctx.db.db.transaction(async (tx) => {
      await tx.insert(researchWorkspaceRelations).values(row);
      if (input.idempotencyKey)
        await tx.insert(researchIdempotency).values({
          id: newId('researchRevision'),
          projectId,
          actorId: actor.id ?? actor.kind,
          action: actionKey,
          key: input.idempotencyKey,
          requestHash: digest(input),
          response: dto,
        });
      return ctx.bus.record(tx, {
        projectId,
        type: 'research.relation.created',
        payload: dto,
        actor,
      });
    });
  } catch (e) {
    const winner = await prior<ResearchRelation>(
      ctx,
      actor,
      projectId,
      actionKey,
      input.idempotencyKey,
      input,
    );
    if (winner) return winner;
    throw e;
  }
  ctx.bus.emit(event);
  return dto;
}

export async function updateWorkspaceRelation(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  relationId: string,
  input: ResearchRelationUpdateInput,
  archive = false,
): Promise<ResearchRelation> {
  const t = researchWorkspaceRelations;
  const now = new Date();
  const event = await ctx.db.db.transaction(async (tx) => {
    const [row] = await tx
      .update(t)
      .set({
        ...(!archive ? { label: input.label } : {}),
        ...(archive ? { archivedAt: now } : {}),
        version: sql`${t.version}+1`,
        updatedAt: now,
        updatedBy: actor,
      })
      .where(
        and(
          eq(t.id, relationId),
          eq(t.projectId, projectId),
          eq(t.recordId, recordId),
          eq(t.version, input.baseVersion),
          isNull(t.archivedAt),
        ),
      )
      .returning();
    if (!row) {
      const [latest] = await tx
        .select()
        .from(t)
        .where(
          and(
            eq(t.id, relationId),
            eq(t.projectId, projectId),
            eq(t.recordId, recordId),
            isNull(t.archivedAt),
          ),
        );
      if (!latest) notFound('研究关系');
      throw new ApiError('version_conflict', '关系已被他人修改', { current: relationDto(latest) });
    }
    return ctx.bus.record(tx, {
      projectId,
      type: archive ? 'research.relation.archived' : 'research.relation.updated',
      payload: relationDto(row),
      actor,
    });
  });
  ctx.bus.emit(event);
  return event.payload;
}

export async function listWorkspaceActivity(
  ctx: AppContext,
  projectId: string,
  recordIds: string[],
): Promise<Map<string, string>> {
  if (!recordIds.length) return new Map();
  const rows = await ctx.db.db
    .select({
      recordId: researchWorkspaceItems.recordId,
      latest: sql<Date>`max(${researchWorkspaceItems.updatedAt})`,
    })
    .from(researchWorkspaceItems)
    .where(
      and(
        eq(researchWorkspaceItems.projectId, projectId),
        inArray(researchWorkspaceItems.recordId, recordIds),
      ),
    )
    .groupBy(researchWorkspaceItems.recordId);
  const wanted = new Set(recordIds);
  return new Map(
    rows
      .filter((r) => wanted.has(r.recordId))
      .map((r) => [r.recordId, new Date(r.latest).toISOString()]),
  );
}

export async function searchWorkspaceItems(
  ctx: AppContext,
  projectId: string,
  query: { q: string; limit?: number; cursor?: string },
) {
  const t = researchWorkspaceItems;
  const pattern = `%${query.q.replace(/[\\%_]/gu, '\\$&')}%`;
  const rows = await ctx.db.db
    .select({ id: t.id, recordId: t.recordId, title: t.title, preview: t.preview })
    .from(t)
    .where(
      and(
        eq(t.projectId, projectId),
        isNull(t.archivedAt),
        visibleWorkspaceItemCondition,
        query.cursor ? lt(t.id, query.cursor) : undefined,
        or(
          ilike(t.title, pattern),
          ilike(t.body, pattern),
          sql`${t.payload}::text ilike ${pattern}`,
        ),
      ),
    )
    .orderBy(desc(t.id))
    .limit(Math.max(1, Math.min(101, query.limit ?? 50)));
  return rows.map((r) => ({
    kind: 'item' as const,
    id: r.id,
    projectId,
    recordId: r.recordId,
    title: r.title,
    snippet: r.preview,
    href: `/p/${projectId}/research-items/${r.id}`,
  }));
}

/** 不复制原件到工作区；每次读前重检项目/团队空间。版本取当前正文摘要，跨页必须比较。 */
export async function getWorkspaceItemContent(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  itemId: string,
  query: { offset?: number; limit?: number } = {},
): Promise<ResearchItemContent> {
  const item = await getWorkspaceItem(ctx, projectId, recordId, itemId);
  return readWorkspaceItemContent(ctx, projectId, recordId, item, query);
}

/** 使用同样的资源权限及分页规则读取草稿块，不把资源引用当成正文。 */
export async function readWorkspaceItemContent(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  item: ResearchItem,
  query: { offset?: number; limit?: number } = {},
): Promise<ResearchItemContent> {
  const offset = Math.max(0, query.offset ?? 0),
    limit = Math.max(1, Math.min(50000, query.limit ?? 20000));
  const result: ResearchItemContent = {
    title: item.title,
    resource: item.resource,
    evidenceRef: item.evidenceRef,
    text: null,
    summary: null,
    locator: null,
    nextOffset: null,
    mime: null,
    version: null,
    href: null,
    unavailableReason: null,
  };
  const useText = (
    text: string,
    version: number | string,
    locator: unknown = null,
    mime = 'text/plain',
  ) => {
    result.text = text.slice(offset, offset + limit);
    result.nextOffset = offset + limit < text.length ? offset + limit : null;
    result.version = version;
    result.locator = locator;
    result.mime = mime;
  };
  if (item.kind === 'note') {
    useText(item.body, item.version, item.origin?.locator ?? null, 'text/markdown');
    return result;
  }
  let ref = item.resource;
  if (item.evidenceRef) {
    await checkEvidence(ctx, projectId, recordId, item.evidenceRef);
    if (item.evidenceRef.kind === 'source') {
      const source = await getEntity<ResearchSource>(ctx, projectId, 'source', item.evidenceRef.id);
      result.title = source.title;
      result.summary = source.citation;
      if (
        source.resourceId &&
        (source.kind === 'file' ||
          source.kind === 'document' ||
          source.kind === 'paper' ||
          source.kind === 'notebook')
      ) {
        ref = { kind: source.kind, id: source.resourceId };
        result.resource = ref;
      } else {
        result.href = source.url && /^https?:\/\//iu.test(source.url) ? source.url : null;
        result.unavailableReason = '来源元数据；原件请在来源中打开';
        result.version = source.version;
        return result;
      }
    } else if (item.evidenceRef.kind === 'excerpt') {
      const ex = await getEntity<EvidenceExcerpt>(ctx, projectId, 'excerpt', item.evidenceRef.id);
      useText(ex.quote, ex.version, ex.locator);
      result.summary = `摘录校验状态：${ex.verification}`;
      return result;
    } else {
      const finding = await getEntity<ResearchFinding>(
        ctx,
        projectId,
        'finding',
        item.evidenceRef.id,
      );
      useText(finding.statement, finding.version);
      result.summary = finding.limitations;
      return result;
    }
  }
  if (!ref) {
    useText(item.body, item.version, item.origin?.locator ?? null, 'text/markdown');
    return result;
  }
  if (ref.kind === 'link') {
    result.href = /^https?:\/\//iu.test(ref.id) ? ref.id : null;
    result.unavailableReason = '外部链接需在原地址查看';
    return result;
  }
  try {
    await checkResource(ctx, projectId, ref);
  } catch (e) {
    if (e instanceof ApiError) {
      result.unavailableReason = '原件不存在、已归档或不再属于团队空间';
      return result;
    }
    throw e;
  }
  if (ref.kind === 'document') {
    const doc = await readDocument(ctx, projectId, ref.id);
    // 编辑器状态可能在首次权限检查后迁入个人空间，读取后再次核对。
    try {
      await checkResource(ctx, projectId, ref);
    } catch (e) {
      if (e instanceof ApiError) {
        result.unavailableReason = '原件不存在、已归档或不再属于团队空间';
        return result;
      }
      throw e;
    }
    result.title = doc.meta.title;
    result.href = `/p/${projectId}/docs/${ref.id}`;
    useText(doc.markdown, digest(doc.markdown), null, 'text/markdown');
    return result;
  }
  if (ref.kind === 'notebook') {
    const { meta, nb } = await readPlainNotebook(ctx, projectId, ref.id);
    const text = JSON.stringify(nb, null, 2);
    result.title = meta.title;
    result.href = `/p/${projectId}/notebooks/${ref.id}`;
    useText(text, digest(text), { kind: 'notebook', notebookId: ref.id }, 'application/json');
    return result;
  }
  if (ref.kind === 'file') {
    const [file] = await ctx.db.db
      .select()
      .from(files)
      .where(and(eq(files.id, ref.id), eq(files.projectId, projectId)));
    if (!file) {
      result.unavailableReason = '文件不存在';
      return result;
    }
    result.title = file.name;
    result.mime = file.mime;
    result.href = `/api/v1/projects/${projectId}/files/${ref.id}?download=1`;
    if (!isTextMime(file.mime)) {
      result.unavailableReason = '此文件无法作为文本预览，请打开原件';
      return result;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(diskPath(ctx, projectId, file.path));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        result.unavailableReason = '文件内容已丢失';
        return result;
      }
      throw e;
    }
    const text = bytes.toString('utf8');
    useText(
      text,
      createHash('sha256').update(bytes).digest('hex'),
      { kind: 'file', path: file.path },
      file.mime,
    );
    return result;
  }
  if (ref.kind === 'paper') {
    const [paper] = await ctx.db.db
      .select()
      .from(papers)
      .where(
        and(
          eq(papers.id, ref.id),
          eq(papers.projectId, projectId),
          eq(papers.space, 'team'),
          isNull(papers.archivedAt),
        ),
      );
    if (!paper) {
      result.unavailableReason = '论文不存在';
      return result;
    }
    result.title = paper.title;
    result.summary = paper.abstract;
    result.href = `/p/${projectId}/library/${ref.id}`;
    result.version = `${paper.pdfSha256 ?? ''}:${paper.updatedAt.toISOString()}`;
    result.mime = 'text/plain';
    const chunks = await ctx.db.db
      .select({
        seq: paperChunks.seq,
        text: paperChunks.text,
        page: paperChunks.page,
        para: paperChunks.para,
        sectionPath: paperChunks.sectionPath,
      })
      .from(paperChunks)
      .where(
        and(
          eq(paperChunks.projectId, projectId),
          eq(paperChunks.paperId, ref.id),
          sql`${paperChunks.seq} >= ${offset}`,
        ),
      )
      .orderBy(paperChunks.seq)
      .limit(2);
    if (!chunks.length) {
      result.unavailableReason = offset === 0 ? '尚无可读取的解析正文；摘要不等于原文' : null;
      return result;
    }
    const chunk = chunks[0]!;
    result.text = chunk.text;
    result.locator = {
      kind: 'paper_chunk',
      seq: chunk.seq,
      page: chunk.page,
      para: chunk.para,
      sectionPath: chunk.sectionPath,
    };
    result.nextOffset = chunks[1]?.seq ?? null;
    return result;
  }
  if (ref.kind === 'experiment') {
    result.unavailableReason = '内容已移除';
    return result;
  }
  const record = await getEntity<ResearchRecord>(ctx, projectId, 'record', ref.id);
  result.title = record.title;
  result.href = `/p/${projectId}/research/${ref.id}`;
  useText(JSON.stringify(record, null, 2), record.version, null, 'application/json');
  return result;
}
