import type { ResearchAction, ResearchItem, ResearchItemPayload } from '@srh/shared';
import { tr } from '@/lib/i18n';

export type ItemDraft = {
  title: string;
  body: string;
  action: ResearchAction | null;
  payload?: ResearchItemPayload | null;
};
export type StoredItemDraft = {
  base: ResearchItem;
  draft: ItemDraft;
  dirty: boolean;
  backup?: ItemDraft;
};
export const itemDraft = (item: ResearchItem): ItemDraft => ({
  title: item.title,
  body: item.body,
  action: item.action ? structuredClone(item.action) : null,
  payload: item.payload ? structuredClone(item.payload) : null,
});

/** 冲突比较需要展示结构化内容，而非只比较笔记正文。 */
export function itemDraftText(draft: ItemDraft): string {
  const payload = draft.payload;
  if (payload?.kind === 'draft')
    return payload.blocks
      .map((block, index) => {
        const text =
          block.kind === 'text'
            ? block.text
            : block.kind === 'resource'
              ? `${block.resource.kind} · ${block.resource.id}`
              : tr('摘录 · {excerptId}', { excerptId: block.excerptId });
        return `${index + 1}. ${text}`;
      })
      .join('\n');
  if (payload?.kind === 'table')
    return (payload.columns ?? [])
      .map(
        (column) =>
          `${column.name} · ${column.type ?? 'text'}${column.unit ? ` · ${column.unit}` : ''}${column.description ? ` · ${column.description}` : ''}${column.missingValues?.length ? tr(' · 缺失值：{missingValues}', { missingValues: column.missingValues.join(tr('、')) }) : ''}`,
      )
      .join('\n');
  if (payload?.kind === 'figure') return payload.caption ?? '';
  return draft.body || draft.action?.instructions || '';
}

/** 未保存草稿永远不被刷新覆盖；版本不同交由使用者比较。 */
export function restoreItemDraft(server: ResearchItem, stored: StoredItemDraft | null) {
  if (!stored?.dirty)
    return { base: server, draft: itemDraft(server), dirty: false, conflict: null };
  return {
    base: stored.base,
    draft: stored.draft,
    dirty: true,
    conflict: stored.base.version === server.version ? null : server,
  };
}
export function draftKey(user: string, project: string, record: string, item: string) {
  return `srh:research-draft:${user}:${project}:${record}:${item}`;
}
