import type { ResearchListItem } from '@srh/shared';

export function filterResearchList(
  rows: ResearchListItem[],
  options: {
    query: string;
    status: string;
    sort: 'newest' | 'oldest' | 'title';
  },
): ResearchListItem[] {
  const needle = options.query.trim().toLocaleLowerCase();
  const filtered = rows.filter(
    (row) =>
      (!needle || row.title.toLocaleLowerCase().includes(needle)) &&
      (options.status === 'all' || row.status === options.status),
  );
  return filtered.sort((a, b) =>
    options.sort === 'title'
      ? a.title.localeCompare(b.title, 'zh-CN')
      : options.sort === 'oldest'
        ? a.updatedAt.localeCompare(b.updatedAt)
        : b.updatedAt.localeCompare(a.updatedAt),
  );
}

/** 兼容实验的 href 由服务端适配层提供；保留原详情路由。 */
export function researchItemHref(pid: string, row: ResearchListItem): string {
  return row.kind === 'experiment'
    ? `/p/${pid}/experiments/${row.id}`
    : `/p/${pid}/research/${row.id}`;
}
