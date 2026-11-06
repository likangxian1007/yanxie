import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { DocumentMeta } from '@srh/shared';
import { ck } from '@/features/collab-kit/keys';
import { api, ApiRequestError } from '@/lib/api';
import { useAgents, useMemberMap, useThreads } from '@/lib/project';
import type { ThreadListFilter } from '@/lib/query-keys';
import type { PanelLookup } from './panel-labels';
import { tr } from '@/lib/i18n';

const PROJECT_THREADS: ThreadListFilter = { kind: 'project' };

function dataOnly(results: { data?: DocumentMeta | undefined }[]): DocumentMeta[] {
  return results.flatMap((r) => (r.data ? [r.data] : []));
}

const noRetryOn404 = (count: number, err: unknown) =>
  count < 2 && !(err instanceof ApiRequestError && err.status === 404);

/**
 * 右侧面板解析名字用的数据：成员、agent、项目线程，以及被引用到的文档 / 实验标题。
 * 文档与 features/docs 共用同一个查询键（数据形状一致），
 * 只有面板里真的出现了 doc_… 时才去取；列表里没有的文档（已归档等）再单独查一次。
 */
export function usePanelLookup(
  pid: string,
  refs: { docIds: readonly string[]; expIds: readonly string[] },
): PanelLookup {
  const memberMap = useMemberMap(pid);
  const agents = useAgents(pid);
  const threads = useThreads(pid, PROJECT_THREADS);

  const docs = useQuery({
    queryKey: ck.docs(pid),
    queryFn: ({ signal }) => api.get<DocumentMeta[]>(`/projects/${pid}/docs`, { signal }),
    enabled: Boolean(pid) && refs.docIds.length > 0,
  });
  const listed = useMemo(() => new Set((docs.data ?? []).map((d) => d.id)), [docs.data]);
  const missingDocIds = docs.isSuccess ? refs.docIds.filter((id) => !listed.has(id)) : [];
  // combine 是模块级函数，结果有结构共享，数据不变时引用也不变
  const singleDocs = useQueries({
    queries: missingDocIds.map((id) => ({
      queryKey: ck.doc(pid, id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get<DocumentMeta>(`/projects/${pid}/docs/${id}`, { signal }),
      retry: noRetryOn404,
      staleTime: 5 * 60_000,
    })),
    combine: dataOnly,
  });

  const docTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of docs.data ?? []) map.set(d.id, d.title);
    for (const d of singleDocs) map.set(d.id, d.title);
    return map;
  }, [docs.data, singleDocs]);

  return useMemo<PanelLookup>(() => {
    const threadTitles = new Map((threads.data ?? []).map((t) => [t.id, t.title]));
    const agentMap = new Map((agents.data ?? []).map((a) => [a.id, a]));
    return {
      pid,
      docTitle: (id) => docTitles.get(id),
      experimentTitle: () => tr('内容已移除'),
      threadTitle: (id) => threadTitles.get(id),
      memberName: (userId) => memberMap.get(userId)?.user.name,
      memberColor: (userId) => memberMap.get(userId)?.user.avatarColor,
      agent: (sessionId) => agentMap.get(sessionId),
    };
  }, [pid, docTitles, threads.data, agents.data, memberMap]);
}
