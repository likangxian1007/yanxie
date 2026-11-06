import type { BoardColumn, Card } from '@srh/shared';
import { describe, expect, it } from 'vitest';
import {
  groupCards,
  moveCard,
  moveCardAfter,
  removeColumn,
  sortBoards,
  upsertCard,
  type BoardDetail,
} from './board-state';
import { dueBucket, formatDue, fromDateInputValue, isOverdue, toDateInputValue } from './due';
import {
  EMPTY_FILTER,
  collectLabels,
  filterCards,
  isFilterActive,
  matchesCardFilter,
  normalizeLabel,
} from './filter';
import { generateKeyBetween } from 'fractional-indexing';
import { comparePosition, isValidPosition, positionBetween, sortByPosition } from './position';

function col(id: string, position: string): BoardColumn {
  return { id, boardId: 'brd_1', name: id, position, color: null };
}

function card(id: string, columnId: string, position: string, extra: Partial<Card> = {}): Card {
  return {
    id,
    boardId: 'brd_1',
    columnId,
    title: `卡片 ${id}`,
    description: '',
    position,
    assigneeIds: [],
    labels: [],
    dueAt: null,
    threadId: null,
    experimentId: null,
    version: 1,
    createdBy: { kind: 'user', id: 'usr_a', name: '张三' },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  };
}

describe('position', () => {
  /** 服务端 checkPosition 的同款校验：generateKeyBetween(position, null) 不抛错 */
  const serverAccepts = (p: string) => {
    try {
      generateKeyBetween(p, null);
      return true;
    } catch {
      return false;
    }
  };

  it('positionBetween 严格落在两者之间，且结果能通过服务端校验', () => {
    const pairs: [string | null, string | null][] = [
      [null, null],
      ['a0', null],
      [null, 'a0'],
      ['a0', 'a1'],
      ['a3', null],
      ['a0V', 'a0W'],
      ['Zz', 'a0'],
      ['a0', 'a0V'],
    ];
    for (const [a, b] of pairs) {
      const p = positionBetween(a, b);
      if (a !== null) expect(p > a, `${a} < ${p}`).toBe(true);
      if (b !== null) expect(p < b, `${p} < ${b}`).toBe(true);
      expect(serverAccepts(p), `服务端接受 ${p}`).toBe(true);
    }
  });

  it('与服务端算法逐个一致（默认四列 a0..a3 之后是 a4）', () => {
    expect(positionBetween('a3', null)).toBe(generateKeyBetween('a3', null));
    expect(positionBetween('a3', null)).toBe('a4');
    expect(positionBetween(null, null)).toBe('a0');
    expect(positionBetween(null, 'a0')).toBe(generateKeyBetween(null, 'a0'));
    expect(positionBetween('a1', 'a2')).toBe(generateKeyBetween('a1', 'a2'));
  });

  it('连续在末尾追加、在开头插入、反复对半插入都保持有序且合法', () => {
    let last: string | null = null;
    for (let i = 0; i < 50; i += 1) {
      const next = positionBetween(last, null);
      if (last !== null) expect(next > last).toBe(true);
      expect(serverAccepts(next)).toBe(true);
      last = next;
    }
    let first: string | null = null;
    for (let i = 0; i < 50; i += 1) {
      const next = positionBetween(null, first);
      if (first !== null) expect(next < first).toBe(true);
      expect(serverAccepts(next)).toBe(true);
      first = next;
    }
    let lo = 'a0';
    const hi = 'a1';
    for (let i = 0; i < 40; i += 1) {
      const mid = positionBetween(lo, hi);
      expect(mid > lo && mid < hi).toBe(true);
      expect(serverAccepts(mid)).toBe(true);
      lo = mid;
    }
  });

  it('输入不合法时退化为合法位置（不抛错）', () => {
    expect(serverAccepts(positionBetween('n', null))).toBe(true);
    expect(positionBetween('a1', 'a0') > 'a1').toBe(true);
    expect(positionBetween('n', 'a0') < 'a0').toBe(true);
    expect(isValidPosition('n')).toBe(false);
    expect(isValidPosition('a4')).toBe(true);
  });

  it('按位置排序，位置相同按 id', () => {
    const items = [
      { id: 'b', position: 'a1' },
      { id: 'a', position: 'a1' },
      { id: 'c', position: 'a0' },
    ];
    expect(sortByPosition(items).map((i) => i.id)).toEqual(['c', 'a', 'b']);
    expect(comparePosition(items[0]!, items[0]!)).toBe(0);
  });
});

