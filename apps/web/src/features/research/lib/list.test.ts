import { describe, expect, it } from 'vitest';
import type { ResearchListItem } from '@srh/shared';
import { filterResearchList, researchItemHref } from './list';

const rows: ResearchListItem[] = [
  {
    kind: 'experiment',
    id: 'exp_1',
    projectId: 'prj_1',
    title: '旧实验',
    status: 'running',
    method: null,
    updatedAt: '2026-01-01',
    href: '',
  },
  {
    kind: 'research',
    id: 'rr_1',
    projectId: 'prj_1',
    title: '访谈',
    status: 'planned',
    method: 'qualitative',
    updatedAt: '2026-01-02',
    href: '',
  },
];
describe('研究列表', () => {
  it('历史实验仍走原详情，研究空间按标题筛选而不要求方法分类', () => {
    expect(researchItemHref('prj_1', rows[0]!)).toBe('/p/prj_1/experiments/exp_1');
    expect(
      filterResearchList(rows, {
        query: '访谈',
        status: 'all',
        sort: 'newest',
      }).map((r) => r.id),
    ).toEqual(['rr_1']);
  });
});
