import { createHash } from 'node:crypto';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { ApiError, type ActorRef, type ResearchArtifactVersion } from '@srh/shared';
import type { AppContext } from '../../context';
import {
  researchEntities,
  researchArtifactVersions,
  researchRecipeVersions,
  researchRuns,
  researchWorkspaceItems,
  researchWorkspaceRelations,
} from '../../db/schema';
import { notFound } from '../collab-common';
import {
  publishedArtifactCondition,
  saveArtifact,
  visibleWorkspaceItemCondition,
} from './artifacts';
import { readResearchTable } from './tables';
import { getWorkspaceItem } from './workspace';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const captureActor: ActorRef = { kind: 'system', id: null, name: '研究空间快照' };
type CapturedTable =
  | {
      itemId: string;
      state: 'available';
      artifactId: string;
      sha256: string;
      sourceVersion: string;
      documentId: string;
      sheetId: string;
    }
  | { itemId: string; state: 'unavailable'; reason: string };

/** 一致性读取内容版本。布局单独导出，不进入研究内容摘要或审阅基线。 */
export async function captureWorkspaceArchive(
  ctx: AppContext,
  projectId: string,
  recordId: string,
) {
  const captured = await ctx.db.db.transaction(
    async (tx) => {
      const [record] = await tx
        .select()
        .from(researchEntities)
        .where(
          and(
            eq(researchEntities.projectId, projectId),
            eq(researchEntities.id, recordId),
            eq(researchEntities.kind, 'record'),
          ),
        );
      if (!record) notFound('研究空间');
      const items = await tx
        .select()
        .from(researchWorkspaceItems)
        .where(
          and(
            eq(researchWorkspaceItems.projectId, projectId),
            eq(researchWorkspaceItems.recordId, recordId),
            visibleWorkspaceItemCondition,
          ),
        )
        .orderBy(asc(researchWorkspaceItems.id));
      const relations = await tx
        .select()
        .from(researchWorkspaceRelations)
        .where(
          and(
            eq(researchWorkspaceRelations.projectId, projectId),
            eq(researchWorkspaceRelations.recordId, recordId),
          ),
        )
        .orderBy(asc(researchWorkspaceRelations.id));
      const runs = await tx
        .select()
        .from(researchRuns)
        .where(and(eq(researchRuns.projectId, projectId), eq(researchRuns.recordId, recordId)))
        .orderBy(asc(researchRuns.id));
      const recipes = await tx
        .select()
        .from(researchRecipeVersions)
        .where(
          and(
            eq(researchRecipeVersions.projectId, projectId),
            eq(researchRecipeVersions.recordId, recordId),
          ),
        )
        .orderBy(asc(researchRecipeVersions.id), asc(researchRecipeVersions.version));
      const artifactRows = await tx
        .select()
        .from(researchArtifactVersions)
        .where(
          and(
            eq(researchArtifactVersions.projectId, projectId),
            eq(researchArtifactVersions.recordId, recordId),
            sql`(${researchArtifactVersions.data}->>'stepId' is null or ${publishedArtifactCondition})`,
          ),
        )
        .orderBy(asc(researchArtifactVersions.id));
      const itemIds = new Set(items.map((item) => item.id));
      const runIds = new Set(runs.map((run) => run.id));
      const referencedIds = new Set<string>();
      for (const row of artifactRows) {
        if (!row.data.stepId) continue;
        row.data.inputs.forEach((id) => referencedIds.add(id));
        const metadata = row.data.metadata as
          { pngArtifactId?: unknown; reportArtifactId?: unknown } | undefined;
        if (typeof metadata?.pngArtifactId === 'string') referencedIds.add(metadata.pngArtifactId);
        if (typeof metadata?.reportArtifactId === 'string')
          referencedIds.add(metadata.reportArtifactId);
      }
      // 中间计算可以形成多级依据链；沿成功产物的引用递归收集，
      // 但不把中间快照当作已发布的画布输出。
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of artifactRows) {
          if (!referencedIds.has(row.id)) continue;
          for (const id of row.data.inputs) {
            if (!referencedIds.has(id)) {
              referencedIds.add(id);
              changed = true;
            }
          }
        }
      }
      const artifacts = artifactRows.filter((artifact) => {
        if (referencedIds.has(artifact.id)) return true;
        if (!itemIds.has(artifact.itemId)) return false;
        if (artifact.data.stepId) return true;
        const metadata = artifact.data.metadata as
          { bindingKey?: unknown; purpose?: unknown } | undefined;
        if (metadata?.purpose === 'workspace_capture') return true;
        return (
          !!artifact.data.runId &&
          runIds.has(artifact.data.runId) &&
          typeof metadata?.bindingKey === 'string'
        );
      });
      const evidenceRows = await tx
        .select()
        .from(researchEntities)
        .where(and(eq(researchEntities.projectId, projectId), ne(researchEntities.kind, 'record')))
        .orderBy(asc(researchEntities.id));
      const requiredIds = new Set([
        ...(Array.isArray(record.data.sourceIds)
          ? record.data.sourceIds.filter((id): id is string => typeof id === 'string')
          : []),
        ...items.flatMap((item) => (item.evidenceRef ? [item.evidenceRef.id] : [])),
        ...items.flatMap((item) =>
          item.payload?.kind === 'draft'
            ? item.payload.blocks.flatMap((block) =>
                block.kind === 'excerpt' ? [block.excerptId] : [],
              )
            : [],
        ),
        ...evidenceRows.filter((row) => row.recordId === recordId).map((row) => row.id),
      ]);
      for (const entry of evidenceRows) {
        if (entry.kind !== 'source') continue;
        if (
          items.some((item) => {
            const resources = [
              ...(item.resource ? [item.resource] : []),
              ...(item.payload?.kind === 'draft'
                ? item.payload.blocks.flatMap((block) =>
                    block.kind === 'resource' ? [block.resource] : [],
                  )
                : []),
            ];
            return resources.some(
              (resource) =>
                entry.data.kind === resource.kind && entry.data.resourceId === resource.id,
            );
          })
        )
          requiredIds.add(entry.id);
      }
      // 沿固定引用闭包收集共享资料及反例；不把无关研究的证据装进导出或审阅。
      let added = true;
      while (added) {
        added = false;
        for (const row of evidenceRows) {
          if (!requiredIds.has(row.id)) continue;
          const refs = [
            'sourceId',
            'snapshotId',
            'originalSourceId',
            'excerptId',
            'codeId',
          ].flatMap((key) => (typeof row.data[key] === 'string' ? [row.data[key] as string] : []));
          for (const key of ['supportingExcerptIds', 'counterExcerptIds', 'contextExcerptIds'])
            if (Array.isArray(row.data[key]))
              refs.push(...row.data[key].filter((id): id is string => typeof id === 'string'));
          for (const id of refs)
            if (!requiredIds.has(id)) {
              requiredIds.add(id);
              added = true;
            }
        }
        for (const row of evidenceRows)
          if (
            row.kind === 'snapshot' &&
            typeof row.data.sourceId === 'string' &&
            requiredIds.has(row.data.sourceId) &&
            !requiredIds.has(row.id)
          ) {
            requiredIds.add(row.id);
            added = true;
          }
      }
      const evidence = evidenceRows
        .filter((row) => requiredIds.has(row.id))
        .map((row) => ({
          kind: row.kind,
          id: row.id,
          version: row.version,
          data: row.data,
        }));
      const contentItems = items.map(
        ({
          position: _position,
          positionVersion: _positionVersion,
          preview: _preview,
          ...item
        }) => {
          // 移动卡片会改变 updatedAt；该时间属于布局活动，不能改变正文的审阅摘要。
          const { updatedAt: _updatedAt, ...content } = item;
          return { ...content, contentHash: digest(content) };
        },
      );
      const manifest = {
        record: { id: record.id, version: record.version, sha256: digest(record.data) },
        items: contentItems.map((item) => ({
          id: item.id,
          version: item.version,
          sha256: item.contentHash,
        })),
        relations: relations.map((relation) => ({
          id: relation.id,
          version: relation.version,
          sha256: digest(relation),
        })),
        recipes: recipes.map((recipe) => ({
          id: recipe.id,
          version: recipe.version,
          sha256: digest(recipe.data),
        })),
        runs: runs.map((run) => ({ id: run.id, revision: run.revision, sha256: digest(run.data) })),
        artifacts: artifacts.map((artifact) => ({
          id: artifact.id,
          version: artifact.version,
          sha256: artifact.data.hash,
        })),
        evidence: evidence.map((entry) => ({
          kind: entry.kind,
          id: entry.id,
          version: entry.version,
          sha256: digest(entry.data),
        })),
      };
      return {
        schemaVersion: 1,
        projectId,
        recordId,
        capturedAt: new Date().toISOString(),
        manifest,
        contentHash: digest(manifest),
        items: contentItems,
        relations,
        recipes: recipes.map((row) => row.data),
        runs: runs.map((row) => row.data),
        artifacts: artifacts.map((row) => row.data),
        evidence,
        layout: items.map((item) => ({
          itemId: item.id,
          position: item.position,
          version: item.positionVersion,
        })),
        resourceCoverage: '原资源保留引用；固定原文见来源快照、摘录及运行输入快照。',
        snapshotDownloads: evidence
          .filter((entry) => entry.kind === 'snapshot' && entry.data.coverage !== 'external')
          .map((entry) => ({
            snapshotId: entry.id,
            href: `/api/v1/projects/${projectId}/research/snapshots/${entry.id}/download`,
            coverage: entry.data.coverage,
            sha256: entry.data.sha256,
          })),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  const currentTables: CapturedTable[] = [];
  const tableArtifacts: ResearchArtifactVersion[] = [];
  for (const entry of captured.items) {
    if (entry.kind !== 'table') continue;
    if (entry.archivedAt) {
      currentTables.push({ itemId: entry.id, state: 'unavailable', reason: '表格条目已归档' });
      continue;
    }
    let tableItem;
    let table;
    try {
      tableItem = await getWorkspaceItem(ctx, projectId, recordId, entry.id);
      if (tableItem.version !== entry.version)
        throw new ApiError('conflict', '表格内容设置在捕获时发生变化，请重试');
      table = await readResearchTable(ctx, projectId, tableItem);
      const latest = await getWorkspaceItem(ctx, projectId, recordId, entry.id);
      if (latest.version !== entry.version)
        throw new ApiError('conflict', '表格内容设置在捕获时发生变化，请重试');
    } catch (error) {
      if (error instanceof ApiError && ['not_found', 'validation_failed'].includes(error.code)) {
        currentTables.push({ itemId: entry.id, state: 'unavailable', reason: error.message });
        continue;
      }
      throw error;
    }
    const bytes = JSON.stringify({
      ...table,
      lineage: tableItem.payload?.kind === 'table' ? (tableItem.payload.lineage ?? []) : [],
    });
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    let artifact: ResearchArtifactVersion;
    try {
      artifact = await saveArtifact(ctx, captureActor, projectId, recordId, {
        itemId: entry.id,
        kind: 'table',
        mime: 'application/json',
        bytes,
        summary: '研究空间捕获的表格数据',
        origin: 'member_report',
        metadata: {
          purpose: 'workspace_capture',
          sourceVersion: table.sourceVersion,
          documentId: table.documentId,
          sheetId: table.sheetId,
        },
        requestKey: `workspace-capture:${entry.id}:${contentHash}`,
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'not_found') {
        currentTables.push({ itemId: entry.id, state: 'unavailable', reason: error.message });
        continue;
      }
      throw error;
    }
    tableArtifacts.push(artifact);
    currentTables.push({
      itemId: entry.id,
      state: 'available',
      artifactId: artifact.id,
      sha256: artifact.hash,
      sourceVersion: table.sourceVersion,
      documentId: table.documentId,
      sheetId: table.sheetId,
    });
  }
  const artifactMap = new Map(captured.artifacts.map((artifact) => [artifact.id, artifact]));
  for (const artifact of tableArtifacts) artifactMap.set(artifact.id, artifact);
  const artifacts = [...artifactMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  const manifest = {
    ...captured.manifest,
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      version: artifact.version,
      sha256: artifact.hash,
    })),
    currentTables,
  };
  return { ...captured, manifest, contentHash: digest(manifest), artifacts, currentTables };
}

