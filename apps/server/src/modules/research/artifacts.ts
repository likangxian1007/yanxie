import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { ApiError, ulid, type ActorRef, type ResearchArtifactVersion } from '@srh/shared';
import type { AppContext } from '../../context';
import {
  researchArtifactVersions,
  researchIdempotency,
  researchRuns,
  researchWorkspaceItems,
} from '../../db/schema';
import { getWorkspaceItem } from './workspace';

const bytesHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** 用正式成功的尝试引用来界定发布，避免中间落盘污染画布和审阅。 */
export const publishedArtifactCondition = sql`exists (
  select 1 from ${researchRuns} rr,
    jsonb_array_elements(rr.data->'steps') st,
    jsonb_array_elements(st->'attempts') att,
    jsonb_array_elements(att->'outputs') outp
  where rr.id = ${researchArtifactVersions.data}->>'runId'
    and rr.project_id = ${researchArtifactVersions.projectId}
    and rr.record_id = ${researchArtifactVersions.recordId}
    and st->'definition'->>'itemId' = ${researchArtifactVersions.data}->>'stepId'
    and att->>'status' = 'succeeded'
    and outp->'artifact'->>'id' = ${researchArtifactVersions.id}
)`;
export const visibleWorkspaceItemCondition = sql`(
  not exists (select 1 from ${researchIdempotency}
    where ${researchIdempotency.projectId} = ${researchWorkspaceItems.projectId}
      and ${researchIdempotency.action} = ('research.item.created:' || ${researchWorkspaceItems.recordId})
      and ${researchIdempotency.key} ~ '^rout_[0-9a-f]{48}$'
      and ${researchIdempotency.response}->>'id' = ${researchWorkspaceItems.id})
  or exists (select 1 from ${researchArtifactVersions}
    where ${researchArtifactVersions.itemId} = ${researchWorkspaceItems.id}
      and ${publishedArtifactCondition})
)`;
/** 独立于可由项目文件接口写入的目录；项目成员无法通过普通文件路径覆盖历史快照。 */
function artifactDiskPath(ctx: AppContext, projectId: string, artifactId: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(projectId) || !/^rart_[A-Za-z0-9]+$/u.test(artifactId))
    throw new ApiError('bad_request', '产物路径无效');
  return resolve(ctx.config.STORAGE_DIR, '.research-artifacts', projectId, artifactId);
}
type Input = {
  itemId: string;
  runId?: string | null;
  stepId?: string | null;
  outputKey?: string;
  kind: ResearchArtifactVersion['kind'];
  mime: string;
  bytes: Buffer | string;
  summary: string;
  origin: ResearchArtifactVersion['origin'];
  inputs?: string[];
  metadata?: unknown;
  requestKey: string;
};

