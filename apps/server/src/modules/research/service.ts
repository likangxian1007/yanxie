import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import {
  ApiError,
  PRESET_RESEARCH_TEMPLATES,
  ResearchTemplatePublishInput,
  newId,
  type ActorRef,
  type EvidenceExcerpt,
  type EvidenceExcerptCreateInput,
  type EventPayload,
  type EventType,
  type Page,
  type ResearchCode,
  type ResearchCodeCreateInput,
  type ResearchCoding,
  type ResearchCodingCreateInput,
  type ResearchFinding,
  type ResearchFindingCreateInput,
  type ResearchLog,
  type ResearchRecord,
  type ResearchRecordCreateInput,
  type ResearchResourceRef,
  type ResearchSnapshot,
  type ResearchSnapshotCreateInput,
  type ResearchSource,
  type ResearchSourceAvailability,
  type ResearchSourceCreateInput,
  type ResearchStep,
  type ResearchTemplate,
} from '@srh/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/client';
import {
  documents,
  files,
  notebooks,
  outputs,
  papers,
  researchEntities,
  researchIdempotency,
  researchRevisions,
  researchSnapshotFiles,
  researchTemplates,
} from '../../db/schema';
import { diskPath, isTextMime } from '../files/service';
import { assertVersion, notFound } from '../collab-common';

export type EntityKind =
  'record' | 'log' | 'source' | 'snapshot' | 'excerpt' | 'code' | 'coding' | 'finding';
type Exec = Pick<Db, 'select'>;
const iso = (value: Date) => value.toISOString();
const now = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function invalid(path: string, message: string): never {
  throw new ApiError('validation_failed', message, { issues: [{ path, message }] });
}

function entity<T>(row: typeof researchEntities.$inferSelect): T {
  return row.data as T;
}

async function getRow(exec: Exec, projectId: string, kind: EntityKind, id: string) {
  const [row] = await exec
    .select()
    .from(researchEntities)
    .where(
      and(
        eq(researchEntities.id, id),
        eq(researchEntities.projectId, projectId),
        eq(researchEntities.kind, kind),
      ),
    );
  if (!row) notFound('科研对象');
  return row;
}

export async function getEntity<T>(
  ctx: AppContext,
  projectId: string,
  kind: EntityKind,
  id: string,
): Promise<T> {
  return entity<T>(await getRow(ctx.db.db, projectId, kind, id));
}