export type WorkspaceArchive = Awaited<ReturnType<typeof captureWorkspaceArchive>>;

/** 审阅与 Markdown 导出共用，保留正文、作者、依据和实际运行，不能只审卡片标题。 */
export function workspaceArchiveMarkdown(archive: WorkspaceArchive): string {
  const lines = [
    '## 研究空间',
    '',
    `内容摘要：SHA-256 ${archive.contentHash}`,
    '',
    archive.resourceCoverage,
    '',
  ];
  for (const item of archive.items) {
    lines.push(
      `### ${item.title}`,
      '',
      `条目 ${item.id} · v${item.version} · ${item.kind}${item.archivedAt ? ' · 已归档' : ''}`,
      '',
      `作者：${item.createdBy.kind}:${item.createdBy.name}；更新者：${item.updatedBy.kind}:${item.updatedBy.name}`,
      '',
      item.body,
      '',
    );
    if (item.resource) lines.push(`原资源：${item.resource.kind} ${item.resource.id}`, '');
    if (item.evidenceRef) lines.push(`依据：${item.evidenceRef.kind} ${item.evidenceRef.id}`, '');
    if (item.payload?.kind === 'draft') {
      lines.push('#### 有序草稿素材', '');
      for (const [index, block] of item.payload.blocks.entries()) {
        if (block.kind === 'text')
          lines.push(`${index + 1}. 文字（${block.id}）`, '', block.text, '');
        else if (block.kind === 'resource')
          lines.push(
            `${index + 1}. 材料（${block.id}）：${block.title || block.resource.id} · ${block.resource.kind} ${block.resource.id}；保留原件引用`,
            '',
          );
        else
          lines.push(
            `${index + 1}. 摘录（${block.id}）：${block.excerptId}；原文及定位见固定研究依据`,
            '',
          );
      }
    }
    if (item.kind === 'table') {
      const tablePayload = item.payload?.kind === 'table' ? item.payload : null;
      const currentTable = archive.currentTables?.find((entry) => entry.itemId === item.id);
      lines.push(
        `工作簿：${item.resource?.id ?? '不可用'}；工作表：${tablePayload?.sheetId ?? '默认'}。`,
        '',
      );
      for (const column of tablePayload?.columns ?? [])
        lines.push(
          `- 列 ${column.id}：${column.name}${column.type ? ` · ${column.type}` : ''}${column.unit ? ` · 单位 ${column.unit}` : ''}${column.description ? ` · ${column.description}` : ''}${column.missingValues?.length ? ` · 缺失标记 ${column.missingValues.join('、')}` : ''}`,
        );
      if (tablePayload?.lineage?.length)
        lines.push(
          '',
          `单元格来源定位：${tablePayload.lineage.length} 条（具体位置与核对状态保存在内容元数据及固定表格快照）。`,
        );
      if (currentTable?.state === 'available')
        lines.push(
          '',
          `本次捕获的表格：版本 ${currentTable.sourceVersion} · SHA-256 ${currentTable.sha256} · [下载固定表格](/api/v1/projects/${archive.projectId}/research/artifacts/${currentTable.artifactId}/download)`,
        );
      else if (currentTable?.state === 'unavailable')
        lines.push('', `当前表格不可用：${currentTable.reason}；仍可查看已有固定产物。`);
      if (!item.archivedAt && currentTable?.state !== 'unavailable')
        lines.push(
          '',
          `[下载当前表格 CSV](/api/v1/projects/${archive.projectId}/research/records/${archive.recordId}/items/${item.id}/table/export)（当前数据，历史版本见固定产物）`,
        );
      lines.push('');
    }
    if (item.payload?.kind === 'figure') {
      lines.push(
        `图像：${item.payload.caption || item.title}；固定数据版本：${item.payload.dataArtifactId ?? '未关联'}`,
        '',
      );
      if (item.payload.chart) {
        const chart = item.payload.chart;
        lines.push(
          `图表：${chart.kind}；横轴列 ${chart.xColumn}；纵轴列 ${chart.yColumns.join('、')}；缺失值 ${chart.missing === 'omit' ? '忽略' : '报错'}${chart.xLabel ? `；横轴名 ${chart.xLabel}` : ''}${chart.yLabel ? `；纵轴名 ${chart.yLabel}` : ''}。`,
          '',
        );
      }
    }
    if (item.action) {
      lines.push(
        `操作：${item.action.kind}${item.action.operation ? ` · ${item.action.operation}` : ''}`,
        '',
        item.action.instructions,
        '',
      );
      const inputs = item.action.inputs;
      if (inputs !== undefined) {
        lines.push('具名输入：', '');
        for (const input of inputs) {
          const source = input.source;
          lines.push(
            source.kind === 'item'
              ? `- ${input.name}：内容 ${source.itemId}${source.blockIds ? `，素材块 ${source.blockIds.join('、')}` : ''}`
              : `- ${input.name}：步骤 ${source.stepId} 的 ${source.outputKey}${source.artifactVersionId ? `，固定产物 ${source.artifactVersionId}` : ''}`,
          );
        }
        if (!inputs.length) lines.push('- 无');
      } else lines.push(`输入：${item.action.inputItemIds.join('、') || '无'}`);
      lines.push('');
      for (const output of item.action.outputs ?? [])
        lines.push(
          `- 输出 ${output.key}：${output.kind}${output.title ? ` · ${output.title}` : ''}`,
        );
      if (item.action.outputs?.length) lines.push('');
    }
  }
  if (archive.artifacts?.length) {
    lines.push('### 固定产物与下载', '');
    for (const artifact of archive.artifacts)
      lines.push(
        `- ${artifact.summary} · ${artifact.kind} · ${artifact.itemId} v${artifact.version} · ${artifact.origin} · SHA-256 ${artifact.hash} · [下载固定版本](${artifact.downloadUrl ?? `/api/v1/projects/${archive.projectId}/research/artifacts/${artifact.id}/download`})`,
      );
    lines.push('');
  }
  if (archive.relations.length) {
    lines.push('### 内容关系', '');
    for (const relation of archive.relations)
      lines.push(
        `- ${relation.fromItemId} → ${relation.toItemId}：${relation.label || '关联'}（${relation.id} v${relation.version}${relation.archivedAt ? '，已归档' : ''}）`,
      );
    lines.push('');
  }
  if (archive.evidence.length) {
    lines.push('### 固定研究依据', '');
    for (const entry of archive.evidence)
      lines.push(
        `#### ${entry.kind} ${entry.id} · v${entry.version}`,
        '',
        '```json',
        JSON.stringify(entry.data, null, 2),
        '```',
        '',
      );
  }
  for (const run of archive.runs) {
    lines.push(
      `### 运行 ${run.id}`,
      '',
      `状态：${run.status}；方案：${run.recipeId ?? '临时片段'} v${run.recipeVersion ?? '—'}；启动者：${run.createdBy.kind}:${run.createdBy.name}`,
      '',
    );
    for (const input of run.inputSnapshots)
      lines.push(
        `输入 ${input.item.id} v${input.item.version}（原内容版本 ${input.contentVersion ?? '无'}；SHA-256 ${input.hash}）：`,
        '',
        input.content,
        '',
      );
    for (const step of run.steps) {
      lines.push(
        `#### ${step.definition.title} · ${step.status}`,
        '',
        `操作条目：${step.definition.itemId} v${step.definition.itemVersion}；依赖：${step.definition.dependsOn.join('、') || '无'}`,
        '',
      );
      if (step.confirmedBy)
        lines.push(`人工检查：${step.confirmedBy.name} · ${step.confirmedAt}`, '');
      for (const attempt of step.attempts) {
        lines.push(
          `尝试 ${attempt.number}：${attempt.status} · ${attempt.startedAt} 至 ${attempt.endedAt ?? '进行中'}`,
          '',
          ...attempt.logs,
          '',
        );
        if (attempt.error) lines.push(`错误：${attempt.error}`, '');
        for (const output of attempt.outputs)
          lines.push(
            `产物：${output.title}（${output.itemId} v${output.version}；${output.origin}；SHA-256 ${output.hash}）`,
            '',
            output.content,
            '',
          );
      }
    }
  }
  lines.push(
    '### 固定版本清单',
    '',
    '```json',
    JSON.stringify(archive.manifest, null, 2),
    '```',
    '',
  );
  return lines.join('\n');
}
