import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { Thread } from '@srh/shared';
import { removeThread } from '@/lib/apply-event';
import { qk } from '@/lib/query-keys';
import { collectLabels, groupByLabel, matchesLabel, threadsInBucket } from './thread-utils';

function t(id: string, label: string | null, extra: Partial<Thread> = {}): Thread {
  return {
    id,
    projectId: 'prj_1',
    kind: 'project',
    rootMessageId: `msg_${id}`,
    title: id,
    label,
    ownerUserId: 'usr_1',
    statusBucket: 'working',
    statusText: '',
    resolved: false,
    replyCount: 0,
    forwardedAt: null,
    agentSessionId: null,
    lastActivityAt: '2026-10-26T10:00:00Z',
    createdAt: '2026-10-26T10:00:00Z',
    ...extra,
  };
}

describe('标签', () => {
  const list = [t('a', '实验'), t('b', '文献'), t('c', '实验'), t('d', null), t('e', '写作')];

  it('collectLabels 按使用次数排，同次数按名字', () => {
    // 实验 2 次排第一；文献、写作各 1 次按名字排
    expect(collectLabels(list)).toEqual([
      '实验',
      ...['文献', '写作'].sort((x, y) => x.localeCompare(y, 'zh-CN')),
    ]);
    expect(collectLabels(list)[0]).toBe('实验');
  });

  it('groupByLabel 组内保持原顺序，未加标签的放最后', () => {
    const groups = groupByLabel(list);
    expect(groups[0]).toEqual({ label: '实验', items: [list[0], list[2]] });
    expect(groups.at(-1)).toEqual({ label: null, items: [list[3]] });
    expect(groups.flatMap((g) => g.items)).toHaveLength(list.length);
  });

  it("matchesLabel：undefined 不筛，'' 只要没有标签的", () => {
    expect(list.filter((x) => matchesLabel(x, undefined))).toHaveLength(5);
    expect(list.filter((x) => matchesLabel(x, '')).map((x) => x.id)).toEqual(['d']);
    expect(list.filter((x) => matchesLabel(x, '实验')).map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('threadsInBucket 带上标签筛选', () => {
    const out = threadsInBucket(list, 'all', { query: '', showResolved: false, label: '文献' });
    expect(out.map((x) => x.id)).toEqual(['b']);
  });
});

describe('removeThread', () => {
  it('从所有线程列表缓存里拿掉，并清掉详情缓存', () => {
    const qc = new QueryClient();
    const pid = 'prj_1';
    const a = t('a', null, { kind: 'personal' });
    const b = t('b', null, { kind: 'personal' });
    qc.setQueryData(qk.threads(pid, { kind: 'personal' }), [a, b]);
    qc.setQueryData(qk.threads(pid, {}), [b]);
    qc.setQueryData(qk.thread(pid, 'a'), a);
    removeThread(qc, pid, 'a');
    expect(qc.getQueryData<Thread[]>(qk.threads(pid, { kind: 'personal' }))).toEqual([b]);
    expect(qc.getQueryData<Thread[]>(qk.threads(pid, {}))).toEqual([b]);
    expect(qc.getQueryData(qk.thread(pid, 'a'))).toBeUndefined();
  });
});