export async function listEntities<T>(
  ctx: AppContext,
  projectId: string,
  kind: EntityKind,
  query: { cursor?: string; limit?: number; recordId?: string } = {},
): Promise<Page<T>> {
  const limit = Math.min(100, Math.max(1, query.limit ?? 50));
  const conditions = [eq(researchEntities.projectId, projectId), eq(researchEntities.kind, kind)];
  if (query.recordId) conditions.push(eq(researchEntities.recordId, query.recordId));
  if (query.cursor) conditions.push(lt(researchEntities.id, query.cursor));
  const rows = await ctx.db.db
    .select()
    .from(researchEntities)
    .where(and(...conditions))
    .orderBy(desc(researchEntities.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit).map((row) => entity<T>(row));
  return { items, nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
}

export async function allEntities<T>(
  ctx: AppContext,
  projectId: string,
  kind: EntityKind,
): Promise<T[]> {
  const result: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await listEntities<T>(ctx, projectId, kind, { cursor, limit: 100 });
    result.push(...page.items);
    if (!page.nextCursor) return result;
    cursor = page.nextCursor;
  }
}

async function idempotent<T>(
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
  if (row.requestHash !== hash(input)) throw new ApiError('conflict', '幂等键已用于其他请求');
  return row.response as T;
}

async function insertWithEvent<T extends EventType, D extends Record<string, unknown>>(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  kind: EntityKind,
  recordId: string | null,
  dto: D,
  type: T,
  key: string | undefined,
  input: unknown,
): Promise<D> {
  const prior = await idempotent<D>(ctx, actor, projectId, type, key, input);
  if (prior) return prior;
  let event;
  try {
    event = await ctx.db.db.transaction(async (tx) => {
      await tx.insert(researchEntities).values({
        id: String(dto.id),
        projectId,
        recordId,
        kind,
        version: Number(dto.version ?? 1),
        data: dto,
      });
      if (key)
        await tx.insert(researchIdempotency).values({
          id: newId('researchRevision'),
          projectId,
          actorId: actor.id ?? actor.kind,
          action: type,
          key,
          requestHash: hash(input),
          response: dto,
        });
      return ctx.bus.record(tx, { projectId, type, payload: dto as EventPayload<T>, actor });
    });
  } catch (error) {
    // 并发相同幂等键以数据库唯一约束决出胜者，再读取其原始响应。
    const winner = await idempotent<D>(ctx, actor, projectId, type, key, input);
    if (winner) return winner;
    throw error;
  }
  ctx.bus.emit(event);
  return dto;
}

async function updateWithEvent<T extends EventType, D extends { id: string; version: number }>(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  kind: EntityKind,
  dto: D,
  baseVersion: number,
  type: T,
): Promise<D> {
  const event = await ctx.db.db.transaction(async (tx) => {
    const rows = await tx
      .update(researchEntities)
      .set({ data: dto as Record<string, unknown>, version: dto.version, updatedAt: new Date() })
      .where(
        and(
          eq(researchEntities.id, dto.id),
          eq(researchEntities.projectId, projectId),
          eq(researchEntities.kind, kind),
          eq(researchEntities.version, baseVersion),
        ),
      )
      .returning({ id: researchEntities.id });
    if (!rows.length) {
      const current = await getRow(tx, projectId, kind, dto.id);
      throw new ApiError('version_conflict', '内容已被他人修改，已为你载入最新版本', {
        current: current.data,
      });
    }
    return ctx.bus.record(tx, { projectId, type, payload: dto as EventPayload<T>, actor });
  });
  ctx.bus.emit(event);
  return dto;
}

export async function listTemplates(
  ctx: AppContext,
  projectId: string,
  query: { cursor?: string; limit?: number } = {},
): Promise<Page<ResearchTemplate>> {
  const rows = await ctx.db.db
    .select()
    .from(researchTemplates)
    .where(eq(researchTemplates.projectId, projectId));
  const all = [...PRESET_RESEARCH_TEMPLATES, ...rows.map((r) => r.data)].sort((a, b) =>
    `${a.id}:${a.version}`.localeCompare(`${b.id}:${b.version}`),
  );
  const start = query.cursor
    ? all.findIndex((x) => `${x.id}:${x.version}` === query.cursor) + 1
    : 0;
  const limit = Math.min(100, Math.max(1, query.limit ?? 50));
  return {
    items: all.slice(start, start + limit),
    nextCursor:
      all.length > start + limit
        ? `${all[start + limit - 1]!.id}:${all[start + limit - 1]!.version}`
        : null,
  };
}

export async function getTemplate(
  ctx: AppContext,
  projectId: string,
  id: string,
  version?: number,
): Promise<ResearchTemplate> {
  const preset = PRESET_RESEARCH_TEMPLATES.find(
    (x) => x.id === id && (version === undefined || x.version === version),
  );
  if (preset) return preset;
  const conditions = [eq(researchTemplates.projectId, projectId), eq(researchTemplates.id, id)];
  if (version) conditions.push(eq(researchTemplates.version, version));
  const [row] = await ctx.db.db
    .select()
    .from(researchTemplates)
    .where(and(...conditions))
    .orderBy(desc(researchTemplates.version))
    .limit(1);
  if (!row) notFound('研究模板');
  return row.data;
}

function checkTemplateShape(input: ResearchTemplatePublishInput): void {
  for (const [name, items] of [
    ['fields', input.fields ?? []],
    ['steps', input.steps ?? []],
  ] as const) {
    const ids = items.map((x) => x.id);
    if (new Set(ids).size !== ids.length) invalid(name, '字段或步骤 ID 不能重复');
  }
  for (const field of input.fields ?? []) {
    if (field.type === 'select' && (field.options ?? []).length === 0)
      invalid(`fields.${field.id}.options`, '选择字段至少需要一个选项');
    if (field.type !== 'number' && field.unit)
      invalid(`fields.${field.id}.unit`, '只有数字字段可指定单位');
  }
}

export async function publishTemplate(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  input: ResearchTemplatePublishInput,
): Promise<ResearchTemplate> {
  const parsed = ResearchTemplatePublishInput.parse(input);
  const prior = await idempotent<ResearchTemplate>(
    ctx,
    actor,
    projectId,
    'research.template.published',
    parsed.idempotencyKey,
    parsed,
  );
  if (prior) return prior;
  checkTemplateShape(parsed);
  const id = input.id ?? newId('researchTemplate');
  if (id.startsWith('rtpl_preset_')) invalid('id', '不能修改预置模板；请创建项目模板');
  const old = input.id ? await getTemplate(ctx, projectId, id) : null;
  if (old && input.baseVersion !== old.version)
    throw new ApiError('version_conflict', '模板已有新版', { current: old });
  if (!old && input.baseVersion) invalid('baseVersion', '新模板不需要基础版本');
  const stamp = now();
  const dto: ResearchTemplate = {
    id,
    projectId,
    version: old ? old.version + 1 : 1,
    method: parsed.method,
    name: parsed.name,
    description: parsed.description,
    fields: parsed.fields,
    steps: parsed.steps,
    published: true,
    createdBy: actor,
    createdAt: stamp,
    publishedAt: stamp,
  };
  let event;
  try {
    event = await ctx.db.db.transaction(async (tx) => {
      await tx
        .insert(researchTemplates)
        .values({ id, projectId, version: dto.version, data: dto, createdBy: actor });
      if (parsed.idempotencyKey)
        await tx.insert(researchIdempotency).values({
          id: newId('researchRevision'),
          projectId,
          actorId: actor.id ?? actor.kind,
          action: 'research.template.published',
          key: parsed.idempotencyKey,
          requestHash: hash(parsed),
          response: dto,
        });
      return ctx.bus.record(tx, {
        projectId,
        type: 'research.template.published',
        payload: dto,
        actor,
      });
    });
  } catch (error) {
    const winner = await idempotent<ResearchTemplate>(
      ctx,
      actor,
      projectId,
      'research.template.published',
      parsed.idempotencyKey,
      parsed,
    );
    if (winner) return winner;
    if (old) {
      const latest = await getTemplate(ctx, projectId, id);
      if (latest.version !== old.version)
        throw new ApiError('version_conflict', '模板已有新版', { current: latest });
    }
    throw error;
  }
  ctx.bus.emit(event);
  return dto;
}

export async function checkResource(ctx: AppContext, projectId: string, ref: ResearchResourceRef) {
  if (ref.kind === 'link') return;
  if (ref.kind === 'research') {
    await getEntity<ResearchRecord>(ctx, projectId, 'record', ref.id);
    return;
  }
  // 研究空间是项目共享对象。即使操作者本人能读个人空间，也不能把其内容带入项目。
  if (ref.kind === 'document' || ref.kind === 'paper') {
    const table = ref.kind === 'document' ? documents : papers;
    const [item] = await ctx.db.db
      .select({ space: table.space, archivedAt: table.archivedAt })
      .from(table)
      .where(and(eq(table.id, ref.id), eq(table.projectId, projectId)));
    if (!item) invalid('resources', '关联资源不属于当前项目或已删除');
    if (item.space !== 'team')
      invalid('resources', '请先将个人文档或论文转到团队空间，再用于项目科研');
    if (item.archivedAt)
      invalid('resources', ref.kind === 'document' ? '文档已归档' : '论文已归档');
    return;
  }
  if (ref.kind === 'experiment') invalid('resources', '实验功能已移除');
  const table = ref.kind === 'file' ? files : notebooks;
  const [row] = await ctx.db.db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, ref.id), eq(table.projectId, projectId)));
  if (!row) invalid('resources', '关联资源不属于当前项目或已删除');
  if (ref.kind === 'notebook') {
    const [active] = await ctx.db.db
      .select({ id: notebooks.id })
      .from(notebooks)
      .where(
        and(
          eq(notebooks.id, ref.id),
          eq(notebooks.projectId, projectId),
          isNull(notebooks.deletedAt),
        ),
      );
    if (!active) invalid('resources', 'Notebook 已删除');
  }
}

