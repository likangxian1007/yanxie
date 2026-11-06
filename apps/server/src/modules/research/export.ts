import { researchHistoryMarkdown } from './history-markdown';
import type {
  EvidenceExcerpt,
  ResearchCode,
  ResearchCoding,
  ResearchFinding,
  ResearchLog,
  ResearchRecordRevision,
  ResearchSnapshot,
  ResearchSource,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { listEntities, listRevisions, recordDetail } from './service';
import { captureWorkspaceArchive, workspaceArchiveMarkdown } from './workspace-archive';

async function all<T>(
  load: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const result: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await load(cursor);
    result.push(...page.items);
    if (!page.nextCursor) return result;
    cursor = page.nextCursor;
  }
}

function csvCell(value: unknown): string {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  let first = 0;
  while (first < text.length && (text.charCodeAt(first) <= 32 || text.charCodeAt(first) === 127))
    first++;
  if (['=', '+', '@', '-'].includes(text[first] ?? '')) text = `'${text}`;
  return `"${text.replace(/"/gu, '""')}"`;
}

export async function exportResearch(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  format: 'json' | 'markdown' | 'csv',
) {
  const { record, template } = await recordDetail(ctx, projectId, recordId);
  const [revisions, logs, sourcesAll, snapshotsAll, excerpts, codes, codings, findings] =
    await Promise.all([
      all<ResearchRecordRevision>((cursor) =>
        listRevisions(ctx, projectId, recordId, { cursor, limit: 100 }),
      ),
      all<ResearchLog>((cursor) =>
        listEntities(ctx, projectId, 'log', { recordId, cursor, limit: 100 }),
      ),
      all<ResearchSource>((cursor) =>
        listEntities(ctx, projectId, 'source', { cursor, limit: 100 }),
      ),
      all<ResearchSnapshot>((cursor) =>
        listEntities(ctx, projectId, 'snapshot', { cursor, limit: 100 }),
      ),
      all<EvidenceExcerpt>((cursor) =>
        listEntities(ctx, projectId, 'excerpt', { recordId, cursor, limit: 100 }),
      ),
      all<ResearchCode>((cursor) =>
        listEntities(ctx, projectId, 'code', { recordId, cursor, limit: 100 }),
      ),
      all<ResearchCoding>((cursor) =>
        listEntities(ctx, projectId, 'coding', { recordId, cursor, limit: 100 }),
      ),
      all<ResearchFinding>((cursor) =>
        listEntities(ctx, projectId, 'finding', { recordId, cursor, limit: 100 }),
      ),
    ]);
  const historicalSourceIds = new Set([
    ...record.sourceIds,
    ...revisions.flatMap((revision) => revision.record.sourceIds),
    ...excerpts.map((excerpt) => excerpt.sourceId),
  ]);
  const sources = sourcesAll.filter((s) => historicalSourceIds.has(s.id));
  const snapshots = snapshotsAll.filter(
    (s) =>
      historicalSourceIds.has(s.sourceId) ||
      excerpts.some((excerpt) => excerpt.snapshotId === s.id),
  );
  const snapshotDownloads = snapshots
    .filter((snapshot) => snapshot.coverage !== 'external')
    .map((snapshot) => ({
      snapshotId: snapshot.id,
      href: `/api/v1/projects/${projectId}/research/snapshots/${snapshot.id}/download`,
      coverage: snapshot.coverage,
      sha256: snapshot.sha256,
    }));
  const workspace = await captureWorkspaceArchive(ctx, projectId, recordId);
  const provenance = {
    exportedAt: new Date().toISOString(),
    projectId,
    record,
    template,
    revisions,
    logs,
    sources,
    snapshots,
    snapshotDownloads,
    excerpts,
    codes,
    codings,
    findings,
    workspace,
  };
  if (format === 'json')
    return { mime: 'application/json; charset=utf-8', body: JSON.stringify(provenance, null, 2) };
  if (format === 'markdown') {
    const snapshotById = new Map(snapshots.map((s) => [s.id, s]));
    const excerptById = new Map(excerpts.map((e) => [e.id, e]));
    const lines = [
      `# ${record.title}`,
      '',
      `- 项目：${projectId}`,
      `- 研究空间：${record.id}，修订 ${record.version}`,
      `- 问题：${record.question}`,
      `- 状态：${record.status}`,
      `- 创建：${record.createdAt} / ${record.createdBy.name}`,
      `- 更新：${record.updatedAt} / ${record.updatedBy.name}`,
      '',
      workspaceArchiveMarkdown(workspace),
      '',
      '## 来源与快照',
      '',
      ...sources.map(
        (source) =>
          `- ${source.title} [${source.id}]；${source.citation || '无书目信息'}；原件：${source.originalSourceId ?? '自身'}；快照：${
            snapshots
              .filter((s) => s.sourceId === source.id)
              .map(
                (s) =>
                  `${s.id} (来源v${s.sourceVersion}：${s.sourceMetadata.title}；${s.sourceMetadata.citation || '无书目信息'}；${s.coverage}, SHA-256 ${s.sha256 ?? '无'}${s.coverage !== 'external' ? `，[下载快照](/api/v1/projects/${projectId}/research/snapshots/${s.id}/download)` : ''})`,
              )
              .join('、') || '无'
          }`,
      ),
      '',
      '## 固定摘录',
      '',
      ...excerpts.map(
        (e) =>
          `> ${e.quote}\n\n来源：${snapshotById.get(e.snapshotId)?.sourceMetadata.title ?? e.sourceId} [${e.sourceId}]；快照 ${e.snapshotId}（来源v${snapshotById.get(e.snapshotId)?.sourceVersion ?? '未知'}）；定位 ${JSON.stringify(e.locator)}；${e.verification}；${e.origin}`,
      ),
      '',
      '## 代码与编码',
      '',
      ...codes.map((c) => `- ${c.name} [${c.id}]：${c.definition}；组别：${c.group ?? '无'}`),
      ...codings.map(
        (c) => `- 摘录 ${c.excerptId} → 代码 ${c.codeId}；对象 ${c.caseId ?? '未标注'}`,
      ),
      '',
      '## 发现',
      '',
      ...findings.map(
        (f) =>
          `### ${f.statement}\n\n- 支持：${f.supportingExcerptIds.map((id) => excerptById.get(id)?.quote ?? id).join('；') || '无'}\n- 反例：${f.counterExcerptIds.map((id) => excerptById.get(id)?.quote ?? id).join('；') || '无'}\n- 背景：${f.contextExcerptIds.map((id) => excerptById.get(id)?.quote ?? id).join('；') || '无'}\n- 局限：${f.limitations || '未填写'}\n- 人工确认：${f.humanConfirmed ? '是' : '否'}；待复核：${f.needsReview ? '是' : '否'}`,
      ),
      '',
      '## 修订历史',
      '',
      ...revisions.map((r) => `- v${r.version} · ${r.createdAt} · ${r.createdBy.name} [${r.id}]`),
      '',
    ];
    return {
      mime: 'text/markdown; charset=utf-8',
      body: `${lines.join('\n')}\n${researchHistoryMarkdown({ record, template, logs })}`,
    };
  }
  const rows: string[][] = [
    ['type', 'id', 'sourceId', 'snapshotId', 'locator', 'text', 'author', 'createdAt'],
  ];
  rows.push([
    'record',
    record.id,
    '',
    '',
    '',
    record.title,
    record.createdBy.name,
    record.createdAt,
  ]);
  for (const source of sources)
    rows.push([
      'source',
      source.id,
      source.originalSourceId ?? '',
      '',
      '',
      `${source.title} ${source.citation}`,
      source.createdBy.name,
      source.createdAt,
    ]);
  for (const snapshot of snapshots)
    rows.push([
      'snapshot',
      snapshot.id,
      snapshot.sourceId,
      snapshot.id,
      snapshot.coverage,
      snapshot.sha256 ?? '',
      snapshot.createdBy.name,
      snapshot.createdAt,
    ]);
  for (const excerpt of excerpts)
    rows.push([
      'excerpt',
      excerpt.id,
      excerpt.sourceId,
      excerpt.snapshotId,
      JSON.stringify(excerpt.locator),
      excerpt.quote,
      excerpt.createdBy.name,
      excerpt.createdAt,
    ]);
  for (const coding of codings)
    rows.push([
      'coding',
      coding.id,
      '',
      '',
      coding.caseId ?? '',
      `${coding.excerptId} → ${coding.codeId}`,
      coding.createdBy.name,
      coding.createdAt,
    ]);
  for (const finding of findings)
    rows.push([
      'finding',
      finding.id,
      '',
      '',
      '',
      finding.statement,
      finding.createdBy.name,
      finding.createdAt,
    ]);
  for (const item of workspace.items)
    rows.push([
      `workspace_${item.kind}`,
      item.id,
      item.resource?.id ?? item.evidenceRef?.id ?? '',
      '',
      item.kind === 'table' && !item.archivedAt
        ? `v${item.version}; /api/v1/projects/${projectId}/research/records/${recordId}/items/${item.id}/table/export`
        : `v${item.version}`,
      `${item.title}\n${item.body}${item.payload ? `\n${JSON.stringify(item.payload)}` : ''}`,
      item.createdBy.name,
      item.createdAt.toISOString(),
    ]);
  for (const artifact of workspace.artifacts ?? [])
    rows.push([
      'artifact',
      artifact.id,
      artifact.itemId,
      artifact.runId ?? '',
      artifact.outputKey ?? '',
      `${artifact.summary} · ${artifact.kind} · ${artifact.origin} · SHA-256 ${artifact.hash} · ${artifact.downloadUrl ?? ''}`,
      artifact.createdBy.name,
      artifact.createdAt,
    ]);
  for (const run of workspace.runs)
    for (const step of run.steps)
      for (const attempt of step.attempts)
        rows.push([
          'run_attempt',
          run.id,
          step.definition.itemId,
          '',
          `attempt:${attempt.number}`,
          `${step.definition.title} · ${attempt.status}\n${attempt.logs.join('\n')}\n${attempt.error ?? ''}`,
          run.createdBy.name,
          attempt.startedAt,
        ]);
  return {
    mime: 'text/csv; charset=utf-8',
    body: `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`,
  };
}
