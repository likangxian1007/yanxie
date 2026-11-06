import type { ResearchItemSummary } from '@srh/shared';

/** 分组边界派生自成员布局，不改写研究者已经摆放的内容。 */
export function workspaceGroupFrames(
  items: ResearchItemSummary[],
  sizes = new Map<string, { width: number; height: number }>(),
) {
  const frames = new Map<string, { x: number; y: number; width: number; height: number }>();
  const visiting = new Set<string>();
  const build = (id: string): { x: number; y: number; width: number; height: number } | null => {
    if (frames.has(id)) return frames.get(id)!;
    if (visiting.has(id)) return null;
    visiting.add(id);
    const children = items.filter((item) => item.parentId === id);
    const boxes = children.map(
      (item) =>
        (item.kind === 'group' ? build(item.id) : null) ?? {
          ...item.position,
          width: sizes.get(item.id)?.width ?? 220,
          height: sizes.get(item.id)?.height ?? (item.previewImageFileId ? 340 : 164),
        },
    );
    visiting.delete(id);
    if (!boxes.length) return null;
    const x = Math.min(...boxes.map((box) => box.x)) - 24;
    const y = Math.min(...boxes.map((box) => box.y)) - 48;
    const frame = {
      x,
      y,
      width: Math.max(...boxes.map((box) => box.x + box.width)) - x + 24,
      height: Math.max(...boxes.map((box) => box.y + box.height)) - y + 24,
    };
    frames.set(id, frame);
    return frame;
  };
  for (const item of items) if (item.kind === 'group') build(item.id);
  return frames;
}

/** 有成员的分组使用派生边界，不再占一个空卡片位置。 */
export function workspaceAutoLayout(items: ResearchItemSummary[]) {
  const populatedGroups = new Set(items.map((item) => item.parentId).filter(Boolean));
  return items
    .filter((item) => item.kind !== 'group' || !populatedGroups.has(item.id))
    .map((item, index) => ({
      item,
      position: { x: 80 + (index % 3) * 270, y: 80 + Math.floor(index / 3) * 240 },
    }));
}