async function checkFields(
  ctx: AppContext,
  projectId: string,
  template: ResearchTemplate,
  values: ResearchRecord['fieldValues'],
  steps: ResearchRecord['stepState'],
  resources: ResearchResourceRef[],
  sourceIds: string[],
) {
  const fields = new Map(template.fields.map((x) => [x.id, x]));
  for (const field of template.fields) {
    const value = values[field.id];
    if (field.active && field.required && (value === undefined || value === null || value === ''))
      invalid(`fieldValues.${field.id}`, `请填写“${field.label}”`);
  }
  for (const [id, value] of Object.entries(values)) {
    const field = fields.get(id);
    if (!field || !field.active) continue; // 迁移模板时保留历史字段
    if (value === null) continue;
    if (field.type === 'number') {
      const numeric =
        typeof value === 'number'
          ? value
          : typeof value === 'object' && 'value' in value
            ? value.value
            : null;
      if (typeof numeric !== 'number' || !Number.isFinite(numeric))
        invalid(`fieldValues.${id}`, '需要数字');
      if (
        field.unit &&
        (typeof value !== 'object' || !('unit' in value) || value.unit !== field.unit)
      )
        invalid(`fieldValues.${id}`, `单位必须是 ${field.unit}`);
    } else if (field.type === 'resource') {
      if (typeof value !== 'object' || !('kind' in value))
        invalid(`fieldValues.${id}`, '需要资源引用');
      await checkResource(ctx, projectId, value as ResearchResourceRef);
    } else {
      if (typeof value !== 'string') invalid(`fieldValues.${id}`, '需要文字');
      if (field.type === 'select' && !field.options.includes(value))
        invalid(`fieldValues.${id}`, '不在允许的选项中');
      if (field.type === 'date' && Number.isNaN(Date.parse(value)))
        invalid(`fieldValues.${id}`, '需要有效日期');
    }
  }
  const validSteps = new Set(
    template.steps.flatMap((step: ResearchStep) => [step.id, ...step.checklist.map((x) => x.id)]),
  );
  for (const id of Object.keys(steps))
    if (!validSteps.has(id)) invalid(`stepState.${id}`, '步骤不存在于当前模板');
  for (const ref of resources) await checkResource(ctx, projectId, ref);
  for (const sourceId of sourceIds)
    await getEntity<ResearchSource>(ctx, projectId, 'source', sourceId);
}