describe('board-state', () => {
  const columns = [col('todo', 'a1'), col('doing', 'a2')];
  const cards = [
    card('c1', 'todo', 'a1'),
    card('c2', 'todo', 'a2'),
    card('c3', 'todo', 'a3'),
    card('d1', 'doing', 'a1'),
  ];

  it('groupCards 每列都有条目并按位置排序', () => {
    const map = groupCards([...cards].reverse(), columns);
    expect(map.get('todo')?.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(map.get('doing')?.map((c) => c.id)).toEqual(['d1']);
    expect(groupCards([], columns).get('doing')).toEqual([]);
  });

  it('列内下移：afterCardId 为新位置的前一张', () => {
    const move = moveCard(cards, 'c1', 'todo', 2)!;
    expect(move.changed).toBe(true);
    expect(move.afterCardId).toBe('c3');
    expect(
      groupCards(move.cards, columns)
        .get('todo')
        ?.map((c) => c.id),
    ).toEqual(['c2', 'c3', 'c1']);
  });

  it('移到列首：afterCardId = null', () => {
    const move = moveCard(cards, 'c3', 'todo', 0)!;
    expect(move.afterCardId).toBeNull();
    expect(
      groupCards(move.cards, columns)
        .get('todo')
        ?.map((c) => c.id),
    ).toEqual(['c3', 'c1', 'c2']);
  });

  it('跨列移动并插到中间', () => {
    const move = moveCard(cards, 'c2', 'doing', 1)!;
    expect(move.afterCardId).toBe('d1');
    const grouped = groupCards(move.cards, columns);
    expect(grouped.get('todo')?.map((c) => c.id)).toEqual(['c1', 'c3']);
    expect(grouped.get('doing')?.map((c) => c.id)).toEqual(['d1', 'c2']);
  });

  it('moveCardAfter：按服务端语义插在某张卡之后', () => {
    const toTop = moveCardAfter(cards, 'c3', 'todo', null)!;
    expect(
      groupCards(toTop.cards, columns)
        .get('todo')
        ?.map((c) => c.id),
    ).toEqual(['c3', 'c1', 'c2']);
    const across = moveCardAfter(cards, 'd1', 'todo', 'c1')!;
    expect(across.afterCardId).toBe('c1');
    expect(
      groupCards(across.cards, columns)
        .get('todo')
        ?.map((c) => c.id),
    ).toEqual(['c1', 'd1', 'c2', 'c3']);
    const unknown = moveCardAfter(cards, 'c1', 'doing', 'nope')!;
    expect(
      groupCards(unknown.cards, columns)
        .get('doing')
        ?.map((c) => c.id),
    ).toEqual(['d1', 'c1']);
  });

  it('原地放下不算改动；不存在的卡返回 null', () => {
    expect(moveCard(cards, 'c2', 'todo', 1)?.changed).toBe(false);
    expect(moveCard(cards, 'nope', 'todo', 0)).toBeNull();
  });

  it('upsertCard 忽略过期版本', () => {
    const detail: BoardDetail = {
      id: 'brd_1',
      projectId: 'prj',
      name: '看板',
      columns,
      cards: [card('c1', 'todo', 'a1', { version: 3, title: '新' })],
      createdAt: '2026-10-01T00:00:00.000Z',
    };
    expect(
      upsertCard(detail, card('c1', 'todo', 'a1', { version: 2, title: '旧' })).cards[0]?.title,
    ).toBe('新');
    expect(
      upsertCard(detail, card('c1', 'todo', 'a1', { version: 4, title: '更新' })).cards[0]?.title,
    ).toBe('更新');
    expect(upsertCard(detail, card('c9', 'todo', 'a9')).cards).toHaveLength(2);
    expect(upsertCard(detail, { ...card('x', 'todo', 'a'), boardId: 'other' })).toBe(detail);
  });

  it('removeColumn 带 moveTo 时把卡片挪到目标列末尾', () => {
    const detail: BoardDetail = {
      id: 'brd_1',
      projectId: 'prj',
      name: '看板',
      columns,
      cards,
      createdAt: '2026-10-01T00:00:00.000Z',
    };
    const moved = removeColumn(detail, 'todo', 'doing');
    expect(moved.columns.map((c) => c.id)).toEqual(['doing']);
    expect(
      groupCards(moved.cards, moved.columns)
        .get('doing')
        ?.map((c) => c.id),
    ).toEqual(['d1', 'c1', 'c2', 'c3']);
    expect(removeColumn(detail, 'todo').cards.map((c) => c.id)).toEqual(['d1']);
  });

  it('看板按创建时间排序', () => {
    const b = (id: string, createdAt: string) => ({
      id,
      projectId: 'p',
      name: id,
      columns: [],
      createdAt,
    });
    expect(sortBoards([b('2', '2026-10-02'), b('1', '2026-10-01')]).map((x) => x.id)).toEqual([
      '1',
      '2',
    ]);
  });
});

describe('filter', () => {
  const list = [
    card('a', 'todo', 'a1', { title: '复现 Baseline', assigneeIds: ['usr_me'], labels: ['实验'] }),
    card('b', 'todo', 'a2', {
      title: '写引言',
      assigneeIds: ['agent:thr_1'],
      labels: ['论文', '实验'],
    }),
    card('c', 'todo', 'a3', { title: '整理数据' }),
  ];

  it('空筛选返回全部', () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(filterCards(list, EMPTY_FILTER, 'usr_me')).toHaveLength(3);
  });

  it('标题搜索不区分大小写', () => {
    expect(
      filterCards(list, { ...EMPTY_FILTER, query: 'baseline' }, null).map((c) => c.id),
    ).toEqual(['a']);
  });

  it('按指派：我的 / agent / 未指派 / 具体对象', () => {
    const ids = (assignee: string, me: string | null = 'usr_me') =>
      filterCards(list, { ...EMPTY_FILTER, assignee }, me).map((c) => c.id);
    expect(ids('me')).toEqual(['a']);
    expect(ids('me', null)).toEqual([]);
    expect(ids('agents')).toEqual(['b']);
    expect(ids('none')).toEqual(['c']);
    expect(ids('agent:thr_1')).toEqual(['b']);
  });

  it('按标签，并能与搜索组合', () => {
    expect(filterCards(list, { ...EMPTY_FILTER, label: '实验' }, null).map((c) => c.id)).toEqual([
      'a',
      'b',
    ]);
    expect(matchesCardFilter(list[1]!, { query: '引言', assignee: '', label: '实验' }, null)).toBe(
      true,
    );
    expect(matchesCardFilter(list[1]!, { query: '数据', assignee: '', label: '实验' }, null)).toBe(
      false,
    );
  });

  it('标签按使用次数排序；新标签规整', () => {
    expect(collectLabels(list)).toEqual(['实验', '论文']);
    expect(normalizeLabel('  深度  学习 ')).toBe('深度 学习');
    expect(normalizeLabel('   ')).toBeNull();
    expect(normalizeLabel('一二三四五六七八九十一二三四五六七八九十多出来')).toHaveLength(20);
  });
});

