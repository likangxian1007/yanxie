import type {
  ResearchAction,
  ResearchCellValue,
  ResearchItem,
  ResearchRunOutput,
  ResearchTableColumn,
} from '@srh/shared';
import { tr } from '@/lib/i18n';

/** 新式具名绑定为真相源；旧操作只在没有 inputs 时使用 inputItemIds。 */
export function itemInputIds(action: ResearchAction): string[] {
  if (action.inputs !== undefined)
    return action.inputs.flatMap((input) =>
      input.source.kind === 'item' ? [input.source.itemId] : [],
    );
  return action.inputItemIds;
}

export function outputDependencies(action: ResearchAction): string[] {
  return [
    ...new Set(
      (action.inputs ?? []).flatMap((input) =>
        input.source.kind === 'output' && !input.source.artifactVersionId
          ? [input.source.stepId]
          : [],
      ),
    ),
  ];
}

export function flowDefinitions(
  selected: string[],
  loaded: ResearchItem[],
  manual: Record<string, string[]>,
) {
  return selected.map((itemId) => {
    const item = loaded.find((entry) => entry.id === itemId);
    const automatic = item?.action ? outputDependencies(item.action) : [];
    return {
      itemId,
      dependsOn: [...new Set([...(manual[itemId] ?? []), ...automatic])].filter((id) =>
        selected.includes(id),
      ),
    };
  });
}

/** 仅由未固定的处理连接扩展流程；普通关联不会成为执行依赖。 */
export function connectedFlow(selected: string[], actions: ResearchItem[]): string[] {
  const connected = new Set(selected);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of actions) {
      const deps = item.action ? outputDependencies(item.action) : [];
      if (connected.has(item.id) || deps.some((id) => connected.has(id))) {
        for (const id of [item.id, ...deps]) {
          if (!connected.has(id) && actions.some((entry) => entry.id === id)) {
            connected.add(id);
            changed = true;
          }
        }
      }
    }
  }
  return actions.filter((item) => connected.has(item.id)).map((item) => item.id);
}

/** 依据列类型解释筛选输入，空值仍保持空字符串而不是补零。 */
export function filterValue(text: string, type: ResearchTableColumn['type']): ResearchCellValue {
  if (type === 'number' && text.trim() && Number.isFinite(Number(text))) return Number(text);
  if (type === 'boolean' && text.trim().toLowerCase() === 'true') return true;
  if (type === 'boolean' && text.trim().toLowerCase() === 'false') return false;
  return text;
}

/** 固定表格的字节用于追溯，运行摘要不把整份 JSON 当正文展示。 */
export function outputSummary(output: ResearchRunOutput): string {
  if (output.artifact?.kind !== 'table' || !output.content.trimStart().startsWith('{'))
    return output.content;
  try {
    const value: unknown = JSON.parse(output.content);
    if (value && typeof value === 'object') {
      const table = value as { totalRows?: unknown; columns?: unknown };
      if (typeof table.totalRows === 'number' && Array.isArray(table.columns))
        return tr('已固定 {totalRows} 行、{count} 列的表格版本。打开结果查看数据与依据。', {
          totalRows: table.totalRows,
          count: table.columns.length,
        });
    }
  } catch {
    /* 大型输入可能只保留摘要，固定快照仍可单独读取。 */
  }
  return tr('已固定表格版本。打开结果查看数据与依据。');
}