export async function createRecord(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  input: ResearchRecordCreateInput & { idempotencyKey?: string },
): Promise<ResearchRecord> {
  const template = await getTemplate(ctx, projectId, input.templateId, input.templateVersion);
  const fieldValues = input.fieldValues ?? {};
  const stepState = input.stepState ?? {};
  const resources = input.resources ?? [];
  const sourceIds = input.sourceIds ?? [];
  await checkFields(ctx, projectId, template, fieldValues, stepState, resources, sourceIds);
  const stamp = now();
  const stepReports = Object.fromEntries(
    Object.entries(stepState).map(([id, done]) => [
      id,
      {
        done,
        reportedBy: actor,
        origin: actor.kind === 'user' ? ('member_report' as const) : ('agent_work' as const),
        verification: 'unverified' as const,
        updatedAt: stamp,
      },
    ]),
  );
  const dto: ResearchRecord = {
    id: newId('researchRecord'),
    projectId,
    templateId: template.id,
    templateVersion: template.version,
    method: template.method,
    title: input.title,
    question: input.question ?? '',
    status: input.status ?? 'planned',
    assigneeId: input.assigneeId ?? null,
    fieldValues,
    stepState,
    stepReports,
    resources,
    sourceIds,
    version: 1,
    createdBy: actor,
    updatedBy: actor,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const prior = await idempotent<ResearchRecord>(
    ctx,
    actor,
    projectId,
    'research.record.created',
    input.idempotencyKey,
    input,
  );
  if (prior) return prior;
  let event;
  try {
    event = await ctx.db.db.transaction(async (tx) => {
      await tx
        .insert(researchEntities)
        .values({ id: dto.id, projectId, recordId: dto.id, kind: 'record', data: dto });
      await tx.insert(outputs).values({
        id: newId('output'),
        projectId,
        kind: 'research',
        ref: dto.id,
        title: dto.title,
      });
      await tx.insert(researchRevisions).values({
        id: newId('researchRevision'),
        projectId,
        recordId: dto.id,
        version: 1,
        data: dto,
        createdBy: actor,
      });
      if (input.idempotencyKey)
        await tx.insert(researchIdempotency).values({
          id: newId('researchRevision'),
          projectId,
          actorId: actor.id ?? actor.kind,
          action: 'research.record.created',
          key: input.idempotencyKey,
          requestHash: hash(input),
          response: dto,
        });
      return ctx.bus.record(tx, {
        projectId,
        type: 'research.record.created',
        payload: dto,
        actor,
      });
    });
  } catch (error) {
    const winner = await idempotent<ResearchRecord>(
      ctx,
      actor,
      projectId,
      'research.record.created',
      input.idempotencyKey,
      input,
    );
    if (winner) return winner;
    throw error;
  }
  ctx.bus.emit(event);
  return dto;
}

export async function updateRecord(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  input: {
    baseVersion: number;
    migrateTemplateVersion?: number;
  } & Partial<ResearchRecordCreateInput>,
): Promise<ResearchRecord> {
  const current = await getEntity<ResearchRecord>(ctx, projectId, 'record', recordId);
  assertVersion(current, input.baseVersion, current);
  const template = await getTemplate(
    ctx,
    projectId,
    current.templateId,
    input.migrateTemplateVersion ?? current.templateVersion,
  );
  const fieldValues = { ...current.fieldValues, ...(input.fieldValues ?? {}) };
  const stepState = { ...current.stepState, ...(input.stepState ?? {}) };
  const resources = input.resources ?? current.resources;
  const sourceIds = input.sourceIds ?? current.sourceIds;
  await checkFields(ctx, projectId, template, fieldValues, stepState, resources, sourceIds);
  const stamp = now();
  const stepReports = { ...current.stepReports };
  for (const [id, done] of Object.entries(input.stepState ?? {}))
    stepReports[id] = {
      done,
      reportedBy: actor,
      origin: actor.kind === 'user' ? 'member_report' : 'agent_work',
      verification: 'unverified',
      updatedAt: stamp,
    };
  const dto: ResearchRecord = {
    ...current,
    title: input.title ?? current.title,
    question: input.question ?? current.question,
    status: input.status ?? current.status,
    assigneeId: input.assigneeId === undefined ? current.assigneeId : input.assigneeId,
    fieldValues,
    stepState,
    stepReports,
    resources,
    sourceIds,
    templateVersion: template.version,
    method: template.method,
    version: current.version + 1,
    updatedBy: actor,
    updatedAt: stamp,
  };
  const event = await ctx.db.db.transaction(async (tx) => {
    const updated = await tx
      .update(researchEntities)
      .set({ data: dto, version: dto.version, updatedAt: new Date() })
      .where(
        and(
          eq(researchEntities.id, recordId),
          eq(researchEntities.projectId, projectId),
          eq(researchEntities.version, input.baseVersion),
        ),
      )
      .returning({ id: researchEntities.id });
    if (!updated.length)
      throw new ApiError('version_conflict', '内容已被他人修改', {
        current: await getEntity<ResearchRecord>(ctx, projectId, 'record', recordId),
      });
    await tx.insert(researchRevisions).values({
      id: newId('researchRevision'),
      projectId,
      recordId,
      version: dto.version,
      data: dto,
      createdBy: actor,
    });
    await tx
      .update(outputs)
      .set({ title: dto.title })
      .where(
        and(
          eq(outputs.projectId, projectId),
          eq(outputs.kind, 'research'),
          eq(outputs.ref, recordId),
        ),
      );
    return ctx.bus.record(tx, { projectId, type: 'research.record.updated', payload: dto, actor });
  });
  ctx.bus.emit(event);
  return dto;
}

export async function recordDetail(ctx: AppContext, projectId: string, recordId: string) {
  const record = await getEntity<ResearchRecord>(ctx, projectId, 'record', recordId);
  const template = await getTemplate(ctx, projectId, record.templateId, record.templateVersion);
  const logs = (await listEntities<ResearchLog>(ctx, projectId, 'log', { recordId, limit: 50 }))
    .items;
  const sources = (await allEntities<ResearchSource>(ctx, projectId, 'source')).filter((source) =>
    record.sourceIds.includes(source.id),
  );
  return { record, template, logs, sources };
}

export async function listRevisions(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  query: { cursor?: string; limit?: number } = {},
) {
  await getEntity<ResearchRecord>(ctx, projectId, 'record', recordId);
  const limit = Math.min(100, Math.max(1, query.limit ?? 50));
  const where = [
    eq(researchRevisions.projectId, projectId),
    eq(researchRevisions.recordId, recordId),
  ];
  if (query.cursor) where.push(lt(researchRevisions.id, query.cursor));
  const rows = await ctx.db.db
    .select()
    .from(researchRevisions)
    .where(and(...where))
    .orderBy(desc(researchRevisions.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit).map((row) => ({
    id: row.id,
    projectId,
    recordId,
    version: row.version,
    record: row.data as ResearchRecord,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
  }));
  return { items, nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
}

export async function addLog(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  input: { body: string; idempotencyKey?: string },
) {
  await getEntity<ResearchRecord>(ctx, projectId, 'record', recordId);
  const dto: ResearchLog = {
    id: newId('researchLog'),
    projectId,
    recordId,
    version: 1,
    body: input.body,
    createdBy: actor,
    createdAt: now(),
  };
  return insertWithEvent(
    ctx,
    actor,
    projectId,
    'log',
    recordId,
    dto,
    'research.log.created',
    input.idempotencyKey,
    input,
  );
}

export async function createSource(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  input: ResearchSourceCreateInput & { idempotencyKey?: string },
): Promise<ResearchSource> {
  if (input.recordId) await getEntity<ResearchRecord>(ctx, projectId, 'record', input.recordId);
  if (input.originalSourceId)
    await getEntity<ResearchSource>(ctx, projectId, 'source', input.originalSourceId);
  if (input.kind === 'url' && !input.url) invalid('url', 'URL 来源需要地址');
  if (['file', 'document', 'paper', 'notebook'].includes(input.kind)) {
    if (!input.resourceId) invalid('resourceId', '需要选择项目资源');
    await checkResource(ctx, projectId, {
      kind: input.kind as ResearchResourceRef['kind'],
      id: input.resourceId,
    });
  } else if (input.resourceId) invalid('resourceId', '手工来源不能绑定资源 ID');
  const stamp = now();
  const dto: ResearchSource = {
    id: newId('researchSource'),
    projectId,
    recordId: input.recordId ?? null,
    kind: input.kind,
    resourceId: input.resourceId ?? null,
    title: input.title,
    citation: input.citation ?? '',
    url: input.url ?? null,
    originalSourceId: input.originalSourceId ?? null,
    archivedAt: null,
    version: 1,
    needsReview: false,
    createdBy: actor,
    updatedBy: actor,
    createdAt: stamp,
    updatedAt: stamp,
  };
  return insertWithEvent(
    ctx,
    actor,
    projectId,
    'source',
    input.recordId ?? null,
    dto,
    'research.source.created',
    input.idempotencyKey,
    input,
  );
}

/** 创建时指定研究空间的来源必须同时出现在该记录的关联列表中。 */
export async function createLinkedSource(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  input: ResearchSourceCreateInput & { idempotencyKey?: string },
): Promise<ResearchSource> {
  const source = await createSource(ctx, actor, projectId, input);
  if (input.recordId) {
    const record = await getEntity<ResearchRecord>(ctx, projectId, 'record', input.recordId);
    if (!record.sourceIds.includes(source.id))
      await updateRecord(ctx, actor, projectId, record.id, {
        baseVersion: record.version,
        sourceIds: [...record.sourceIds, source.id],
      });
  }
  return source;
}

export async function sourceAvailability(
  ctx: AppContext,
  projectId: string,
  sourceId: string,
): Promise<ResearchSourceAvailability> {
  const source = await getEntity<ResearchSource>(ctx, projectId, 'source', sourceId);
  const common = {
    resourceKind: source.kind,
    resourceId: source.resourceId,
    experimentId: null as string | null,
  };
  if (source.kind === 'url') return { ...common, available: false, reason: 'external' };
  if (source.kind === 'bibliography') return { ...common, available: false, reason: 'manual' };
  if (!source.resourceId) return { ...common, available: false, reason: 'missing' };
  if (source.kind === 'document' || source.kind === 'paper') {
    const table = source.kind === 'document' ? documents : papers;
    const [item] = await ctx.db.db
      .select({ space: table.space })
      .from(table)
      .where(and(eq(table.id, source.resourceId), eq(table.projectId, projectId)));
    if (item?.space === 'personal') return { ...common, available: false, reason: 'missing' };
  }
  try {
    await checkResource(ctx, projectId, { kind: source.kind, id: source.resourceId });
    if (source.kind === 'file') {
      const [file] = await ctx.db.db
        .select()
        .from(files)
        .where(and(eq(files.projectId, projectId), eq(files.id, source.resourceId)));
      if (file) await stat(diskPath(ctx, projectId, file.path));
    }
    return { ...common, available: true, reason: 'available' };
  } catch (error) {
    if (
      (error instanceof ApiError && error.code === 'validation_failed') ||
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      return { ...common, available: false, reason: 'missing' };
    throw error;
  }
}

export async function updateSource(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  id: string,
  input: { baseVersion: number; archived?: boolean } & Partial<ResearchSourceCreateInput>,
): Promise<ResearchSource> {
  const current = await getEntity<ResearchSource>(ctx, projectId, 'source', id);
  assertVersion(current, input.baseVersion, current);
  if (input.originalSourceId)
    await getEntity<ResearchSource>(ctx, projectId, 'source', input.originalSourceId);
  const kind = input.kind ?? current.kind;
  const resourceId = input.resourceId === undefined ? current.resourceId : input.resourceId;
  if (['file', 'document', 'paper', 'notebook'].includes(kind)) {
    if (!resourceId) invalid('resourceId', '需要选择项目资源');
    await checkResource(ctx, projectId, {
      kind: kind as ResearchResourceRef['kind'],
      id: resourceId,
    });
  } else if (resourceId) invalid('resourceId', '手工来源不能绑定资源 ID');
  if (kind === 'url' && !(input.url ?? current.url)) invalid('url', 'URL 来源需要地址');
  const dto: ResearchSource = {
    ...current,
    kind,
    resourceId,
    title: input.title ?? current.title,
    citation: input.citation ?? current.citation,
    url: input.url === undefined ? current.url : input.url,
    originalSourceId:
      input.originalSourceId === undefined ? current.originalSourceId : input.originalSourceId,
    archivedAt: input.archived === undefined ? current.archivedAt : input.archived ? now() : null,
    version: current.version + 1,
    needsReview: true,
    updatedBy: actor,
    updatedAt: now(),
  };
  await updateWithEvent(
    ctx,
    actor,
    projectId,
    'source',
    dto,
    input.baseVersion,
    'research.source.updated',
  );
  await markFindingsForSource(ctx, actor, projectId, id);
  return dto;
}

async function markFindingsForSource(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  sourceId: string,
) {
  const excerpts = (await allEntities<EvidenceExcerpt>(ctx, projectId, 'excerpt')).filter(
    (e) => e.sourceId === sourceId,
  );
  const ids = new Set(excerpts.map((e) => e.id));
  if (!ids.size) return;
  const findings = await allEntities<ResearchFinding>(ctx, projectId, 'finding');
  for (const finding of findings) {
    if (
      ![
        ...finding.supportingExcerptIds,
        ...finding.counterExcerptIds,
        ...finding.contextExcerptIds,
      ].some((id) => ids.has(id))
    )
      continue;
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await getEntity<ResearchFinding>(ctx, projectId, 'finding', finding.id);
      if (current.needsReview && !current.humanConfirmed) break;
      const changed = {
        ...current,
        needsReview: true,
        humanConfirmed: false,
        version: current.version + 1,
        updatedBy: actor,
        updatedAt: now(),
      };
      try {
        await updateWithEvent(
          ctx,
          actor,
          projectId,
          'finding',
          changed,
          current.version,
          'research.finding.updated',
        );
        break;
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'version_conflict') || attempt === 4)
          throw error;
      }
    }
  }
}

/** 上游项目资源变化时标记来源和关联发现待复核；旧快照及摘录仍保持不变。 */
export async function markSourcesForResource(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  kind: 'file' | 'document' | 'notebook' | 'paper',
  resourceId: string,
  _deleted: boolean,
): Promise<void> {
  const sources = (await allEntities<ResearchSource>(ctx, projectId, 'source')).filter(
    (source) => source.kind === kind && source.resourceId === resourceId && !source.archivedAt,
  );
  for (const source of sources) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await getEntity<ResearchSource>(ctx, projectId, 'source', source.id);
      if (current.archivedAt) break;
      const changed: ResearchSource = {
        ...current,
        needsReview: true,
        version: current.version + 1,
        updatedBy: actor,
        updatedAt: now(),
      };
      try {
        await updateWithEvent(
          ctx,
          actor,
          projectId,
          'source',
          changed,
          current.version,
          'research.source.updated',
        );
        break;
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'version_conflict') || attempt === 4)
          throw error;
      }
    }
    await markFindingsForSource(ctx, actor, projectId, source.id);
  }
}