/** 幂等键对应一次快照；保存前后都核验字节，历史版本不可由后续编辑改写。 */
export async function saveArtifact(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  input: Input,
): Promise<ResearchArtifactVersion> {
  await getWorkspaceItem(ctx, projectId, recordId, input.itemId);
  const bytes = typeof input.bytes === 'string' ? Buffer.from(input.bytes, 'utf8') : input.bytes;
  const digest = bytesHash(bytes);
  const findPrior = async () => {
    const [prior] = await ctx.db.db
      .select()
      .from(researchArtifactVersions)
      .where(
        and(
          eq(researchArtifactVersions.projectId, projectId),
          eq(researchArtifactVersions.requestKey, input.requestKey),
        ),
      );
    if (!prior) return null;
    if (prior.recordId !== recordId || prior.itemId !== input.itemId || prior.data.hash !== digest)
      throw new ApiError('conflict', '产物幂等键已用于不同内容');
    return prior.data;
  };
  const prior = await findPrior();
  if (prior) return prior;
  const id = `rart_${ulid()}`;
  const path = id;
  const absolute = artifactDiskPath(ctx, projectId, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes, { flag: 'wx' });
  try {
    return await ctx.db.db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from ${researchWorkspaceItems} where ${researchWorkspaceItems.id} = ${input.itemId} and ${researchWorkspaceItems.projectId} = ${projectId} for update`,
      );
      const [latest] = await tx
        .select({ version: researchArtifactVersions.version })
        .from(researchArtifactVersions)
        .where(eq(researchArtifactVersions.itemId, input.itemId))
        .orderBy(desc(researchArtifactVersions.version))
        .limit(1);
      const version = (latest?.version ?? 0) + 1;
      const data: ResearchArtifactVersion = {
        id,
        itemId: input.itemId,
        projectId,
        recordId,
        version,
        kind: input.kind,
        mime: input.mime,
        hash: digest,
        size: bytes.length,
        downloadUrl: `/api/v1/projects/${projectId}/research/artifacts/${id}/download`,
        ...(input.outputKey ? { outputKey: input.outputKey } : {}),
        runId: input.runId ?? null,
        stepId: input.stepId ?? null,
        summary: input.summary,
        createdBy: actor,
        createdAt: new Date().toISOString(),
        origin: input.origin,
        inputs: input.inputs ?? [],
        metadata: input.metadata,
      };
      await tx.insert(researchArtifactVersions).values({
        id,
        projectId,
        recordId,
        itemId: input.itemId,
        version,
        storagePath: path,
        requestKey: input.requestKey,
        data,
      });
      return data;
    });
  } catch (error) {
    await rm(absolute, { force: true });
    const winner = await findPrior();
    if (winner) return winner;
    throw error;
  }
}

export async function getArtifact(ctx: AppContext, projectId: string, id: string) {
  const [row] = await ctx.db.db
    .select()
    .from(researchArtifactVersions)
    .where(
      and(eq(researchArtifactVersions.id, id), eq(researchArtifactVersions.projectId, projectId)),
    );
  if (!row) throw new ApiError('not_found', '产物版本不存在');
  return row;
}

export async function readArtifact(ctx: AppContext, projectId: string, id: string) {
  const row = await getArtifact(ctx, projectId, id);
  let bytes: Buffer;
  try {
    bytes = await readFile(artifactDiskPath(ctx, projectId, row.storagePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new ApiError('not_found', '固定产物文件不可用');
    throw error;
  }
  if (bytes.length !== row.data.size || bytesHash(bytes) !== row.data.hash)
    throw new ApiError('conflict', '产物快照校验失败，无法读取');
  return { artifact: row.data, bytes };
}

/** 运行完成前的落盘文件不属于已发布结果。 */
export async function artifactWasPublished(
  ctx: AppContext,
  projectId: string,
  data: ResearchArtifactVersion,
) {
  if (!data.runId || !data.stepId) return false;
  const [run] = await ctx.db.db
    .select({ data: researchRuns.data })
    .from(researchRuns)
    .where(
      and(
        eq(researchRuns.id, data.runId),
        eq(researchRuns.projectId, projectId),
        eq(researchRuns.recordId, data.recordId),
      ),
    );
  return !!run?.data.steps.some(
    (step) =>
      step.definition.itemId === data.stepId &&
      step.attempts.some(
        (attempt) =>
          attempt.status === 'succeeded' &&
          attempt.outputs.some((output) => output.artifact?.id === data.id),
      ),
  );
}

/** 内容条目的输入快照可供回查；图像格式文件和未完成的确认说明不伪装成输出版本。 */
async function isRunInputSnapshot(
  ctx: AppContext,
  projectId: string,
  data: ResearchArtifactVersion,
) {
  const metadata = data.metadata as { bindingKey?: unknown } | undefined;
  if (data.stepId || !data.runId || typeof metadata?.bindingKey !== 'string') return false;
  const [run] = await ctx.db.db
    .select({ id: researchRuns.id })
    .from(researchRuns)
    .where(
      and(
        eq(researchRuns.id, data.runId),
        eq(researchRuns.projectId, projectId),
        eq(researchRuns.recordId, data.recordId),
      ),
    );
  return !!run;
}

export async function listArtifacts(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  itemId: string,
  query: { cursor?: string; limit?: number },
) {
  const item = await getWorkspaceItem(ctx, projectId, recordId, itemId);
  const limit = Math.max(1, Math.min(100, query.limit ?? 50));
  const published: ResearchArtifactVersion[] = [];
  let cursor = query.cursor;
  let exhausted = false;
  while (published.length <= limit && !exhausted) {
    const rows = await ctx.db.db
      .select()
      .from(researchArtifactVersions)
      .where(
        and(
          eq(researchArtifactVersions.projectId, projectId),
          eq(researchArtifactVersions.recordId, recordId),
          item.kind === 'action'
            ? sql`${researchArtifactVersions.data}->>'stepId' = ${item.id}`
            : eq(researchArtifactVersions.itemId, item.id),
          cursor ? lt(researchArtifactVersions.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(researchArtifactVersions.id))
      .limit(100);
    exhausted = rows.length < 100;
    for (const row of rows) {
      const metadata = row.data.metadata as { purpose?: unknown } | undefined;
      const isCapture =
        !row.data.runId && !row.data.stepId && metadata?.purpose === 'workspace_capture';
      if (
        (await artifactWasPublished(ctx, projectId, row.data)) ||
        (item.kind !== 'action' &&
          (isCapture || (await isRunInputSnapshot(ctx, projectId, row.data))))
      )
        published.push(row.data);
      if (published.length > limit) break;
    }
    cursor = rows.at(-1)?.id;
  }
  const items = published.slice(0, limit);
  return { items, nextCursor: published.length > limit ? items.at(-1)!.id : null };
}