describe('due', () => {
  const now = new Date(2026, 9, 26, 15, 0); // 2026-10-26 周一

  it('日期输入框往返', () => {
    const iso = fromDateInputValue('2026-10-28');
    expect(iso).not.toBeNull();
    expect(toDateInputValue(iso)).toBe('2026-10-28');
    expect(fromDateInputValue('')).toBeNull();
    expect(toDateInputValue(null)).toBe('');
  });

  it('过期 = 截止日早于今天', () => {
    expect(isOverdue(fromDateInputValue('2026-10-25'), now)).toBe(true);
    expect(isOverdue(fromDateInputValue('2026-10-26'), now)).toBe(false);
    expect(isOverdue(null, now)).toBe(false);
  });

  it('中文展示', () => {
    expect(formatDue(fromDateInputValue('2026-10-26'), now)).toBe('今天');
    expect(formatDue(fromDateInputValue('2026-10-27'), now)).toBe('明天');
    expect(formatDue(fromDateInputValue('2026-10-25'), now)).toBe('昨天');
    expect(formatDue(fromDateInputValue('2026-11-03'), now)).toBe('11月3日');
    expect(formatDue(fromDateInputValue('2027-01-03'), now)).toBe('2027年1月3日');
  });

  it('分桶：已过期 / 今天 / 本周 / 以后 / 无日期', () => {
    expect(dueBucket(fromDateInputValue('2026-10-20'), now)).toBe('overdue');
    expect(dueBucket(fromDateInputValue('2026-10-26'), now)).toBe('today');
    expect(dueBucket(fromDateInputValue('2026-11-01'), now)).toBe('week');
    expect(dueBucket(fromDateInputValue('2026-11-02'), now)).toBe('later');
    expect(dueBucket(null, now)).toBe('none');
    // 周日：本周只剩今天
    const sunday = new Date(2026, 10, 1, 9, 0);
    expect(dueBucket(fromDateInputValue('2026-11-02'), sunday)).toBe('later');
  });
});
