import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocComment, DocCommentCreateInput, DocCommentUpdateInput } from '@srh/shared';
import { api } from '@/lib/api';
import { useProjectEvent } from '@/lib/realtime';
import { ck } from '@/features/collab-kit/keys';

/** 行内评论的查询键（挂在文档下面：/ws resync 时随项目一起刷新） */
export const docCommentsKey = (pid: string, docId: string) =>
  [...ck.doc(pid, docId), 'comments'] as const;

/** 用一条评论更新列表（新增或替换） */
export function upsertComment(list: DocComment[] | undefined, c: DocComment): DocComment[] {
  const prev = list ?? [];
  const i = prev.findIndex((x) => x.id === c.id);
  if (i < 0) return [...prev, c];
  // 乱序到达的旧事件不覆盖新数据
  if (prev[i]!.updatedAt > c.updatedAt) return prev;
  const next = prev.slice();
  next[i] = c;
  return next;
}

/** 删掉一条评论；删首条时连同回复 */
export function removeComment(list: DocComment[] | undefined, id: string): DocComment[] {
  return (list ?? []).filter((c) => c.id !== id && c.parentId !== id);
}

/** 文档的全部评论 + 实时更新（document.comment_*） */
export function useDocComments(pid: string, docId: string) {
  const qc = useQueryClient();
  const key = docCommentsKey(pid, docId);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api.get<DocComment[]>(`/projects/${pid}/docs/${docId}/comments`, { signal }),
    enabled: Boolean(pid && docId),
  });
  useProjectEvent(pid, (ev) => {
    if (ev.type === 'document.comment_created' || ev.type === 'document.comment_updated') {
      const c = ev.payload;
      if (c.documentId === docId) qc.setQueryData<DocComment[]>(key, (l) => upsertComment(l, c));
    } else if (ev.type === 'document.comment_deleted') {
      const { id, documentId } = ev.payload;
      if (documentId === docId) qc.setQueryData<DocComment[]>(key, (l) => removeComment(l, id));
    }
  });
  return query;
}

export function useCommentMutations(pid: string, docId: string) {
  const qc = useQueryClient();
  const key = docCommentsKey(pid, docId);
  const base = `/projects/${pid}/docs/${docId}/comments`;
  const write = (c: DocComment) => qc.setQueryData<DocComment[]>(key, (l) => upsertComment(l, c));
  const create = useMutation({
    mutationFn: (input: DocCommentCreateInput) => api.post<DocComment>(base, input),
    onSuccess: write,
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: DocCommentUpdateInput }) =>
      api.patch<DocComment>(`${base}/${id}`, patch),
    onSuccess: write,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`${base}/${id}`),
    onSuccess: (_v, id) => qc.setQueryData<DocComment[]>(key, (l) => removeComment(l, id)),
  });
  return { create, update, remove };
}
