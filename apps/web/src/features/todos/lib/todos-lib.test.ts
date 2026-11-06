import type { Todo } from '@srh/shared';
import { describe, expect, it } from 'vitest';
import { fromDateInputValue } from '@/features/board/lib/due';
import { parseQuickAdd, stripPendingMention } from './quick-add';
import {
  activeTodos,
  completedTodos,
  groupByDue,
  isVisibleTo,
  mergeTodos,
  moveTodoAfter,
  removeTodo,
  upsertTodo,
} from './todo-list';

function todo(id: string, position: string, extra: Partial<Todo> = {}): Todo {
  return {
    id,
    projectId: 'prj',
    ownerUserId: null,
    assigneeId: null,
    title: `待办 ${id}`,
    notes: '',
    done: false,
    priority: 'normal',
    dueAt: null,
    position,
    source: null,
    createdBy: { kind: 'user', id: 'usr_a', name: '张三' },
    createdAt: '2026-10-01T00:00:00.000Z',
    completedAt: null,
    ...extra,
  };
}

describe('stripPendingMention', () => {
  it('选好指派后去掉末尾正在输入的 @ 标记（含已输入的名字片段）', () => {
    expect(stripPendingMention('整理 miniImageNet 数据划分 !高 @王')).toBe(
      '整理 miniImageNet 数据划分 !高',
    );
    expect(stripPendingMention('写引言 @')).toBe('写引言');
    expect(stripPendingMention('@王')).toBe('');
    expect(parseQuickAdd(stripPendingMention('整理数据 !高 @王')).title).toBe('整理数据');
  });

  it('不动正文中间的 @ 和邮箱', () => {
    expect(stripPendingMention('联系 a@b.com')).toBe('联系 a@b.com');
    expect(stripPendingMention('@张三 写引言')).toBe('@张三 写引言');
  });
});

describe('parseQuickAdd', () => {
  const people = [
    { value: 'usr_a', label: '张三' },
    { value: 'agent:thr_1', label: '调研 扩散模型' },
    { value: 'usr_long', label: '张三丰' },
  ];

  it('没有标记时原样返回（去掉多余空白）', () => {
    expect(parseQuickAdd('  整理  实验数据 ')).toEqual({
      title: '整理 实验数据',
      priority: null,
      assigneeId: null,
    });
  });

  it('识别优先级：!高 / !! / !!! / !紧急 / !低，含全角', () => {
    expect(parseQuickAdd('写引言 !高')).toMatchObject({ title: '写引言', priority: 'high' });
    expect(parseQuickAdd('!! 写引言')).toMatchObject({ title: '写引言', priority: 'high' });
    expect(parseQuickAdd('写引言 !!!')).toMatchObject({ priority: 'urgent' });
    expect(parseQuickAdd('写引言 ！紧急')).toMatchObject({ title: '写引言', priority: 'urgent' });
    expect(parseQuickAdd('写引言 !low')).toMatchObject({ priority: 'low' });
    expect(parseQuickAdd('写引言 !低')).toMatchObject({ priority: 'low' });
  });

  it('不误伤正文里的感叹号', () => {
    expect(parseQuickAdd('Hello! 世界')).toMatchObject({ title: 'Hello! 世界', priority: null });
    expect(parseQuickAdd('看看 ! 就好')).toMatchObject({ title: '看看 ! 就好', priority: null });
  });

  it('识别 @指派（最长匹配，可含空格）', () => {
    expect(parseQuickAdd('复现 baseline @张三', people)).toMatchObject({
      title: '复现 baseline',
      assigneeId: 'usr_a',
    });
    expect(parseQuickAdd('@张三丰 跑消融 !!', people)).toEqual({
      title: '跑消融',
      priority: 'high',
      assigneeId: 'usr_long',
    });
    expect(parseQuickAdd('交给 @调研 扩散模型 看看', people)).toMatchObject({
      title: '交给 看看',
      assigneeId: 'agent:thr_1',
    });
    expect(parseQuickAdd('邮件发给 a@张三.com', people)).toMatchObject({ assigneeId: null });
  });
});

describe('todo-list', () => {
  const list = [
    todo('a', 'a1', { assigneeId: 'usr_me' }),
    todo('b', 'a2', { ownerUserId: 'usr_me' }),
    todo('c', 'a3'),
    todo('d', 'a4', { done: true, completedAt: '2026-10-20T00:00:00.000Z', assigneeId: 'usr_me' }),
    todo('e', 'a0', { done: true, completedAt: '2026-10-25T00:00:00.000Z' }),
  ];

  it('全部 / 我的：未完成、按位置', () => {
    expect(activeTodos(list, 'all', 'usr_me').map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(activeTodos(list, 'mine', 'usr_me').map((t) => t.id)).toEqual(['a', 'b']);
    expect(activeTodos(list, 'mine', null)).toEqual([]);
  });

  it('刚勾选完成的项暂时留在原处', () => {
    expect(activeTodos(list, 'all', 'usr_me', new Set(['e'])).map((t) => t.id)).toEqual([
      'e',
      'a',
      'b',
      'c',
    ]);
  });

  it('已完成：最近完成在前，可只看我的', () => {
    expect(completedTodos(list, 'usr_me').map((t) => t.id)).toEqual(['e', 'd']);
    expect(completedTodos(list, 'usr_me', true).map((t) => t.id)).toEqual(['d']);
  });

  it('按日期分组，跳过空组', () => {
    const now = new Date(2026, 9, 26, 10, 0);
    const groups = groupByDue(
      [
        todo('x', 'a1', { dueAt: fromDateInputValue('2026-10-26') }),
        todo('y', 'a2'),
        todo('z', 'a3', { dueAt: fromDateInputValue('2026-10-20') }),
        todo('w', 'a4', { dueAt: fromDateInputValue('2026-10-30') }),
      ],
      now,
    );
    expect(groups.map((g) => [g.label, g.todos.map((t) => t.id)])).toEqual([
      ['已过期', ['z']],
      ['今天', ['x']],
      ['本周', ['w']],
      ['无日期', ['y']],
    ]);
  });

  it('拖动排序：插在某项之后 / 最前', () => {
    const open = list.slice(0, 3);
    const ids = (m: ReturnType<typeof moveTodoAfter>) =>
      activeTodos(m!.todos, 'all', null).map((t) => t.id);
    expect(ids(moveTodoAfter(open, 'a', 'c'))).toEqual(['b', 'c', 'a']);
    expect(ids(moveTodoAfter(open, 'c', null))).toEqual(['c', 'a', 'b']);
    expect(moveTodoAfter(open, 'b', 'a')?.changed).toBe(false);
    expect(moveTodoAfter(open, 'nope', null)).toBeNull();
  });

  it('缓存写入、删除、合并去重与可见性', () => {
    expect(upsertTodo(list, { ...list[0]!, title: '改' })[0]?.title).toBe('改');
    expect(upsertTodo([], list[0]!)).toHaveLength(1);
    expect(removeTodo(list, 'a')).toHaveLength(4);
    expect(mergeTodos([list[0]!], [list[0]!, list[1]!])).toHaveLength(2);
    expect(isVisibleTo(todo('p', 'a', { ownerUserId: 'usr_x' }), 'usr_me')).toBe(false);
    expect(isVisibleTo(todo('p', 'a', { ownerUserId: 'usr_me' }), 'usr_me')).toBe(true);
  });
});