function snapshotRoot(ctx: AppContext, projectId: string): string {
  return resolve(ctx.config.STORAGE_DIR, 'research-snapshots', projectId);
}

function snapshotPath(ctx: AppContext, projectId: string, id: string): string {
  const base = snapshotRoot(ctx, projectId);
  const path = resolve(base, id);
  if (!path.startsWith(base + sep)) throw new ApiError('bad_request', '快照路径不合法');
  return path;
}

export async function createSnapshot(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  sourceId: string,
  input: ResearchSnapshotCreateInput & { idempotencyKey?: string },
): Promise<ResearchSnapshot> {
  const source = await getEntity<ResearchSource>(ctx, projectId, 'source', sourceId);
  if (source.archivedAt) invalid('sourceId', '已归档来源不能新增快照');
  if (source.resourceId && (source.kind === 'document' || source.kind === 'paper'))
    await checkResource(ctx, projectId, { kind: source.kind, id: source.resourceId });
  const prior = await idempotent<ResearchSnapshot>(
    ctx,
    actor,
    projectId,
    'research.snapshot.created',
    input.idempotencyKey,
    { sourceId, ...input },
  );
  if (prior) return prior;
  let bytes: Buffer | null = null;
  let text: string | null = null;
  let mime = 'application/octet-stream';
  let originalName = source.title;
  if (input.coverage === 'external') {
    if (!source.url && source.kind !== 'url') invalid('coverage', '仅远程链接可使用 external');
    if (input.text) invalid('text', 'external 快照不保存原文');
  } else if (input.coverage === 'complete') {
    if (source.resourceId && ['file', 'notebook'].includes(source.kind))
      await checkResource(ctx, projectId, {
        kind: source.kind as ResearchResourceRef['kind'],
        id: source.resourceId,
      });
    if (source.kind === 'file' && source.resourceId) {
      const [file] = await ctx.db.db
        .select()
        .from(files)
        .where(and(eq(files.projectId, projectId), eq(files.id, source.resourceId)));
      if (!file) notFound('原文件');
      // 直接复制 STORAGE_DIR 中完整文件；历史文件版本表对 >5MB 可能只存元数据，不能用于快照。
      bytes = await readFile(diskPath(ctx, projectId, file.path));
      mime = file.mime;
      originalName = file.name;
      if (isTextMime(mime) && bytes.length <= 2_000_000) text = bytes.toString('utf8');
    } else if (source.kind === 'paper' && source.resourceId) {
      const [paper] = await ctx.db.db
        .select()
        .from(papers)
        .where(
          and(
            eq(papers.projectId, projectId),
            eq(papers.id, source.resourceId),
            eq(papers.space, 'team'),
          ),
        );
      if (!paper) notFound('论文');
      if (!paper.fileId) invalid('coverage', '论文没有本地原件，不能标为 complete');
      const [file] = await ctx.db.db
        .select()
        .from(files)
        .where(and(eq(files.projectId, projectId), eq(files.id, paper.fileId)));
      if (!file) notFound('论文原件');
      bytes = await readFile(diskPath(ctx, projectId, file.path));
      mime = file.mime;
      originalName = file.name;
    } else if (source.kind === 'document' && source.resourceId) {
      const [doc] = await ctx.db.db
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.projectId, projectId),
            eq(documents.id, source.resourceId),
            eq(documents.space, 'team'),
          ),
        );
      if (!doc) notFound('文档');
      if (!doc.ydocState) invalid('coverage', '文档内容尚未持久化，不能标为 complete');
      bytes = Buffer.from(doc.ydocState);
      text = doc.contentText;
      mime = 'application/vnd.srh.ydoc';
      originalName = `${doc.title}.ydoc`;
    } else if (source.kind === 'notebook' && source.resourceId) {
      const [nb] = await ctx.db.db
        .select()
        .from(notebooks)
        .where(and(eq(notebooks.projectId, projectId), eq(notebooks.id, source.resourceId)));
      if (!nb) notFound('Notebook');
      if (!nb.ydocState) invalid('coverage', 'Notebook 内容尚未持久化，不能标为 complete');
      bytes = Buffer.from(nb.ydocState);
      mime = 'application/vnd.srh.ydoc';
      originalName = `${nb.title}.ydoc`;
    } else invalid('coverage', '此来源没有可保存的完整原件');
  } else {
    if (!input.text?.trim()) invalid('text', '摘录快照需要文字');
    text = input.text;
    bytes = Buffer.from(input.text, 'utf8');
    mime = 'text/plain';
    originalName = `${source.title}.txt`;
  }
  const id = newId('researchSnapshot');
  const dto: ResearchSnapshot = {
    id,
    projectId,
    sourceId,
    version: 1,
    sourceVersion: source.version,
    sourceMetadata: source,
    coverage: input.coverage,
    sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null,
    byteLength: bytes?.length ?? 0,
    mime,
    originalName,
    text,
    createdBy: actor,
    createdAt: now(),
  };
  const path = bytes ? snapshotPath(ctx, projectId, id) : null;
  if (path && bytes) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' });
  }
  let event;
  try {
    event = await ctx.db.db.transaction(async (tx) => {
      await tx
        .insert(researchEntities)
        .values({ id, projectId, recordId: source.recordId, kind: 'snapshot', data: dto });
      if (path)
        await tx
          .insert(researchSnapshotFiles)
          .values({ id, projectId, sourceId, relativePath: id });
      if (input.idempotencyKey)
        await tx.insert(researchIdempotency).values({
          id: newId('researchRevision'),
          projectId,
          actorId: actor.id ?? actor.kind,
          action: 'research.snapshot.created',
          key: input.idempotencyKey,
          requestHash: hash({ sourceId, ...input }),
          response: dto,
        });
      return ctx.bus.record(tx, {
        projectId,
        type: 'research.snapshot.created',
        payload: dto,
        actor,
      });
    });
  } catch (error) {
    if (path) await rm(path, { force: true });
    const winner = await idempotent<ResearchSnapshot>(
      ctx,
      actor,
      projectId,
      'research.snapshot.created',
      input.idempotencyKey,
      { sourceId, ...input },
    );
    if (winner) return winner;
    throw error;
  }
  ctx.bus.emit(event);
  await markFindingsForSource(ctx, actor, projectId, sourceId);
  return dto;
}

