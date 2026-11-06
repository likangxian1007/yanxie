import { useMemo } from 'react';
import { useDocs } from '@/features/docs/list/use-docs';
import type { SummaryContext } from './step-summary';

/** 项目文档 id → 标题（agent 的参数里只有 doc_id 时，用文档列表补上标题） */
export function useDocTitleContext(projectId: string | undefined): SummaryContext {
  const docs = useDocs(projectId ?? '');
  return useMemo(() => {
    const map = new Map((docs.data ?? []).map((d) => [d.id, d.title]));
    return { docTitle: (id: string) => map.get(id) || undefined };
  }, [docs.data]);
}
