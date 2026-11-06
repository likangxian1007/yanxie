import type { ResearchActionInput, ResearchItemSummary } from '@srh/shared';
import { tr } from '@/lib/i18n';
export type DataConnection = {
  id: string;
  fromItemId: string;
  toItemId: string;
  outputKey?: string;
  inputName: string;
};
export function dataConnections(items: ResearchItemSummary[]): DataConnection[] {
  return items.flatMap((item) =>
    (item.actionInputs ?? [])
      .filter((input) => input.source.kind === 'item' || !input.source.artifactVersionId)
      .map((input) => ({
        id: `data:${item.id}:${encodeURIComponent(input.name)}`,
        fromItemId: input.source.kind === 'item' ? input.source.itemId : input.source.stepId,
        toItemId: item.id,
        ...(input.source.kind === 'output' ? { outputKey: input.source.outputKey } : {}),
        inputName: input.name,
      })),
  );
}
/** 自动产物按处理步骤与输出槽聚合；原始手工内容不折叠。 */
export function latestWorkspaceItems(items: ResearchItemSummary[]) {
  const newest = new Map<string, ResearchItemSummary>();
  for (const item of items) {
    if (!item.producerStepId) continue;
    const key = `${item.producerStepId}:${item.producerOutputKey ?? item.kind}`;
    const old = newest.get(key);
    if (
      !old ||
      old.createdAt < item.createdAt ||
      (old.createdAt === item.createdAt && old.id < item.id)
    )
      newest.set(key, item);
  }
  const visible = new Set([...newest.values()].map((item) => item.id));
  return items.filter((item) => !item.producerStepId || visible.has(item.id));
}
export function inputBinding(
  source: ResearchItemSummary,
  target: ResearchItemSummary,
  inputs: ResearchActionInput[],
  outputKey?: string,
): ResearchActionInput {
  if (target.kind !== 'action' || source.kind === 'group')
    throw new Error(tr('处理连接需要从内容或产物指向处理步骤。'));
  const output =
    source.kind === 'action'
      ? (source.actionOutputs?.length
          ? source.actionOutputs
          : [{ key: 'result', kind: 'note' as const }]
        ).find((entry) => entry.key === (outputKey ?? 'result'))
      : null;
  if (source.kind === 'action' && !output)
    throw new Error(tr('该输出不存在，请重新选择处理步骤的输出。'));
  const stem = source.title.slice(0, 170) || tr('输入');
  let name = stem,
    index = 2;
  while (inputs.some((input) => input.name === name)) name = `${stem} ${index++}`;
  return {
    name,
    source:
      source.kind === 'action'
        ? { kind: 'output', stepId: source.id, outputKey: outputKey ?? 'result' }
        : { kind: 'item', itemId: source.id },
  };
}