export async function readSnapshotBytes(
  ctx: AppContext,
  projectId: string,
  snapshotId: string,
): Promise<{ snapshot: ResearchSnapshot; bytes: Buffer }> {
  const snapshot = await getEntity<ResearchSnapshot>(ctx, projectId, 'snapshot', snapshotId);
  const [row] = await ctx.db.db
    .select()
    .from(researchSnapshotFiles)
    .where(
      and(eq(researchSnapshotFiles.id, snapshotId), eq(researchSnapshotFiles.projectId, projectId)),
    );
  if (!row) notFound('快照原件');
  return { snapshot, bytes: await readFile(snapshotPath(ctx, projectId, row.relativePath)) };
}

export async function createExcerpt(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  input: EvidenceExcerptCreateInput & { idempotencyKey?: string },
): Promise<EvidenceExcerpt> {
  const record = await getEntity<ResearchRecord>(ctx, projectId, 'record', recordId);
  const source = await getEntity<ResearchSource>(ctx, projectId, 'source', input.sourceId);
  if (!record.sourceIds.includes(source.id)) invalid('sourceId', '来源尚未关联到该记录');
  const snapshot = await getEntity<ResearchSnapshot>(ctx, projectId, 'snapshot', input.snapshotId);
  if (snapshot.sourceId !== source.id) invalid('snapshotId', '快照不属于该来源');
  if (actor.kind !== 'user' && !['ai_extraction', 'tool_result'].includes(input.origin))
    invalid('origin', 'AI 摘录须标明 AI 提取或工具结果来源');
  let verification: EvidenceExcerpt['verification'] = 'unverified';
  if (input.locator.kind === 'text' && snapshot.coverage === 'complete' && snapshot.text) {
    const paragraph = snapshot.text.split(/\n\s*\n/u)[input.locator.paragraph - 1];
    if (paragraph?.includes(input.quote)) verification = 'verified';
  }
  // PDF 页、表格范围及人工定位尚无可核对的分段索引，不能仅因全文出现就宣称 verified。
  const dto: EvidenceExcerpt = {
    id: newId('researchExcerpt'),
    projectId,
    recordId,
    version: 1,
    sourceId: source.id,
    snapshotId: snapshot.id,
    quote: input.quote,
    locator: input.locator,
    origin: input.origin,
    verification,
    createdBy: actor,
    createdAt: now(),
  };
  return insertWithEvent(
    ctx,
    actor,
    projectId,
    'excerpt',
    recordId,
    dto,
    'research.excerpt.created',
    input.idempotencyKey,
    { recordId, ...input },
  );
}

