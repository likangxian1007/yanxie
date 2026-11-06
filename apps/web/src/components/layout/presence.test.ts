import { QueryClient } from '@tanstack/react-query';
import type { PresenceState } from '@srh/shared';
import { describe, expect, it } from 'vitest';
import { presenceFromPath } from '@/lib/realtime';
import { knownResourceTitle, presenceActivity } from './presence';

const member = (view: string, objectId: string | null = 'id'): PresenceState => ({
  userId: 'other',
  name: '同事',
  avatarColor: 0,
  view,
  objectId,
  activity: 'viewing',
  lastSeenAt: '2026-10-27T00:00:00Z',
});

describe('在线位置', () => {
  it('将文献与帮助路径转换为中文位置，未知路径不暴露内部值', () => {
    expect(presenceFromPath('/p/p/library')).toEqual({ view: 'library', objectId: null });
    expect(presenceFromPath('/p/p/library/id')).toEqual({ view: 'paper', objectId: 'id' });
    expect(presenceFromPath('/p/p/help')).toEqual({ view: 'help', objectId: null });
    expect(presenceFromPath('/p/p/private/secret')).toEqual({ view: 'unknown', objectId: null });
    expect(presenceFromPath('/p/p/constructor')).toEqual({ view: 'unknown', objectId: null });
    expect(presenceActivity(member('experiment'))).toBe('在线');
    expect(presenceActivity(member('desktop'))).toBe('在线');
    expect(presenceActivity(member('private-route'))).toBe('在线');
    expect(presenceActivity(member('constructor'))).toBe('在线');
  });

  it.each([
    ['thread', ['p', 'p', 'threads', {}], '线程'],
    ['document', ['p', 'p', 'docs'], '文档'],
    ['paper', ['p', 'p', 'library', 'papers'], '论文'],
    ['notebook', ['p', 'p', 'notebooks'], 'Notebook'],
    ['review', ['p', 'p', 'reviews'], '审阅'],
    ['proposal', ['p', 'p', 'proposals'], '改动提案'],
    ['report', ['p', 'p', 'reports'], '组会汇报'],
  ])('显示已知的%s标题', (view, key, label) => {
    const qc = new QueryClient();
    const p = member(view);
    qc.setQueryData(key, [{ id: 'id', title: '研究进展' }]);
    expect(presenceActivity(p, knownResourceTitle(qc, 'p', p))).toBe(`正在看 ${label}《研究进展》`);
    expect(knownResourceTitle(qc, 'other-project', p)).toBeUndefined();
  });
});
