import { describe, expect, it } from 'vitest';
import type { DocumentMeta } from '@srh/shared';
import {
  buildTree,
  countByKind,
  descendantIds,
  filterDocs,
  pinnedFirst,
  upsertDoc,
  type DocNode,
} from './doc-tree';
import { excerptCells, excerptLines } from './excerpt';

describe('pinnedFirst', () => {
  it('置顶的按置顶先后排到最前，其余保持原顺序', () => {
    const items = ['a', 'b', 'c', 'd'];
    expect(pinnedFirst(items, ['d', 'thr_x', 'b'], (x) => x)).toEqual(['d', 'b', 'a', 'c']);
    expect(pinnedFirst(items, [], (x) => x)).toBe(items);
  });
});

function doc(id: string, over: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    id,
    projectId: 'p1',
    parentId: null,
    kind: 'doc',
    title: id,
    icon: null,
    excerpt: '',
    createdBy: { kind: 'user', id: 'u1', name: '张三' },
    updatedBy: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    archivedAt: null,
    ...over,
  };
}

const shape = (nodes: DocNode[]): unknown =>
  nodes.map((n) => (n.children.length ? { [n.doc.id]: shape(n.children) } : n.doc.id));

describe('buildTree', () => {
  const docs = [
    doc('a', { updatedAt: '2026-10-03T00:00:00.000Z' }),
    doc('b', { updatedAt: '2026-10-05T00:00:00.000Z' }),
    doc('a1', { parentId: 'a', updatedAt: '2026-10-02T00:00:00.000Z' }),
    doc('a2', { parentId: 'a', updatedAt: '2026-10-04T00:00:00.000Z' }),
    doc('a1x', { parentId: 'a1' }),
    doc('orphan', { parentId: 'gone' }),
  ];

  it('按 parentId 组装，每层按最近更新排序；父文档不在列表里的提升为根', () => {
    expect(shape(buildTree(docs, 'updated'))).toEqual([
      'b',
      { a: ['a2', { a1: ['a1x'] }] },
      'orphan',
    ]);
  });

  it('按标题排序（数字自然序）', () => {
    const t = buildTree([doc('第10周'), doc('第2周'), doc('第1周')], 'title');
    expect(t.map((n) => n.doc.id)).toEqual(['第1周', '第2周', '第10周']);
  });

  it('环引用不会死循环，也不会丢文档', () => {
    const t = buildTree([doc('x', { parentId: 'y' }), doc('y', { parentId: 'x' })], 'title');
    expect(t.map((n) => n.doc.id).sort()).toEqual(['x', 'y']);
  });

  it('descendantIds 包含自身与全部子孙', () => {
    expect([...descendantIds(docs, 'a')].sort()).toEqual(['a', 'a1', 'a1x', 'a2']);
  });
});

describe('filterDocs / countByKind', () => {
  const docs = [
    doc('1', { kind: 'sheet', title: '实验数据', excerpt: 'ResNet acc 0.95' }),
    doc('2', { kind: 'doc', title: '周报', excerpt: '消融实验' }),
    doc('3', { kind: 'latex', title: 'Paper Draft', excerpt: '\\section{Intro}' }),
  ];
  it('按类型与关键词（标题 + 摘要，大小写不敏感，多词全部命中）', () => {
    expect(filterDocs(docs, { kind: 'all', query: '实验' }).map((d) => d.id)).toEqual(['1', '2']);
    expect(filterDocs(docs, { kind: 'sheet', query: '' }).map((d) => d.id)).toEqual(['1']);
    expect(filterDocs(docs, { kind: 'all', query: 'paper intro' }).map((d) => d.id)).toEqual(['3']);
    expect(filterDocs(docs, { kind: 'all', query: 'resnet 周报' })).toEqual([]);
  });
  it('计数', () => {
    expect(countByKind(docs)).toEqual({ all: 3, doc: 1, sheet: 1, slides: 0, latex: 1 });
  });
});

describe('upsertDoc', () => {
  it('活跃列表收到归档的文档时移除，归档列表收到恢复的文档时移除', () => {
    const list = [doc('a'), doc('b')];
    const archived = doc('a', { archivedAt: '2026-10-26T00:00:00.000Z' });
    expect(upsertDoc(list, archived, false)?.map((d) => d.id)).toEqual(['b']);
    expect(upsertDoc([], archived, true)?.map((d) => d.id)).toEqual(['a']);
    expect(upsertDoc([archived], doc('a'), true)).toEqual([]);
    expect(upsertDoc(list, doc('c'), false)?.map((d) => d.id)).toEqual(['c', 'a', 'b']);
    expect(upsertDoc(undefined, doc('c'), false)).toBeUndefined();
  });
});

describe('excerpt', () => {
  it('去掉 markdown 记号与表格分隔行', () => {
    expect(excerptLines('# 标题\n\n- 列表\n| --- | --- |\n> 引用\n1. 有序', 10)).toEqual([
      '标题',
      '列表',
      '引用',
      '有序',
    ]);
  });
  it('表格切成单元格', () => {
    expect(excerptCells('| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |', 5, 2)).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(excerptCells('x\ty\tz', 1, 3)).toEqual([['x', 'y', 'z']]);
  });
});