export async function createCode(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  input: ResearchCodeCreateInput & { idempotencyKey?: string },
): Promise<ResearchCode> {
  await getEntity<ResearchRecord>(ctx, projectId, 'record', recordId);
  const stamp = now();
  const dto: ResearchCode = {
    id: newId('researchCode'),
    projectId,
    recordId,
    name: input.name,
    definition: input.definition ?? '',
    group: input.group ?? null,
    version: 1,
    createdBy: actor,
    updatedBy: actor,
    createdAt: stamp,
    updatedAt: stamp,
  };
  return insertWithEvent(
    ctx,
    actor,
    projectId,
    'code',
    recordId,
    dto,
    'research.code.created',
    input.idempotencyKey,
    { recordId, ...input },
  );
}

export async function updateCode(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  id: string,
  input: { baseVersion: number; name?: string; definition?: string; group?: string | null },
): Promise<ResearchCode> {
  const current = await getEntity<ResearchCode>(ctx, projectId, 'code', id);
  assertVersion(current, input.baseVersion, current);
  const dto = {
    ...current,
    name: input.name ?? current.name,
    definition: input.definition ?? current.definition,
    group: input.group === undefined ? current.group : input.group,
    version: current.version + 1,
    updatedBy: actor,
    updatedAt: now(),
  };
  return updateWithEvent(
    ctx,
    actor,
    projectId,
    'code',
    dto,
    input.baseVersion,
    'research.code.updated',
  );
}

