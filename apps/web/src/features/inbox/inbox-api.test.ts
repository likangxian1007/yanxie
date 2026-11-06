import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { InboxItem } from '@srh/shared';
import { qk } from '@/lib/query-keys';
import { applyPatch, findCachedItem, placeItem, sortDone, sortPending } from './inbox-api';

const PID = 'prj_1';

function item(
  id: string,
  kind: InboxItem['kind'],
  createdAt: string,
  extra: Partial<InboxItem> = {},
): InboxItem {
  return {
    id,
    projectId: PID,
    userId: 'usr_1',
    kind,
    title: id,
    href: `/p/${PID}/threads/${id}`,
    sourceId: `src_${id}`,
    readAt: null,
    doneAt: null,
    createdAt,
    ...extra,
  };
}

describe('sortPending', () => {
  it('按优先级排序，同级按时间新到旧', () => {
    const list = [
      item('m', 'mention', '2026-10-26T10:00:00Z'),
      item('d1', 'decision', '2026-10-26T08:00:00Z'),
      item('d2', 'decision', '2026-10-26T09:00:00Z'),
      item('c', 'conflict', '2026-10-26T11:00:00Z'),
      item('r', 'review', '2026-10-25T11:00:00Z'),
    ];
    expect(sortPending(list).map((x) => x.id)).toEqual(['d2', 'd1', 'r', 'c', 'm']);
  });
});

describe('sortDone', () => {
  it('最近完成的在前', () => {
    const list = [
      item('a', 'decision', '2026-10-26T08:00:00Z', { doneAt: '2026-10-26T09:00:00Z' }),
      item('b', 'finished', '2026-10-26T07:00:00Z', { doneAt: '2026-10-26T12:00:00Z' }),
    ];
    expect(sortDone(list).map((x) => x.id)).toEqual(['b', 'a']);
  });
});

describe('applyPatch', () => {
  const now = '2026-10-26T12:00:00.000Z';
  it('标为完成同时视为已读，移回待处理清掉 doneAt', () => {
    const done = applyPatch(item('a', 'review', now), { done: true }, now);
    expect(done.doneAt).toBe(now);
    expect(done.readAt).toBe(now);
    expect(applyPatch(done, { done: false }, now).doneAt).toBeNull();
  });
  it('标为未读清掉 readAt', () => {
    const read = item('a', 'review', now, { readAt: now });
    expect(applyPatch(read, { read: false }, now).readAt).toBeNull();
  });
});

describe('placeItem', () => {
  it('按 doneAt 在两份缓存之间移动条目，未加载的列表不动', () => {
    const qc = new QueryClient();
    const a = item('a', 'decision', '2026-10-26T08:00:00Z');
    const b = item('b', 'mention', '2026-10-26T09:00:00Z');
    qc.setQueryData(qk.inbox(PID, false), [a, b]);

    const doneA = { ...a, doneAt: '2026-10-26T10:00:00Z' };
    placeItem(qc, PID, doneA);
    expect(qc.getQueryData<InboxItem[]>(qk.inbox(PID, false))?.map((x) => x.id)).toEqual(['b']);
    expect(qc.getQueryData(qk.inbox(PID, true))).toBeUndefined();

    qc.setQueryData(qk.inbox(PID, true), [doneA]);
    placeItem(qc, PID, a);
    expect(qc.getQueryData<InboxItem[]>(qk.inbox(PID, false))?.map((x) => x.id)).toEqual([
      'a',
      'b',
    ]);
    expect(qc.getQueryData<InboxItem[]>(qk.inbox(PID, true))).toEqual([]);
    expect(findCachedItem(qc, PID, 'a')).toEqual(a);
  });
});
