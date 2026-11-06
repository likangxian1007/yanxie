import { createHash } from 'node:crypto';
import {
  ApiError,
  type ActorRef,
  type ResearchActionInput,
  type ResearchExecutionDefinition,
  type ResearchItem,
  type ResearchRunInputSnapshot,
} from '@srh/shared';
import type { AppContext } from '../../context';
import { getWorkspaceItem, readWorkspaceItemContent } from './workspace';
import { readResearchTable } from './tables';
import { getArtifact, readArtifact, saveArtifact } from './artifacts';
import { getRow as getDocumentRow } from '../documents/service';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const itemBindingKey = (itemId: string, blockIds?: string[]) =>
  JSON.stringify([itemId, blockIds ? [...blockIds].sort() : null]);

async function fullText(ctx: AppContext, projectId: string, recordId: string, item: ResearchItem) {
  let offset = 0;
  let content = '';
  let version: string | number | null | undefined;
  const visited = new Set<number>();
  for (;;) {
    if (visited.has(offset)) throw new ApiError('validation_failed', '材料分页出现循环');
    visited.add(offset);
    const page = await readWorkspaceItemContent(ctx, projectId, recordId, item, {
      offset,
      limit: 50000,
    });
    if (page.unavailableReason || page.text === null)
      return {
        text: null,
        version: page.version,
        reason: page.unavailableReason ?? '无可读取正文',
        href: page.href,
        locator: page.locator,
      };
    if (version !== undefined && page.version !== version)
      throw new ApiError('conflict', `材料「${item.title}」在读取时发生变化`);
    version = page.version;
    content += page.text;
    if (page.nextOffset === null)
      return {
        text: content,
        version: version ?? null,
        reason: null,
        href: page.href,
        locator: page.locator,
      };
    offset = page.nextOffset;
  }
}

async function materialize(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  item: ResearchItem,
  blockIds?: string[],
) {
  if (item.kind === 'action' || item.kind === 'group')
    throw new ApiError('validation_failed', '行动或分组不能当作材料输入');
  if (item.payload?.kind === 'draft') {
    const requested = blockIds ? new Set(blockIds) : null;
    if (blockIds && !blockIds.length)
      throw new ApiError('validation_failed', '请至少选择一个草稿素材块');
    if (
      requested &&
      (requested.size !== blockIds!.length ||
        [...requested].some(
          (id) =>
            !item.payload ||
            item.payload.kind !== 'draft' ||
            !item.payload.blocks.some((block) => block.id === id),
        ))
    )
      throw new ApiError('validation_failed', '所选草稿素材不存在或重复');
    const blocks = [];
    for (const block of item.payload.blocks) {
      if (requested && !requested.has(block.id)) continue;
      if (block.kind === 'text') {
        blocks.push(block);
        continue;
      }
      const source: ResearchItem = {
        ...item,
        kind: 'resource',
        payload: null,
        resource: block.kind === 'resource' ? block.resource : null,
        evidenceRef: block.kind === 'excerpt' ? { kind: 'excerpt', id: block.excerptId } : null,
      };
      if (
        source.resource?.kind === 'document' &&
        (await getDocumentRow(ctx, projectId, source.resource.id)).kind === 'sheet'
      ) {
        const table = await readResearchTable(ctx, projectId, {
          ...source,
          kind: 'table',
          payload: { kind: 'table' },
        });
        blocks.push({
          ...block,
          content: { structuredTable: table, version: table.sourceVersion, reason: null },
        });
        continue;
      }
      const content = await fullText(ctx, projectId, recordId, source);
      if (content.text === null)
        throw new ApiError(
          'validation_failed',
          `草稿素材「${block.kind === 'resource' ? (block.title ?? block.resource.id) : block.excerptId}」无法读取：${content.reason ?? '无正文'}；请选择可读取的素材`,
        );
      blocks.push({ ...block, content });
    }
    if (!blocks.length || blocks.every((block) => block.kind === 'text' && !block.text.trim()))
      throw new ApiError('validation_failed', `草稿「${item.title}」没有可处理的内容`);
    return {
      content: JSON.stringify({ kind: 'draft', itemId: item.id, blocks }),
      version: item.version,
    };
  }
  if (blockIds) throw new ApiError('validation_failed', '只能选择草稿中的素材块');
  if (item.kind === 'table') {
    const table = await readResearchTable(ctx, projectId, item);
    return {
      content: JSON.stringify({
        ...table,
        lineage: item.payload?.kind === 'table' ? (item.payload.lineage ?? []) : [],
      }),
      version: table.sourceVersion,
    };
  }
  if (
    item.resource?.kind === 'document' &&
    (await getDocumentRow(ctx, projectId, item.resource.id)).kind === 'sheet'
  ) {
    const table = await readResearchTable(ctx, projectId, {
      ...item,
      kind: 'table',
      payload: { kind: 'table' },
    });
    return {
      content: JSON.stringify({ kind: 'structured_table_resource', table }),
      version: table.sourceVersion,
    };
  }
  if (item.kind === 'figure')
    return {
      content: JSON.stringify({ kind: 'figure', payload: item.payload, resource: item.resource }),
      version: item.version,
    };
  const content = await fullText(ctx, projectId, recordId, item);
  if (content.text === null || !content.text.trim())
    throw new ApiError(
      'validation_failed',
      `材料「${item.title}」无法读取完整正文：${content.reason ?? '无正文'}`,
    );
  return { content: content.text, version: content.version };
}

