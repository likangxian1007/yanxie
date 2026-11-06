import { expect, it } from 'vitest';
import type { ResearchItemSummary } from '@srh/shared';
import { workspaceAutoLayout, workspaceGroupFrames } from './workspace-graph';

it('分组包围原布局中的成员与嵌套分组，不修改任何原坐标', () => {
  const items = [
    { id: 'g1', kind: 'group', parentId: null, position: { x: 0, y: 0 } },
    { id: 'g2', kind: 'group', parentId: 'g1', position: { x: 500, y: 500 } },
    { id: 'n1', kind: 'note', parentId: 'g2', position: { x: 120, y: 160 } },
    { id: 'n2', kind: 'resource', parentId: 'g1', position: { x: -80, y: 80 } },
  ] as ResearchItemSummary[];
  const before = structuredClone(items);
  const frames = workspaceGroupFrames(items);
  const inner = frames.get('g2')!;
  const outer = frames.get('g1')!;
  expect(inner.x).toBeLessThan(120);
  expect(inner.x + inner.width).toBeGreaterThan(340);
  expect(outer.x).toBeLessThan(-80);
  expect(outer.x + outer.width).toBeGreaterThan(inner.x + inner.width);
  expect(outer.y + outer.height).toBeGreaterThan(inner.y + inner.height);
  expect(items).toEqual(before);
});

it('整理布局为内容和分组边界留出间距，已展开分组不再占空位置', () => {
  const items = [
    { id: 'g', kind: 'group', parentId: null, position: { x: 0, y: 0 } },
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `n${i}`,
      kind: 'note',
      parentId: i < 2 ? 'g' : null,
      position: { x: 0, y: 0 },
    })),
  ] as ResearchItemSummary[];
  const layout = workspaceAutoLayout(items);
  expect(layout.map(({ item }) => item.id)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
  const arranged = layout.map(({ item, position }) => ({ ...item, position }));
  const frame = workspaceGroupFrames([items[0]!, ...arranged]).get('g')!;
  expect(frame.y + frame.height).toBeLessThan(arranged[3]!.position.y);
  expect(items[1]!.position).toEqual({ x: 0, y: 0 });
});

it('分组边界包含实际测量的图像卡片', () => {
  const items = [
    { id: 'g', kind: 'group', parentId: null, position: { x: 0, y: 0 } },
    { id: 'f', kind: 'figure', parentId: 'g', position: { x: 10, y: 20 } },
  ] as ResearchItemSummary[];
  const frame = workspaceGroupFrames(items, new Map([['f', { width: 220, height: 320 }]])).get(
    'g',
  )!;
  expect(frame.y + frame.height).toBeGreaterThanOrEqual(340);
});