export async function createCoding(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  input: ResearchCodingCreateInput & { idempotencyKey?: string },
): Promise<ResearchCoding> {
  const excerpt = await getEntity<EvidenceExcerpt>(ctx, projectId, 'excerpt', input.excerptId);
  const code = await getEntity<ResearchCode>(ctx, projectId, 'code', input.codeId);
  if (excerpt.recordId !== recordId || code.recordId !== recordId)
    invalid('excerptId', '摘录与代码必须属于同一研究空间');
  const dto: ResearchCoding = {
    id: newId('researchCoding'),
    projectId,
    recordId,
    version: 1,
    excerptId: excerpt.id,
    codeId: code.id,
    caseId: input.caseId ?? null,
    createdBy: actor,
    createdAt: now(),
  };
  return insertWithEvent(
    ctx,
    actor,
    projectId,
    'coding',
    recordId,
    dto,
    'research.coding.created',
    input.idempotencyKey,
    { recordId, ...input },
  );
}

async function checkFindingExcerpts(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  lists: string[][],
) {
  for (const id of lists.flat()) {
    const excerpt = await getEntity<EvidenceExcerpt>(ctx, projectId, 'excerpt', id);
    if (excerpt.recordId !== recordId) invalid('excerptIds', '摘录必须属于同一研究空间');
  }
}

export async function createFinding(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  input: ResearchFindingCreateInput & { idempotencyKey?: string },
): Promise<ResearchFinding> {
  await getEntity<ResearchRecord>(ctx, projectId, 'record', recordId);
  if (actor.kind !== 'user' && input.humanConfirmed)
    invalid('humanConfirmed', 'AI 不能确认人工结论');
  const supportingExcerptIds = input.supportingExcerptIds ?? [];
  const counterExcerptIds = input.counterExcerptIds ?? [];
  const contextExcerptIds = input.contextExcerptIds ?? [];
  await checkFindingExcerpts(ctx, projectId, recordId, [
    supportingExcerptIds,
    counterExcerptIds,
    contextExcerptIds,
  ]);
  const stamp = now();
  const dto: ResearchFinding = {
    id: newId('researchFinding'),
    projectId,
    recordId,
    statement: input.statement,
    supportingExcerptIds,
    counterExcerptIds,
    contextExcerptIds,
    limitations: input.limitations ?? '',
    humanConfirmed: input.humanConfirmed ?? false,
    needsReview: false,
    version: 1,
    createdBy: actor,
    updatedBy: actor,
    createdAt: stamp,
    updatedAt: stamp,
  };
  return insertWithEvent(
    ctx,
    actor,
    projectId,
    'finding',
    recordId,
    dto,
    'research.finding.created',
    input.idempotencyKey,
    { recordId, ...input },
  );
}

export async function updateFinding(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  id: string,
  input: { baseVersion: number; resolveReview?: boolean } & Partial<ResearchFindingCreateInput>,
): Promise<ResearchFinding> {
  const current = await getEntity<ResearchFinding>(ctx, projectId, 'finding', id);
  assertVersion(current, input.baseVersion, current);
  if (actor.kind !== 'user' && input.humanConfirmed)
    invalid('humanConfirmed', 'AI 不能确认人工结论');
  if (actor.kind !== 'user' && input.resolveReview)
    invalid('resolveReview', 'AI 不能清除待复核状态');
  const supportingExcerptIds = input.supportingExcerptIds ?? current.supportingExcerptIds;
  const counterExcerptIds = input.counterExcerptIds ?? current.counterExcerptIds;
  const contextExcerptIds = input.contextExcerptIds ?? current.contextExcerptIds;
  await checkFindingExcerpts(ctx, projectId, current.recordId, [
    supportingExcerptIds,
    counterExcerptIds,
    contextExcerptIds,
  ]);
  const materialChange =
    input.statement !== undefined ||
    input.supportingExcerptIds !== undefined ||
    input.counterExcerptIds !== undefined ||
    input.contextExcerptIds !== undefined ||
    input.limitations !== undefined;
  const dto = {
    ...current,
    statement: input.statement ?? current.statement,
    supportingExcerptIds,
    counterExcerptIds,
    contextExcerptIds,
    limitations: input.limitations ?? current.limitations,
    humanConfirmed:
      actor.kind === 'user'
        ? (input.humanConfirmed ?? (materialChange ? false : current.humanConfirmed))
        : false,
    needsReview: current.needsReview && !(actor.kind === 'user' && input.resolveReview === true),
    version: current.version + 1,
    updatedBy: actor,
    updatedAt: now(),
  };
  return updateWithEvent(
    ctx,
    actor,
    projectId,
    'finding',
    dto,
    input.baseVersion,
    'research.finding.updated',
  );
}