export async function snapshotItem(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  runId: string,
  itemId: string,
  blockIds?: string[],
  keyPrefix = 'input',
): Promise<ResearchRunInputSnapshot> {
  const item = await getWorkspaceItem(ctx, projectId, recordId, itemId);
  const data = await materialize(ctx, projectId, recordId, item, blockIds);
  const fresh = await getWorkspaceItem(ctx, projectId, recordId, itemId);
  if (fresh.version !== item.version)
    throw new ApiError('conflict', `材料「${item.title}」在读取时发生变化，请重试`);
  const bindingKey = itemBindingKey(itemId, blockIds);
  const artifact = await saveArtifact(ctx, actor, projectId, recordId, {
    itemId,
    runId,
    kind: item.kind === 'action' || item.kind === 'group' ? 'resource' : item.kind,
    mime:
      item.kind === 'table' ||
      item.kind === 'draft' ||
      item.kind === 'figure' ||
      data.content.startsWith('{"kind":"structured_table_resource"')
        ? 'application/json'
        : 'text/plain; charset=utf-8',
    bytes: data.content,
    summary: `运行输入 · ${item.title}`,
    origin: 'member_report',
    metadata: { bindingKey, blockIds },
    requestKey: `${keyPrefix}:${runId}:${hash(bindingKey)}`,
  });
  return {
    item,
    content:
      data.content.length <= 200000
        ? data.content
        : `${data.content.slice(0, 20000)}\n（完整输入保存在固定产物快照中）`,
    contentVersion: data.version ?? null,
    hash: artifact.hash,
    artifact,
  };
}

export async function snapshotInputs(
  ctx: AppContext,
  actor: ActorRef,
  projectId: string,
  recordId: string,
  runId: string,
  definitions: ResearchExecutionDefinition[],
) {
  const bindings: Array<{ itemId: string; blockIds?: string[] }> = [];
  for (const definition of definitions) {
    if (definition.action.inputs !== undefined) {
      for (const input of definition.action.inputs)
        if (input.source.kind === 'item') bindings.push(input.source);
    } else for (const itemId of definition.action.inputItemIds) bindings.push({ itemId });
  }
  const unique = new Map(
    bindings.map((binding) => [itemBindingKey(binding.itemId, binding.blockIds), binding]),
  );
  return Promise.all(
    [...unique.values()].map((binding) =>
      snapshotItem(ctx, actor, projectId, recordId, runId, binding.itemId, binding.blockIds),
    ),
  );
}

export async function resolveSnapshot(
  ctx: AppContext,
  projectId: string,
  snapshots: ResearchRunInputSnapshot[],
  binding: Extract<ResearchActionInput['source'], { kind: 'item' }>,
) {
  const key = itemBindingKey(binding.itemId, binding.blockIds);
  for (const snapshot of snapshots) {
    if (snapshot.item.id !== binding.itemId) continue;
    if (!snapshot.artifact) {
      if (!binding.blockIds) return snapshot;
      continue;
    }
    const row = await getArtifact(ctx, projectId, snapshot.artifact.id);
    const metadata = row.data.metadata as { bindingKey?: string } | undefined;
    if (metadata?.bindingKey !== key) continue;
    const content = (await readArtifact(ctx, projectId, snapshot.artifact.id)).bytes.toString(
      'utf8',
    );
    return { ...snapshot, content };
  }
  throw new ApiError('validation_failed', '找不到指定输入的固定快照');
}

/** 只比较当前内容，不为过期检查或重试创建新版本。 */
export async function snapshotIsCurrent(
  ctx: AppContext,
  projectId: string,
  recordId: string,
  original: ResearchRunInputSnapshot,
) {
  const item = await getWorkspaceItem(ctx, projectId, recordId, original.item.id);
  const row = original.artifact ? await getArtifact(ctx, projectId, original.artifact.id) : null;
  const metadata = row?.data.metadata as { blockIds?: string[] } | undefined;
  const current = await materialize(ctx, projectId, recordId, item, metadata?.blockIds);
  return (
    item.version === original.item.version &&
    current.version === original.contentVersion &&
    hash(current.content) === original.hash
  );
}
