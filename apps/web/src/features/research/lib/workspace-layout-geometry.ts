import type { ResearchItemSummary, ResearchPosition } from '@srh/shared';

/** 选择分组时包含所有层级的成员，已单独选中的成员不会重复移动。 */
export function workspaceMoveIds(items: ResearchItemSummary[], selected: string[]): Set<string> {
  const ids = new Set(selected);
  const groups = new Set(items.filter((item) => item.kind === 'group').map((item) => item.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (
        item.parentId &&
        ids.has(item.parentId) &&
        groups.has(item.parentId) &&
        !ids.has(item.id)
      ) {
        ids.add(item.id);
        changed = true;
      }
    }
  }
  return ids;
}

export function translatedPositions(
  initial: Map<string, ResearchPosition>,
  dx: number,
  dy: number,
): Map<string, ResearchPosition> {
  return new Map(
    [...initial].map(([id, position]) => [id, { x: position.x + dx, y: position.y + dy }]),
  );
}

/** 添加 source → target 后若 target 已能到达 source，就会形成环。 */
export function workspaceDataWouldCycle(
  connections: { fromItemId: string; toItemId: string }[],
  source: string,
  target: string,
): boolean {
  if (source === target) return true;
  const visited = new Set<string>();
  const todo = [target];
  while (todo.length) {
    const current = todo.pop()!;
    if (current === source) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of connections) if (edge.fromItemId === current) todo.push(edge.toItemId);
  }
  return false;
}
