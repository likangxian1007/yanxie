import { expect, it, vi } from 'vitest';
import type { ResearchItem, ResearchItemSummary, ResearchLayoutUpdateInput } from '@srh/shared';
import { WorkspaceLayoutCoordinator } from './workspace-layout';
import { workspaceDataWouldCycle, workspaceMoveIds } from './workspace-layout-geometry';

const actor = { kind: 'user' as const, id: 'u', name: '研究者' };
function item(id: string, positionVersion = 1, x = 0): ResearchItem {
  return {
    id,
    projectId: 'p',
    recordId: 'r',
    kind: 'note',
    title: id,
    body: '',
    resource: null,
    evidenceRef: null,
    action: null,
    origin: null,
    parentId: null,
    position: { x, y: 0 },
    version: 1,
    positionVersion,
    createdBy: actor,
    updatedBy: actor,
    createdAt: '',
    updatedAt: '',
    archivedAt: null,
  };
}
function summary(value: ResearchItem): ResearchItemSummary {
  const { body: _body, action: _action, origin: _origin, ...rest } = value;
  return { ...rest, originItemId: null, actionKind: null, preview: '' };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const displayed = (queue: WorkspaceLayoutCoordinator, id = 'a') =>
  queue.getSnapshot().items.find((entry) => entry.id === id)!.position.x;

it('延迟响应及旧事件不能回弹，连续移动按节点串行并合并最新位置', async () => {
  const first = deferred<{ items: ResearchItem[] }>();
  const second = deferred<{ items: ResearchItem[] }>();
  const save = vi
    .fn<(input: ResearchLayoutUpdateInput) => Promise<{ items: ResearchItem[] }>>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const queue = new WorkspaceLayoutCoordinator([summary(item('a'))], save);
  queue.moveMany([{ id: 'a', position: { x: 10, y: 0 } }]);
  queue.moveMany([{ id: 'a', position: { x: 20, y: 0 } }]);
  queue.moveMany([{ id: 'a', position: { x: 30, y: 0 } }]);
  expect(save).toHaveBeenCalledTimes(1);
  queue.ingest([summary({ ...item('a'), title: '刷新后的正文', version: 2 })]);
  expect(displayed(queue)).toBe(30);
  first.resolve({ items: [item('a', 2, 10)] });
  await tick();
  expect(displayed(queue)).toBe(30);
  expect(queue.getSnapshot().items[0]?.title).toBe('刷新后的正文');
  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[1]![0].moves).toEqual([
    { itemId: 'a', basePositionVersion: 2, position: { x: 30, y: 0 } },
  ]);
  queue.ingest([summary(item('a', 1, 0))]);
  expect(displayed(queue)).toBe(30);
  second.resolve({ items: [item('a', 3, 30)] });
  await tick();
  expect(displayed(queue)).toBe(30);
  expect(queue.getSnapshot().saving).toBe(false);
});

it('失败保留本地布局；重试使用同一幂等键，其他无关移动不等待', async () => {
  const first = deferred<{ items: ResearchItem[] }>();
  const save = vi
    .fn<(input: ResearchLayoutUpdateInput) => Promise<{ items: ResearchItem[] }>>()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({ items: [item('b', 2, 50)] })
    .mockResolvedValueOnce({ items: [item('a', 2, 20)] });
  const queue = new WorkspaceLayoutCoordinator([summary(item('a')), summary(item('b'))], save);
  queue.moveMany([{ id: 'a', position: { x: 20, y: 0 } }]);
  queue.moveMany([{ id: 'b', position: { x: 50, y: 0 } }]);
  expect(save).toHaveBeenCalledTimes(2);
  first.reject(new Error('网络中断'));
  await tick();
  expect(displayed(queue)).toBe(20);
  const issue = queue.getSnapshot().issues[0]!;
  expect(issue.status).toBe('error');
  queue.retry(issue.id);
  await tick();
  expect(save.mock.calls[2]![0]).toEqual(save.mock.calls[0]![0]);
  expect(queue.getSnapshot().issues).toEqual([]);
});

it('批量冲突展示双方位置，只有显式选择后才继续', async () => {
  const save = vi
    .fn<(input: ResearchLayoutUpdateInput) => Promise<{ items: ResearchItem[] }>>()
    .mockRejectedValueOnce({
      code: 'version_conflict',
      details: { current: [item('a', 2, 100), item('b', 1, 0)] },
    })
    .mockResolvedValueOnce({ items: [item('a', 3, 20), item('b', 2, 40)] });
  const onSaved = vi.fn();
  const queue = new WorkspaceLayoutCoordinator(
    [summary(item('a')), summary(item('b'))],
    save,
    onSaved,
  );
  queue.moveMany([
    { id: 'a', position: { x: 20, y: 0 } },
    { id: 'b', position: { x: 40, y: 0 } },
  ]);
  await tick();
  const issue = queue.getSnapshot().issues[0]!;
  expect(issue.status).toBe('conflict');
  expect(issue.positions[0]).toMatchObject({ local: { x: 20, y: 0 }, remote: { x: 100, y: 0 } });
  expect(displayed(queue)).toBe(20);
  expect(save).toHaveBeenCalledTimes(1);
  queue.resolveMine(issue.id);
  await tick();
  expect(save.mock.calls[1]![0].moves[0]?.basePositionVersion).toBe(2);
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(queue.getSnapshot().issues).toEqual([]);
});

it('拖动嵌套分组时每个条目只加入一次', () => {
  const rows = [
    { ...summary(item('g1')), kind: 'group' as const },
    { ...summary(item('g2')), kind: 'group' as const, parentId: 'g1' },
    { ...summary(item('a')), parentId: 'g2' },
    { ...summary(item('b')), parentId: 'g1' },
  ];
  expect([...workspaceMoveIds(rows, ['g1', 'g2', 'a'])].sort()).toEqual(['a', 'b', 'g1', 'g2']);
});

it('数据连接允许分支与汇合，拒绝自环和已有路径的逆向连接', () => {
  const connections = [
    { fromItemId: 'a', toItemId: 'b' },
    { fromItemId: 'a', toItemId: 'c' },
    { fromItemId: 'b', toItemId: 'd' },
    { fromItemId: 'c', toItemId: 'd' },
  ];
  expect(workspaceDataWouldCycle(connections, 'd', 'a')).toBe(true);
  expect(workspaceDataWouldCycle(connections, 'b', 'b')).toBe(true);
  expect(workspaceDataWouldCycle(connections, 'a', 'd')).toBe(false);
});
